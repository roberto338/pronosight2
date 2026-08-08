// ══════════════════════════════════════════════
// victor/mortalite.js — Enregistre la cause de mort du process
//
// Depuis le 03/08, les jobs prematch et value meurent en cours
// d'exécution et sont marqués « Job orphelin — process interrompu ».
// Ce message dit CE QUI s'est passé, jamais POURQUOI.
//
// Trois hypothèses ont été testées et écartées :
//   - lenteur du pipeline  → exécutions mesurées à 13-39 s
//   - saturation mémoire   → pic à 69 Mo sur 512 disponibles
//   - endormissement       → les jobs légers passent en 2 s aux mêmes heures
//
// Le projet n'avait AUCUN gestionnaire de process : une exception non
// capturée ou un SIGTERM tuait le service sans laisser de trace.
// Ce module inscrit la cause dans le job en cours avant de mourir,
// pour que le heartbeat du lendemain la rapporte.
// ══════════════════════════════════════════════

import { query } from '../db/database.js';

let dejaInstalle = false;

/** Inscrit la cause sur les jobs en cours, puis rend la main. */
async function consigner(cause, detail) {
  const message = `${cause} — ${String(detail || '').slice(0, 300)}`;
  console.error(`\n💀 [Mortalité] ${message}\n`);
  try {
    const { rowCount } = await query(
      `UPDATE victor_jobs
       SET error = $1, updated_at = NOW()
       WHERE status = 'running'`,
      [message]
    );
    if (rowCount > 0) console.error(`💀 [Mortalité] cause inscrite sur ${rowCount} job(s) en cours`);
  } catch (err) {
    console.error('💀 [Mortalité] écriture impossible:', err.message);
  }
}

export function installerSurveillanceProcess() {
  if (dejaInstalle) return;
  dejaInstalle = true;

  // Node arrête le process sur promesse rejetée non gérée.
  process.on('unhandledRejection', async (raison) => {
    await consigner('Promesse rejetée non gérée', raison?.stack || raison?.message || raison);
    process.exit(1);
  });

  process.on('uncaughtException', async (err) => {
    await consigner('Exception non capturée', err?.stack || err?.message || err);
    process.exit(1);
  });

  // Render envoie SIGTERM lors d'un redéploiement, d'une mise en veille
  // ou d'un dépassement de quota. Distinguer ce cas d'un plantage change
  // complètement le diagnostic.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      await consigner(`Arrêt demandé par la plateforme (${signal})`,
        `uptime ${Math.round(process.uptime())}s, mémoire ${Math.round(process.memoryUsage().rss / 1048576)} Mo`);
      process.exit(0);
    });
  }

  // Avertissement mémoire : si la limite Render approche, on le saura
  // avant de se faire tuer sans explication.
  const SEUIL_MO = Number(process.env.SEUIL_MEMOIRE_MO || 400);
  setInterval(() => {
    const mo = Math.round(process.memoryUsage().rss / 1048576);
    if (mo > SEUIL_MO) console.warn(`⚠️  [Mortalité] mémoire élevée : ${mo} Mo`);
  }, 60_000).unref();

  console.log('    Surveillance:   ✅ causes de mort tracées (crash, SIGTERM, mémoire)');
}

export default installerSurveillanceProcess;
