// ══════════════════════════════════════════════
// nexus/agents/googleAgent.js
// Gmail · Calendar · Drive operations via Google APIs
// ══════════════════════════════════════════════

import { google }        from 'googleapis';
import { getAuthClient } from '../lib/googleAuth.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';
import { callAI }           from '../lib/ai.js';

// ── Helpers ──────────────────────────────────────

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d.dateTime || d.date);
  return dt.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function decodeBase64Url(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b, 'base64').toString('utf8');
}

function extractBody(payload) {
  // Try text/plain first, then text/html
  const parts = payload?.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data).slice(0, 1000);
  }
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) {
      return decodeBase64Url(p.body.data).replace(/<[^>]+>/g, ' ').slice(0, 800);
    }
  }
  if (payload?.body?.data) return decodeBase64Url(payload.body.data).slice(0, 1000);
  return '(corps non disponible)';
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── Gmail ─────────────────────────────────────────

async function readEmails(auth, { count = 10, query: q = 'is:unread' } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  const list  = await gmail.users.messages.list({
    userId:     'me',
    maxResults: count,
    q,
  });
  const msgs = list.data.messages || [];
  if (!msgs.length) return 'Aucun email trouvé.';

  const details = await Promise.all(
    msgs.slice(0, count).map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'] })
    )
  );

  const lines = details.map((d, i) => {
    const h = d.data.payload?.headers || [];
    return `${i + 1}. **${getHeader(h, 'Subject') || '(sans objet)'}**\n   De: ${getHeader(h, 'From')} — ${getHeader(h, 'Date')}`;
  });
  return `📧 **${msgs.length} email(s)**\n\n` + lines.join('\n\n');
}

async function readEmailFull(auth, { messageId } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  const msg   = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const h     = msg.data.payload?.headers || [];
  const body  = extractBody(msg.data.payload);
  return `**De:** ${getHeader(h, 'From')}\n**Sujet:** ${getHeader(h, 'Subject')}\n**Date:** ${getHeader(h, 'Date')}\n\n${body}`;
}

async function sendEmail(auth, { to, subject, body: bodyText } = {}) {
  if (!to || !subject || !bodyText) throw new Error('to, subject et body requis');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw   = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return `✅ Email envoyé à ${to} — "${subject}"`;
}

async function searchEmails(auth, { query: q = '' } = {}) {
  return readEmails(auth, { count: 10, query: q });
}

async function draftEmail(auth, { to, subject, body: bodyText } = {}) {
  if (!to || !subject || !bodyText) throw new Error('to, subject et body requis');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw   = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return `📝 Brouillon créé (id: ${res.data.id}) — "${subject}"`;
}

// ── Calendar ──────────────────────────────────────

async function getEvents(auth, { days = 7 } = {}) {
  const calendar = google.calendar({ version: 'v3', auth });
  const now      = new Date();
  const end      = new Date(now.getTime() + days * 86_400_000);
  const res      = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      now.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   20,
  });
  const items = res.data.items || [];
  if (!items.length) return `Aucun événement dans les ${days} prochains jours.`;
  const lines = items.map((e, i) =>
    `${i + 1}. **${e.summary || '(sans titre)'}** — ${fmtDate(e.start)}${e.location ? '\n   📍 ' + e.location : ''}`
  );
  return `📅 **${items.length} événement(s)** sur ${days} jours\n\n` + lines.join('\n\n');
}

async function createEvent(auth, { title, start, end, description = '', location = '' } = {}) {
  if (!title || !start || !end) throw new Error('title, start et end requis (ISO 8601)');
  const calendar = google.calendar({ version: 'v3', auth });
  const event    = {
    summary:     title,
    description,
    location,
    start: { dateTime: start, timeZone: 'Europe/Paris' },
    end:   { dateTime: end,   timeZone: 'Europe/Paris' },
  };
  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return `✅ Événement créé: "${title}" — ${fmtDate({ dateTime: start })}`;
}

async function checkAvailability(auth, { date } = {}) {
  const start = new Date(date || new Date());
  start.setHours(0, 0, 0, 0);
  const end   = new Date(start.getTime() + 86_400_000);
  const calendar = google.calendar({ version: 'v3', auth });
  const res   = await calendar.events.list({
    calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: true, orderBy: 'startTime',
  });
  const items = res.data.items || [];
  if (!items.length) return `📅 Aucun événement le ${start.toLocaleDateString('fr-FR')} — tu es libre !`;
  return `📅 ${items.length} événement(s) le ${start.toLocaleDateString('fr-FR')}:\n` +
    items.map(e => `• ${e.summary} — ${fmtDate(e.start)}`).join('\n');
}

// ── Drive ─────────────────────────────────────────

