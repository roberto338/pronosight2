// ══════════════════════════════════════════════════════════════
// telegramCompat.js — Adaptateur node-telegram-bot-api → grammY
//
// Expose la surface d'API utilisée par bot/telegram.js et
// nexus/telegramHandler.js pour migrer vers grammY sans réécrire
// les ~40 handlers testés en prod :
//   sendMessage / editMessageText / answerCallbackQuery / getFileLink
//   onText(regex, cb(msg, match)) / on('message'|'photo'|'callback_query'|'polling_error')
//   options { polling: { interval, autoStart, params } }
//
// Sémantique préservée :
//   - onText ne matche que msg.text (jamais les légendes de photos)
//   - on('message') reçoit TOUS les messages (les handlers filtrent eux-mêmes)
//   - les erreurs Telegram gardent err.code === 'ETELEGRAM' et un message
//     contenant la description API ("409", "message is not modified", …)
//   - disable_web_page_preview est traduit en link_preview_options (Bot API 7+)
// ══════════════════════════════════════════════════════════════

import { Bot, GrammyError, HttpError } from 'grammy';

function toCompatError(err) {
  const inner = err?.error ?? err; // BotError de grammY enveloppe l'erreur d'origine
  if (inner instanceof GrammyError) {
    const e = new Error(`ETELEGRAM: ${inner.error_code} ${inner.description}`);
    e.code = 'ETELEGRAM';
    e.response = { statusCode: inner.error_code, body: inner.payload };
    return e;
  }
  if (inner instanceof HttpError) {
    const e = new Error(`EFATAL: ${inner.message}`);
    e.code = 'EFATAL';
    return e;
  }
  return inner instanceof Error ? inner : new Error(String(inner));
}

// Traduit les options node-telegram-bot-api vers l'API Bot actuelle
function normalizeOpts(opts = {}) {
  const o = { ...opts };
  if ('disable_web_page_preview' in o) {
    o.link_preview_options = { is_disabled: !!o.disable_web_page_preview };
    delete o.disable_web_page_preview;
  }
  return o;
}

export default class CompatBot {
  constructor(token, options = {}) {
    this.token = token;
    // options.botInfo : réservé aux tests (permet handleUpdate sans réseau)
    this.bot = new Bot(token, options.botInfo ? { botInfo: options.botInfo } : undefined);

    this._textHandlers  = [];
    this._eventHandlers = { message: [], photo: [], callback_query: [], polling_error: [] };

    // ── Routage des updates entrantes ────────────
    this.bot.on('message', (ctx) => {
      const msg = ctx.message;
      if (msg.text) {
        for (const { regexp, cb } of this._textHandlers) {
          const match = regexp.exec(msg.text);
          if (match) this._safeCall(cb, msg, match);
        }
      }
      if (msg.photo?.length) {
        for (const cb of this._eventHandlers.photo) this._safeCall(cb, msg);
      }
      for (const cb of this._eventHandlers.message) this._safeCall(cb, msg);
    });

    this.bot.on('callback_query', (ctx) => {
      for (const cb of this._eventHandlers.callback_query) this._safeCall(cb, ctx.callbackQuery);
    });

    // Erreurs levées dans les handlers (ne doivent jamais tuer le polling)
    this.bot.catch((err) => {
      console.error('[TelegramCompat] Erreur handler:', toCompatError(err).message);
    });

    if (options.polling && options.polling.autoStart !== false) {
      this.startPolling(options.polling);
    }
  }

  _safeCall(cb, ...args) {
    Promise.resolve()
      .then(() => cb(...args))
      .catch((err) => console.error('[TelegramCompat] Erreur handler:', err.message));
  }

  // ── Réception ──────────────────────────────────
  onText(regexp, cb) { this._textHandlers.push({ regexp, cb }); }

  on(event, cb) {
    if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
    this._eventHandlers[event].push(cb);
  }

  startPolling(pollingOpts = {}) {
    const timeout = pollingOpts.params?.timeout;
    this._running = this.bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        ...(timeout ? { timeout } : {}),
      })
      .catch((err) => {
        const compat = toCompatError(err);
        const handlers = this._eventHandlers.polling_error;
        if (handlers.length === 0) {
          console.error('[TelegramCompat] Polling error:', compat.message);
          return;
        }
        for (const cb of handlers) this._safeCall(cb, compat);
      });
    return this._running;
  }

  async stopPolling() { await this.bot.stop(); }

  // ── Envoi (mêmes signatures que node-telegram-bot-api) ──
  async sendMessage(chatId, text, opts) {
    try {
      return await this.bot.api.sendMessage(chatId, text, normalizeOpts(opts));
    } catch (err) { throw toCompatError(err); }
  }

  async editMessageText(text, opts = {}) {
    const { chat_id, message_id, ...rest } = opts;
    try {
      return await this.bot.api.editMessageText(chat_id, message_id, text, normalizeOpts(rest));
    } catch (err) { throw toCompatError(err); }
  }

  async answerCallbackQuery(callbackQueryId, opts) {
    try {
      return await this.bot.api.answerCallbackQuery(callbackQueryId, opts);
    } catch (err) { throw toCompatError(err); }
  }

  async getFileLink(fileId) {
    try {
      const file = await this.bot.api.getFile(fileId);
      return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    } catch (err) { throw toCompatError(err); }
  }

  // Réservé aux tests : injecte une update sans réseau
  async handleUpdate(update) { return this.bot.handleUpdate(update); }
}
