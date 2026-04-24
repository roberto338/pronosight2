// ══════════════════════════════════════════════
// nexus/agents/notifyAgent.js
// Sends Telegram notifications via existing bot
// ══════════════════════════════════════════════

import { sendAlert } from '../../bot/telegram.js';

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { message?, type?: 'info'|'alert'|'success'|'error' }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runNotify({ input, meta = {} }) {
  const message = meta.message || input;
  const type    = meta.type    || 'info';
  console.log(`[NotifyAgent] Send [${type}]: ${message.slice(0, 80)}`);

  try {
    await sendAlert(message, type);
    const output = `✅ Notification envoyée (type: ${type})\n${message.slice(0, 300)}`;
    return {
      output,
      meta: { agent: 'notify', type, sent: true, length: message.length },
    };
  } catch (err) {
    console.error('[NotifyAgent] Erreur:', err.message);
    return {
      output: `❌ Notification échouée: ${err.message}`,
      meta:   { agent: 'notify', type, sent: false, error: err.message },
    };
  }
}
