// ══════════════════════════════════════════════
// nexus/orchestrator.js — Task dispatcher
// Creates the nexus-tasks BullMQ queue
// ══════════════════════════════════════════════

import { Queue } from 'bullmq';
import { redisConnection } from '../queues/victorQueue.js';
import { insertTask } from './lib/db.js';

// ── BullMQ Queue ───────────────────────────────
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
 * Saves the task in DB first, then enqueues the job.
 *
 * @param {Object} opts
 * @param {string} opts.agentType  'research' | 'write' | 'code' | 'monitor' | 'notify' | 'custom'
 * @param {string} opts.input      Task description / prompt
 * @param {Object} opts.meta       Extra metadata (userId, source, etc.)
 * @param {number} opts.priority   Job priority (lower = higher priority, default 0)
 * @returns {Promise<{taskId: number, jobId: string|null}>}
 */
export async function dispatchTask({ agentType, input, meta = {}, priority = 0 }) {
  const taskId = await insertTask({ agentType, input, meta });

  if (!nexusQueue) {
    console.warn(`[Nexus] Queue indisponible — tâche #${taskId} enregistrée en DB uniquement`);
    return { taskId, jobId: null };
  }

  const job = await nexusQueue.add(
    agentType,
    { taskId, agentType, input, meta },
    { priority }
  );

  console.log(`[Nexus] Tâche #${taskId} dispatchée → job BullMQ #${job.id} (agent: ${agentType})`);
  return { taskId, jobId: job.id };
}
