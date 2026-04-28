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
//
// v2.2: Auto-routing — custom tasks whose payload
// contains business-idea keywords are transparently
// re-routed to critiqueAgent.
// ══════════════════════════════════════════════

import { insertTask }           from './lib/db.js';
import { hasCritiqueKeywords }  from './agents/critiqueAgent.js';

// Kept as null for backwards compatibility with routes.js status endpoint
export const nexusQueue = null;

/**
 * Dispatch a task — inserts into nexus_tasks as 'pending'.
 * The DB-based worker will pick it up within ~15 seconds.
 *
 * Auto-routing: if agentType is 'custom' and the payload
 * contains business-idea keywords, the task is silently
 * re-routed to 'critique' (Roberto framework).
 *
 * @param {Object} opts
 * @param {string} opts.agentType  Agent to run
 * @param {string} opts.input      Task prompt / description
 * @param {Object} opts.meta       Extra metadata (chatId, source, etc.)
 * @param {number} opts.priority   Unused (kept for API compatibility)
 * @returns {Promise<{taskId: number, jobId: null}>}
 */
export async function dispatchTask({ agentType, input, meta = {}, priority = 0 }) {
  let resolvedType = agentType;

  // Auto-detect business ideas in custom tasks → critiqueAgent
  if (agentType === 'custom') {
    const textToCheck = (meta.prompt || input || '');
    if (hasCritiqueKeywords(textToCheck)) {
      resolvedType = 'critique';
      console.log(`[Nexus] 💡 Mots-clés idée détectés → re-routage automatique vers critiqueAgent`);
    }
  }

  const taskId = await insertTask({ agentType: resolvedType, input, meta });
  console.log(`[Nexus] Tâche #${taskId} enregistrée → agent: ${resolvedType}`);
  return { taskId, jobId: null };
}
