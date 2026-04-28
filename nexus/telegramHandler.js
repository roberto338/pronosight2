// ══════════════════════════════════════════════
// nexus/telegramHandler.js
// Interface Telegram pour Nexus
// Reçoit les commandes, dispatche aux agents,
// renvoie les résultats automatiquement
// ══════════════════════════════════════════════

import TelegramBot from 'node-telegram-bot-api';
import { dispatchTask }                   from './orchestrator.js';
import { saveMessage, clearHistory, getHistory } from './lib/memory.js';
import { remember, forget, listMemories } from './lib/longTermMemory.js';
import { parseNaturalCommand, jarvisTaskToDispatch } from './jarvis.js';
import { generateDailyBriefing }          from './projects.js';
import { query }                          from '../db/database.js';
import { scheduleRoutine, unscheduleRoutine } from './nexusCron.js';

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

// ── Envoie un message avec clavier inline ─────
export async function sendNexusKeyboard(chatId, text, reply_markup) {
  if (!nexusBot || !chatId) return null;
  try {
    const msg = await nexusBot.sendMessage(chatId, text, {
      parse_mode:               'Markdown',
      disable_web_page_preview: true,
      reply_markup,
    });
    return msg.message_id;
  } catch (err) {
    console.error('[NexusBot] sendNexusKeyboard error:', err.message);
    return null;
  }
}

