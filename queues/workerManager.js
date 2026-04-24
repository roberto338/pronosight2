// ══════════════════════════════════════════════
// queues/workerManager.js
// Instancie le Worker BullMQ et dispatche par job name
// ══════════════════════════════════════════════

import { Worker } from 'bullmq';
import { redisConnection } from './victorQueue.js';
import { prematchProcessor }    from './workers/prematchWorker.js';
import { valueProcessor }       from './workers/valueWorker.js';
import { liveProcessor }        from './workers/liveWorker.js';
import { checkResults, updateVictorStats, weeklyVictorReview } from '../victor/core.js';
import { discoverNewPatterns }  from '../victor/patterns.js';
import { sendDailyStats }       from '../bot/telegram.js';
import { query }                from '../db/database.js';

// ── Dispatcher principal ───────────────────────
async function processor(job) {
  console.log(`\n⚙️  [Worker] Job reçu : ${job.name} #${job.id}`);

  switch (job.name) {

    case 'prematch':
      return prematchProcessor(job);

    case 'value':
      return valueProcessor(job);

    case 'live':
      return liveProcessor(job);

    case 'check-results': {
      console.log(`\n🔍 [check-results #${job.id}] Vérification résultats...`);
      await job.updateProgress(20);
      await checkResults();
      await job.updateProgress(60);
      await updateVictorStats();
      await job.updateProgress(85);

      // Envoie les stats du jour sur Telegram
      try {
        const { rows } = await query(
          'SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE'
        );
        if (rows.length > 0) {
          await sendDailyStats(rows[0]);
          console.log(`   📊 [check-results #${job.id}] Stats Telegram envoyées`);
        }
      } catch (statErr) {
        console.warn(`   ⚠️  Stats Telegram échouées:`, statErr.message);
      }

      await job.updateProgress(100);
      return { done: true, date: new Date().toISOString().slice(0, 10) };
    }

    case 'weekly-review': {
      console.log(`\n📊 [weekly-review #${job.id}] Review hebdomadaire...`);
      await job.updateProgress(20);
      await discoverNewPatterns();
      await job.updateProgress(60);
      await weeklyVictorReview();
      await job.updateProgress(100);
      return { done: true, week: new Date().toISOString().slice(0, 10) };
    }

    default:
      console.warn(`⚠️  [Worker] Job inconnu : ${job.name} — ignoré`);
      return { skipped: true, reason: `Job name inconnu: ${job.name}` };
  }
}

// ── Création du Worker ─────────────────────────
let workerInstance = null;

export function startWorker() {
  if (!redisConnection) {
    console.warn('⚠️  Worker BullMQ non démarré — REDIS_URL manquante');
    return null;
  }
  if (workerInstance) {
    console.log('⚙️  Worker déjà démarré');
    return workerInstance;
  }

  workerInstance = new Worker('victor-analysis', processor, {
    connection:  redisConnection,
    concurrency: 1, // 1 seul job IA à la fois (rate limits)
    limiter: {
      max:      1,
      duration: 10000, // max 1 job toutes les 10s
    },
  });

  // ── Événements du Worker ───────────────────
  workerInstance.on('completed', (job, result) => {
    console.log(`✅ [Worker] Job terminé : ${job.name} #${job.id}`, JSON.stringify(result).slice(0, 100));
  });

  workerInstance.on('failed', (job, err) => {
    console.error(`❌ [Worker] Job échoué : ${job?.name} #${job?.id} (tentative ${job?.attemptsMade}) — ${err.message}`);
  });

  workerInstance.on('error', (err) => {
    console.error('❌ [Worker] Erreur Worker:', err.message);
  });

  workerInstance.on('stalled', (jobId) => {
    console.warn(`⚠️  [Worker] Job bloqué : #${jobId}`);
  });

  console.log('⚙️  Worker BullMQ démarré — queue: victor-analysis (concurrency: 1)');
  return workerInstance;
}

export function getWorker() {
  return workerInstance;
}

export default startWorker;