async function listFiles(auth, { query: q = '', count = 10 } = {}) {
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.list({
    q:          q || undefined,
    pageSize:   count,
    fields:     'files(id, name, mimeType, modifiedTime, size)',
    orderBy:    'modifiedTime desc',
  });
  const files = res.data.files || [];
  if (!files.length) return 'Aucun fichier trouvé.';
  const typeIcon = m =>
    m.includes('folder') ? '📁' :
    m.includes('document') ? '📝' :
    m.includes('spreadsheet') ? '📊' :
    m.includes('pdf') ? '📄' :
    m.includes('image') ? '🖼️' : '📄';
  const lines = files.map((f, i) =>
    `${i + 1}. ${typeIcon(f.mimeType)} **${f.name}** — modifié: ${new Date(f.modifiedTime).toLocaleDateString('fr-FR')}`
  );
  return `📁 **${files.length} fichier(s)**\n\n` + lines.join('\n');
}

async function searchFiles(auth, { query: q = '' } = {}) {
  const searchQ = q ? `name contains '${q.replace(/'/g, "\\'")}' or fullText contains '${q.replace(/'/g, "\\'")}'` : '';
  return listFiles(auth, { query: searchQ, count: 10 });
}

async function readFile(auth, { fileId, fileName } = {}) {
  const drive = google.drive({ version: 'v3', auth });

  // If only fileName given, search for it first
  let id = fileId;
  if (!id && fileName) {
    const res = await drive.files.list({
      q: `name contains '${fileName.replace(/'/g, "\\'")}'`,
      pageSize: 1, fields: 'files(id, name, mimeType)',
    });
    const f = res.data.files?.[0];
    if (!f) return `Fichier "${fileName}" non trouvé sur Drive.`;
    id = f.id;
  }
  if (!id) throw new Error('fileId ou fileName requis');

  // Export Google Docs as plain text
  try {
    const meta = await drive.files.get({ fileId: id, fields: 'mimeType, name' });
    if (meta.data.mimeType?.includes('google-apps.document')) {
      const exp = await drive.files.export({ fileId: id, mimeType: 'text/plain' });
      return `**${meta.data.name}**\n\n${String(exp.data).slice(0, 4000)}`;
    }
    // Binary download — return limited text
    const dl = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
    return `**${meta.data.name}**\n\n${String(dl.data).slice(0, 4000)}`;
  } catch (err) {
    return `Impossible de lire le fichier: ${err.message}`;
  }
}

// ── Action dispatcher ─────────────────────────────

const ACTIONS = {
  read_emails:        readEmails,
  read_email_full:    readEmailFull,
  send_email:         sendEmail,
  search_emails:      searchEmails,
  draft_email:        draftEmail,
  get_events:         getEvents,
  create_event:       createEvent,
  check_availability: checkAvailability,
  list_files:         listFiles,
  search_files:       searchFiles,
  read_file:          readFile,
};

// ── Main agent ────────────────────────────────────

const GOOGLE_INSTRUCTIONS = `Tu es l'agent Google de Roberto. Tu as accès à Gmail, Google Calendar et Google Drive.
Après avoir récupéré des données Google, synthétise-les de façon claire, concise et actionnable.
Si des actions sont demandées (envoyer email, créer événement), confirme-les après exécution.`;

/**
 * @param {{ input, meta: { action, memoryContext, ...params } }}
 */
export async function runGoogle({ input, meta = {} }) {
  const auth = await getAuthClient();
  if (!auth) {
    return {
      output: '❌ Google non connecté. Va sur `/nexus/google/auth` pour autoriser l\'accès.',
      meta:   { agent: 'google', error: 'not_connected' },
    };
  }

  const action = meta.action || 'read_emails';
  const handler = ACTIONS[action];

  let rawResult = '';
  if (handler) {
    try {
      rawResult = await handler(auth, meta);
    } catch (err) {
      rawResult = `Erreur Google API (${action}): ${err.message}`;
    }
  } else {
    rawResult = `Action inconnue: ${action}. Actions disponibles: ${Object.keys(ACTIONS).join(', ')}`;
  }

  // Pass raw result through Claude for synthesis (skip for simple actions like send/create)
  const skipSynthesis = ['send_email', 'draft_email', 'create_event'].includes(action);
  let output = rawResult;

  if (!skipSynthesis && rawResult.length > 50) {
    const systemPrompt = buildNexusPrompt(GOOGLE_INSTRUCTIONS, meta.memoryContext || '');
    const userPrompt   = `Demande de l'utilisateur: "${input}"\n\nDonnées récupérées:\n${rawResult}`;
    output = await callAI(systemPrompt, userPrompt, { maxTokens: 2000 });
  }

  return {
    output,
    meta: { agent: 'google', action, rawLength: rawResult.length },
  };
}
