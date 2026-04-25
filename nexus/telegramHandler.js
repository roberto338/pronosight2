// ══════════════════════════════════════════════
// nexus/telegramHandler.js
// Interface Telegram pour Nexus
// Reçoit les commandes, dispatche aux agents,
// renvoie les résultats automatiquement
// ══════════════════════════════════════════════

import TelegramBot from 'node-telegram-bot-api';
import { dispatchTask } from './orchestrator.js';
import { saveMessage, clearHistory, getHistory } from './lib/memory.js';

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID; // ID Telegram de l'admin (toi)

let nexusBot = null;

// ── Envoie un message via le bot Nexus ─────────
export async function sendNexusMessage(chatId, text) {
  if (!nexusBot || !chatId) return;
  try {
    // Telegram limite à 4096 chars par message
    if (text.length <= 4000) {
      await nexusBot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } else {
      // Découpe en morceaux
      const chunks = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 4000));
        remaining = remaining.slice(4000);
      }
      for (const chunk of chunks) {
        await nexusBot.sendMessage(chatId, chunk, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        // Petit délai pour éviter rate limit
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (err) {
    console.error('[NexusBot] Erreur envoi message:', err.message);
    // Retry sans Markdown si erreur de parsing
    try {
      await nexusBot.sendMessage(chatId, text.replace(/[*_`\[]/g, ''), {
        disable_web_page_preview: true,
      });
    } catch { /* ignore */ }
  }
}

// ── Vérifie si l'utilisateur est autorisé ──────
function isAuthorized(chatId) {
  if (!ADMIN_ID) return true; // Pas de restriction si ADMIN_ID non défini
  return String(chatId) === String(ADMIN_ID);
}

// ── Dispatch + réponse automatique ─────────────
async function handleCommand(chatId, agentType, input, meta = {}) {
  try {
    // Sauvegarde le message utilisateur en mémoire
    await saveMessage(chatId, 'user', input, agentType);

    await sendNexusMessage(chatId, `⏳ *Nexus* traite ta demande...\n_Agent: ${agentType}_`);

    const { taskId } = await dispatchTask({
      agentType,
      input,
      meta: { ...meta, chatId, source: 'telegram' },
    });

    // Le worker enverra la réponse quand la tâche sera terminée
    console.log(`[NexusBot] Tâche #${taskId} dispatchée pour chatId ${chatId}`);
  } catch (err) {
    console.error('[NexusBot] Erreur dispatch:', err.message);
    await sendNexusMessage(chatId, `❌ Erreur: ${err.message}`);
  }
}

// ── Démarrage du bot Nexus avec polling ─────────
export function startTelegramHandler() {
  if (!TOKEN) {
    console.warn('⚠️  [NexusBot] TELEGRAM_BOT_TOKEN absent — handler non démarré');
    return;
  }

  try {
    nexusBot = new TelegramBot(TOKEN, {
      polling: {
        interval: 2000,
        autoStart: true,
        params: { timeout: 10 },
      },
    });

    console.log('📱 [NexusBot] Handler Telegram démarré (polling)');

    // ── /help ou /aide ──────────────────────────
    nexusBot.onText(/^\/(help|aide)/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      await sendNexusMessage(msg.chat.id,
        `🤖 *NEXUS — Commandes disponibles*\n\n` +
        `🧠 */plan [objectif]* — Plan multi-étapes autonome\n` +
        `_Ex: /plan analyse les matchs du weekend et envoie-moi les meilleurs paris_\n\n` +
        `⚽ */radar [match]* — Analyse paris sportifs\n` +
        `_Ex: /radar PSG vs Lyon_\n\n` +
        `🔴 */live [match]* — Analyse en direct\n` +
        `💎 */value [compétition]* — Chasse les value bets\n\n` +
        `🔍 */research [question]* — Recherche web temps réel\n` +
        `✍️ */write [sujet]* — Rédiger un contenu\n\n` +
        `📊 */status* — État de Nexus\n` +
        `💬 *Message libre* → Agent custom\n\n` +
        `_Nexus tourne 24h/24 sur Render ✅_`
      );
    });

    // ── /radar ──────────────────────────────────
    nexusBot.onText(/^\/radar\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const query = (match[1] || '').trim();
      if (!query) {
        await sendNexusMessage(msg.chat.id, '⚽ Donne-moi un match à analyser.\n_Ex: /radar PSG vs Lyon_');
        return;
      }
      await handleCommand(msg.chat.id, 'radar', query, { mode: 'pre-match' });
    });

    // ── /live (Radar mode live) ──────────────────
    nexusBot.onText(/^\/live\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const query = (match[1] || '').trim();
      if (!query) {
        await sendNexusMessage(msg.chat.id, '🔴 Donne-moi le match en cours.\n_Ex: /live PSG 1-0 Lyon 68e_');
        return;
      }
      await handleCommand(msg.chat.id, 'radar', query, { mode: 'live' });
    });

    // ── /value ───────────────────────────────────
    nexusBot.onText(/^\/value\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const query = (match[1] || '').trim() || 'matchs du jour';
      await handleCommand(msg.chat.id, 'radar', query, { mode: 'value' });
    });

    // ── /research ───────────────────────────────
    nexusBot.onText(/^\/research\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const query = (match[1] || '').trim();
      if (!query) {
        await sendNexusMessage(msg.chat.id, '🔍 Que veux-tu rechercher ?\n_Ex: /research blessés PSG aujourd\'hui_');
        return;
      }
      await handleCommand(msg.chat.id, 'research', query);
    });

    // ── /write ──────────────────────────────────
    nexusBot.onText(/^\/write\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const prompt = (match[1] || '').trim();
      if (!prompt) {
        await sendNexusMessage(msg.chat.id, '✍️ Que veux-tu rédiger ?\n_Ex: /write résumé de la semaine en Ligue 1_');
        return;
      }
      await handleCommand(msg.chat.id, 'write', prompt);
    });

    // ── /api ─────────────────────────────────────
    nexusBot.onText(/^\/api\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const task = (match[1] || '').trim();
      if (!task) {
        await sendNexusMessage(msg.chat.id,
          '🌐 Décris l\'appel API à faire.\n_Ex: /api récupère les cotes du PSG ce weekend depuis Odds API_'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'api', task);
    });

    // ── /browser ──────────────────────────────────
    nexusBot.onText(/^\/browser\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const task = (match[1] || '').trim();
      if (!task) {
        await sendNexusMessage(msg.chat.id,
          '🌐 Que veux-tu récupérer sur le web ?\n_Ex: /browser prix des abonnements Winamax aujourd\'hui_'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'browser', task);
    });

    // ── /exec ────────────────────────────────────
    nexusBot.onText(/^\/exec\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const task = (match[1] || '').trim();
      if (!task) {
        await sendNexusMessage(msg.chat.id,
          '💻 Décris la tâche à exécuter.\n_Ex: /exec calcule les stats de victoire à domicile de la Ligue 1 cette saison_'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'exec', task);
    });

    // ── /plan ────────────────────────────────────
    nexusBot.onText(/^\/plan\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const goal = (match[1] || '').trim();
      if (!goal) {
        await sendNexusMessage(msg.chat.id,
          '🧠 Donne-moi un objectif à planifier.\n_Ex: /plan crée un rapport sur les matchs de cette semaine et envoie-le moi_'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'planner', goal);
    });

    // ── /bankroll ────────────────────────────────
    nexusBot.onText(/^\/bankroll/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      await handleCommand(msg.chat.id, 'finance', 'status bankroll', { action: 'status' });
    });

    // ── /finance ─────────────────────────────────
    nexusBot.onText(/^\/finance\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const input = (match[1] || 'status').trim();
      await handleCommand(msg.chat.id, 'finance', input);
    });

    // ── /report ──────────────────────────────────
    nexusBot.onText(/^\/report\s*(\w+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const period = match[1] || 'all';
      await handleCommand(msg.chat.id, 'finance', `rapport ${period}`, { action: 'report', params: { period } });
    });

    // ── /status ──────────────────────────────────
    nexusBot.onText(/^\/status/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      try {
        const { query } = await import('../db/database.js');
        const { rows } = await query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status='done')    AS done,
            COUNT(*) FILTER (WHERE status='running') AS running,
            COUNT(*) FILTER (WHERE status='failed')  AS failed,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h') AS last24h
          FROM nexus_tasks
        `);
        const s = rows[0];
        await sendNexusMessage(msg.chat.id,
          `📊 *NEXUS — Status*\n\n` +
          `🟢 Serveur : en ligne\n` +
          `📋 Total tâches : ${s.total}\n` +
          `✅ Terminées : ${s.done}\n` +
          `🔄 En cours : ${s.running}\n` +
          `❌ Échouées : ${s.failed}\n` +
          `📅 Dernières 24h : ${s.last24h}\n\n` +
          `_Nexus tourne 24h/24 sur Render_`
        );
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Erreur status: ${err.message}`);
      }
    });

    // ── /clear ───────────────────────────────────
    nexusBot.onText(/^\/clear/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const count = await clearHistory(msg.chat.id);
      await sendNexusMessage(msg.chat.id, `🗑 Mémoire effacée (${count} messages supprimés)`);
    });

    // ── /memory ──────────────────────────────────
    nexusBot.onText(/^\/memory/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const history = await getHistory(msg.chat.id, 6);
      if (history.length === 0) {
        await sendNexusMessage(msg.chat.id, '🧠 Aucun historique pour ce chat.');
        return;
      }
      let txt = `🧠 *Mémoire — ${history.length} derniers messages*\n${'─'.repeat(22)}\n`;
      history.forEach(m => {
        const who = m.role === 'user' ? '👤' : '🤖';
        txt += `${who} ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}\n\n`;
      });
      await sendNexusMessage(msg.chat.id, txt);
    });

    // ── Message libre → agent custom ─────────────
    nexusBot.on('message', async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      if (!msg.text) return;
      if (msg.text.startsWith('/')) return; // Déjà géré par onText

      const text = msg.text.trim();
      if (text.length < 3) return;

      await handleCommand(msg.chat.id, 'custom', text);
    });

    // ── Gestion erreurs polling ───────────────────
    nexusBot.on('polling_error', (err) => {
      if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
        console.warn('[NexusBot] Conflit polling (409) — autre instance active');
      } else {
        console.error('[NexusBot] Polling error:', err.message);
      }
    });

  } catch (err) {
    console.error('[NexusBot] Erreur démarrage:', err.message);
  }
}

export default nexusBot;
