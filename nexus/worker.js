// ══════════════════════════════════════════════
// nexus/worker.js — DB-based polling worker
// Replaces BullMQ to eliminate Redis overhead.
// Uses PostgreSQL FOR UPDATE SKIP LOCKED to
// atomically claim pending nexus_tasks jobs.
// ══════════════════════════════════════════════

import { query }          from '../db/database.js';
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
};

const POLL_INTERVAL_MS = 15_000; // 15 seconds between polls
const CONCURRENCY      = 4;      // max simultaneous jobs

let _activeJobs = 0;
let _running    = false;
let _timer      = null;

// ── Claim the next available pending job ─────────
async function claimNextJob() {
  const { rows } = await query(`
    UPDATE nexus_tasks
    SET    status     = 'running',
           started_at = NOW(),
           updated_at = NOW()
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
              meta
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
    console.error(`[NexusWorker] ❌ Tâche #${taskId} échouée:`, err.message);
    await updateTaskStatus(taskId, 'failed', err.message);
    if (meta?.chatId && /^\d+$/.test(String(meta.chatId))) {
      await replyToTelegram(meta.chatId, `❌ Erreur agent ${agentType}: ${err.message}`, agentType, taskId);
    }
  }
}

// ── Poll loop ─────────────────────────────────────
async function tick() {
  if (!_running) return;
  try {
    // Claim as many jobs as concurrency slots allow
    while (_activeJobs < CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) break; // no pending jobs
      _activeJobs++;
      processJob(job).finally(() => { _activeJobs--; });
    }
  } catch (err) {
    console.error('[NexusWorker] Poll error:', err.message);
  } finally {
    if (_running) {
      _timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
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
  _timer   = setTimeout(tick, 1_000); // first poll after 1s
  console.log('✅ [NexusWorker] DB-based poller started (interval: 15s, concurrency: 4)');
}

/**
 * Gracefully stop the worker (finishes in-flight jobs).
 */
export function stopNexusWorker() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log('[NexusWorker] Stopped (active jobs will finish)');
}
