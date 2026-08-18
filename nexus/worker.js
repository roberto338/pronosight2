// ══════════════════════════════════════════════
// nexus/worker.js — DB-based polling worker
// Replaces BullMQ to eliminate Redis overhead.
// Uses PostgreSQL FOR UPDATE SKIP LOCKED to
// atomically claim pending nexus_tasks jobs.
// ══════════════════════════════════════════════

import { query }          from '../db/database.js';
import { definirReveil }  from '../queues/reveil.js';
import { updateTaskStatus, saveOutput } from './lib/db.js';
import { saveMessage }    from './lib/memory.js';
import { buildMemoryContext, extractAndSave } from './lib/longTermMemory.js';
import { runResearch }    from './agents/researchAgent.js';
import { runWrite }       from './agents/writeAgent.js';
import { runCode }        from './agents/codeAgent.js';
import { runMonitor }     from './agents/monitorAgent.js';
import { runNotify }      from './agents/notifyAgent.js';
import { runCustom }      from './agents/customAgent.js';
import { runRadar }       from './agents/radarAgent.js';
import { runPlanner }     from './agents/plannerAgent.js';
import { runExec }        from './agents/execAgent.js';
import { runApi }         from './agents/apiAgent.js';
import { runBrowser }     from './agents/browserAgent.js';
import { runFinance }     from './agents/financeAgent.js';
import { runBusiness }    from './agents/businessAgent.js';
import { runVision }      from './agents/visionAgent.js';
import { runCritique }    from './agents/critiqueAgent.js';
import { runGoogle }      from './agents/googleAgent.js';

const AGENT_MAP = {
  research: runResearch,
  write:    runWrite,
  code:     runCode,
  monitor:  runMonitor,
  notify:   runNotify,
  custom:   runCustom,
  radar:    runRadar,
  planner:  runPlanner,
  exec:     runExec,
  api:      runApi,
  browser:  runBrowser,
  finance:  runFinance,
  business: runBusiness,
  vision:   runVision,
  critique: runCritique,
  google:   runGoogle,
};

// Cadence juste après une tâche : d'autres attendent peut-être derrière.
const POLL_ACTIF_MS    = 5_000;
// Cadence au repos. Le worker est réveillé par insertTask() : ce sondage
// ne rattrape que les orphelines. À 15 s, il empêchait le compute Neon de
// se suspendre — quota du palier gratuit épuisé le 18/08 à 01:26.
const POLL_REPOS_MS    = Number(process.env.NEXUS_POLL_IDLE_MS || 20 * 60 * 1000);
const CONCURRENCY      = 4;      // max simultaneous jobs
const BACKOFF_BASE_MS  = 5_000;  // backoff exponentiel : 5s, 10s, 20s…
const STALE_AFTER_MIN  = Number(process.env.JOB_STALE_MINUTES || 20);
const RETRY_WINDOW_H   = Number(process.env.JOB_RETRY_WINDOW_HOURS || 2);

let _activeJobs = 0;
let _running    = false;
let _timer      = null;

// ── Reprise des jobs orphelins ──────────────────────────────────
// Même filet que queues/workerManager.js : une tâche passée en 'running' dont
// le process meurt (redéploiement Render, OOM) n'est plus jamais reprise —
// claimNextJob() ne regarde que 'pending'. C'est la panne qui a figé 26 jobs
// Victor pendant 3 semaines ; nexus_tasks avait exactement le même trou.
async function requeueStaleTasks() {
  try {
    // Une tâche récente mérite un retry (redémarrage passager). Une tâche
    // ancienne porterait un contexte périmé et repartirait en masse au premier
    // déploiement → abandon direct au-delà de RETRY_WINDOW_H.
    const { rows } = await query(`
      UPDATE nexus_tasks
      SET    status = CASE
                        WHEN attempts < max_attempts
                         AND started_at > NOW() - ($2 || ' hours')::interval
                        THEN 'pending' ELSE 'failed'
                      END,
             error  = COALESCE(error, 'Tâche orpheline — process interrompu en cours de traitement'),
             updated_at = NOW()
      WHERE  status = 'running'
        AND  started_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id, status
    `, [String(STALE_AFTER_MIN), String(RETRY_WINDOW_H)]);

    if (rows.length > 0) {
      const requeues = rows.filter(r => r.status === 'pending').length;
      console.warn(`♻️  [NexusWorker] ${rows.length} tâche(s) orpheline(s) — ${requeues} requeuée(s), ${rows.length - requeues} abandonnée(s)`);
    }
    return rows.length;
  } catch (err) {
    console.error('❌ [NexusWorker] Balayage des orphelines impossible:', err.message);
    return 0;
  }
}

