// ══════════════════════════════════════════════
// nexus/lib/googleAuth.js
// Google OAuth2 client — persists tokens in nexus_ltm
// ══════════════════════════════════════════════

import { google }  from 'googleapis';
import { query }   from '../../db/database.js';

const LTM_KEY = 'google_oauth_tokens';

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
    VALUES ('fact', $1, $2, 1.0, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, last_seen = NOW()
  `, [LTM_KEY, JSON.stringify(tokens)]);
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
export function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type:  'offline',
    prompt:       'consent',
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
