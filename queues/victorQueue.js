// ══════════════════════════════════════════════
// queues/victorQueue.js — File Victor en PostgreSQL
//
// Remplace BullMQ/Redis (Upstash) : les jobs vivent dans la table
// victor_jobs (migration 008), claim atomique via FOR UPDATE SKIP
// LOCKED dans workerManager.js. Zéro dépendance Redis.
//
// Sémantique BullMQ conservée :
//   - priority : plus petit = plus prioritaire
//   - jobId quotidien (prematch-YYYY-MM-DD) → dedupe_key UNIQUE :
//     un 2e ajout le même jour renvoie le job existant
//   - attempts/backoff : gérés par workerManager (3 essais, expo 5s)
// ══════════════════════════════════════════════

import { query } from '../db/database.js';
import { reveillerWorker } from './reveil.js';

// Objet queue minimal — les routes de statut testent seulement sa présence
export const victorQueue = { backend: 'postgres', table: 'victor_jobs' };

/**
 * Insère un job. Si dedupeKey existe déjà (job quotidien), renvoie
 * le job existant sans en créer un nouveau (comportement jobId BullMQ).
 * @returns {Promise<{id: number, deduped?: boolean}>}
 */
async function addJob(name, data = {}, { priority = 5, dedupeKey = null } = {}) {
  const payload = JSON.stringify({ ...data, addedAt: new Date().toISOString() });

  if (dedupeKey) {
    // La déduplication ne doit PAS emprisonner la journée : si le job du
    // jour a échoué ou s'est figé, un nouvel ajout doit le relancer.
    // Sans ce DO UPDATE, un seul plantage matinal bloquait tous les
    // déclenchements suivants jusqu'au lendemain.
    const { rows } = await query(
      `INSERT INTO victor_jobs (name, data, priority, dedupe_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET status        = 'pending',
             data          = EXCLUDED.data,
             attempts      = 0,
             progress      = 0,
             error         = NULL,
             scheduled_for = NULL,
             started_at    = NULL,
             completed_at  = NULL,
             updated_at    = NOW()
         WHERE victor_jobs.status = 'failed'
            OR (victor_jobs.status = 'running'
                AND victor_jobs.started_at < NOW() - INTERVAL '20 minutes')
       RETURNING id`,
      [name, payload, priority, dedupeKey]
    );
    if (rows[0]) { reveillerWorker('victor', `${name} #${rows[0].id}`); return { id: rows[0].id }; }
    // Aucune ligne renvoyée = job déjà 'pending' ou 'done' → on le réutilise
    const { rows: existing } = await query(
      `SELECT id FROM victor_jobs WHERE dedupe_key = $1`, [dedupeKey]
    );
    return { id: existing[0]?.id, deduped: true };
  }

  const { rows } = await query(
    `INSERT INTO victor_jobs (name, data, priority)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name, payload, priority]
  );
  // Le worker ne sonde plus toutes les 10 s : c'est ici qu'il apprend
  // qu'il a du travail. Sans ce réveil, le job attendrait le sondage
  // de secours (20 min).
  reveillerWorker('victor', `${name} #${rows[0].id}`);
  return { id: rows[0].id };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function addPrematchJob(data = {}) {
  return addJob('prematch', data, { priority: 1, dedupeKey: `prematch-${today()}` });
}

export async function addValueJob(data = {}) {
  return addJob('value', data, { priority: 2, dedupeKey: `value-${today()}` });
}

export async function addLiveJob(data = {}) {
  return addJob('live', data, { priority: 1 });
}

export async function addCheckResultsJob(data = {}) {
  return addJob('check-results', data, { priority: 3, dedupeKey: `check-results-${today()}` });
}

export async function addWeeklyReviewJob(data = {}) {
  return addJob('weekly-review', data, { priority: 5 });
}

export async function addHeartbeatJob(data = {}) {
  return addJob('heartbeat', data, { priority: 4, dedupeKey: `heartbeat-${today()}` });
}

/** Compteurs par statut — utilisé par le dashboard /admin/queues */
export async function getQueueCounts() {
  const { rows } = await query(`
    SELECT status, COUNT(*)::int AS n
    FROM victor_jobs
    GROUP BY status
  `);
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

/** Derniers jobs — utilisé par le dashboard /admin/queues */
export async function getRecentJobs(limit = 30) {
  const { rows } = await query(`
    SELECT id, name, status, priority, attempts, progress, error,
           dedupe_key, created_at, started_at, completed_at
    FROM victor_jobs
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

/** Purge des jobs terminés anciens (appelé par le worker, 1×/jour) */
export async function pruneOldJobs(keepDays = 14) {
  const { rowCount } = await query(
    `DELETE FROM victor_jobs
     WHERE status IN ('done', 'failed')
       AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(keepDays)]
  );
  return rowCount;
}

export default victorQueue;
