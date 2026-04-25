// ══════════════════════════════════════════════
// nexus/nexusCron.js — Scheduled Nexus tasks
// ══════════════════════════════════════════════

import cron from 'node-cron';
import { dispatchTask } from './orchestrator.js';
import { query } from '../db/database.js';
import { consolidate } from './lib/longTermMemory.js';
import { cleanOldMemory } from './lib/memory.js';

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

  // ── Weekly long-term memory consolidation (Sunday 06:00) ──
  cron.schedule('0 6 * * 0', async () => {
    console.log('[NexusCron] Consolidation mémoire long terme...');
    try {
      const ltmResult  = await consolidate();
      const convCleaned = await cleanOldMemory(30); // 30 days for conversational memory
      console.log(`[NexusCron] ✅ LTM: ${ltmResult.total} supprimées | Conv: ${convCleaned} messages purgés`);

      // Notify admin on Telegram
      try {
        const { sendNexusMessage } = await import('./telegramHandler.js');
        const adminId = process.env.TELEGRAM_ADMIN_ID;
        if (adminId) {
          await sendNexusMessage(adminId,
            `🧠 *Nexus Memory — Consolidation hebdo*\n\n` +
            `🗑 Mémoires oubliées: ${ltmResult.forgotten}\n` +
            `🕸 Mémoires obsolètes: ${ltmResult.stale}\n` +
            `💬 Messages anciens purgés: ${convCleaned}\n\n` +
            `_Prochaine consolidation dans 7 jours_`
          );
        }
      } catch { /* ignore Telegram errors in cron */ }
    } catch (err) {
      console.error('[NexusCron] ❌ Erreur consolidation:', err.message);
    }
  });

  console.log('✅ [NexusCron] Cron jobs Nexus démarrés');
}
