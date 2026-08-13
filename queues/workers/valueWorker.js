// ══════════════════════════════════════════════
// queues/workers/valueWorker.js
// Traite les jobs 'value' — refresh value bets 13h00
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';

/**
 * Processeur du job 'value'.
 * Lancé à 13h00 — refresh des matchs du soir,
 * focus value betting.
 * @param {{id: number, name: string, data: object, updateProgress: (p: number) => Promise<void>}} job
 */
export async function valueProcessor(job) {
  console.log(`\n🌆 [value #${job.id}] Démarrage analyse value betting...`);

  await job.updateProgress(10);

  // ── Analyse Victor (même pipeline, contexte soir) ──
  // majExistants:false — le pronostic du matin a déjà été diffusé sur
  // Telegram. Le job du soir peut AJOUTER des matchs (rencontres tardives),
  // jamais réécrire ce que les abonnés ont déjà reçu.
  const result = await runVictor({
    onEtape: (pct) => job.updateProgress(pct),
    majExistants: false,
  });

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
