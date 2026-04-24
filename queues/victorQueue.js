// ══════════════════════════════════════════════
// queues/victorQueue.js — BullMQ Queue + Redis
// ══════════════════════════════════════════════

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// ── Connexion Redis ────────────────────────────
export const redisConnection = new IORedis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null, // Requis par BullMQ
    enableReadyCheck:     false,
    lazyConnect:          true,
  }
);

redisConnection.on('connect',       () => console.log('🔴 Redis connecté'));
redisConnection.on('error',  (err) => console.warn('⚠️  Redis erreur:', err.message));
redisConnection.on('close',         () => console.warn('⚠️  Redis déconnecté'));

// ── Queue principale Victor ────────────────────
export const victorQueue = new Queue('victor-analysis', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:          3,
    backoff:           { type: 'exponential', delay: 5000 },
    removeOnComplete:  { count: 10 },
    removeOnFail:      { count: 50 },
  },
});

// ── Queue Events (monitoring) ──────────────────
export const victorQueueEvents = new QueueEvents('victor-analysis', {
  connection: new IORedis(
    process.env.REDIS_URL || 'redis://localhost:6379',
    { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true }
  ),
});

// ── Helpers d'ajout de jobs ───────────────────

/**
 * Ajoute un job d'analyse pré-match (07h00)
 */
export async function addPrematchJob(data = {}) {
  return victorQueue.add('prematch', { ...data, addedAt: new Date().toISOString() }, {
    priority: 1,
    jobId:    `prematch-${new Date().toISOString().slice(0, 10)}`, // 1 seul par jour
  });
}

/**
 * Ajoute un job d'analyse value betting (13h00)
 */
export async function addValueJob(data = {}) {
  return victorQueue.add('value', { ...data, addedAt: new Date().toISOString() }, {
    priority: 2,
    jobId:    `value-${new Date().toISOString().slice(0, 10)}`,
  });
}

/**
 * Ajoute un job d'analyse live (à la demande)
 */
export async function addLiveJob(data = {}) {
  return victorQueue.add('live', { ...data, addedAt: new Date().toISOString() }, {
    priority: 1,
  });
}

/**
 * Ajoute un job de vérification des résultats (23h30)
 */
export async function addCheckResultsJob(data = {}) {
  return victorQueue.add('check-results', { ...data, addedAt: new Date().toISOString() }, {
    priority: 3,
    jobId:    `check-results-${new Date().toISOString().slice(0, 10)}`,
  });
}

/**
 * Ajoute un job de review hebdomadaire (dimanche 01h00)
 */
export async function addWeeklyReviewJob(data = {}) {
  return victorQueue.add('weekly-review', { ...data, addedAt: new Date().toISOString() }, {
    priority: 5,
  });
}

export default victorQueue;