// ── Claim the next available pending job ─────────
async function claimNextJob() {
  const { rows } = await query(`
    UPDATE nexus_tasks
    SET    status     = 'running',
           started_at = NOW(),
           updated_at = NOW(),
           attempts   = attempts + 1
    WHERE  id = (
      SELECT id
      FROM   nexus_tasks
      WHERE  status = 'pending'
        AND  (scheduled_for IS NULL OR scheduled_for <= NOW())
      ORDER  BY created_at ASC
      LIMIT  1
      FOR    UPDATE SKIP LOCKED
    )
    RETURNING id,
              agent_type AS "agentType",
              input,
              meta,
              attempts,
              max_attempts AS "maxAttempts"
  `);
  return rows[0] || null;
}

// ── Send result to Telegram ───────────────────────
async function replyToTelegram(chatId, output, agentType, taskId) {
  if (!chatId) return;
  try {
    const { sendNexusMessage } = await import('./telegramHandler.js');
    const header = `✅ *Nexus #${taskId}* — agent: ${agentType}\n${'─'.repeat(24)}\n`;
    await sendNexusMessage(chatId, header + output);
  } catch (err) {
    console.error('[NexusWorker] Erreur réponse Telegram:', err.message);
  }
}

// ── Process a single claimed job ─────────────────
async function processJob(job) {
  const { id: taskId, agentType, input } = job;
  // meta stored as JSON string in DB; parse it
  const meta = typeof job.meta === 'string' ? JSON.parse(job.meta) : (job.meta || {});

  console.log(`[NexusWorker] Processing task #${taskId} — agent: ${agentType}`);

  const handler = AGENT_MAP[agentType];
  if (!handler) {
    const errMsg = `Agent inconnu: ${agentType}`;
    await updateTaskStatus(taskId, 'failed', errMsg);
    if (meta?.chatId) await replyToTelegram(meta.chatId, `❌ ${errMsg}`, agentType, taskId);
    return;
  }

  // Enrich meta with long-term memory context at execution time.
  // Always inject (even empty string) so agents always get ROBERTO_BASE
  // from buildNexusPrompt regardless of LTM state.
  let enrichedMeta = meta;
  try {
    const memoryContext = await buildMemoryContext(agentType, input);
    console.log(`[NexusWorker] 🧠 Memory: ${memoryContext.length} chars, task #${taskId} (agent: ${agentType})`);
    enrichedMeta = { ...meta, memoryContext };
  } catch (err) {
    console.warn('[NexusWorker] Memory fetch failed (non-blocking):', err.message);
    enrichedMeta = { ...meta, memoryContext: '' }; // ensure key always exists
  }

  try {
    const result = await handler({ taskId, input, meta: enrichedMeta });
    await saveOutput({ taskId, output: result.output, meta: result.meta || {} });
    await updateTaskStatus(taskId, 'done');
    console.log(`[NexusWorker] ✅ Tâche #${taskId} terminée`);

    // Non-blocking LTM extraction
    setImmediate(() => extractAndSave(taskId, agentType, input, result.output || ''));

    if (meta?.chatId) {
      await saveMessage(meta.chatId, 'assistant', result.output, agentType);
      // Only Telegram-reply for numeric chat IDs.
      // Non-numeric IDs (e.g. 'nexus-web-chat') are web-UI sessions — the poll
      // endpoint delivers the response; no Telegram message needed.
      const isTelegramId = /^\d+$/.test(String(meta.chatId));
      if (isTelegramId) {
        const useSummary = agentType === 'business' && result.meta?.summary;
        await replyToTelegram(
          meta.chatId,
          useSummary ? result.meta.summary : result.output,
          agentType,
          taskId
        );
      }
    }
  } catch (err) {
    // Un échec transitoire (429 Anthropic, 503 Gemini, timeout réseau) ne doit
    // pas tuer la tâche définitivement : on la replanifie avec un backoff.
    const attempts   = job.attempts    ?? 1;
    const maxAttempts = job.maxAttempts ?? 1;
    const willRetry  = attempts < maxAttempts;
    const backoffMs  = BACKOFF_BASE_MS * 2 ** (attempts - 1);

    console.error(`[NexusWorker] ❌ Tâche #${taskId} échouée (tentative ${attempts}/${maxAttempts}):`, err.message);

    await query(
      `UPDATE nexus_tasks
       SET status = $1, error = $2,
           scheduled_for = CASE WHEN $1 = 'pending' THEN NOW() + ($3 || ' milliseconds')::interval ELSE scheduled_for END,
           updated_at = NOW()
       WHERE id = $4`,
      [willRetry ? 'pending' : 'failed', err.message, String(backoffMs), taskId]
    );

    // Ne prévenir Roberto qu'à l'abandon définitif — pas à chaque tentative.
    if (!willRetry && meta?.chatId && /^\d+$/.test(String(meta.chatId))) {
      await replyToTelegram(meta.chatId, `❌ Erreur agent ${agentType}: ${err.message}`, agentType, taskId);
    }
  }
}

