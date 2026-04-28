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

// ── Autonomous v3.0 modules ─────────────────────
import { runDetectionCycle }      from './autonomous/opportunityEngine.js';
import { generateDailyDecisions, getPendingDecisions, sendDecisionToTelegram } from './autonomous/decisionEngine.js';
import { generateWeeklyCalendar } from './autonomous/contentEngine.js';
import { runFollowUps }           from './autonomous/outreachEngine.js';
import { sendDailyRevenueReport, syncRevenueToDb } from './autonomous/revenueTracker.js';
import { runProblemSolver }       from './autonomous/problemSolver.js';

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

  // ── Every 30 min — DB health check ─────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      await dispatchTask({
        agentType: 'monitor',
        input:     'health-check',
        meta:      { type: 'db', source: 'cron', chatId: null },
        priority:  10,
      });
    } catch { /* silent */ }
  });

  // ── Every 3 hours — proactivity engine ──────────
  cron.schedule('0 */3 * * *', async () => {
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

  // ════════════════════════════════════════════════
  // AUTONOMOUS ENTREPRENEUR v3.0 — cron schedule
  // ════════════════════════════════════════════════

  // ── Daily 06:30 — generate decisions from LTM ──
  cron.schedule('30 6 * * *', async () => {
    console.log('[NexusCron] Autonomous: generating daily decisions...');
    try {
      const decisions = await generateDailyDecisions();
      console.log(`[NexusCron] ${decisions?.length || 0} decisions generated`);
    } catch (err) {
      console.error('[NexusCron] generateDailyDecisions error:', err.message);
    }
  });

  // ── Daily 07:30 — send pending decisions to Telegram ──
  cron.schedule('30 7 * * *', async () => {
    console.log('[NexusCron] Autonomous: sending pending decisions...');
    try {
      const pending = await getPendingDecisions();
      if (pending.length === 0) return;
      await sendAdmin(`🎯 *${pending.length} décision(s) t'attendent !*\n_Tape /decisions pour les voir._`);
      for (const d of pending.slice(0, 3)) {
        await sendDecisionToTelegram(d);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (err) {
      console.error('[NexusCron] send decisions error:', err.message);
    }
  });

  // ── Daily 07:45 — revenue sync + daily report ──
  cron.schedule('45 7 * * *', async () => {
    console.log('[NexusCron] Autonomous: revenue report...');
    try {
      await syncRevenueToDb();
      await sendDailyRevenueReport();
    } catch (err) {
      console.error('[NexusCron] revenue report error:', err.message);
    }
  });

  // ── Daily 10:00 — outreach follow-ups ───────────
  cron.schedule('0 10 * * *', async () => {
    console.log('[NexusCron] Autonomous: outreach follow-ups...');
    try {
      const result = await runFollowUps();
      if (result.total > 0) {
        console.log(`[NexusCron] Follow-ups: ${result.followUpsSent}/${result.total} envoyés`);
      }
    } catch (err) {
      console.error('[NexusCron] follow-ups error:', err.message);
    }
  });

  // ── Daily 12:00 — opportunity detection (noon) ──
  cron.schedule('0 12 * * *', async () => {
    console.log('[NexusCron] Autonomous: opportunity scan (noon)...');
    try {
      const decisions = await runDetectionCycle();
      if (decisions.length > 0) {
        await sendAdmin(`🔍 *Nexus a détecté ${decisions.length} nouvelle(s) opportunité(s) !*\n_Tape /decisions pour décider._`);
      }
    } catch (err) {
      console.error('[NexusCron] opportunity scan (noon) error:', err.message);
    }
  });

  // ── Daily 18:00 — opportunity detection (evening) ──
  cron.schedule('0 18 * * *', async () => {
    console.log('[NexusCron] Autonomous: opportunity scan (evening)...');
    try {
      const decisions = await runDetectionCycle();
      if (decisions.length > 0) {
        await sendAdmin(`🌆 *${decisions.length} nouvelle(s) opportunité(s) détectée(s) ce soir !*\n_Tape /decisions pour voir._`);
      }
    } catch (err) {
      console.error('[NexusCron] opportunity scan (evening) error:', err.message);
    }
  });

  // ── Sunday 20:00 — generate weekly content calendar ──
  cron.schedule('0 20 * * 0', async () => {
    console.log('[NexusCron] Autonomous: weekly content calendar...');
    try {
      const result = await generateWeeklyCalendar();
      if (result?.generated > 0) {
        await sendAdmin(
          `📅 *Calendrier contenu de la semaine prêt !*\n` +
          `${result.generated} posts générés\n` +
          `${result.scheduled} programmés via Buffer\n\n` +
          `_Contenu pour: ${(result.projects || []).join(', ')}_`
        );
      }
    } catch (err) {
      console.error('[NexusCron] weekly calendar error:', err.message);
    }
  });

  // ── Daily 22:00 — problem solver health check ──
  cron.schedule('0 22 * * *', async () => {
    console.log('[NexusCron] Autonomous: problem solver...');
    try {
      const result = await runProblemSolver();
      if (result.problems > 0) {
        console.log(`[NexusCron] ProblemSolver: ${result.summary}`);
      }
    } catch (err) {
      console.error('[NexusCron] problem solver error:', err.message);
    }
  });

  // ── Daily 00:30 — autonomous daily summary ──────
  cron.schedule('30 0 * * *', async () => {
    console.log('[NexusCron] Autonomous: daily summary...');
    try {
      const { rows: decisions } = await query(
        `SELECT status, COUNT(*)::int AS n FROM nexus_decisions
         WHERE created_at > NOW() - INTERVAL '24h' GROUP BY status`
      ).catch(() => ({ rows: [] }));
      const { rows: saas } = await query(
        `SELECT COUNT(*)::int AS n FROM nexus_saas WHERE created_at > NOW() - INTERVAL '24h'`
      ).catch(() => ({ rows: [{ n: 0 }] }));
      const { rows: outreach } = await query(
        `SELECT COUNT(*)::int AS n FROM nexus_outreach WHERE sent_at > NOW() - INTERVAL '24h'`
      ).catch(() => ({ rows: [{ n: 0 }] }));

      const approved  = decisions.find(r => r.status === 'approved')?.n  || 0;
      const ignored   = decisions.find(r => r.status === 'ignored')?.n   || 0;
      const pending   = decisions.find(r => r.status === 'pending')?.n   || 0;
      const saasCount = saas[0]?.n || 0;
      const emails    = outreach[0]?.n || 0;

      if (approved + ignored + saasCount + emails > 0) {
        await sendAdmin(
          `🌙 *Récap 24h — Nexus Autonomous*\n${'━'.repeat(20)}\n\n` +
          `🎯 Décisions: ${approved} approuvées | ${ignored} ignorées | ${pending} en attente\n` +
          `🚀 SaaS lancés: ${saasCount}\n` +
          `📧 Emails envoyés: ${emails}\n\n` +
          `_Nexus continue de tourner — à demain !_`
        );
      }
    } catch (err) {
      console.error('[NexusCron] daily summary error:', err.message);
    }
  });

  // ── Load dynamic routines from DB ───────────────
  loadDynamicRoutines();

  console.log('✅ [NexusCron] All cron jobs started (v3.0 — Autonomous Entrepreneur)');
}
