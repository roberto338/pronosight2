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
  addRecapVeilleJob,
  addBilanPeriodeJob,
  addWeeklyReviewJob,
  addHeartbeatJob,
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
// JOB 3 bis — Bilan des pronos de la veille (10h00 chaque jour)
// ══════════════════════════════════════════════
// 10h et non 7h : les matchs d'Amérique du Sud finissent vers 4-5h (Paris),
// et les sources mettent un moment à publier les scores.
const jobRecapVeille = cron.schedule('0 10 * * *', async () => {
  console.log(`\n📒 [${now()}] Victor — Ajout job bilan de la veille...`);
  await enqueue('recap-veille', addRecapVeilleJob, { source: 'cron-recap' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 3 ter — Bilan de la semaine (lundi 10h20) et du mois (le 1er, 10h40)
// ══════════════════════════════════════════════
// Après le bilan de la veille de 10h : il note les matchs de la nuit, donc
// ceux du dimanche (ou du dernier jour du mois) sont comptés.
const jobBilanSemaine = cron.schedule('20 10 * * 1', async () => {
  console.log(`\n📊 [${now()}] Victor — Ajout job bilan de la semaine...`);
  await enqueue('bilan-periode', addBilanPeriodeJob, { type: 'semaine', source: 'cron-semaine' });
}, { timezone: 'Europe/Paris', scheduled: false });

const jobBilanMois = cron.schedule('40 10 1 * *', async () => {
  console.log(`\n📊 [${now()}] Victor — Ajout job bilan du mois...`);
  await enqueue('bilan-periode', addBilanPeriodeJob, { type: 'mois', source: 'cron-mois' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 4 — Review hebdomadaire (dimanche 01h00)
// ══════════════════════════════════════════════
const jobHebdo = cron.schedule('0 1 * * 0', async () => {
  console.log(`\n📊 [${now()}] Victor — Ajout job review hebdomadaire...`);
  await enqueue('weekly-review', addWeeklyReviewJob, { source: 'cron-hebdo' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 5 — Heartbeat (08h30 chaque jour)
//
// Passe APRÈS le job du matin : si l'analyse de 07h a échoué,
// le heartbeat de 08h30 le signale le jour même. C'est le job qui
// rend toute panne visible en moins de 24h.
// ══════════════════════════════════════════════
const jobHeartbeat = cron.schedule('30 8 * * *', async () => {
  console.log(`\n💓 [${now()}] Victor — Ajout job heartbeat...`);
  await enqueue('heartbeat', addHeartbeatJob, { source: 'cron-heartbeat' });
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// START SCHEDULER
// ══════════════════════════════════════════════

export function startScheduler() {
  console.log('⏰ Démarrage du scheduler Victor (file PostgreSQL)...');
  jobMatin.start();
  console.log('   Job Matin     (07h00 Paris) démarré');
  jobSoir.start();
  console.log('   Job Soir      (13h00 Paris) démarré');
  jobResultats.start();
  console.log('   Job Résultats (23h30 Paris) démarré');
  jobRecapVeille.start();
  console.log('   Job Bilan veille (10h00 Paris) démarré');
  jobBilanSemaine.start();
  console.log('   Job Bilan semaine (Lun 10h20 Paris) démarré');
  jobBilanMois.start();
  console.log('   Job Bilan mois (le 1er, 10h40 Paris) démarré');
  jobHebdo.start();
  console.log('   Job Hebdo     (Dim 01h00 Paris) démarré');
  jobHeartbeat.start();
  console.log('   Job Heartbeat (08h30 Paris) démarré');

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
  console.log('   🌅 07h00 — prematch        → victor_jobs (quotidien)');
  console.log('   💓 08h30 — heartbeat       → victor_jobs (quotidien)');
  console.log('   🌆 13h00 — value           → victor_jobs (quotidien)');
  console.log('   🔍 23h30 — check-results   → victor_jobs (quotidien)');
  console.log('   📊 01h00 — weekly-review   → victor_jobs (dimanche)\n');
}