// ── Boucle d'exécution ────────────────────────────
//
// Même principe que queues/workerManager.js : le worker est réveillé par
// insertTask() au lieu de sonder. Le sondage ne rattrape plus que les
// orphelines d'un process mort, et devient donc lent — ce qui laisse le
// compute Neon se suspendre au lieu d'être tenu éveillé en permanence.
let _enCours       = false;
let _reveilDemande = false;

function planifier(delaiMs) {
  if (!_running) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(tick, delaiMs);
}

function reveiller(raison = 'nouvelle tâche') {
  if (!_running) return;
  if (_enCours) { _reveilDemande = true; return; }
  planifier(0);
  console.log(`⚡ [NexusWorker] Réveil — ${raison}`);
}

async function tick() {
  if (!_running) return;
  _enCours = true;
  let aTravaille = false;
  try {
    await requeueStaleTasks();   // avant tout claim : libère les zombies

    // Claim as many jobs as concurrency slots allow
    while (_activeJobs < CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) break; // no pending jobs
      aTravaille = true;
      _activeJobs++;
      processJob(job).finally(() => { _activeJobs--; });
    }
  } catch (err) {
    console.error('[NexusWorker] Poll error:', err.message);
  } finally {
    _enCours = false;
    // Une tâche vient d'être lancée : on repasse vite pour la suivante.
    // Sinon on laisse la base dormir jusqu'au prochain réveil.
    const delai = _reveilDemande ? 0 : (aTravaille ? POLL_ACTIF_MS : POLL_REPOS_MS);
    _reveilDemande = false;
    planifier(delai);
  }
}

/**
 * Start the Nexus DB-based polling worker.
 * Call once on server startup (after DB is ready).
 * Zero Redis commands — uses PostgreSQL FOR UPDATE SKIP LOCKED.
 */
export function startNexusWorker() {
  if (_running) {
    console.warn('[NexusWorker] Already running');
    return;
  }
  _running = true;
  definirReveil('nexus', reveiller);
  planifier(1_000); // premier passage après 1s (orphelines du process précédent)
  console.log(`✅ [NexusWorker] démarré — réveil à l'insertion, sondage de secours toutes les ${Math.round(POLL_REPOS_MS / 60000)} min (concurrency ${CONCURRENCY})`);
}

/**
 * Gracefully stop the worker (finishes in-flight jobs).
 */
export function stopNexusWorker() {
  _running = false;
  definirReveil('nexus', null);
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log('[NexusWorker] Stopped (active jobs will finish)');
}
