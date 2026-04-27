// ══════════════════════════════════════════════
// nexus/selfImprovement.js
// Weekly self-review — every Sunday 07:00
// Analyzes performance, generates suggestions,
// saves top insights to long-term memory
// ══════════════════════════════════════════════

import { query }          from '../db/database.js';
import { callAI }         from './lib/ai.js';
import { remember, listMemories } from './lib/longTermMemory.js';

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

export async function weeklyReview() {
  console.log('[SelfImprovement] Weekly review starting...');

  // ── 1. Pull last 7 days task stats ────────────
  const [statsRes, agentRes, failRes] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE status = 'done')::int                         AS success,
        COUNT(*) FILTER (WHERE status = 'failed')::int                       AS failed,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000))::int AS avg_ms
      FROM nexus_tasks
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),
    query(`
      SELECT agent_type, COUNT(*)::int AS count
      FROM nexus_tasks
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY agent_type
      ORDER BY count DESC
      LIMIT 6
    `),
    query(`
      SELECT agent_type, LEFT(error, 80) AS err, COUNT(*)::int AS count
      FROM nexus_tasks
      WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'failed'
      GROUP BY agent_type, LEFT(error, 80)
      ORDER BY count DESC
      LIMIT 5
    `),
  ]).catch(() => ([
    { rows: [{}] },
    { rows: [] },
    { rows: [] },
  ]));

  const stats     = statsRes.rows[0] || {};
  const total     = stats.total     || 0;
  const success   = stats.success   || 0;
  const failed    = stats.failed    || 0;
  const avgMs     = stats.avg_ms    || 0;
  const successPct = total > 0 ? Math.round(success / total * 100) : 0;

  // ── 2. Get feedback memories ──────────────────
  const feedbackMems = await listMemories('feedback');
  const feedbackTxt  = feedbackMems.slice(0, 8)
    .map(m => `- ${m.key}: ${m.value}`)
    .join('\n') || 'Aucun feedback enregistré';

  // ── 3. Ask Claude for improvement suggestions ──
  const analysisPrompt =
    `Analyse ces métriques de performance de Nexus (semaine écoulée):\n\n` +
    `Tâches: ${total} | Réussite: ${successPct}% | Échouées: ${failed} | Temps moyen: ${avgMs}ms\n\n` +
    `Agents utilisés:\n${agentRes.rows.map(r => `- ${r.agent_type}: ${r.count} tâches`).join('\n') || 'Aucun'}\n\n` +
    `Erreurs fréquentes:\n${failRes.rows.map(r => `- ${r.agent_type}: "${r.err}" (${r.count}×)`).join('\n') || 'Aucune'}\n\n` +
    `Feedback mémorisé:\n${feedbackTxt}\n\n` +
    `Donne 3 suggestions CONCRÈTES pour améliorer Nexus. Chaque suggestion: 1 titre + 1 ligne d'action.`;

  let suggestions = '';
  try {
    suggestions = await callAI(
      'Tu es un expert en amélioration de systèmes IA autonomes. Sois précis et actionnable.',
      analysisPrompt,
      { maxTokens: 600, temperature: 0.4 }
    );
  } catch {
    suggestions = '⚠️ Analyse indisponible cette semaine.';
  }

  // ── 4. Save review summary to memory ──────────
  const reviewKey = `weekly_review_${new Date().toISOString().slice(0, 10)}`;
  await remember('feedback', reviewKey,
    `Taux succès: ${successPct}%, ${total} tâches, top agent: ${agentRes.rows[0]?.agent_type || '—'}`
  ).catch(() => {});

  // ── 5. Build and send report ──────────────────
  const agentList = agentRes.rows
    .map(r => `• \`${r.agent_type}\`: ${r.count}`)
    .join('\n') || '—';

  const report =
    `🧠 *Nexus Weekly Review*\n${'━'.repeat(22)}\n\n` +
    `📊 Tâches: *${total}* | ✅ *${successPct}%* | ❌ *${failed}*\n` +
    `⚡ Temps moyen: *${avgMs}ms*\n` +
    `🏆 Top agent: *${agentRes.rows[0]?.agent_type || '—'}*\n\n` +
    `📈 *Par agent:*\n${agentList}\n\n` +
    `💡 *Suggestions:*\n${suggestions.slice(0, 1200)}\n\n` +
    `${'━'.repeat(22)}\n_Prochaine review dans 7 jours_`;

  if (ADMIN_ID) {
    try {
      const { sendNexusMessage } = await import('./telegramHandler.js');
      await sendNexusMessage(ADMIN_ID, report);
    } catch (err) {
      console.error('[SelfImprovement] Telegram send error:', err.message);
    }
  }

  console.log('[SelfImprovement] Weekly review done.');
  return report;
}
