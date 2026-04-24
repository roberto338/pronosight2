// ══════════════════════════════════════════════
// cron/scheduler.js — Jobs planifiés de Victor
// Tous les horaires en heure de Paris (Europe/Paris)
// Les crons ajoutent des jobs dans BullMQ au lieu
// d'appeler Victor directement (asynchrone + retry)
// ══════════════════════════════════════════════

import cron from 'node-cron';
import {
  addPrematchJob,
  addValueJob,
  addCheckResultsJob,
  addWeeklyReviewJob,
} from '../queues/victorQueue.js';

// ── Helper : timestamp Paris ──────────────────
function now() {
  return new Date().toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ── Helper : ajoute un job avec log ───────────
async function enqueue(name, addFn, data = {}) {
  try {
    const job = await addFn(data);
    console.log(`✅ [${now()}] Job '${name}' ajouté → #${job.id}`);
  } catch (err) {
    console.error(`❌ [${now()}] Impossible d'ajouter le job '${name}':`, err.message);
  }
}

// ══════════════════════════════════════════════
// JOB 1 — Analyse du matin (07h00 chaque jour)
// ══════════════════════════════════════════════
const jobMatin = cron.schedule('0 7 * * *', async () => {
  console.log(`\n🌅 [${now()}] Victor — Ajout job analyse du matin...`);
  await enqueue('prematch', addPrematchJob, { source: 'cron-matin' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 2 — Refresh du soir (13h00 chaque jour)
// ══════════════════════════════════════════════
const jobSoir = cron.schedule('0 13 * * *', async () => {
  console.log(`\n🌆 [${now()}] Victor — Ajout job refresh soir...`);
  await enqueue('value', addValueJob, { source: 'cron-soir' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 3 — Vérification résultats (23h30 chaque jour)
// ══════════════════════════════════════════════
const jobResultats = cron.schedule('30 23 * * *', async () => {
  console.log(`\n🔍 [${now()}] Victor — Ajout job vérification résultats...`);
  await enqueue('check-results', addCheckResultsJob, { source: 'cron-resultats' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 4 — Review hebdomadaire (dimanche 01h00)
// ══════════════════════════════════════════════
const jobHebdo = cron.schedule('0 1 * * 0', async () => {
  console.log(`\n📊 [${now()}] Victor — Ajout job review hebdomadaire...`);
  await enqueue('weekly-review', addWeeklyReviewJob, { source: 'cron-hebdo' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// START SCHEDULER
// ══════════════════════════════════════════════

export function startScheduler() {
  console.log('⏰ Démarrage du scheduler Victor (BullMQ)...');
  jobMatin.start();
  console.log('   Job Matin     (07h00 Paris) démarré');
  jobSoir.start();
  console.log('   Job Soir      (13h00 Paris) démarré');
  jobResultats.start();
  console.log('   Job Résultats (23h30 Paris) démarré');
  jobHebdo.start();
  console.log('   Job Hebdo     (Dim 01h00 Paris) démarré');

  // ── Keepalive Render free tier ────────────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/api/ping`);
        console.log(`💓 [${now()}] Keepalive ping OK`);
      } catch (e) {
        console.warn(`⚠️  [${now()}] Keepalive ping échoué:`, e.message);
      }
    }, 10 * 60 * 1000);
    console.log(`   💓 Keepalive actif → ${RENDER_URL}/api/ping (toutes les 10min)`);
  } else {
    console.log('   ⚠️  RENDER_EXTERNAL_URL non définie — keepalive désactivé');
  }

  console.log('\n⏰ Scheduler Victor démarré :');
  console.log('   🌅 07h00 — prematch        → BullMQ (quotidien)');
  console.log('   🌆 13h00 — value           → BullMQ (quotidien)');
  console.log('   🔍 23h30 — check-results   → BullMQ (quotidien)');
  console.log('   📊 01h00 — weekly-review   → BullMQ (dimanche)\n');
}
