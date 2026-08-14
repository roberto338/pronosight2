// ══════════════════════════════════════════════
// queues/workers/valueWorker.js
// Traite les jobs 'value' — refresh value bets 13h00
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';
import { broadcastDaily } from '../../bot/telegram.js';

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
  const nouveaux     = result?.nouveaux || [];
  console.log(`   ✅ [value #${job.id}] ${nbPronostics} retenu(s), dont ${nouveaux.length} nouveau(x)`);

  // ── Diffusion des SEULS ajouts ────────────────────────────────
  // Ce job ne rediffusait rien, « pour éviter le spam ». Le raisonnement
  // valait quand il réanalysait toute la journée. Depuis majExistants,
  // il ne peut plus qu'AJOUTER — et ces ajouts n'étaient jamais annoncés.
  // Le 14/08, Sporting CP a été ajouté à 13h20 sans que personne le sache.
  let telegramSent = false;
  if (nouveaux.length > 0) {
    await broadcastDaily({ ...result, events: nouveaux, complement: true });
    telegramSent = true;
    console.log(`   📱 [value #${job.id}] ${nouveaux.length} ajout(s) diffusé(s)`);
  }

  await job.updateProgress(100);

  return {
    date:        result?.date,
    nbPronostics,
    nbNouveaux:  nouveaux.length,
    telegramSent,
    generatedAt: new Date().toISOString(),
  };
}
