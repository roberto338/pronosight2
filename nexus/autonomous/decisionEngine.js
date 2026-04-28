// ══════════════════════════════════════════════
// nexus/autonomous/decisionEngine.js
// 1-Tap Decision System — Roberto Edition
//
// Nexus prepares decisions fully.
// Roberto taps OUI or NON on Telegram.
// That's it.
// ══════════════════════════════════════════════

import { query }   from '../../db/database.js';
import { remember } from '../lib/longTermMemory.js';

// ── DB helpers ───────────────────────────────────

/**
 * Insert a new decision into nexus_decisions.
 *
 * @param {Object} opts
 * @param {string} opts.type         saas | content | outreach | feature | revenue
 * @param {string} opts.title
 * @param {string} opts.description
 * @param {Object} opts.analysis     { market, effort, revenue, compatibility }
 * @param {Array}  opts.actionPlan   list of steps Nexus will execute
 * @param {number} opts.score        1–10
 * @returns {Promise<Object>}  full decision row
 */
export async function createDecision({ type, title, description, analysis = {}, actionPlan = [], score = 5 }) {
  const { rows } = await query(
    `INSERT INTO nexus_decisions (type, title, description, analysis, action_plan, score)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [type, title, description, JSON.stringify(analysis), JSON.stringify(actionPlan), score]
  );
  return rows[0];
}

/**
 * Retrieve a decision by UUID.
 */
export async function getDecision(id) {
  const { rows } = await query('SELECT * FROM nexus_decisions WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * List pending decisions (not yet decided).
 */
export async function getPendingDecisions(limit = 10) {
  const { rows } = await query(
    `SELECT * FROM nexus_decisions
     WHERE status = 'pending'
     ORDER BY score DESC, created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Update decision status + optional result payload.
 */
export async function updateDecision(id, status, result = {}) {
  const { rows } = await query(
    `UPDATE nexus_decisions
     SET status     = $2,
         result     = $3,
         decided_at  = CASE WHEN $2 IN ('approved','ignored') THEN NOW() ELSE decided_at END,
         executed_at = CASE WHEN $2 = 'done'                  THEN NOW() ELSE executed_at END
     WHERE id = $1
     RETURNING *`,
    [id, status, JSON.stringify(result)]
  );
  return rows[0] || null;
}

/**
 * Save the Telegram message_id so we can edit/delete the OUI/NON buttons later.
 */
export async function saveDecisionMsgId(decisionId, messageId) {
  await query(
    'UPDATE nexus_decisions SET telegram_msg_id = $2 WHERE id = $1',
    [decisionId, messageId]
  );
}

// ── Telegram message builder ─────────────────────

/**
 * Build the Telegram decision message text + inline keyboard.
 *
 * @param {Object} decision  Full DB row
 * @returns {{ text: string, reply_markup: Object }}
 */
export function buildDecisionMessage(decision) {
  const analysis = typeof decision.analysis === 'string'
    ? JSON.parse(decision.analysis)
    : (decision.analysis || {});
  const actionPlan = typeof decision.action_plan === 'string'
    ? JSON.parse(decision.action_plan)
    : (decision.action_plan || []);

  const scoreBar  = '█'.repeat(decision.score) + '░'.repeat(10 - decision.score);
  const typeEmoji = { saas: '🏗', content: '✍️', outreach: '📧', feature: '⚡', revenue: '💰' }[decision.type] || '💡';

  let text = `${typeEmoji} *Nexus Decision*\n${'━'.repeat(22)}\n\n`;
  text += `💡 *${decision.title}*\n\n`;
  text += `${decision.description}\n\n`;

  if (Object.keys(analysis).length > 0) {
    text += `📊 *Analyse rapide:*\n`;
    if (analysis.market)         text += `Marché: ${analysis.market}\n`;
    if (analysis.competitors)    text += `Concurrents: ${analysis.competitors}\n`;
    if (analysis.effort)         text += `Effort: ${analysis.effort}\n`;
    if (analysis.revenue)        text += `Revenue estimé: ${analysis.revenue}\n`;
    if (analysis.compatibility)  text += `Stack: ${analysis.compatibility}\n`;
    text += '\n';
  }

  if (actionPlan.length > 0) {
    text += `🛠 *Ce que Nexus va faire si tu dis OUI:*\n`;
    actionPlan.forEach((step, i) => { text += `${i + 1}. ${step}\n`; });
    text += '\n';
  }

  text += `📈 Score: ${decision.score}/10  ${scoreBar}\n`;
  text += `⚡ _Roberto: 0 minutes d'effort requis_`;

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ OUI — Lance',   callback_data: `decision_yes_${decision.id}`   },
      { text: '❌ NON — Ignore',  callback_data: `decision_no_${decision.id}`    },
      { text: '🔄 Plus tard',     callback_data: `decision_later_${decision.id}` },
    ]],
  };

  return { text, reply_markup };
}

// ── Send to Telegram ─────────────────────────────

/**
 * Send a decision card to Roberto via Telegram.
 * Saves the message_id for later button removal.
 *
 * @param {Object} decision
 * @returns {Promise<void>}
 */
