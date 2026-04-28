// ══════════════════════════════════════════════
// nexus/autonomous/problemSolver.js
// Proactive problem detection + autonomous fixes.
// Runs every hour via cron.
// ══════════════════════════════════════════════

import { query } from '../../db/database.js';
import fetch      from 'node-fetch';

// ── Pattern matching ─────────────────────────────

export const PROBLEM_PATTERNS = [
  {
    pattern: /\b(error|crash|down|exception|traceback|fatal|failed to|cannot|unable)\b/i,
    category: 'technical_error',
    action:   'debug_and_fix',
    agent:    'code',
  },
  {
    pattern: /\b(comment faire|how to|how do i|guide|tutorial|étapes pour|steps to)\b/i,
    category: 'knowledge_request',
    action:   'research_and_explain',
    agent:    'research',
  },
  {
    pattern: /\b(rédige|écris|génère|write|draft|compose|formule)\b/i,
    category: 'content_request',
    action:   'write_content',
    agent:    'write',
  },
  {
    pattern: /\b(analyse|compare|évalue|evaluate|benchmark|audit|review)\b/i,
    category: 'analysis_request',
    action:   'analyze',
    agent:    'critique',
  },
];

export function detectPatternInText(text) {
  for (const p of PROBLEM_PATTERNS) {
    if (p.pattern.test(text)) return p;
  }
  return null;
}

// ── Database health ───────────────────────────────

export async function checkDatabaseHealth() {
  const problems = [];
  try {
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*)::int AS count FROM nexus_tasks
       WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour'`
    );
    if (count > 5) {
      problems.push({
        severity: 'high', category: 'task_failures', autoFixable: false,
        message:  `${count} tâches ont échoué dans la dernière heure.`,
        action:   'notify_admin',
      });
    }
  } catch (err) { console.error('[ProblemSolver] failed check:', err.message); }

  try {
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*)::int AS count FROM nexus_tasks
       WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`
    );
    if (count > 0) {
      problems.push({
        severity: 'medium', category: 'stuck_tasks', autoFixable: true,
        message:  `${count} tâche(s) bloquées en "running" depuis > 30 min.`,
        action:   'reset_stuck_tasks',
      });
    }
  } catch (err) { console.error('[ProblemSolver] stuck check:', err.message); }

  return problems;
}

// ── Render health ─────────────────────────────────

export async function checkRenderHealth() {
  if (!process.env.RENDER_API_KEY) return [];
  try {
    const resp = await fetch('https://api.render.com/v1/services', {
      headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
    });
    if (!resp.ok) return [];
    const data     = await resp.json();
    const services = Array.isArray(data) ? data : (data.services || []);
    return services
      .filter(s => (s.service?.suspended || s.suspended) === 'suspended')
      .map(s => ({
        severity: 'high', category: 'render_suspended', autoFixable: false,
        message:  `Service Render suspendu: ${s.service?.name || s.name || 'inconnu'}`,
        action:   'notify_admin',
      }));
  } catch (err) {
    console.error('[ProblemSolver] Render check:', err.message);
    return [];
  }
}

// ── Aggregate ─────────────────────────────────────

export async function detectProblems() {
  const [db, render] = await Promise.all([checkDatabaseHealth(), checkRenderHealth()]);
  return [...db, ...render];
}

// ── Auto-fix ──────────────────────────────────────

export async function solveAutonomously(problem) {
  if (problem.action === 'reset_stuck_tasks') {
    try {
      const { rowCount } = await query(
        `UPDATE nexus_tasks SET status='pending', started_at=NULL, updated_at=NOW()
         WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`
      );
      return { solved: true, message: `${rowCount || 0} tâche(s) remises en file.` };
    } catch (err) {
      return { solved: false, message: `Échec reset: ${err.message}` };
    }
  }

  try {
    const { dispatchTask } = await import('../orchestrator.js');
    const { taskId } = await dispatchTask({
      agentType: problem.agent || 'custom',
      input:     problem.message,
      meta:      { source: 'problem_solver', chatId: process.env.TELEGRAM_ADMIN_ID },
      priority:  problem.severity === 'high' ? 1 : 2,
    });
    return { solved: true, dispatched: true, taskId };
  } catch (err) {
    return { solved: false, message: `Dispatch échoué: ${err.message}` };
  }
}

// ── Notify ────────────────────────────────────────

export async function notifyWithSolution(problems) {
  if (!problems.length) return;
  const ADMIN = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN) return;

  try {
    const { sendNexusMessage } = await import('../telegramHandler.js');
    const lines = problems.map(p => {
      const icon = p.severity === 'high' ? '🔴' : p.severity === 'medium' ? '🟡' : '🟢';
      return `${icon} *[${p.category}]* ${p.message}\n_Action: ${p.action}_`;
    });
    await sendNexusMessage(ADMIN, `🚨 *Nexus Problem Solver*\n${'━'.repeat(20)}\n\n${lines.join('\n\n')}`);
  } catch (err) {
    console.error('[ProblemSolver] notify error:', err.message);
  }
}

// ── Main entry ────────────────────────────────────

export async function runProblemSolver() {
  const problems = await detectProblems();
  if (!problems.length) {
    return { problems: 0, solved: 0, notified: 0, summary: 'Aucun problème détecté.' };
  }

  const fixable  = problems.filter(p => p.autoFixable);
  const notify   = problems.filter(p => !p.autoFixable);
  const results  = [];

  for (const p of fixable) {
    const r = await solveAutonomously(p);
    results.push({ category: p.category, ...r });
  }
  if (notify.length > 0) await notifyWithSolution(notify);

  const solved = results.filter(r => r.solved).length;
  console.log(`[ProblemSolver] ${problems.length} problèmes | ${solved} résolus | ${notify.length} notifiés`);
  return { problems: problems.length, solved, notified: notify.length, summary: `${solved}/${problems.length} auto-résolus.` };
}
