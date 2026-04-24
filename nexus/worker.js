// ══════════════════════════════════════════════
// nexus/worker.js — BullMQ Worker
// Processes nexus-tasks jobs
// ══════════════════════════════════════════════

import { Worker } from 'bullmq';
import { redisConnection } from '../queues/victorQueue.js';
import { updateTaskStatus, saveOutput } from './lib/db.js';
import { runResearch } from './agents/researchAgent.js';
import { runWrite    } from './agents/writeAgent.js';
import { runCode     } from './agents/codeAgent.js';
import { runMonitor  } from './agents/monitorAgent.js';
import { runNotify   } from './agents/notifyAgent.js';
import { runCustom   } from './agents/customAgent.js';

const AGENT_MAP = {
  research: runResearch,
  write:    runWrite,
  code:     runCode,
  monitor:  runMonitor,
  notify:   runNotify,
  custom:   runCustom,
};

/**
 * Start the Nexus BullMQ worker.
 * Call once on server startup (after Redis is ready).
 * @returns {Worker|null}
 */
export function startNexusWorker() {
  if (!redisConnection) {
    console.warn('⚠️  [NexusWorker] Redis indisponible — worker non démarré');
    return null;
  }

  const worker = new Worker(
    'nexus-tasks',
    async (job) => {
      const { taskId, agentType, input, meta } = job.data;
      console.log(`[NexusWorker] Job #${job.id} — agent:${agentType} task:#${taskId}`);

      await updateTaskStatus(taskId, 'running');

      const handler = AGENT_MAP[agentType];
      if (!handler) {
        const errMsg = `Agent inconnu: ${agentType}`;
        await updateTaskStatus(taskId, 'failed', errMsg);
        throw new Error(errMsg);
      }

      try {
        const result = await handler({ taskId, input, meta });
        await saveOutput({ taskId, output: result.output, meta: result.meta || {} });
        await updateTaskStatus(taskId, 'done');
        console.log(`[NexusWorker] ✅ Tâche #${taskId} terminée`);
        return { taskId, agentType, outputLength: result.output?.length || 0 };
      } catch (err) {
        console.error(`[NexusWorker] ❌ Tâche #${taskId} échouée:`, err.message);
        await updateTaskStatus(taskId, 'failed', err.message);
        throw err;
      }
    },
    {
      connection:  redisConnection,
      concurrency: 2,
      limiter:     { max: 10, duration: 60000 }, // max 10 jobs/min
    }
  );

  worker.on('completed', (job) =>
    console.log(`[NexusWorker] ✅ Job #${job.id} done`)
  );
  worker.on('failed', (job, err) =>
    console.error(`[NexusWorker] ❌ Job #${job?.id} failed:`, err.message)
  );
  worker.on('error', (err) =>
    console.error('[NexusWorker] Worker error:', err.message)
  );

  console.log('✅ [NexusWorker] Worker nexus-tasks démarré (concurrency: 2)');
  return worker;
}
