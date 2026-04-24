// ══════════════════════════════════════════════
// nexus/nexusCron.js — Scheduled Nexus tasks
// ══════════════════════════════════════════════

import cron from 'node-cron';
import { dispatchTask } from './orchestrator.js';
import { query } from '../db/database.js';

export function startNexusCron() {
  // ── Nettoyage tâches anciennes (chaque nuit à 3h15) ──
  cron.schedule('15 3 * * *', async () => {
    console.log('[NexusCron] Nettoyage des tâches > 30 jours...');
    try {
      const r1 = await query(`DELETE FROM nexus_outputs WHERE created_at < NOW() - INTERVAL '30 days'`);
      const r2 = await query(`DELETE FROM nexus_tasks   WHERE created_at < NOW() - INTERVAL '30 days'`);
      console.log(`[NexusCron] ✅ Nettoyage: ${r2.rowCount} tâches, ${r1.rowCount} outputs supprimés`);
    } catch (err) {
      console.error('[NexusCron] ❌ Erreur nettoyage:', err.message);
    }
  });

  // ── Health check DB toutes les heures ──
  cron.schedule('0 * * * *', async () => {
    try {
      await dispatchTask({
        agentType: 'monitor',
        input:     'hourly-health-check',
        meta:      { type: 'db', source: 'cron' },
        priority:  10,
      });
    } catch (err) {
      console.error('[NexusCron] Monitor dispatch error:', err.message);
    }
  });

  console.log('✅ [NexusCron] Cron jobs Nexus démarrés');
}
