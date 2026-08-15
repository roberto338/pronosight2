// ══════════════════════════════════════════════
// queues/workerManager.js — Worker Victor (poller PostgreSQL)
//
// Remplace le Worker BullMQ : claim atomique FOR UPDATE SKIP LOCKED
// sur victor_jobs, même pattern que nexus/worker.js. Zéro Redis.
//
// Sémantique BullMQ conservée :
//   - concurrency 1 + minimum 10s entre deux jobs (rate limit IA)
//   - 3 tentatives, backoff exponentiel base 5s
//   - job.updateProgress() persiste la colonne progress
// ══════════════════════════════════════════════

import { prematchProcessor } from './workers/prematchWorker.js';
import { valueProcessor }    from './workers/valueWorker.js';
import { liveProcessor }     from './workers/liveWorker.js';
import { checkResults, updateVictorStats, weeklyVictorReview } from '../victor/core.js';
import { discoverNewPatterns } from '../victor/patterns.js';
import { computePatterns }    from '../victor/patterns-compute.js';
import { sendDailyStats, sendHeartbeat } from '../bot/telegram.js';
import { runHealthcheck }    from '../victor/healthcheck.js';
import { query }             from '../db/database.js';
import { pruneOldJobs }      from './victorQueue.js';

const POLL_INTERVAL_MS = 10_000; // 1 claim max par tick → max 1 job / 10s (ex-limiter BullMQ)
const BACKOFF_BASE_MS  = 5_000;  // backoff exponentiel : 5s, 10s, 20s…

// Doit rester INFÉRIEUR au seuil de requeue du balayage (20 min), sinon
// un job lent est repris pendant qu'il tourne encore et consomme ses
// tentatives pour rien. Un échec explicite vaut mieux qu'un job fantôme.
const JOB_TIMEOUT_MS   = Number(process.env.JOB_TIMEOUT_MS || 12 * 60 * 1000);
const STALE_AFTER_MIN  = Number(process.env.JOB_STALE_MINUTES || 20);
// 6 h et non 2 : un job de 7h ou de 13h reste pertinent le soir même, et
// une indisponibilité de Render dépasse facilement deux heures. Le 15/08,
// le job de 13h a été abandonné après un seul essai pour cette raison.
// Au-delà de 6 h on renonce : le contexte du jour n'a plus de sens.
const RETRY_WINDOW_H   = Number(process.env.JOB_RETRY_WINDOW_HOURS || 6);

// ── Reprise des jobs orphelins ──────────────────────────────────
// Un job passé en 'running' dont le process meurt (redéploiement Render,
// spin-down du free tier, OOM) n'est plus jamais repris : claimNextJob()
// ne regarde que 'pending'. 26 jobs sont ainsi restés figés du 15/07 au
// 03/08/2026 — panne invisible de 3 semaines. Ce balayage est le filet.
async function requeueStaleJobs(seuilMin = STALE_AFTER_MIN) {
  try {
    // Un job récent mérite un retry (redémarrage Render passager).
    // Un job ancien ne doit PAS être rejoué : il porterait un contexte
    // périmé, et 26 zombies accumulés partiraient tous d'un coup au
    // premier déploiement. Au-delà de RETRY_WINDOW_H → abandon direct.
    const { rows } = await query(`
      UPDATE victor_jobs
      SET    status = CASE
                        WHEN attempts < max_attempts
                         AND started_at > NOW() - ($2 || ' hours')::interval
                        THEN 'pending' ELSE 'failed'
                      END,
             -- Message prudent : le process PEUT être mort, mais il peut
             -- aussi être vivant et le job simplement trop lent. Les 07,
             -- 08 et 09/08, ce libellé affirmait « process interrompu »
             -- alors que le service tournait depuis 34 h sans coupure —
             -- il attendait le quota football-data. Un diagnostic faux
             -- coûte plus cher qu'une absence de diagnostic.
             error  = COALESCE(error, 'Repris : toujours en cours après ' || $1 || ' min sans aboutir'),
             updated_at = NOW()
      WHERE  status = 'running'
        AND  started_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id, name, status
    `, [String(seuilMin), String(RETRY_WINDOW_H)]);

    if (rows.length > 0) {
      const requeues = rows.filter(r => r.status === 'pending').length;
      console.warn(`♻️  [Worker] ${rows.length} job(s) orphelin(s) — ${requeues} requeué(s), ${rows.length - requeues} abandonné(s) (trop ancien)`);
    }
    return rows.length;
  } catch (err) {
    console.error('❌ [Worker] Balayage des orphelins impossible:', err.message);
    return 0;
  }
}

