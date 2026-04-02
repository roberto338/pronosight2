// ══════════════════════════════════════════════
// cron/scheduler.js — Jobs planifiés de Victor
// Tous les horaires en heure de Paris (Europe/Paris)
// ══════════════════════════════════════════════

import cron from 'node-cron';
import { runVictor, checkResults, updateVictorStats, weeklyVictorReview } from '../victor/core.js';
import { discoverNewPatterns } from '../victor/patterns.js';

// ── Import du bot Telegram ────────────────────
let broadcastDaily = null;
let sendDailyStats = null;
try {
  const telegramModule = await import('../bot/telegram.js');
  broadcastDaily = telegramModule.broadcastDaily;
  sendDailyStats = telegramModule.sendDailyStats;
  console.log('📱 Bot Telegram chargé');
} catch (err) {
  console.warn('⚠️  bot/telegram.js non disponible:', err.message);
}

// ── Helper : timestamp Paris ──────────────────
function now() {
  return new Date().toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ══════════════════════════════════════════════
// JOB 1 — Analyse du matin (07h00 chaque jour)
// ══════════════════════════════════════════════
const jobMatin = cron.schedule('0 7 * * *', async () => {
  console.log(`\n🌅 [${now()}] Victor — Analyse du matin...`);
  try {
    const result = await runVictor();

    // Broadcast Telegram si disponible
    if (broadcastDaily) {
      try {
        await broadcastDaily(result);
        console.log(`📱 [${now()}] Broadcast Telegram envoyé`);
      } catch (teleErr) {
        console.error(`❌ [${now()}] Erreur broadcast Telegram:`, teleErr.message);
      }
    }

    console.log(`✅ [${now()}] Analyse matin terminée — ${result.events?.length || 0} pronostic(s)`);
  } catch (err) {
    console.error(`❌ [${now()}] Erreur analyse matin:`, err.message);
  }
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 2 — Refresh du soir (13h00 chaque jour)
// ══════════════════════════════════════════════
const jobSoir = cron.schedule('0 13 * * *', async () => {
  console.log(`\n🌆 [${now()}] Victor — Refresh matchs du soir...`);
  try {
    const result = await runVictor();
    console.log(`✅ [${now()}] Refresh terminé — ${result.events?.length || 0} pronostic(s)`);
  } catch (err) {
    console.error(`❌ [${now()}] Erreur refresh soir:`, err.message);
  }
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 3 — Vérification résultats (23h30 chaque jour)
// ══════════════════════════════════════════════
const jobResultats = cron.schedule('30 23 * * *', async () => {
  console.log(`\n🔍 [${now()}] Victor — Vérification résultats...`);
  try {
    await checkResults();
    await updateVictorStats();

    // Envoie les stats du jour sur Telegram
    if (sendDailyStats) {
      try {
        const db = await import('../db/database.js');
        const { rows } = await db.query(
          'SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE'
        );
        if (rows.length > 0) await sendDailyStats(rows[0]);
      } catch (statErr) {
        console.error(`❌ [${now()}] Erreur envoi stats Telegram:`, statErr.message);
      }
    }

    console.log(`✅ [${now()}] Vérification terminée`);
  } catch (err) {
    console.error(`❌ [${now()}] Erreur vérification résultats:`, err.message);
  }
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// JOB 4 — Review hebdomadaire (dimanche 01h00)
// ══════════════════════════════════════════════
const jobHebdo = cron.schedule('0 1 * * 0', async () => {
  console.log(`\n📊 [${now()}] Victor — Review hebdomadaire...`);
  try {
    await discoverNewPatterns();
    await weeklyVictorReview();
    console.log(`✅ [${now()}] Review hebdo terminée`);
  } catch (err) {
    console.error(`❌ [${now()}] Erreur review hebdo:`, err.message);
  }
}, { timezone: 'Europe/Paris', scheduled: false });

// ══════════════════════════════════════════════
// START SCHEDULER
// ══════════════════════════════════════════════

export function startScheduler() {
  console.log('⏰ Démarrage du scheduler Victor...');
  jobMatin.start();
  console.log(`Job Matin (07h00 Paris) démarré. Prochain run: ${jobMatin.nextDates(1).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  jobSoir.start();
  console.log(`Job Soir (13h00 Paris) démarré. Prochain run: ${jobSoir.nextDates(1).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  jobResultats.start();
  console.log(`Job Résultats (23h30 Paris) démarré. Prochain run: ${jobResultats.nextDates(1).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  jobHebdo.start();
  console.log(`Job Hebdo (Dim 01h00 Paris) démarré. Prochain run: ${jobHebdo.nextDates(1).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);

  console.log('\n⏰ Scheduler Victor démarré :');
  console.log('   🌅 07h00 — Analyse du matin       (quotidien)');
  console.log('   🌆 13h00 — Refresh matchs du soir  (quotidien)');
  console.log('   🔍 23h30 — Vérification résultats  (quotidien)');
  console.log('   📊 01h00 — Review hebdomadaire     (dimanche)\n');
}
