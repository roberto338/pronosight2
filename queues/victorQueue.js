// ══════════════════════════════════════════════
// queues/victorQueue.js — BullMQ Queue + Redis
//
// Connection model (BullMQ requirement):
//   redisConnection  → shared across all Queue instances (non-blocking)
//   createConnection → factory for Workers & QueueEvents (blocking / pub-sub,
//                      each call returns a dedicated IORedis instance)
// ══════════════════════════════════════════════

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// ── Config ─────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || '';
const IS_TLS    = REDIS_URL.startsWith('rediss://');

/** Base IORedis options shared by every connection */
const BASE_OPTS = {
  maxRetriesPerRequest: null,   // required by BullMQ
  enableReadyCheck:     false,
  lazyConnect:          false,
  ...(IS_TLS ? { tls: { rejectUnauthorized: false } } : {}),
};

/**
 * Create a new dedicated IORedis connection.
 * Call this for Workers and QueueEvents — they need their own sockets
 * because they issue blocking commands (BLMOVE, SUBSCRIBE) that would
 * stall a shared connection.
 *
 * @param {string} [label]  Optional name shown in logs
 * @returns {IORedis | null}
 */
export function createConnection(label = 'redis') {
  if (!REDIS_URL) return null;
  const conn = new IORedis(REDIS_URL, BASE_OPTS);
  conn.on('connect', () => console.log(`🔴 [${label}] Redis connecté (${IS_TLS ? 'TLS' : 'plain'})`));
  conn.on('ready',   () => console.log(`✅ [${label}] Redis prêt`));
  conn.on('error',  (err) => console.warn(`⚠️  [${label}] Redis erreur:`, err.message));
  conn.on('close',  ()    => console.warn(`⚠️  [${label}] Redis déconnecté`));
  return conn;
}

// ── Shared Queue connection (non-blocking, reused by all Queue instances) ──
export const redisConnection = createConnection('queue-shared');

if (!redisConnection) {
  console.warn('⚠️  REDIS_URL non définie — BullMQ désactivé, fallback synchrone actif');
}

// ── Queue principale Victor ────────────────────
export const victorQueue = redisConnection
  ? new Queue('victor-analysis', {
      connection: redisConnection,       // shared — Queue only does non-blocking SET/ZADD
      defaultJobOptions: {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 50 },
      },
    })
  : null;

// ── Queue Events — disabled to save Redis connections ──────────────────────
// QueueEvents uses a dedicated pub/sub socket (SUBSCRIBE). Disabled here
// because no code path currently listens to victor-analysis events.
// Re-enable if you add job-completion hooks: new QueueEvents('victor-analysis', { connection: createConnection('qevents-victor') })
export const victorQueueEvents = null;

// ── Helpers d'ajout de jobs ────────────────────

export async function addPrematchJob(data = {}) {
  if (!victorQueue) throw new Error('Redis indisponible');
  return victorQueue.add('prematch', { ...data, addedAt: new Date().toISOString() }, {
    priority: 1,
    jobId: `prematch-${new Date().toISOString().slice(0, 10)}`,
  });
}

export async function addValueJob(data = {}) {
  if (!victorQueue) throw new Error('Redis indisponible');
  return victorQueue.add('value', { ...data, addedAt: new Date().toISOString() }, {
    priority: 2,
    jobId: `value-${new Date().toISOString().slice(0, 10)}`,
  });
}

export async function addLiveJob(data = {}) {
  if (!victorQueue) throw new Error('Redis indisponible');
  return victorQueue.add('live', { ...data, addedAt: new Date().toISOString() }, {
    priority: 1,
  });
}

export async function addCheckResultsJob(data = {}) {
  if (!victorQueue) throw new Error('Redis indisponible');
  return victorQueue.add('check-results', { ...data, addedAt: new Date().toISOString() }, {
    priority: 3,
    jobId: `check-results-${new Date().toISOString().slice(0, 10)}`,
  });
}

export async function addWeeklyReviewJob(data = {}) {
  if (!victorQueue) throw new Error('Redis indisponible');
  return victorQueue.add('weekly-review', { ...data, addedAt: new Date().toISOString() }, {
    priority: 5,
  });
}

export default victorQueue;
