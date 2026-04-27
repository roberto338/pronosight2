// ══════════════════════════════════════════════
// nexus/worker.js — BullMQ Worker
// Processes nexus-tasks jobs
// ══════════════════════════════════════════════

import { Worker } from 'bullmq';
import { createConnection } from '../queues/victorQueue.js';
import { updateTaskStatus, saveOutput } from './lib/db.js';
import { saveMessage } from './lib/memory.js';
import { runResearch } from './agents/researchAgent.js';
import { runWrite    } from './agents/writeAgent.js';
import { runCode     } from './agents/codeAgent.js';
import { runMonitor  } from './agents/monitorAgent.js';
import { runNotify   } from './agents/notifyAgent.js';
import { runCustom   } from './agents/customAgent.js';
import { runRadar    } from './agents/radarAgent.js';
import { runPlanner  } from './agents/plannerAgent.js';
import { runExec     } from './agents/execAgent.js';
import { runApi      } from './agents/apiAgent.js';
import { runBrowser  } from './agents/browserAgent.js';
import { runFinance  } from './agents/financeAgent.js';
import { runBusiness } from './agents/businessAgent.js';
import { runVision   } from './agents/visionAgent.js';
import { extractAndSave } from './lib/longTermMemory.js';

const AGENT_MAP = {
  research: runResearch,
  write:    runWrite,
  code:     runCode,
  monitor:  runMonitor,
  notify:   runNotify,
  custom:   runCustom,
  radar:    runRadar,
  planner:  runPlanner,
  exec:     runExec,
  api:      runApi,
  browser:  runBrowser,
  finance:  runFinance,
  business: runBusiness,
  vision:   runVision,
};

/**
 * Envoie le résultat sur Telegram si chatId présent dans meta
 */
async function replyToTelegram(chatId, output, agentType, taskId) {
  if (!chatId) return;
  try {
    // Import dynamique pour éviter circular dependency
    const { sendNexusMessage } = await import('./telegramHandler.js');
    const header = `✅ *Nexus #${taskId}* — agent: ${agentType}\n${'─'.repeat(24)}\n`;
    await sendNexusMessage(chatId, header + output);
  } catch (err) {
    console.error('[NexusWorker] Erreur réponse Telegram:', err.message);
  }
}

/**
 * Start the Nexus BullMQ worker.
 * Call once on server startup (after Redis is ready).
 * @returns {Worker|null}
 */
export function startNexusWorker() {
  // Workers use blocking Redis commands (BLMOVE) — they MUST have a
  // dedicated connection, never the shared Queue connection.
  const workerConn = createConnection('worker-nexus');
  if (!workerConn) {
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
        if (meta?.chatId) {
          await replyToTelegram(meta.chatId, `❌ ${errMsg}`, agentType, taskId);
        }
        throw new Error(errMsg);
      }

      try {
        const result = await handler({ taskId, input, meta });
        await saveOutput({ taskId, output: result.output, meta: result.meta || {} });
        await updateTaskStatus(taskId, 'done');
        console.log(`[NexusWorker] ✅ Tâche #${taskId} terminée`);

        // Non-blocking long-term memory extraction
        console.log(`🧠 [NexusWorker] Memory extraction started for task #${taskId}`);
        setImmediate(() => extractAndSave(taskId, agentType, input, result.output || ''));

        // Sauvegarde la réponse en mémoire + Telegram
        if (meta?.chatId) {
          await saveMessage(meta.chatId, 'assistant', result.output, agentType);
          // Business agent sends its own Telegram summary — skip generic reply
          const useSummary = agentType === 'business' && result.meta?.summary;
          await replyToTelegram(meta.chatId, useSummary ? result.meta.summary : result.output, agentType, taskId);
        }

        return { taskId, agentType, outputLength: result.output?.length || 0 };
      } catch (err) {
        console.error(`[NexusWorker] ❌ Tâche #${taskId} échouée:`, err.message);
        await updateTaskStatus(taskId, 'failed', err.message);

        // Notifie Telegram de l'erreur
        if (meta?.chatId) {
          await replyToTelegram(meta.chatId, `❌ Erreur agent ${agentType}: ${err.message}`, agentType, taskId);
        }
        throw err;
      }
    },
    {
      connection:  workerConn,
      concurrency: 4,
      limiter:     { max: 20, duration: 60000 },
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

  console.log('✅ [NexusWorker] Worker nexus-tasks démarré (concurrency: 4)');
  return worker;
}
