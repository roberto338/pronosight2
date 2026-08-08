// ══════════════════════════════════════════════
// nexus/routes/google.js — OAuth Google (Gmail, Calendar, Drive)
//
// /google/callback est nécessairement public : c'est Google qui l'appelle.
// Sa protection est le `state` émis par /google/auth, lui-même derrière
// requireChatAuth. Voir lib/googleAuth.js.
// ══════════════════════════════════════════════

import { Router }          from 'express';
import { query }           from '../../db/database.js';
import { requireChatAuth } from './middleware.js';

const router = Router();

// ══════════════════════════════════════════════
// GOOGLE OAUTH
// ══════════════════════════════════════════════

// ── GET /nexus/google/status ────────────────────
router.get('/google/status', requireChatAuth, async (req, res) => {
  try {
    const { isGoogleConnected } = await import('../lib/googleAuth.js');
    const connected = await isGoogleConnected();
    res.json({ connected });
  } catch (err) {
    res.json({ connected: false });
  }
});

// ── GET /nexus/google/auth ──────────────────────
// Redirects to Google OAuth consent screen
router.get('/google/auth', requireChatAuth, async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).send(`
        <div style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#f5f5f5;min-height:100vh">
          <h2 style="color:#ef4444">⚠️ Google OAuth non configuré</h2>
          <p>Ajoute ces variables dans <code>.env</code> et sur Render:</p>
          <pre style="background:#1a1a1a;padding:16px;border-radius:8px;color:#a78bfa">
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=https://pronosight2.onrender.com/nexus/google/callback</pre>
          <p><a href="https://console.cloud.google.com" style="color:#7c3aed">→ console.cloud.google.com</a></p>
          <a href="/nexus/chat" style="color:#888">← Retour au chat</a>
        </div>
      `);
    }
    const { getAuthUrl } = await import('../lib/googleAuth.js');
    res.redirect(await getAuthUrl());
  } catch (err) {
    res.status(500).send(`Erreur: ${err.message}`);
  }
});

// ── GET /nexus/google/callback ──────────────────
// Receives the code from Google, saves tokens, redirects to chat
// Route nécessairement publique : c'est Google qui l'appelle, pas un navigateur
// authentifié. La protection est le `state` émis par /google/auth (lui, derrière
// requireChatAuth) — sans cette vérification, n'importe qui peut lier son propre
// compte Google à cette instance.
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    return res.redirect(`/nexus/chat?google=error&reason=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect('/nexus/chat?google=error&reason=no_code');
  }
  try {
    const { exchangeCode, consumeState } = await import('../lib/googleAuth.js');
    await consumeState(state);   // lève avant tout échange si le state ne colle pas
    await exchangeCode(code);
    console.log('[Google OAuth] Tokens saved successfully');
    res.redirect('/nexus/chat?google=connected');
  } catch (err) {
    console.error('[Google OAuth] Callback error:', err.message);
    res.redirect(`/nexus/chat?google=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /nexus/google/disconnect ───────────────
router.post('/google/disconnect', requireChatAuth, async (req, res) => {
  try {
    await query(`DELETE FROM nexus_ltm WHERE key = 'google_oauth_tokens'`);
    res.json({ status: 'disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


export default router;