// ── Dispatcher principal (inchangé fonctionnellement) ──────────
async function processor(job) {
  console.log(`\n⚙️  [Worker] Job reçu : ${job.name} #${job.id}`);

  switch (job.name) {

    case 'prematch':
      return prematchProcessor(job);

    case 'value':
      return valueProcessor(job);

    case 'live':
      return liveProcessor(job);

    case 'check-results': {
      console.log(`\n🔍 [check-results #${job.id}] Vérification résultats...`);
      await job.updateProgress(20);
      await checkResults();
      await job.updateProgress(60);
      await updateVictorStats();
      await job.updateProgress(85);

      try {
        const { rows } = await query(
          'SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE'
        );
        if (rows.length > 0) {
          await sendDailyStats(rows[0]);
          console.log(`   📊 [check-results #${job.id}] Stats Telegram envoyées`);
        }
      } catch (statErr) {
        console.warn(`   ⚠️  Stats Telegram échouées:`, statErr.message);
      }

      await job.updateProgress(100);
      return { done: true, date: new Date().toISOString().slice(0, 10) };
    }

    case 'weekly-review': {
      console.log(`\n📊 [weekly-review #${job.id}] Review hebdomadaire...`);

      // Recalcul des patterns depuis l'historique réel des matchs.
      // Sans ce rafraîchissement, ils se périment et sont désactivés
      // au bout de 30 jours — la table redeviendrait vide.
      await job.updateProgress(15);
      let patterns = { calcules: 0, ecrits: 0, matchs: 0 };
      try {
        patterns = await computePatterns({ jours: 120 });
      } catch (err) {
        console.warn('   ⚠️  Recalcul des patterns échoué:', err.message);
      }

      await job.updateProgress(45);
      await discoverNewPatterns();
      await job.updateProgress(70);
      await weeklyVictorReview();
      await job.updateProgress(100);
      return {
        done: true,
        week: new Date().toISOString().slice(0, 10),
        patternsEcrits: patterns.ecrits,
        matchsAnalyses: patterns.matchs,
      };
    }

    case 'heartbeat': {
      console.log(`\n💓 [heartbeat #${job.id}] Diagnostic de santé...`);
      await job.updateProgress(30);
      const diag = await runHealthcheck();
      await job.updateProgress(70);
      await sendHeartbeat(diag);
      await job.updateProgress(100);
      return { done: true, problemes: diag.problemes };
    }

    default:
      console.warn(`⚠️  [Worker] Job inconnu : ${job.name} — ignoré`);
      return { skipped: true, reason: `Job name inconnu: ${job.name}` };
  }
}

// ── Claim atomique du prochain job ──────────────────────────────
async function claimNextJob() {
  const { rows } = await query(`
    UPDATE victor_jobs
    SET    status     = 'running',
           started_at = NOW(),
           updated_at = NOW(),
           attempts   = attempts + 1
    WHERE  id = (
      SELECT id
      FROM   victor_jobs
      WHERE  status = 'pending'
        AND  (scheduled_for IS NULL OR scheduled_for <= NOW())
      ORDER  BY priority ASC, created_at ASC
      LIMIT  1
      FOR    UPDATE SKIP LOCKED
    )
    RETURNING id, name, data, attempts, max_attempts AS "maxAttempts"
  `);
  return rows[0] || null;
}