// ── Édite un message existant (retire les boutons) ──
export async function editNexusMessage(chatId, messageId, text) {
  if (!nexusBot || !chatId || !messageId) return;
  try {
    await nexusBot.editMessageText(text, {
      chat_id:                  chatId,
      message_id:               messageId,
      parse_mode:               'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    // 400 "message is not modified" is normal — ignore silently
    if (!err.message?.includes('not modified')) {
      console.error('[NexusBot] editNexusMessage error:', err.message);
    }
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

    // ── Helper: handle vision (photo) messages ──
    async function handleVisionMessage(msg, instruction) {
      try {
        const photo    = msg.photo[msg.photo.length - 1]; // highest res
        const fileLink = await nexusBot.getFileLink(photo.file_id);
        await sendNexusMessage(msg.chat.id, `👁 *Vision* — Analyse en cours...\n_${instruction.slice(0, 60)}_`);
        await handleCommand(msg.chat.id, 'vision', instruction, {
          imageUrl: fileLink,
          instruction,
        });
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Vision erreur: ${err.message}`);
      }
    }

    // ── /help ou /aide ──────────────────────────
    nexusBot.onText(/^\/(help|aide)/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      await sendNexusMessage(msg.chat.id,
        `🤖 *NEXUS v2.0 — Jarvis Mode*\n\n` +
        `💬 *Message libre* — Jarvis comprend et agit\n` +
        `_Ex: "vérifie si PronoSight tourne"_\n` +
        `_Ex: "j'ai une idée d'app de coaching IA"_\n\n` +
        `${'─'.repeat(24)}\n` +
        `🔍 */critique [idée]* — Critique business 8 étapes + score /25\n` +
        `🚀 */plan [objectif]* — Plan multi-agents autonome\n` +
        `🏢 */business [idée]* — MVP complet en 10min\n` +
        `👁 */vision [instruction]* — Analyse d'image\n` +
        `🔎 */research [question]* — Recherche web temps réel\n` +
        `✍️ */write [sujet]* — Rédaction structurée\n` +
        `💻 */exec [tâche]* — Exécution code Node.js\n` +
        `🌐 */browser [site]* — Extraction web\n` +
        `🔌 */api [description]* — Appel API externe\n\n` +
        `${'─'.repeat(24)}\n` +
        `☀️ */briefing* — Briefing quotidien immédiat\n` +
        `🎯 */goal [add|list|done|update]* — Objectifs\n` +
        `⚙️ */routine [add|list|stop]* — Automatisations\n\n` +
        `${'─'.repeat(24)}\n` +
        `⚽ */radar* | 🔴 */live* | 💎 */value* | 💰 */finance*\n\n` +
        `${'─'.repeat(24)}\n` +
        `🔮 */memories* | 💾 */remember* | 🗑 */forget*\n` +
        `🧠 */memory* | 🧹 */clear* | 📊 */status*\n\n` +
        `${'─'.repeat(24)}\n` +
        `🤖 *Autonomous v3.0*\n` +
        `🎯 */decisions* — Décisions en attente (OUI/NON)\n` +
        `💰 */revenue* — Rapport revenus Stripe temps réel\n\n` +
        `_Nexus v3.0 — Autonomous Entrepreneur 24h/24 ✅_`
      );
    });

    // ── /business ───────────────────────────────
    nexusBot.onText(/^\/business\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const idea = (match[1] || '').trim();
      if (!idea) {
        await sendNexusMessage(msg.chat.id,
          '🏢 Donne-moi une idée de business.\n_Ex: /business application de méditation IA pour managers_'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'business', idea, { idea, market: 'francophone', budget: 0 });
    });

    // ── /critique — Roberto business critique framework ──
    nexusBot.onText(/^\/critique\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const idea = (match[1] || '').trim();
      if (!idea) {
        await sendNexusMessage(msg.chat.id,
          '🔍 *Critique Business — Roberto Edition*\n\n' +
          'Donne-moi une idée, un projet ou une fonctionnalité à analyser.\n\n' +
          '_Ex: /critique app de coaching sportif IA pour la diaspora haïtienne_\n' +
          '_Ex: /critique SaaS de gestion de devis pour artisans francophones_\n\n' +
          '→ Analyse 8 étapes : verdict, diagnostic 3D, concurrence, finances, acquisition, MVP, risques, score /25'
        );
        return;
      }
      await handleCommand(msg.chat.id, 'critique', idea, { idea, prompt: idea });
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

    // ── /memories — long-term knowledge ──────────
    nexusBot.onText(/^\/memories/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const memories = await listMemories();
      if (memories.length === 0) {
        await sendNexusMessage(msg.chat.id, '🧠 Aucune mémoire long terme enregistrée.\n_Nexus apprend au fil des tâches._');
        return;
      }
      const grouped = {};
      for (const m of memories) {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m);
      }
      const ICONS = { project:'📁', preference:'⚙️', pattern:'🔄', person:'👤', fact:'📌', feedback:'💬' };
      let txt = `🧠 *Nexus Memory — ${memories.length} entrées*\n${'─'.repeat(24)}\n\n`;
      for (const [cat, items] of Object.entries(grouped)) {
        txt += `${ICONS[cat] || '▸'} *${cat.toUpperCase()}* (${items.length})\n`;
        for (const m of items.slice(0, 4)) {
          const val = m.value.length > 80 ? m.value.slice(0, 77) + '...' : m.value;
          txt += `  • \`${m.key}\`: ${val}\n`;
        }
        if (items.length > 4) txt += `  _...et ${items.length - 4} autre(s)_\n`;
        txt += '\n';
      }
      txt += `_Commandes: /remember, /forget_`;
      await sendNexusMessage(msg.chat.id, txt);
    });

    // ── /remember <[catégorie]> <clé> <valeur> ──
    nexusBot.onText(/^\/remember\s+([\s\S]+)/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const args  = match[1].trim();
      const parts = args.split(' ');
      const VALID = ['project', 'preference', 'pattern', 'person', 'fact', 'feedback'];

      let category, key, value;
      if (VALID.includes(parts[0]) && parts.length >= 3) {
        [category, key, ...rest] = parts;
        value = rest.join(' ');
      } else if (parts.length >= 2) {
        category = 'fact';
        [key, ...rest] = parts;
        value = rest.join(' ');
      } else {
        await sendNexusMessage(msg.chat.id,
          '🧠 Usage: `/remember [catégorie] clé valeur`\n\n' +
          '_Catégories: project, preference, pattern, person, fact, feedback_\n\n' +
          '_Ex: /remember project pronosight Stack Node.js + PostgreSQL Neon_\n' +
          '_Ex: /remember prefer\\_markdown true_'
        );
        return;
      }
      const ok = await remember(category, key, value);
      if (ok) {
        await sendNexusMessage(msg.chat.id, `🧠 Mémorisé ✅\n_[${category}] \`${key}\`: ${value}_`);
      } else {
        await sendNexusMessage(msg.chat.id, `❌ Catégorie invalide. Utilise: ${VALID.join(', ')}`);
      }
    });

    // ── /forget <clé> ────────────────────────────
    nexusBot.onText(/^\/forget\s+(.+)/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const key   = match[1].trim();
      const found = await forget(key);
      await sendNexusMessage(msg.chat.id, found
        ? `🗑 Mémoire \`${key}\` oubliée.`
        : `❓ Aucune mémoire trouvée pour la clé \`${key}\``
      );
    });

    // ── /briefing — daily briefing on demand ─────
    nexusBot.onText(/^\/briefing/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      await sendNexusMessage(msg.chat.id, '⏳ Génération du briefing...');
      try {
        const briefing = await generateDailyBriefing();
        await sendNexusMessage(msg.chat.id, briefing);
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Erreur briefing: ${err.message}`);
      }
    });

    // ── /goal — goals management ─────────────────
    nexusBot.onText(/^\/goal\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const args = (match[1] || '').trim();
      const parts = args.split(' ');
      const action = parts[0]?.toLowerCase();

      if (!action || action === 'list') {
        const { rows } = await query(
          `SELECT id, title, progress, deadline FROM nexus_goals WHERE status='active' ORDER BY deadline ASC NULLS LAST`
        ).catch(() => ({ rows: [] }));
        if (rows.length === 0) {
          await sendNexusMessage(msg.chat.id, '🎯 Aucun objectif actif.\n_/goal add <titre> [date] pour en créer un_');
          return;
        }
        let txt = `🎯 *Objectifs actifs (${rows.length})*\n${'─'.repeat(22)}\n\n`;
        rows.forEach(g => {
          const bar      = '█'.repeat(Math.floor(g.progress / 10)) + '░'.repeat(10 - Math.floor(g.progress / 10));
          const deadline = g.deadline ? ` — _${new Date(g.deadline).toLocaleDateString('fr-FR')}_` : '';
          txt += `*#${g.id}* ${g.title}${deadline}\n${g.progress}% ${bar}\n\n`;
        });
        await sendNexusMessage(msg.chat.id, txt);
        return;
      }

      if (action === 'add') {
        const rest  = parts.slice(1);
        // Try to detect a date at the end (YYYY-MM-DD or DD/MM/YYYY)
        const dateRx = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/;
        const dm     = rest.join(' ').match(dateRx);
        const title  = dm ? rest.join(' ').replace(dm[0], '').trim() : rest.join(' ').trim();
        const ddl    = dm ? dm[0].replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1') : null;
        if (!title) {
          await sendNexusMessage(msg.chat.id, '🎯 Usage: `/goal add <titre> [YYYY-MM-DD]`');
          return;
        }
        const { rows } = await query(
          `INSERT INTO nexus_goals (title, deadline) VALUES ($1, $2) RETURNING id`,
          [title, ddl]
        );
        await sendNexusMessage(msg.chat.id, `🎯 Objectif #${rows[0].id} ajouté ✅\n_${title}${ddl ? ` — deadline: ${ddl}` : ''}_`);
        return;
      }

      if (action === 'done' || action === 'update') {
        const id       = parseInt(parts[1]);
        const progress = action === 'update' ? parseInt(parts[2]) : 100;
        const status   = progress >= 100 ? 'done' : 'active';
        if (isNaN(id)) {
          await sendNexusMessage(msg.chat.id, `_Usage: /goal ${action} <id> [0-100]_`);
          return;
        }
        await query(
          `UPDATE nexus_goals SET progress=$1, status=$2, updated_at=NOW() WHERE id=$3`,
          [Math.min(100, Math.max(0, progress)), status, id]
        );
        await sendNexusMessage(msg.chat.id, `🎯 Objectif #${id} mis à jour — ${progress}%${status === 'done' ? ' ✅ Terminé !' : ''}`);
        return;
      }

      await sendNexusMessage(msg.chat.id,
        `🎯 *Commandes /goal:*\n` +
        `• /goal list\n• /goal add <titre> [date]\n• /goal update <id> <0-100>\n• /goal done <id>`
      );
    });

    // ── /routine — dynamic task automation ───────
    nexusBot.onText(/^\/routine\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const args   = (match[1] || '').trim();
      const parts  = args.split(' ');
      const action = parts[0]?.toLowerCase();

      const INTERVAL_MAP = {
        hourly:  '0 * * * *',
        daily:   '0 9 * * *',
        morning: '0 8 * * *',
        evening: '0 20 * * *',
        weekly:  '0 9 * * 1',
        nightly: '0 23 * * *',
      };

      if (!action || action === 'list') {
        const { rows } = await query(
          `SELECT id, name, cron_expression, task_type, active, last_run FROM nexus_routines ORDER BY created_at DESC`
        ).catch(() => ({ rows: [] }));
        if (rows.length === 0) {
          await sendNexusMessage(msg.chat.id, '⚙️ Aucune routine.\n_/routine add <interval> <agent> <tâche>_\n_Intervals: hourly, daily, morning, evening, weekly_');
          return;
        }
        let txt = `⚙️ *Routines (${rows.length})*\n${'─'.repeat(22)}\n\n`;
        rows.forEach(r => {
          const st   = r.active ? '🟢' : '🔴';
          const last = r.last_run ? new Date(r.last_run).toLocaleDateString('fr-FR') : 'jamais';
          txt += `${st} *#${r.id}* ${r.name}\n_${r.cron_expression}_ • ${r.task_type} • dernière: ${last}\n\n`;
        });
        await sendNexusMessage(msg.chat.id, txt);
        return;
      }

      if (action === 'add') {
        // /routine add <interval> <agent_type> <prompt...>
        const interval  = parts[1]?.toLowerCase();
        const agentType = parts[2]?.toLowerCase();
        const prompt    = parts.slice(3).join(' ');
        const cronExpr  = INTERVAL_MAP[interval];

        if (!cronExpr || !agentType || !prompt) {
          await sendNexusMessage(msg.chat.id,
            `⚙️ Usage: \`/routine add <interval> <agent> <tâche>\`\n\n` +
            `Intervals: ${Object.keys(INTERVAL_MAP).join(', ')}\n` +
            `Agents: research, write, custom, exec, browser...\n\n` +
            `_Ex: /routine add daily research dernières news IA_`
          );
          return;
        }

        const { rows } = await query(
          `INSERT INTO nexus_routines (name, cron_expression, task_type, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
          [`${interval} ${agentType}`, cronExpr, agentType, JSON.stringify({ prompt })]
        );
        scheduleRoutine(rows[0]);
        await sendNexusMessage(msg.chat.id,
          `⚙️ Routine #${rows[0].id} créée ✅\n_${interval} — ${agentType}: ${prompt.slice(0, 80)}_`
        );
        return;
      }

      if (action === 'stop' || action === 'pause') {
        const id = parseInt(parts[1]);
        if (isNaN(id)) { await sendNexusMessage(msg.chat.id, '_Usage: /routine stop <id>_'); return; }
        await query(`UPDATE nexus_routines SET active = false WHERE id = $1`, [id]);
        unscheduleRoutine(id);
        await sendNexusMessage(msg.chat.id, `⚙️ Routine #${id} arrêtée.`);
        return;
      }

      if (action === 'start' || action === 'resume') {
        const id = parseInt(parts[1]);
        if (isNaN(id)) { await sendNexusMessage(msg.chat.id, '_Usage: /routine start <id>_'); return; }
        const { rows } = await query(`UPDATE nexus_routines SET active = true WHERE id = $1 RETURNING *`, [id]);
        if (rows[0]) scheduleRoutine(rows[0]);
        await sendNexusMessage(msg.chat.id, `⚙️ Routine #${id} réactivée.`);
        return;
      }

      await sendNexusMessage(msg.chat.id,
        `⚙️ *Commandes /routine:*\n• /routine list\n• /routine add <interval> <agent> <tâche>\n• /routine stop <id>\n• /routine start <id>`
      );
    });

    // ── /vision — image analysis (also handles photos) ──
    nexusBot.onText(/^\/vision\s*([\s\S]+)?/, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      const instruction = (match[1] || 'Analyse cette image en détail').trim();
      if (!msg.photo?.length) {
        await sendNexusMessage(msg.chat.id,
          '👁 Envoie une image avec `/vision <instruction>` en légende.\n_Ex: envoie une capture d\'écran avec la légende: /vision analyse ce dashboard_'
        );
        return;
      }
      await handleVisionMessage(msg, instruction);
    });

    // ── Photos sent directly (with or without /vision) ──
    nexusBot.on('photo', async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const instruction = msg.caption?.replace(/^\/vision\s*/i, '').trim() || 'Analyse cette image en détail';
      // Only process if caption starts with /vision or has no other / command
      if (msg.caption && msg.caption.startsWith('/') && !msg.caption.startsWith('/vision')) return;
      await handleVisionMessage(msg, instruction);
    });

    // ── Message libre → Jarvis NLP ───────────────
    nexusBot.on('message', async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      if (!msg.text) return;
      if (msg.text.startsWith('/')) return; // Already handled by onText

      const text = msg.text.trim();
      if (text.length < 2) return;

      try {
        // Show "thinking" indicator
        await sendNexusMessage(msg.chat.id, `🤖 *Jarvis* — J'analyse ta demande...`);

        // Parse natural language
        const task     = await parseNaturalCommand(text, msg.chat.id);
        const dispatch = jarvisTaskToDispatch(task);

        await sendNexusMessage(msg.chat.id,
          `🎯 *${task.explanation}*\n_Agent: ${task.type} | Priorité: ${task.priority}_`
        );

        // Save user message to conversational memory
        await saveMessage(msg.chat.id, 'user', text, task.type);

        // Dispatch the task
        const { taskId } = await dispatchTask({
          agentType: dispatch.agentType,
          input:     dispatch.input,
          meta:      { ...dispatch.meta, chatId: msg.chat.id, source: 'jarvis' },
          priority:  task.priority,
        });

        await sendNexusMessage(msg.chat.id, `⏳ Tâche #${taskId} en cours...`);
      } catch (err) {
        console.error('[NexusBot] Jarvis error:', err.message);
        await sendNexusMessage(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // ── /decisions — décisions autonomes en attente ──
    nexusBot.onText(/^\/decisions/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      try {
        const { getPendingDecisions, sendDecisionToTelegram } = await import('./autonomous/decisionEngine.js');
        const pending = await getPendingDecisions();
        if (pending.length === 0) {
          await sendNexusMessage(msg.chat.id,
            '🎯 Aucune décision en attente.\n_Nexus génère de nouvelles opportunités toutes les 6h._\n\n' +
            '_Tu peux forcer un scan: /scan_'
          );
          return;
        }
        await sendNexusMessage(msg.chat.id, `🎯 *${pending.length} décision(s) en attente* — Envoi en cours...`);
        for (const d of pending.slice(0, 5)) {
          await sendDecisionToTelegram(d);
          await new Promise(r => setTimeout(r, 600));
        }
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Erreur /decisions: ${err.message}`);
      }
    });

    // ── /revenue — rapport revenus temps réel ────────
    nexusBot.onText(/^\/revenue/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      try {
        const { buildRevenueReport } = await import('./autonomous/revenueTracker.js');
        await sendNexusMessage(msg.chat.id, '💰 Récupération des données Stripe...');
        const report = await buildRevenueReport();
        await sendNexusMessage(msg.chat.id, report);
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Revenue error: ${err.message}`);
      }
    });

    // ── /scan — force opportunity detection ──────────
    nexusBot.onText(/^\/scan/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      await sendNexusMessage(msg.chat.id, '🔍 *Nexus* scan les opportunités...\n_Peut prendre 30-60 secondes._');
      try {
        const { runDetectionCycle } = await import('./autonomous/opportunityEngine.js');
        const decisions = await runDetectionCycle();
        if (decisions.length === 0) {
          await sendNexusMessage(msg.chat.id, '🔍 Scan terminé — aucune opportunité ≥7/10 détectée cette fois.');
        } else {
          await sendNexusMessage(msg.chat.id, `✅ *${decisions.length} nouvelle(s) décision(s) créée(s) !*\n_Tape /decisions pour les voir._`);
        }
      } catch (err) {
        await sendNexusMessage(msg.chat.id, `❌ Scan error: ${err.message}`);
      }
    });

    // ── Callback query — OUI / NON / PLUS TARD ───────
    nexusBot.on('callback_query', async (cbq) => {
      const chatId = cbq.message?.chat?.id;
      if (!isAuthorized(chatId)) return;

      const data      = cbq.data || '';
      const msgId     = cbq.message?.message_id;

      // Always dismiss the spinner
      try { await nexusBot.answerCallbackQuery(cbq.id); } catch { /* ignore */ }

      // ── OUI → execute decision ──
      if (data.startsWith('decision_yes_')) {
        const decisionId = data.slice('decision_yes_'.length);
        try {
          const { executeDecision } = await import('./autonomous/decisionEngine.js');
          await editNexusMessage(chatId, msgId, `⚡ _Exécution en cours..._\n\n_ID: ${decisionId.slice(0, 8)}..._`);
          await sendNexusMessage(chatId, `⚡ *Nexus se met au travail !*\n_Je te notifie quand c'est lancé._`);
          const result = await executeDecision(decisionId);
          await sendNexusMessage(chatId,
            `✅ *Décision exécutée*\n${'━'.repeat(20)}\n\n` +
            `_${result?.summary || 'Tâche démarrée avec succès.'}_`
          );
        } catch (err) {
          console.error('[NexusBot] decision_yes error:', err.message);
          await sendNexusMessage(chatId, `❌ Erreur exécution: ${err.message}`);
        }
        return;
      }

      // ── NON → ignore decision ──
      if (data.startsWith('decision_no_')) {
        const decisionId = data.slice('decision_no_'.length);
        try {
          const { markIgnored } = await import('./autonomous/decisionEngine.js');
          await editNexusMessage(chatId, msgId, `🚫 _Décision ignorée._`);
          await markIgnored(decisionId);
        } catch (err) {
          console.error('[NexusBot] decision_no error:', err.message);
        }
        return;
      }

      // ── PLUS TARD → reschedule +24h ──
      if (data.startsWith('decision_later_')) {
        const decisionId = data.slice('decision_later_'.length);
        try {
          const { rescheduleDecision } = await import('./autonomous/decisionEngine.js');
          await editNexusMessage(chatId, msgId, `⏰ _Reporté à demain._`);
          await rescheduleDecision(decisionId, 24);
        } catch (err) {
          console.error('[NexusBot] decision_later error:', err.message);
        }
        return;
      }
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
