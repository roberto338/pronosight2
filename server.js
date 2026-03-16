// ══════════════════════════════════════════════════════════════
// PronoSight v4.0 — Backend Proxy avec GEMINI
// ══════════════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Sécurité (CSP assouplie) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    }
  }
}));
app.use(cors({ origin: false }));
app.use(express.json({ limit: '1mb' }));

// ── Rate Limiting ──
const geminiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: { message: '⏳ Trop de requêtes — attends 1 minute' } }
});

const oddsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Rate limit odds' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Rate limit' }
});

// ── Static files ──
app.use(express.static(join(__dirname, 'public')));

// ══════════════════════════════════════════════
// ROUTE: Gemini API Proxy
// ══════════════════════════════════════════════
app.post('/api/gemini', geminiLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: '⚠️ Clé API Gemini non configurée sur le serveur' } });
  }

  try {
    const { messages, useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = req.body;

    // Convertir les messages au format Gemini
    const geminiMessages = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        geminiMessages.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        geminiMessages.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    const modelName = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    
    const requestBody = {
      contents: geminiMessages,
      generationConfig: {
        maxOutputTokens: Math.min(maxTokens || 4096, 8192),
        temperature: 0.7,
        ...(jsonMode ? { responseMimeType: "application/json" } : {})
      }
    };

    if (useSearch) {
      requestBody.tools = [{ googleSearch: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (data.error) {
      const msg = data.error.message || '';
      if (response.status === 429 || msg.includes('quota') || msg.includes('rate')) {
        return res.status(429).json({
          error: { message: '⏳ Limite de débit API atteinte. Réessaie dans quelques secondes.' }
        });
      }
      if (msg.includes('billing') || msg.includes('payment')) {
        return res.status(402).json({
          error: { message: '💳 Quota API épuisé. Vérifie ton compte Google Cloud.' }
        });
      }
      return res.status(response.status).json(data);
    }

    const formattedResponse = {
      content: data.candidates?.[0]?.content?.parts?.map(p => ({
        type: 'text',
        text: p.text || ''
      })) || []
    };

    res.json(formattedResponse);
  } catch (err) {
    console.error('[Gemini Proxy]', err.message);
    res.status(500).json({ error: { message: 'Erreur serveur proxy: ' + err.message } });
  }
});

// ══════════════════════════════════════════════
// ROUTE: The Odds API Proxy
// ══════════════════════════════════════════════
app.get('/api/odds/:sportKey', oddsLimiter, async (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(404).json({ error: 'Clé Odds API non configurée' });
  }

  try {
    const { sportKey } = req.params;
    const { regions, markets, oddsFormat, bookmakers } = req.query;

    const params = new URLSearchParams({
      apiKey,
      regions: regions || 'eu',
      markets: markets || 'h2h',
      oddsFormat: oddsFormat || 'decimal'
    });
    if (bookmakers) params.set('bookmakers', bookmakers);

    const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds/?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Odds API HTTP ' + response.status });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[Odds Proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// ROUTE: football-data.org Proxy
// ══════════════════════════════════════════════
app.get('/api/football-data/*', generalLimiter, async (req, res) => {
  const apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(404).json({ error: 'Clé football-data non configurée' });
  }

  try {
    const fdPath = req.params[0];
    const qs = new URLSearchParams(req.query).toString();
    const url = `https://api.football-data.org/v4/${fdPath}${qs ? '?' + qs : ''}`;

    const response = await fetch(url, {
      headers: { 'X-Auth-Token': apiKey }
    });

    if (response.status === 429) {
      return res.status(429).json({ error: 'football-data.org rate limit (10 req/min)' });
    }
    if (!response.ok) {
      return res.status(response.status).json({ error: 'football-data HTTP ' + response.status });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[FD Proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// ROUTE: TheSportsDB Proxy
// ══════════════════════════════════════════════
app.get('/api/tsdb/*', generalLimiter, async (req, res) => {
  try {
    const tsdbPath = req.params[0];
    const qs = new URLSearchParams(req.query).toString();
    
    let endpoint = tsdbPath;
    if (tsdbPath.includes('eventslastleague')) {
      endpoint = tsdbPath.replace('eventslastleague', 'eventspastleague');
    }
    
    const url = `https://www.thesportsdb.com/api/v1/json/3/${endpoint}${qs ? '?' + qs : ''}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return res.json({ events: [] });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[TSDB Proxy]', err.message);
    res.json({ events: [] });
  }
});

// ══════════════════════════════════════════════
// ROUTE: Config status
// ══════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  res.json({
    claude: false,
    gemini: !!process.env.GEMINI_API_KEY,
    odds: !!process.env.ODDS_API_KEY,
    footballData: !!process.env.FOOTBALL_DATA_KEY,
    liveApi: !!process.env.LIVE_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  });
});

// ── SPA Fallback ──
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  ⚡ PronoSight v4.0 (GEMINI) — http://localhost:${PORT}\n`);
  console.log('  APIs configurées:');
  console.log(`    Gemini:        ${process.env.GEMINI_API_KEY ? '✅' : '❌ manquante'}`);
  console.log(`    Odds API:      ${process.env.ODDS_API_KEY ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Football-Data: ${process.env.FOOTBALL_DATA_KEY ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Live API:      ${process.env.LIVE_API_KEY ? '✅' : '⚠️  optionnelle'}\n`);
});