// ── Exécution d'un job réclamé ──────────────────────────────────
async function processClaimedJob(row) {
  const job = {
    id:   row.id,
    name: row.name,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}),
    updateProgress: async (p) => {
      try {
        await query(`UPDATE victor_jobs SET progress = $1, updated_at = NOW() WHERE id = $2`, [p, row.id]);
      } catch { /* le progress est cosmétique — jamais bloquant */ }
    },
  };

  try {
    // Plafond de durée : un job ne doit JAMAIS dépasser la fenêtre de
    // requeue du balayage (20 min), sinon il est repris alors qu'il
    // tourne encore, jusqu'à épuiser ses tentatives — ce qui s'est
    // produit les 07, 08 et 09/08 en affichant « process interrompu »
    // alors que le process était parfaitement vivant (34 h d'uptime).
    const result = await Promise.race([
      processor(job),
      new Promise((_, rejeter) =>
        setTimeout(() => rejeter(new Error(`Délai dépassé (${JOB_TIMEOUT_MS / 1000}s) — job interrompu par sécurité`)),
          JOB_TIMEOUT_MS).unref()
      ),
    ]);
    await query(
      `UPDATE victor_jobs
       SET status = 'done', result = $1, error = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(result ?? {}), row.id]
    );
    console.log(`✅ [Worker] Job terminé : ${row.name} #${row.id}`, JSON.stringify(result ?? {}).slice(0, 100));
  } catch (err) {
    const willRetry = row.attempts < row.maxAttempts;
    const backoffMs = BACKOFF_BASE_MS * 2 ** (row.attempts - 1);
    console.error(`❌ [Worker] Job échoué : ${row.name} #${row.id} (tentative ${row.attempts}/${row.maxAttempts}) — ${err.message}`);

    await query(
      `UPDATE victor_jobs
       SET status = $1, error = $2,
           scheduled_for = CASE WHEN $1 = 'pending' THEN NOW() + ($3 || ' milliseconds')::interval ELSE scheduled_for END,
           updated_at = NOW()
       WHERE id = $4`,
      [willRetry ? 'pending' : 'failed', err.message, String(backoffMs), row.id]
    );
  }
}

// ── Boucle de polling (concurrency 1) ───────────────────────────
let _running   = false;
let _timer     = null;
let _lastPrune = 0;

async function tick() {
  if (!_running) return;
  try {
    await requeueStaleJobs();     // avant tout claim : libère les zombies
    const row = await claimNextJob();
    if (row) await processClaimedJob(row); // séquentiel : 1 job IA à la fois

    // Purge quotidienne des vieux jobs terminés
    if (Date.now() - _lastPrune > 24 * 60 * 60 * 1000) {
      _lastPrune = Date.now();
      const n = await pruneOldJobs(14).catch(() => 0);
      if (n > 0) console.log(`🧹 [Worker] ${n} vieux job(s) purgés`);
    }
  } catch (err) {
    console.error('❌ [Worker] Poll error:', err.message);
  } finally {
    if (_running) _timer = setTimeout(tick, POLL_INTERVAL_MS);
  }
}

export function startWorker() {
  if (_running) {
    console.log('⚙️  Worker déjà démarré');
    return true;
  }
  _running = true;

  // ── Reprise immédiate au démarrage ────────────────────────────
  // Une seule instance, un seul worker, concurrency 1 : au boot, un job
  // encore en 'running' appartenait forcément au process précédent. Il
  // est orphelin par définition — inutile d'attendre les 20 minutes du
  // balayage périodique.
  //
  // Le 15/08, le job value de 13h a été tué par un SIGTERM de Render à
  // 75% d'avancement. Il est resté 'running', et quand le balayage l'a
  // enfin vu, la fenêtre de rejeu de 2 h avait expiré : abandonné après
  // un seul essai, alors que deux tentatives restaient disponibles.
  requeueStaleJobs(0)
    .then(n => { if (n > 0) console.warn(`♻️  [Worker] ${n} job(s) repris au démarrage`); })
    .catch(() => { /* le balayage périodique prendra le relais */ });

  _timer   = setTimeout(tick, 2_000);
  console.log('⚙️  Worker Victor démarré — poller PostgreSQL (victor_jobs, 1 job / 10s max)');
  return true;
}

export function stopWorker() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log('[Worker] Arrêté (le job en cours se termine)');
}

export function getWorker() {
  return _running ? { backend: 'postgres', running: true } : null;
}

export default startWorker;
