// ══════════════════════════════════════════════
// nexus/orchestrator.js — Task dispatcher
// Creates the nexus-tasks BullMQ queue
//
// Connection strategy:
//   nexusQueue uses the shared redisConnection (Queue = non-blocking).
//   Workers import createConnection() and build their own dedicated
//   blocking socket — they must NOT share the Queue connection.
// ══════════════════════════════════════════════

import { Queue } from 'bullmq';
import { redisConnection } from '../queues/victorQueue.js';
import { insertTask } from './lib/db.js';
import { buildMemoryContext } from './lib/longTermMemory.js';

// ── Re-export createConnection so nexus internals ──
// ── have a single import point for Redis helpers ───
export { createConnection } from '../queues/victorQueue.js';

// ── BullMQ Queue (shares the non-blocking Queue connection) ───
export const nexusQueue = redisConnection
  ? new Queue('nexus-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts:         2,
        backoff:          { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 50 },
      },
    })
  : null;

if (!nexusQueue) {
  console.warn('⚠️  [Nexus] Queue désactivée — Redis indisponible');
}

/**
 * Dispatch a task to the nexus-tasks queue.
 * 1. Saves task in DB
 * 2. Fetches relevant long-term memories
 * 3. Enqueues job with enriched meta (memoryContext)
 *
 * @param {Object} opts
 * @param {string} opts.agentType  Agent to run
 * @param {string} opts.input      Task prompt / description
 * @param {Object} opts.meta       Extra metadata (chatId, source, etc.)
 * @param {number} opts.priority   Job priority (lower = higher, default 0)
 * @returns {Promise<{taskId: number, jobId: string|null}>}
 */
export async function dispatchTask({ agentType, input, meta = {}, priority = 0 }) {
  // Save task to DB first (without memoryContext — keep DB meta lean)
  const taskId = await insertTask({ agentType, input, meta });

  if (!nexusQueue) {
    console.warn(`[Nexus] Queue indisponible — tâche #${taskId} enregistrée en DB uniquement`);
    return { taskId, jobId: null };
  }

  // Enrich job with long-term memory context (non-blocking on error)
  let enrichedMeta = meta;
  try {
    const memoryContext = await buildMemoryContext(agentType, input);
    if (memoryContext) {
      enrichedMeta = { ...meta, memoryContext };
      console.log(`[Nexus] 🧠 Mémoire injectée pour tâche #${taskId} (${agentType})`);
    }
  } catch (err) {
    console.warn('[Nexus] Memory fetch failed (non-blocking):', err.message);
  }

  const job = await nexusQueue.add(
    agentType,
    { taskId, agentType, input, meta: enrichedMeta },
    { priority }
  );

  console.log(`[Nexus] Tâche #${taskId} dispatchée → job BullMQ #${job.id} (agent: ${agentType})`);
  return { taskId, jobId: job.id };
}
