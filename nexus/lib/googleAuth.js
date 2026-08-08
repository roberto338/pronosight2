// ══════════════════════════════════════════════
// nexus/lib/googleAuth.js
// Google OAuth2 client — persists tokens in nexus_ltm
// ══════════════════════════════════════════════

import { google }  from 'googleapis';
import { randomBytes, timingSafeEqual } from 'crypto';
import { query }   from '../../db/database.js';

const LTM_KEY   = 'google_oauth_tokens';
const STATE_KEY = 'google_oauth_state';

// Ces deux clés vivent dans nexus_ltm faute d'autre magasin persistant, mais
// sous la catégorie 'system' : getRelevantMemories() l'exclut explicitement
// pour qu'un token ne parte jamais dans un prompt IA.
const SYSTEM_CATEGORY = 'system';

// Un state non consommé au bout de ce délai est périmé.
const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://pronosight2.onrender.com/nexus/google/callback'
  );
}

/**
 * Returns an OAuth2 client pre-loaded with saved tokens, or null if not connected.
 */
export async function getAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  try {
    const { rows } = await query(
      `SELECT value FROM nexus_ltm WHERE key = $1 LIMIT 1`,
      [LTM_KEY]
    );
    if (!rows.length) return null;

    const client = createOAuthClient();
    const tokens = JSON.parse(rows[0].value);
    client.setCredentials(tokens);

    // Auto-refresh if token nearly expired
    client.on('tokens', async (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      await saveTokens(merged);
    });

    return client;
  } catch (err) {
    console.error('[GoogleAuth] getAuthClient error:', err.message);
    return null;
  }
}

/**
 * Save/update OAuth tokens in nexus_ltm.
 */
export async function saveTokens(tokens) {
  await query(`
    INSERT INTO nexus_ltm (category, key, value, confidence, last_seen)
    VALUES ($3, $1, $2, 1.0, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, category = EXCLUDED.category, last_seen = NOW()
  `, [LTM_KEY, JSON.stringify(tokens), SYSTEM_CATEGORY]);
}

/**
 * Check if Google is connected (tokens exist in nexus_ltm).
 */
export async function isGoogleConnected() {
  try {
    const { rows } = await query(`SELECT 1 FROM nexus_ltm WHERE key = $1 LIMIT 1`, [LTM_KEY]);
    return rows.length > 0;
  } catch { return false; }
}

/**
 * Build the Google OAuth consent URL.
 * Scopes: Gmail read/send, Calendar, Drive.
 */
export async function getAuthUrl() {
  const client = createOAuthClient();

  // Anti-CSRF : /nexus/google/callback est nécessairement public (c'est Google
  // qui l'appelle). Sans state, n'importe qui peut y poster un `code` et lier
  // SON compte Google à cette instance — avec les scopes gmail.send et drive
  // ci-dessous. Le state lie le retour à une session authentifiée.
  const state = randomBytes(32).toString('hex');
  await query(`
    INSERT INTO nexus_ltm (category, key, value, confidence, last_seen)
    VALUES ($2, $1, $3, 1.0, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, category = EXCLUDED.category, last_seen = NOW()
  `, [STATE_KEY, SYSTEM_CATEGORY, state]);

  return client.generateAuthUrl({
    access_type:  'offline',
    prompt:       'consent',
    state,
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

/**
 * Vérifie le state renvoyé par Google, puis le consomme (usage unique).
 * Lève si le state est absent, inconnu ou périmé — l'échange de code
 * ne doit alors pas avoir lieu.
 *
 * @param {string} state  valeur reçue dans req.query.state
 */
export async function consumeState(state) {
  if (!state) throw new Error('state manquant');

  const { rows } = await query(
    `SELECT value, last_seen FROM nexus_ltm WHERE key = $1 AND category = $2 LIMIT 1`,
    [STATE_KEY, SYSTEM_CATEGORY]
  );
  if (!rows.length) throw new Error('aucune demande d\'autorisation en cours');

  const expected = rows[0].value;
  const fresh    = Date.now() - new Date(rows[0].last_seen).getTime() < STATE_TTL_MS;

  // Consommation systématique : un state rejoué ou expiré est brûlé aussi,
  // sinon un attaquant pourrait réessayer indéfiniment.
  await query(`DELETE FROM nexus_ltm WHERE key = $1`, [STATE_KEY]);

  const a = Buffer.from(String(state));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('state invalide');
  if (!fresh) throw new Error('state expiré — relance la connexion');
}

/**
 * Exchange auth code for tokens and persist them.
 * Returns the credentials object.
 */
export async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveTokens(tokens);
  return tokens;
}
