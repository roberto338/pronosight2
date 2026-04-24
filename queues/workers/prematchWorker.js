// ══════════════════════════════════════════════
// queues/workers/prematchWorker.js
// Traite les jobs 'prematch' — analyse du matin
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';
import { broadcastDaily } from '../../bot/telegram.js';

/**
 * Processeur du job 'prematch'.
 * Lancé à 07h00 chaque jour.
 * @param {import('bullmq').Job} job
 */
export async function prematchProcessor(job) {
  console.log(`\n🌅 [prematch #${job.id}] Démarrage analyse pré-match...`);

  await job.updateProgress(10);

  // ── Analyse Victor complète ────────────────
  const result = await runVictor();

  await job.updateProgress(80);

  const nbPronostics = result?.events?.length || 0;
  console.log(`   ✅ [prematch #${job.id}] ${nbPronostics} pronostic(s) générés`);

  // ── Broadcast Telegram ─────────────────────
  if (nbPronostics > 0) {
    await broadcastDaily(result);
    console.log(`   📱 [prematch #${job.id}] Telegram envoyé`);
  } else {
    console.warn(`   ⚠️  [prematch #${job.id}] Aucun pronostic — Telegram non envoyé`);
  }

  await job.updateProgress(100);

  return {
    date:          result?.date,
    nbPronostics,
    telegramSent:  nbPronostics > 0,
    generatedAt:   new Date().toISOString(),
  };
}
