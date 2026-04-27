// ══════════════════════════════════════════════
// nexus/orchestrator.js — Task dispatcher
//
// v2.1: BullMQ removed from Nexus.
// dispatchTask() is now a pure DB insert.
// Jobs are picked up by the DB-based poller in
// worker.js (FOR UPDATE SKIP LOCKED).
//
// Redis is no longer used for Nexus task routing,
// which eliminates the ~12k requests/min BullMQ
// idle overhead that exhausted the Upstash quota.
// ══════════════════════════════════════════════

import { insertTask } from './lib/db.js';

// Kept as null for backwards compatibility with routes.js status endpoint
export const nexusQueue = null;

/**
 * Dispatch a task — inserts into nexus_tasks as 'pending'.
 * The DB-based worker will pick it up within ~15 seconds.
 *
 * @param {Object} opts
 * @param {string} opts.agentType  Agent to run
 * @param {string} opts.input      Task prompt / description
 * @param {Object} opts.meta       Extra metadata (chatId, source, etc.)
 * @param {number} opts.priority   Unused (kept for API compatibility)
 * @returns {Promise<{taskId: number, jobId: null}>}
 */
export async function dispatchTask({ agentType, input, meta = {}, priority = 0 }) {
  const taskId = await insertTask({ agentType, input, meta });
  console.log(`[Nexus] Tâche #${taskId} enregistrée → agent: ${agentType}`);
  return { taskId, jobId: null };
}
