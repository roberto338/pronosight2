// ══════════════════════════════════════════════
// queues/workers/prematchWorker.js
// Traite les jobs 'prematch' — analyse du matin
// ══════════════════════════════════════════════

import { runVictor } from '../../victor/core.js';
import { broadcastDaily, sendAlert } from '../../bot/telegram.js';

/**
 * Processeur du job 'prematch'.
 * Lancé à 07h00 chaque jour.
 * @param {{id: number, name: string, data: object, updateProgress: (p: number) => Promise<void>}} job
 */
export async function prematchProcessor(job) {
  console.log(`\n🌅 [prematch #${job.id}] Démarrage analyse pré-match...`);

  await job.updateProgress(10);

  // ── Analyse Victor complète ────────────────
  const result = await runVictor();

  await job.updateProgress(80);

  const nbPronostics = result?.events?.length || 0;
  const nbRejets     = result?.rejets?.length || 0;
  console.log(`   ✅ [prematch #${job.id}] ${nbPronostics} pronostic(s) retenus, ${nbRejets} rejeté(s) — moteur ${result?.moteur || '?'}`);

  // ── Broadcast Telegram ─────────────────────
  // Zéro pronostic n'est PAS un cas normal à passer sous silence :
  // c'est ainsi que 3 semaines de panne sont passées inaperçues.
  let telegramSent = false;
  if (nbPronostics > 0) {
    await broadcastDaily(result);
    telegramSent = true;
    console.log(`   📱 [prematch #${job.id}] Telegram envoyé`);
  } else {
    const raison = result?.raison || 'cause inconnue';
    console.warn(`   ⚠️  [prematch #${job.id}] Aucun pronostic généré — ${raison}`);
    await sendAlert(`Victor n'a généré aucun pronostic ce matin (${raison}).`, 'danger')
      .catch(e => console.error('   ❌ Alerte Telegram impossible:', e.message));
  }

  await job.updateProgress(100);

  return {
    date:          result?.date,
    nbPronostics,
    nbRejets,
    moteur:        result?.moteur ?? null,
    rejets:        result?.rejets ?? [],
    telegramSent,
    raison:        result?.raison ?? null,
    generatedAt:   new Date().toISOString(),
  };
}
