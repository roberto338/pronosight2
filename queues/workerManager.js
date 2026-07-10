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
import { sendDailyStats }    from '../bot/telegram.js';
import { query }             from '../db/database.js';
import { pruneOldJobs }      from './victorQueue.js';

const POLL_INTERVAL_MS = 10_000; // 1 claim max par tick → max 1 job / 10s (ex-limiter BullMQ)
const BACKOFF_BASE_MS  = 5_000;  // backoff exponentiel : 5s, 10s, 20s…

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
      await job.updateProgress(20);
      await discoverNewPatterns();
      await job.updateProgress(60);
      await weeklyVictorReview();
      await job.updateProgress(100);
      return { done: true, week: new Date().toISOString().slice(0, 10) };
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
    const result = await processor(job);
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
