// ══════════════════════════════════════════════
// queues/victorQueue.js — BullMQ Queue + Redis
// ══════════════════════════════════════════════

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// ── Config Redis ───────────────────────────────
const REDIS_URL = process.env.REDIS_URL || '';
const IS_TLS    = REDIS_URL.startsWith('rediss://');

function makeConn() {
  if (!REDIS_URL) return null;
  const conn = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // Requis par BullMQ
    enableReadyCheck:     false,
    ...(IS_TLS ? { tls: { rejectUnauthorized: false } } : {}),
  });
  conn.on('connect', () => console.log(`🔴 Redis connecté (${IS_TLS ? 'TLS Upstash' : 'plain'})`));
  conn.on('ready',   () => console.log('✅ Redis prêt — BullMQ opérationnel'));
  conn.on('error',  (err) => console.warn('⚠️  Redis erreur:', err.message));
  conn.on('close',  ()    => console.warn('⚠️  Redis déconnecté'));
  return conn;
}

// ── Connexion principale ───────────────────────
export const redisConnection = makeConn();

if (!redisConnection) {
  console.warn('⚠️  REDIS_URL non définie — BullMQ désactivé, fallback synchrone actif');
}

// ── Queue principale Victor ────────────────────
export const victorQueue = redisConnection
  ? new Queue('victor-analysis', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 50 },
      },
    })
  : null;

// ── Queue Events (monitoring) ──────────────────
export const victorQueueEvents = redisConnection
  ? new QueueEvents('victor-analysis', { connection: makeConn() })
  : null;

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
