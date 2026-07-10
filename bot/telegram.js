// ══════════════════════════════════════════════
// bot/telegram.js — Bot Telegram PronoSight
// ══════════════════════════════════════════════

import 'dotenv/config';
import TelegramBot from '../nexus/lib/telegramCompat.js';

const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// ── Initialisation du bot ─────────────────────
let bot = null;

if (!TOKEN) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN absent — bot désactivé');
} else {
  try {
    bot = new TelegramBot(TOKEN); // envoi seul — pas de polling (le polling vit dans nexus/telegramHandler.js)
    console.log('📱 Bot Telegram initialisé');
  } catch (err) {
    console.error('❌ Erreur init Telegram:', err.message);
    bot = null;
  }
}

// ── Helper silencieux si bot absent ───────────
async function send(chatId, text, opts = {}) {
  if (!bot || !chatId) return null;
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...opts,
  });
}

// ══════════════════════════════════════════════
// ESCAPE MARKDOWN
// Caractères spéciaux à échapper en Markdown v1
// ══════════════════════════════════════════════

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

// ══════════════════════════════════════════════
// EMOJI PAR SPORT
// ══════════════════════════════════════════════

export function getEmojiBySport(sport = '') {
  const s = sport.toLowerCase();
  if (s.includes('football') || s === 'foot')  return '⚽';
  if (s.includes('basket') || s === 'nba')     return '🏀';
  if (s.includes('tennis'))                    return '🎾';
  if (s.includes('rugby'))                     return '🏉';
  if (s.includes('mma') || s.includes('ufc'))  return '🥊';
  if (s.includes('box'))                       return '🥊';
  if (s === 'f1' || s.includes('formule'))     return '🏎️';
  if (s.includes('cycl'))                      return '🚴';
  if (s.includes('hand'))                      return '🤾';
  if (s.includes('volley'))                    return '🏐';
  if (s.includes('snooker'))                   return '🎱';
  if (s.includes('golf'))                      return '⛳';
  return '🏆';
}

// ══════════════════════════════════════════════
// BROADCAST DAILY — Analyse complète du jour
// ══════════════════════════════════════════════

