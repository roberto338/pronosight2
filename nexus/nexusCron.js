// ══════════════════════════════════════════════
// nexus/nexusCron.js — Full Nexus cron schedule
// v2.0: proactivity + briefing + reports + review
// ══════════════════════════════════════════════

import cron    from 'node-cron';
import { dispatchTask }         from './orchestrator.js';
import { query }                from '../db/database.js';
import { consolidate }          from './lib/longTermMemory.js';
import { cleanOldMemory }       from './lib/memory.js';
import { runProactivityEngine } from './proactivity.js';
import { weeklyReview }         from './selfImprovement.js';
import {
  generateDailyBriefing,
  generateWeeklyProjectReport,
} from './projects.js';

// ── In-memory map of dynamic routine cron tasks ─
const _routineTasks = new Map(); // routineId → cron.ScheduledTask

/**
 * Register a single routine from DB into node-cron.
 */
export function scheduleRoutine(routine) {
  if (!routine.active || !routine.cron_expression) return;
  // Unschedule first if already registered
  if (_routineTasks.has(routine.id)) {
    _routineTasks.get(routine.id).stop();
    _routineTasks.delete(routine.id);
  }
  try {
    const task = cron.schedule(routine.cron_expression, async () => {
      console.log(`[NexusCron] Routine #${routine.id} (${routine.name}) firing...`);
      try {
        await dispatchTask({
          agentType: routine.task_type,
          input:     routine.payload?.prompt || routine.payload?.query || routine.name,
          meta:      { ...routine.payload, chatId: process.env.TELEGRAM_ADMIN_ID, source: 'routine' },
        });
        await query(
          'UPDATE nexus_routines SET last_run = NOW() WHERE id = $1',
          [routine.id]
        );
      } catch (err) {
        console.error(`[NexusCron] Routine #${routine.id} error:`, err.message);
      }
    });
    _routineTasks.set(routine.id, task);
    console.log(`[NexusCron] Routine "${routine.name}" (${routine.cron_expression}) registered`);
  } catch (err) {
    console.error(`[NexusCron] Invalid cron for routine #${routine.id}: ${err.message}`);
  }
}

/**
 * Unregister a routine.
 */
export function unscheduleRoutine(routineId) {
  if (_routineTasks.has(routineId)) {
    _routineTasks.get(routineId).stop();
    _routineTasks.delete(routineId);
    console.log(`[NexusCron] Routine #${routineId} unscheduled`);
  }
}

/**
 * Load all active routines from DB and register them.
 */
async function loadDynamicRoutines() {
  try {
    const { rows } = await query('SELECT * FROM nexus_routines WHERE active = true');
    for (const routine of rows) scheduleRoutine(routine);
    if (rows.length > 0) console.log(`[NexusCron] ${rows.length} routine(s) chargée(s)`);
  } catch (err) {
    console.error('[NexusCron] Erreur chargement routines:', err.message);
  }
}

/**
 * Start all Nexus cron jobs.
 * Call once after DB is ready.
 */
export function startNexusCron() {
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

  async function sendAdmin(msg) {
    if (!ADMIN_ID) return;
    try {
      const { sendNexusMessage } = await import('./telegramHandler.js');
      await sendNexusMessage(ADMIN_ID, msg);
    } catch { /* ignore */ }
  }

  // ── Every 5 min — process pending monitor tasks ──
  cron.schedule('*/5 * * * *', async () => {
    try {
      await dispatchTask({
        agentType: 'monitor',
        input:     'quick-health-check',
        meta:      { type: 'db', source: 'cron', chatId: null },
        priority:  10,
      });
    } catch { /* silent */ }
  });

  // ── Every hour — proactivity engine ─────────────
  cron.schedule('0 * * * *', async () => {
    try {
      await runProactivityEngine();
    } catch (err) {
      console.error('[NexusCron] Proactivity error:', err.message);
    }
  });

  // ── Daily 08:00 — morning briefing ──────────────
  cron.schedule('0 8 * * *', async () => {
    console.log('[NexusCron] Daily briefing...');
    try {
      const briefing = await generateDailyBriefing();
      await sendAdmin(briefing);
    } catch (err) {
      console.error('[NexusCron] Briefing error:', err.message);
    }
  });

  // ── Monday 08:00 — weekly project reports ───────
  cron.schedule('0 8 * * 1', async () => {
    console.log('[NexusCron] Weekly project reports...');
    try {
      await generateWeeklyProjectReport();
    } catch (err) {
      console.error('[NexusCron] Weekly report error:', err.message);
    }
  });

  // ── Sunday 06:00 — memory consolidation ─────────
  cron.schedule('0 6 * * 0', async () => {
    console.log('[NexusCron] Memory consolidation...');
    try {
      const ltm   = await consolidate();
      const conv  = await cleanOldMemory(30);
      await sendAdmin(
        `🧠 *Nexus — Consolidation hebdo*\n\n` +
        `🗑 Mémoires oubliées: ${ltm.forgotten}\n` +
        `🕸 Obsolètes: ${ltm.stale}\n` +
        `💬 Conv purgés: ${conv}\n\n` +
        `_Prochaine consolidation dans 7 jours_`
      );
    } catch (err) {
      console.error('[NexusCron] Consolidation error:', err.message);
    }
  });

  // ── Sunday 07:00 — self-improvement review ───────
  cron.schedule('0 7 * * 0', async () => {
    console.log('[NexusCron] Self-improvement review...');
    try {
      await weeklyReview();
    } catch (err) {
      console.error('[NexusCron] Self-improvement error:', err.message);
    }
  });

  // ── Daily 03:15 — old task cleanup ──────────────
  cron.schedule('15 3 * * *', async () => {
    console.log('[NexusCron] DB cleanup...');
    try {
      const r1 = await query(`DELETE FROM nexus_outputs WHERE created_at < NOW() - INTERVAL '30 days'`);
      const r2 = await query(`DELETE FROM nexus_tasks   WHERE created_at < NOW() - INTERVAL '30 days'`);
      console.log(`[NexusCron] ✅ Cleanup: ${r2.rowCount} tâches, ${r1.rowCount} outputs supprimés`);
    } catch (err) {
      console.error('[NexusCron] Cleanup error:', err.message);
    }
  });

  // ── Load dynamic routines from DB ───────────────
  loadDynamicRoutines();

  console.log('✅ [NexusCron] All cron jobs started (v2.0)');
}
