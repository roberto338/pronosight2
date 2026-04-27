// ══════════════════════════════════════════════
// nexus/proactivity.js
// Proactivity engine — runs every hour via cron
// Monitors projects, detects patterns, sends alerts
// ══════════════════════════════════════════════

import { query }         from '../db/database.js';
import { listMemories, remember } from './lib/longTermMemory.js';
import { PROJECTS }      from './projects.js';

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

// In-memory debounce: avoid spamming same alert within N hours
const _notifiedAt = new Map();
function canNotify(key, cooldownHours = 6) {
  const last = _notifiedAt.get(key);
  if (last && Date.now() - last < cooldownHours * 3_600_000) return false;
  _notifiedAt.set(key, Date.now());
  return true;
}

async function notify(msg) {
  if (!ADMIN_ID) return;
  try {
    const { sendNexusMessage } = await import('./telegramHandler.js');
    await sendNexusMessage(ADMIN_ID, msg);
  } catch { /* ignore */ }
}

// ── Check 1: Project URL health ─────────────────
async function checkProjectHealth() {
  const monitorable = Object.values(PROJECTS).filter(p => p.monitor && p.url);

  await Promise.allSettled(monitorable.map(async (project) => {
    const key = `health_${project.name.toLowerCase().replace(/\s/g, '_')}`;
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 8000);
      const t0         = Date.now();

      const resp = await fetch(project.url, {
        signal:  controller.signal,
        method:  'HEAD',
        headers: { 'User-Agent': 'Nexus-Monitor/2.0' },
      });
      clearTimeout(timer);

      const ms = Date.now() - t0;

      if (resp.status >= 500) {
        if (canNotify(`down_${key}`, 2)) {
          await notify(`🔴 *${project.name} est DOWN*\nHTTP ${resp.status} — ${project.url}`);
        }
      } else if (ms > 5000) {
        if (canNotify(`slow_${key}`, 4)) {
          await notify(`⚠️ *${project.name} répond lentement*\nLatence: ${ms}ms — ${project.url}`);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (canNotify(`timeout_${key}`, 2)) {
          await notify(`🔴 *${project.name} — Timeout* (>8s)\n${project.url}`);
        }
      }
      // Ignore other network errors (DNS, SSL, etc.)
    }
  }));
}

// ── Check 2: Opportunity detection (max every 6h) ─
async function checkOpportunities() {
  // Rate-limit via LTM
  const opps = await listMemories('pattern');
  const lastCheck = opps.find(m => m.key === 'last_opportunity_scan');

  if (lastCheck) {
    const elapsed = Date.now() - new Date(lastCheck.last_seen).getTime();
    if (elapsed < 6 * 3_600_000) return; // Skip if checked < 6h ago
  }

  await remember('pattern', 'last_opportunity_scan', new Date().toISOString());

  const activeProjects = Object.values(PROJECTS)
    .filter(p => p.status === 'active' || p.status === 'in-development')
    .map(p => p.name).join(', ');

  try {
    const { runResearch } = await import('./agents/researchAgent.js');
    const result = await runResearch({
      input: `Veille stratégique rapide pour entrepreneur tech avec ces projets: ${activeProjects}. Trouve: 3 tendances IA récentes pertinentes, 1 outil/API qui pourrait être utile, 1 opportunité de marché à saisir. Sois concis.`,
      meta:  { chatId: null },
    });

    if (result.output?.length > 150 && canNotify('opportunity', 6)) {
      await notify(
        `💡 *Nexus — Veille opportunités*\n${'─'.repeat(22)}\n${result.output.slice(0, 1000)}`
      );
    }
  } catch (err) {
    console.error('[Proactivity] Opportunity error:', err.message);
  }
}

// ── Check 3: Pattern-based suggestions ──────────
async function checkPatterns() {
  try {
    // Detect repeated task types (3+ times in 7 days)
    const { rows: agentCounts } = await query(`
      SELECT agent_type, COUNT(*)::int AS count
      FROM nexus_tasks
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND status = 'done'
      GROUP BY agent_type
      HAVING COUNT(*) >= 3
      ORDER BY count DESC
      LIMIT 3
    `);

    for (const row of agentCounts) {
      const sugKey = `auto_suggest_${row.agent_type}`;
      if (canNotify(sugKey, 72)) { // max once per 3 days per agent type
        await remember('feedback', sugKey, `Agent ${row.agent_type} utilisé ${row.count}× cette semaine`);
        await notify(
          `🔄 *Nexus — Pattern détecté*\n\nTu utilises \`${row.agent_type}\` fréquemment (${row.count}× cette semaine).\nVeux-tu créer une routine automatique ?\n_/routine add pour automatiser_`
        );
      }
    }

    // Detect stale tasks (pending > 30 min)
    const { rows: stale } = await query(`
      SELECT COUNT(*)::int AS count FROM nexus_tasks
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '30 minutes'
    `);

    if ((stale[0]?.count || 0) > 0 && canNotify('stale_tasks', 2)) {
      await notify(`⚠️ *${stale[0].count} tâche(s) bloquée(s)* en attente depuis >30min. Worker OK ?`);
    }
  } catch (err) {
    console.error('[Proactivity] Pattern check error:', err.message);
  }
}

// ── Check 4: Scheduled follow-ups ───────────────
async function checkFollowUps() {
  try {
    const mems    = await listMemories('pattern');
    const followUps = mems.filter(m => m.key.startsWith('followup_'));
    const now     = new Date();

    for (const fu of followUps) {
      try {
        const data = JSON.parse(fu.value);
        if (!data.date || new Date(data.date) > now) continue;

        console.log(`[Proactivity] Executing follow-up: ${fu.key}`);
        const { dispatchTask } = await import('./orchestrator.js');
        await dispatchTask({
          agentType: data.agentType || 'custom',
          input:     data.task || `Follow-up: ${fu.key}`,
          meta:      { chatId: ADMIN_ID, source: 'proactivity_followup' },
        });

        // Mark done
        const { forget } = await import('./lib/longTermMemory.js');
        await forget(fu.key);
        await remember('feedback', `${fu.key}_completed`, `Exécuté le ${now.toISOString().slice(0, 10)}`);
      } catch { /* ignore malformed follow-up */ }
    }
  } catch (err) {
    console.error('[Proactivity] Follow-up error:', err.message);
  }
}

// ── Main export ──────────────────────────────────
export async function runProactivityEngine() {
  console.log('[Proactivity] Engine tick...');
  await Promise.allSettled([
    checkProjectHealth(),
    checkPatterns(),
    checkFollowUps(),
    checkOpportunities(),  // internally rate-limited to 6h
  ]);
}
