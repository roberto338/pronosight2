// ══════════════════════════════════════════════════════════════
// PronoSight v4.1 — Backend Proxy + Victor IA
// ══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { startScheduler } from './cron/scheduler.js';
import { query as dbQuery } from './db/database.js';
import { runVictor } from './victor/core.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.set('trust proxy', 1);
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
  max: 12,
  validate: { xForwardedForHeader: false },
  message: { error: { message: '⏳ Trop de requêtes — attends 1 minute' } }
});

const oddsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  message: { error: 'Rate limit odds' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  validate: { xForwardedForHeader: false },
  message: { error: 'Rate limit' }
});

// ── Cache mémoire analyses (2h TTL) ──
const analysisCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// ── Fallback Groq (format OpenAI) ──
async function callGroq(messages, maxTokens, jsonMode) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('GROQ_API_KEY non configurée');
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages,
      max_tokens: Math.min(maxTokens || 4096, 4096),
      temperature: 0.7,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error('Groq HTTP ' + resp.status + ': ' + (err.error?.message || ''));
  }
  const groqData = await resp.json();
  const text = groqData.choices?.[0]?.message?.content || '';
  return { content: [{ type: 'text', text }] };
}

// ══════════════════════════════════════════════
// ROUTE: Gemini API Proxy
// ══════════════════════════════════════════════
app.post('/api/gemini', geminiLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: '⚠️ Clé API Gemini non configurée sur le serveur' } });
  }

  try {
    const { messages, useSearch = false, maxTokens = 4096, model = null, jsonMode = false, cacheKey = null } = req.body;

    // ── Cache hit ──
    if (cacheKey) {
      const cached = analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        console.log(`[Cache] Hit: ${cacheKey}`);
        return res.json(cached.data);
      }
    }

    // ── Groq en primaire (sauf useSearch — Groq ne supporte pas Google Search) ──
    if (!useSearch) {
      try {
        const groqResult = await callGroq(messages, maxTokens, jsonMode);
        if (cacheKey) analysisCache.set(cacheKey, { data: groqResult, ts: Date.now() });
        console.log('[Groq] OK (primaire)');
        return res.json(groqResult);
      } catch (groqErr) {
        console.warn('[Groq primaire]', groqErr.message, '— bascule Gemini');
      }
    }

    // ── Gemini (primaire pour useSearch, fallback sinon) ──
    const geminiMessages = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        geminiMessages.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        geminiMessages.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    const modelName = model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const requestBody = {
      contents: geminiMessages,
      generationConfig: {
        maxOutputTokens: Math.min(maxTokens || 4096, 8192),
        temperature: 0.7,
        ...(jsonMode ? { responseMimeType: "application/json" } : {})
      }
    };
    if (useSearch) requestBody.tools = [{ googleSearch: {} }];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    const data = await response.json();

    const isRateLimited = response.status === 429 ||
      !!(data.error && (data.error.message || '').match(/quota|rate/i));

    // ── Si Gemini aussi limité → dernier recours Groq (sans search) ──
    if (isRateLimited) {
      console.warn('[Gemini] 429 — dernier recours Groq sans search');
      try {
        const groqResult = await callGroq(messages, maxTokens, jsonMode);
        if (cacheKey) analysisCache.set(cacheKey, { data: groqResult, ts: Date.now() });
        console.log('[Groq] OK (dernier recours)');
        return res.json(groqResult);
      } catch (groqErr) {
        console.error('[Groq dernier recours]', groqErr.message);
        return res.status(429).json({
          error: { message: '⏳ Limite de débit atteinte sur Gemini et Groq. Réessaie dans 1 minute.' }
        });
      }
    }

    if (data.error) {
      const msg = data.error.message || '';
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

    if (cacheKey) analysisCache.set(cacheKey, { data: formattedResponse, ts: Date.now() });
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
// ROUTE: API-Football (RapidAPI) proxy
// ══════════════════════════════════════════════
app.get('/api/apifootball/*', generalLimiter, async (req, res) => {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return res.status(404).json({ error: 'RAPIDAPI_KEY non configurée' });
  const path = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://v3.football.api-sports.io/${path}${qs ? '?' + qs : ''}`;
  try {
    const resp = await fetch(url, {
      headers: { 'x-apisports-key': key }
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('[APIF Proxy]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
// ROUTE: Config status
// ══════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    groq: !!process.env.GROQ_API_KEY,
    odds: !!process.env.ODDS_API_KEY,
    footballData: !!process.env.FOOTBALL_DATA_KEY,
    liveApi: !!process.env.LIVE_API_KEY,
    apifootball: !!process.env.RAPIDAPI_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  });
});

// ══════════════════════════════════════════════
// ROUTES VICTOR IA
// ══════════════════════════════════════════════

// ── ROUTE 1 : GET /api/victor/today ───────────
app.get('/api/victor/today', generalLimiter, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await dbQuery(
      `SELECT * FROM ps_pronostics
       WHERE date = $1
       ORDER BY confiance DESC, cote_estimee DESC`,
      [today]
    );
    res.json({
      date: today,
      total: rows.length,
      pronostics: rows,
      generated_at: rows[0]?.created_at || null,
    });
  } catch (err) {
    console.error('[Victor/today]', err.message);
    res.status(500).json({ error: 'Erreur récupération pronostics du jour' });
  }
});

// ── ROUTE 2 : GET /api/victor/stats ───────────
app.get('/api/victor/stats', generalLimiter, async (req, res) => {
  try {
    // Stats globales
    const { rows: globalRows } = await dbQuery(`
      SELECT
        COUNT(*)                                                                     AS total,
        COUNT(*) FILTER (WHERE pronostic_correct = true)                             AS corrects,
        ROUND(AVG(CASE WHEN pronostic_correct = true THEN 1.0 ELSE 0 END) * 100, 2) AS taux_global,
        ROUND(AVG(CASE
          WHEN (confiance ILIKE '%lev%' OR confiance ILIKE 'forte' OR confiance ILIKE 'très forte') AND pronostic_correct = true  THEN 1.0
          WHEN (confiance ILIKE '%lev%' OR confiance ILIKE 'forte' OR confiance ILIKE 'très forte') AND pronostic_correct = false THEN 0
        END) * 100, 2)                                                               AS taux_eleve,
        ROUND(AVG(CASE
          WHEN confiance ILIKE 'moy%' AND pronostic_correct = true  THEN 1.0
          WHEN confiance ILIKE 'moy%' AND pronostic_correct = false THEN 0
        END) * 100, 2)                                                               AS taux_moyen
      FROM ps_pronostics
      WHERE pronostic_correct IS NOT NULL
    `);

    // Stats par sport
    const { rows: sportRows } = await dbQuery(`
      SELECT sport,
        COUNT(*)                                                                     AS total,
        COUNT(*) FILTER (WHERE pronostic_correct = true)                             AS corrects,
        ROUND(AVG(CASE WHEN pronostic_correct = true THEN 1.0 ELSE 0 END) * 100, 2) AS taux
      FROM ps_pronostics
      WHERE pronostic_correct IS NOT NULL
      GROUP BY sport
      ORDER BY taux DESC
    `);

    // Dernière entrée stats journalières
    const { rows: statsRows } = await dbQuery(
      'SELECT * FROM ps_victor_stats ORDER BY date DESC LIMIT 1'
    );

    const g = globalRows[0];
    const total = parseInt(g.total) || 0;
    const taux  = parseFloat(g.taux_global) || 0;

    res.json({
      global: {
        total,
        corrects:    parseInt(g.corrects) || 0,
        taux_global: taux,
        taux_eleve:  parseFloat(g.taux_eleve)  || null,
        taux_moyen:  parseFloat(g.taux_moyen)  || null,
      },
      par_sport:   sportRows,
      derniere_maj: statsRows[0] || null,
      message_victor: total > 0
        ? `${total} pronostics vérifiés. Taux de réussite : ${taux}%`
        : 'Aucun pronostic vérifié pour le moment.',
    });
  } catch (err) {
    console.error('[Victor/stats]', err.message);
    res.status(500).json({ error: 'Erreur récupération statistiques' });
  }
});

// ── ROUTE 3 : GET /api/victor/patterns ────────
app.get('/api/victor/patterns', generalLimiter, async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT * FROM ps_victor_patterns
       WHERE actif = true
       ORDER BY taux_confirmation DESC`
    );

    res.json({
      total:     rows.length,
      forts:     rows.filter(p => parseFloat(p.taux_confirmation) >= 70),
      moyens:    rows.filter(p => parseFloat(p.taux_confirmation) >= 55 && parseFloat(p.taux_confirmation) < 70),
      emergents: rows.filter(p => parseFloat(p.taux_confirmation) < 55),
    });
  } catch (err) {
    console.error('[Victor/patterns]', err.message);
    res.status(500).json({ error: 'Erreur récupération patterns' });
  }
});

// ── ROUTE 4 : GET /api/victor/history ─────────
app.get('/api/victor/history', generalLimiter, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await dbQuery(
      `SELECT * FROM ps_pronostics
       WHERE date >= NOW() - INTERVAL '${days} days'
         AND pronostic_correct IS NOT NULL
       ORDER BY date DESC`,
    );

    const corrects = rows.filter(r => r.pronostic_correct === true).length;
    const taux = rows.length > 0
      ? Math.round((corrects / rows.length) * 100 * 100) / 100
      : 0;

    res.json({
      periode:    `${days} jours`,
      total:      rows.length,
      corrects,
      taux,
      pronostics: rows,
    });
  } catch (err) {
    console.error('[Victor/history]', err.message);
    res.status(500).json({ error: 'Erreur récupération historique' });
  }
});

// ── ROUTE 5 : POST /api/victor/refresh ────────
app.post('/api/victor/refresh', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const expected = process.env.VICTOR_API_KEY;

  if (!expected || apiKey !== expected) {
    return res.status(401).json({ error: 'Non autorisé — x-api-key invalide' });
  }

  console.log('🔄 [Victor/refresh] Refresh manuel demandé');

  // Lance en arrière-plan sans bloquer la réponse
  runVictor().catch(err =>
    console.error('❌ [Victor/refresh] Erreur background:', err.message)
  );

  res.json({
    status: 'started',
    message: 'Victor lance l\'analyse... Résultats dans /api/victor/today dans 30-60 secondes.',
  });
});

// ── ROUTE keepalive — évite le sleep Render free tier ──
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) });
});

// ── ROUTE 6 : GET /api/victor/status ──────────
app.get('/api/victor/status', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbTime   = null;
  let pronosticsToday = 0;
  let patternsActifs  = 0;

  try {
    const { rows } = await dbQuery('SELECT NOW() as db_time');
    dbStatus = 'connected';
    dbTime   = rows[0].db_time;
  } catch { /* db error handled below */ }

  if (dbStatus === 'connected') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [p, pa] = await Promise.all([
        dbQuery('SELECT COUNT(*) FROM ps_pronostics WHERE date = $1', [today]),
        dbQuery('SELECT COUNT(*) FROM ps_victor_patterns WHERE actif = true'),
      ]);
      pronosticsToday = parseInt(p.rows[0].count) || 0;
      patternsActifs  = parseInt(pa.rows[0].count) || 0;
    } catch { /* counts fallback to 0 */ }
  }

  res.json({
    status:           dbStatus === 'connected' ? 'ok' : 'degraded',
    db:               dbStatus,
    db_time:          dbTime,
    ia_moteur:        process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : 'missing',
    telegram:         process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
    pronostics_today: pronosticsToday,
    patterns_actifs:  patternsActifs,
    version:          '4.1.0',
    uptime:           Math.round(process.uptime()),
  });
});

// ── Static files (après toutes les routes API) ──
app.use(express.static(join(__dirname, 'public')));

// ── SPA Fallback ──
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  ⚡ PronoSight v4.1 — http://localhost:${PORT}\n`);
  console.log('  APIs configurées:');
  console.log(`    Gemini:         ${process.env.GEMINI_API_KEY    ? '✅' : '❌ manquante'}`);
  console.log(`    Groq (fallback):${process.env.GROQ_API_KEY      ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Gemini (Victor):${process.env.GEMINI_API_KEY    ? '✅ ACTIF' : '❌ manquante'}`);
  console.log(`    Groq/Gemma (fallback):${process.env.GROQ_API_KEY ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Odds API:       ${process.env.ODDS_API_KEY      ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Football-Data:  ${process.env.FOOTBALL_DATA_KEY ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    API-Football:   ${process.env.RAPIDAPI_KEY      ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    PostgreSQL:     ${process.env.DATABASE_URL      ? '✅' : '❌ manquante'}`);
  console.log(`    Telegram:       ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '⚠️  optionnelle'}\n`);

  // Démarrage du scheduler Victor
  startScheduler();
  console.log('🎙️  PronoSight v4.1 — Victor opérationnel\n');
});