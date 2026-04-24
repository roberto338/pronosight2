// ══════════════════════════════════════════════
// queues/workers/liveWorker.js
// Traite les jobs 'live' — analyse à la demande
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';
import { broadcastDaily, sendAlert } from '../../bot/telegram.js';

/**
 * Processeur du job 'live'.
 * Déclenché manuellement via POST /api/victor/refresh
 * ou par un event live (webhook futur).
 * @param {import('bullmq').Job} job
 */
export async function liveProcessor(job) {
  const { triggeredBy = 'manual', matchId = null } = job.data || {};
  console.log(`\n⚡ [live #${job.id}] Analyse live déclenchée par: ${triggeredBy}`);

  await job.updateProgress(10);

  // ── Analyse Victor ─────────────────────────
  const result = await runVictor();

  await job.updateProgress(80);

  const nbPronostics = result?.events?.length || 0;
  console.log(`   ✅ [live #${job.id}] ${nbPronostics} pronostic(s) live générés`);

  // ── Broadcast Telegram (alertes live) ─────
  if (nbPronostics > 0) {
    await broadcastDaily(result);
    console.log(`   📱 [live #${job.id}] Telegram envoyé`);
  }

  await job.updateProgress(100);

  return {
    date:         result?.date,
    nbPronostics,
    triggeredBy,
    matchId,
    telegramSent: nbPronostics > 0,
    generatedAt:  new Date().toISOString(),
  };
}
