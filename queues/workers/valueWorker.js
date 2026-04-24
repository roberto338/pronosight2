// ══════════════════════════════════════════════
// queues/workers/valueWorker.js
// Traite les jobs 'value' — refresh value bets 13h00
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';

/**
 * Processeur du job 'value'.
 * Lancé à 13h00 — refresh des matchs du soir,
 * focus value betting.
 * @param {import('bullmq').Job} job
 */
export async function valueProcessor(job) {
  console.log(`\n🌆 [value #${job.id}] Démarrage analyse value betting...`);

  await job.updateProgress(10);

  // ── Analyse Victor (même pipeline, contexte soir) ──
  const result = await runVictor();

  await job.updateProgress(90);

  const nbPronostics = result?.events?.length || 0;
  console.log(`   ✅ [value #${job.id}] ${nbPronostics} pronostic(s) value générés`);

  // Pas de broadcast Telegram pour le refresh du soir
  // (évite le spam — le broadcast principal est fait le matin)

  await job.updateProgress(100);

  return {
    date:        result?.date,
    nbPronostics,
    generatedAt: new Date().toISOString(),
  };
}