export async function broadcastDaily(victorData) {
  if (!bot || !CHANNEL_ID) return;

  try {
    const events   = victorData.events || [];
    const date     = victorData.date      || new Date().toISOString().slice(0, 10);
    const genAt    = victorData.generated_at || '--:--';
    const combine  = victorData.combine_victor;
    const verdict  = victorData.verdict_journee || '';

    // ── Partie 1 : En-tête + events ──────────────
    let msgEvents = `🎙️ *VICTOR — Analyse du ${esc(date)}*\n`;
    msgEvents    += `_Généré à ${esc(genAt)}_\n`;
    msgEvents    += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const eventsToShow = events.slice(0, 6);
    for (const ev of eventsToShow) {
      const emoji     = getEmojiBySport(ev.sport);
      const confScore = ev.confiance_score ? `${ev.confiance_score}/5` : '—';

      msgEvents += `${emoji} *${esc(ev.sport)}* | ${esc(ev.competition)}\n`;
      msgEvents += `🆚 *${esc(ev.equipe_a)} vs ${esc(ev.equipe_b)}* — ${esc(ev.heure)}\n`;
      msgEvents += `🎯 *Pronostic :* ${esc(ev.pronostic_principal)}\n`;
      msgEvents += `💰 *Cote :* ~${esc(ev.cote_estimee)} | ${esc(ev.confiance)}\n`;

      if (ev.value_bet) {
        msgEvents += `💎 *Value bet :* ${esc(ev.value_bet)} \\(~${esc(ev.cote_value)}\\)\n`;
      }
      if (ev.pari_a_eviter) {
        msgEvents += `⚠️ *Éviter :* ${esc(ev.pari_a_eviter)}\n`;
      }
      if (ev.score_predit) {
        msgEvents += `📊 *Score prédit :* ${esc(ev.score_predit)} \\(${esc(confScore)}\\)\n`;
      }
      if (ev.phrase_signature) {
        msgEvents += `💬 _${esc(ev.phrase_signature)}_\n`;
      }
      msgEvents += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    // ── Partie 2 : Combiné + verdict ─────────────
    let msgVerdict = '';

    if (combine?.selections?.length > 0) {
      msgVerdict += `🎲 *COMBINÉ VICTOR*\n`;
      msgVerdict += `${combine.selections.map(esc).join(' ➕ ')}\n`;
      msgVerdict += `💰 Cote combinée : ~${esc(combine.cote_combinee)}\n`;
      if (combine.risque) {
        msgVerdict += `⚡ Risque : ${esc(combine.risque)}\n`;
      }
      msgVerdict += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    if (verdict) {
      msgVerdict += `🏆 *VERDICT DU JOUR*\n${esc(verdict)}\n\n`;
    }

    msgVerdict += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msgVerdict += `_PronoSight — Victor IA | Jouer responsablement_`;

    // ── Envoi : découpe si > 4000 chars ──────────
    const fullMsg = msgEvents + msgVerdict;

    if (fullMsg.length <= 4000) {
      await send(CHANNEL_ID, fullMsg);
    } else {
      // Message 1 : events
      if (msgEvents.length > 0) await send(CHANNEL_ID, msgEvents);
      // Message 2 : combiné + verdict
      if (msgVerdict.length > 0) await send(CHANNEL_ID, msgVerdict);
    }

    console.log(`✅ Broadcast Telegram envoyé (${eventsToShow.length} pronostics)`);

  } catch (err) {
    console.error('❌ Erreur broadcast Telegram:', err.message);
  }
}

// ══════════════════════════════════════════════
// SEND ALERT — Alertes urgentes
// ══════════════════════════════════════════════

export async function sendAlert(message, type = 'info') {
  if (!bot || !CHANNEL_ID) return;

  const emojis = {
    success: '✅',
    warning: '⚠️',
    danger:  '🚨',
    info:    'ℹ️',
  };
  const emoji = emojis[type] || 'ℹ️';

  const ts = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  const text = `${emoji} *ALERTE PRONOSIGHT*\n${esc(message)}\n_${esc(ts)}_`;

  try {
    await send(CHANNEL_ID, text);
  } catch (err) {
    console.error('❌ Erreur sendAlert:', err.message);
  }
}

// ══════════════════════════════════════════════
// SEND DAILY STATS
// ══════════════════════════════════════════════

export async function sendDailyStats(stats) {
  if (!bot || !CHANNEL_ID || !stats) return;

  try {
    const text =
      `📊 *STATS VICTOR — ${esc(stats.date)}*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `✅ Taux global : ${esc(stats.taux_global)}%\n` +
      `🎯 Confiance Élevé : ${esc(stats.taux_confiance_eleve)}%\n` +
      `📈 Confiance Moyen : ${esc(stats.taux_confiance_moyen)}%\n` +
      `💎 Value bets : ${esc(stats.taux_value_bet)}%\n` +
      `💰 ROI simulé : ${esc(stats.roi_mise_fixe)}€ \\(mise fixe 10€\\)\n` +
      `📋 Total : ${esc(stats.total_pronostics)} pronostics\n` +
      `━━━━━━━━━━━━━━━\n` +
      `_Mise à jour automatique — PronoSight_`;

    await send(CHANNEL_ID, text);
    console.log('📊 Stats journalières envoyées sur Telegram');
  } catch (err) {
    console.error('❌ Erreur sendDailyStats:', err.message);
  }
}

// ══════════════════════════════════════════════
// COMMANDES BOT (mode non-production uniquement)
// ══════════════════════════════════════════════

if (bot && process.env.NODE_ENV !== 'production') {
  // Import dynamique pour éviter circular dep avec core.js
  const setupCommands = async () => {
    let queryDB;
    try {
      const db = await import('../db/database.js');
      queryDB = db.query;
    } catch {
      console.warn('⚠️  DB non disponible pour les commandes bot');
      return;
    }

    // /aide
    bot.onText(/\/aide/, async (msg) => {
      await send(msg.chat.id,
        `🎙️ *Commandes Victor*\n\n` +
        `/today — Pronostics du jour\n` +
        `/best — Top 3 confiance Élevé\n` +
        `/stats — Performances du jour\n` +
        `/aide — Cette aide`
      );
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucune stat disponible pour aujourd\'hui.');
          return;
        }
        await sendDailyStats(rows[0]);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /today
    bot.onText(/\/today/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT match, sport, pronostic_principal, cote_estimee, confiance
           FROM ps_pronostics
           WHERE date = CURRENT_DATE
           ORDER BY created_at DESC
           LIMIT 6`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucun pronostic pour aujourd\'hui.');
          return;
        }
        let txt = `📅 *Pronostics du jour*\n━━━━━━━━━━━━━\n`;
        rows.forEach(r => {
          txt += `${getEmojiBySport(r.sport)} ${esc(r.match)}\n`;
          txt += `🎯 ${esc(r.pronostic_principal)} — ~${esc(r.cote_estimee)} \\(${esc(r.confiance)}\\)\n\n`;
        });
        await send(msg.chat.id, txt);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /best
    bot.onText(/\/best/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT match, sport, pronostic_principal, cote_estimee,
                  value_bet, cote_value, phrase_signature
           FROM ps_pronostics
           WHERE date = CURRENT_DATE AND confiance = 'Élevé'
           ORDER BY cote_estimee DESC
           LIMIT 3`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucun pronostic confiance Élevé aujourd\'hui.');
          return;
        }
        let txt = `🔥 *Top picks du jour \\(Confiance Élevé\\)*\n━━━━━━━━━━━━━\n`;
        rows.forEach((r, i) => {
          txt += `${i + 1}\\. ${getEmojiBySport(r.sport)} *${esc(r.match)}*\n`;
          txt += `🎯 ${esc(r.pronostic_principal)} — ~${esc(r.cote_estimee)}\n`;
          if (r.value_bet) txt += `💎 Value: ${esc(r.value_bet)} \\(~${esc(r.cote_value)}\\)\n`;
          if (r.phrase_signature) txt += `💬 _${esc(r.phrase_signature)}_\n`;
          txt += '\n';
        });
        await send(msg.chat.id, txt);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    console.log('💬 Commandes bot activées \\(mode dev\\)');
  };

  setupCommands().catch(() => {});
}

export default bot;