export async function sendDecisionToTelegram(decision) {
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN_ID) {
    console.warn('[DecisionEngine] TELEGRAM_ADMIN_ID absent — décision non envoyée');
    return;
  }

  try {
    const { sendNexusMessage, sendNexusKeyboard } = await import('../telegramHandler.js');
    const { text, reply_markup } = buildDecisionMessage(decision);
    const msgId = await sendNexusKeyboard(ADMIN_ID, text, reply_markup);
    if (msgId) await saveDecisionMsgId(decision.id, msgId);
  } catch (err) {
    console.error('[DecisionEngine] Erreur envoi Telegram:', err.message);
  }
}

// ── Execute decision on OUI ──────────────────────

/**
 * Route an approved decision to the correct execution pipeline.
 *
 * @param {string} decisionId  UUID
 */
export async function executeDecision(decisionId) {
  const decision = await getDecision(decisionId);
  if (!decision) return console.error(`[DecisionEngine] Décision introuvable: ${decisionId}`);
  if (decision.status !== 'approved') return;

  await updateDecision(decisionId, 'executing');
  console.log(`[DecisionEngine] Exécution décision #${decisionId} (type: ${decision.type})`);

  try {
    let result = {};

    if (decision.type === 'saas') {
      const { saasFactory } = await import('./saasFactory.js');
      result = await saasFactory(decision);
    }
    else if (decision.type === 'content') {
      const { contentPipeline } = await import('./contentEngine.js');
      result = await contentPipeline(decision);
    }
    else if (decision.type === 'outreach') {
      const { outreachPipeline } = await import('./outreachEngine.js');
      result = await outreachPipeline(decision);
    }
    else if (decision.type === 'feature') {
      const { dispatchTask } = await import('../orchestrator.js');
      const analysis = typeof decision.analysis === 'string'
        ? JSON.parse(decision.analysis) : (decision.analysis || {});
      const { taskId } = await dispatchTask({
        agentType: 'code',
        input:     decision.description,
        meta:      { prompt: decision.description, chatId: process.env.TELEGRAM_ADMIN_ID, source: 'decision' },
      });
      result = { taskId };
    }
    else {
      // Generic: dispatch as custom task
      const { dispatchTask } = await import('../orchestrator.js');
      const { taskId } = await dispatchTask({
        agentType: 'custom',
        input:     decision.description,
        meta:      { prompt: decision.description, chatId: process.env.TELEGRAM_ADMIN_ID, source: 'decision' },
      });
      result = { taskId };
    }

    await updateDecision(decisionId, 'done', result);
    await remember('pattern', `decision_type_preferred_${decision.type}`, `Roberto dit souvent OUI aux décisions de type ${decision.type}`);
    console.log(`[DecisionEngine] ✅ Décision #${decisionId} exécutée`);
  } catch (err) {
    console.error(`[DecisionEngine] Erreur exécution:`, err.message);
    await updateDecision(decisionId, 'failed', { error: err.message });

    // Notify Roberto of failure
    const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
    if (ADMIN_ID) {
      try {
        const { sendNexusMessage } = await import('../telegramHandler.js');
        await sendNexusMessage(ADMIN_ID,
          `❌ *Nexus — Exécution échouée*\n\n` +
          `Décision: _${decision.title}_\n` +
          `Erreur: \`${err.message}\``
        );
      } catch { /* ignore */ }
    }
  }
}

/**
 * Mark a decision as ignored (NON).
 */
export async function markIgnored(decisionId) {
  await updateDecision(decisionId, 'ignored');
  await remember('pattern', 'decision_ignored', `Roberto a ignoré: ${decisionId}`);
}

/**
 * Reschedule a decision for later (+N hours).
 */
export async function rescheduleDecision(decisionId, hours = 24) {
  await query(
    `UPDATE nexus_decisions
     SET created_at = NOW() + INTERVAL '${hours} hours'
     WHERE id = $1`,
    [decisionId]
  );
}

// ── Daily decision generation ────────────────────

/**
 * Pick the top 3 pending decisions and send them to Telegram.
 * Called every morning at 07h30 by cron.
 */
export async function generateDailyDecisions() {
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN_ID) return;

  try {
    const decisions = await getPendingDecisions(3);

    if (decisions.length === 0) {
      // Trigger opportunity detection to generate new ones
      try {
        const { runDetectionCycle } = await import('./opportunityEngine.js');
        await runDetectionCycle();
      } catch (err) {
        console.warn('[DecisionEngine] Pas de décisions pendantes, détection lancée');
      }
      return;
    }

    const { sendNexusMessage } = await import('../telegramHandler.js');
    await sendNexusMessage(ADMIN_ID,
      `🌅 *Bonjour Roberto — ${decisions.length} décision${decisions.length > 1 ? 's' : ''} à valider*\n` +
      `_Tape OUI ou NON sur chaque carte. C'est tout._`
    );

    // Small delay between each card for readability
    for (const decision of decisions) {
      await sendDecisionToTelegram(decision);
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error('[DecisionEngine] generateDailyDecisions error:', err.message);
  }
}

// ── Remove buttons after decision ────────────────

/**
 * Remove inline keyboard buttons from a Telegram message after decision.
 * Called after OUI/NON so the buttons don't stay active.
 */
export async function removeDecisionButtons(decision, statusText) {
  if (!decision.telegram_msg_id) return;
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN_ID) return;

  try {
    const { editNexusMessage } = await import('../telegramHandler.js');
    const { text } = buildDecisionMessage(decision);
    await editNexusMessage(ADMIN_ID, decision.telegram_msg_id, text + `\n\n${statusText}`);
  } catch { /* ignore — message may have been deleted */ }
}
