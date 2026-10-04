// ══════════════════════════════════════════════════════════════
// PronoSight v4.1 — Backend Proxy + Victor IA
// ══════════════════════════════════════════════════════════════

// DOIT rester le premier import : charge .env avant que le moindre module
// ne lise process.env. Les imports ESM sont hoistés — un dotenv.config()
// placé dans le corps du fichier s'exécuterait trop tard. Voir config/env.js.
import './config/env.js';

import { createHash } from 'node:crypto';
import {
  ODDS_REGIONS, ODDS_MARKETS, sportKeyValide, bookmakersValides,
  cheminFootballDataAutorise, cheminApiFootballAutorise,
  GEMINI_MAX_TOKENS, refusGemini,
} from './config/proxy-guards.js';

import { startScheduler }          from './cron/scheduler.js';
import { query as dbQuery }         from './db/database.js';
import { runVictor }                from './victor/core.js';
import { getFixturesOfDay, getResultsOfDay } from './victor/sources.js';
import { getOddsEvents, sportDe, cacheLire as cotesDeVictor, cachesActifs } from './victor/odds.js';
import { selectionsDuJour } from './victor/combines.js';
import { regler } from './victor/reglement.js';
import { noterQuota, etatQuota, sitePeutAcheter } from './victor/quota-cotes.js';
import { creerCacheProxyCotes }     from './victor/cache-proxy-cotes.js';
import { bilanVictor, bilanValeursMarche, valeursRecentes } from './victor/valeur-suivi.js';
import { broadcastDaily }           from './bot/telegram.js';
import { startWorker }              from './queues/workerManager.js';
import { installerSurveillanceProcess } from './victor/mortalite.js';
import { victorQueue, addLiveJob, getQueueCounts } from './queues/victorQueue.js';
import { setupQueueDashboard }      from './admin/queueDashboard.js';
import { nexusRouter, startNexusWorker, startNexusCron, startTelegramHandler } from './nexus/index.js';
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

// Le chat Nexus annonce « max 10 MB » (nexus/chat.html) et envoie les fichiers
// en base64, soit ~13,4 MB de JSON. Le plafond global de 1 MB les rejetait tous
// au-delà de ~750 Ko. Parser dédié AVANT le global : body-parser marque req._body
// et le second parser passe son tour. Le plafond large reste confiné à /nexus,
// derrière Basic Auth — l'élargir globalement exposerait les routes publiques.
app.use('/nexus', express.json({ limit: '15mb' }));
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

// /nexus est protégé par mot de passe (Basic Auth) et par clé API, mais sans
// plafond de tentatives le mot de passe reste brute-forçable, et /chat/stream
// consomme des crédits Anthropic à chaque appel. 60/min laisse largement passer
// un usage humain, y compris le polling du chat.
const nexusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  validate: { xForwardedForHeader: false },
  message: { error: '⏳ Trop de requêtes Nexus — attends 1 minute' }
});

// Plafond serré sur l'authentification elle-même : 10 échecs / 15 min.
// requestWasSuccessful est redéfini pour ne compter QUE les 401 — sinon les 404
// légitimes du polling (/nexus/chat/poll/:id) videraient le quota d'un usage normal.
const nexusAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  validate: { xForwardedForHeader: false },
  message: 'Trop de tentatives d\'authentification — réessaie dans 15 minutes'
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
      // Même modèle que le secours de Victor (victor/core.js), bien plus solide
      // que llama-3.1-8b-instant pour un JSON d'analyse complet.
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
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
    const { messages, useSearch = false, jsonMode = false } = req.body;

    // ── Bornes sur ce que l'appelant peut demander ──────────────────
    // Cette route est publique et fait répondre la clé Gemini du serveur —
    // celle dont dépend la production quotidienne de pronostics, et que
    // Gemma partage. Sans bornes, un tiers choisissait le modèle et la
    // taille de réponse : un proxy LLM ouvert sur le quota de Roberto.
    const refus = refusGemini(messages, JSON.stringify(messages || '').length);
    if (refus) return res.status(400).json({ error: { message: refus } });

    // Le frontend demande au plus 6000 tokens (public/js/modules/api.js).
    const maxTokens = Math.min(Number(req.body.maxTokens) || 4096, GEMINI_MAX_TOKENS);

    // Modèle imposé par le serveur : le frontend n'en demande jamais.
    const model = null;

    // ── Clé de cache dérivée du contenu, jamais reçue du client ──────
    // Elle était fournie dans le corps de la requête : deux appelants
    // pouvaient partager une clé, donc lire la réponse l'un de l'autre, ou
    // empoisonner le cache d'un tiers. Un hachage du contenu supprime le
    // problème et rend le cache réellement efficace.
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ messages, useSearch, jsonMode, maxTokens }))
      .digest('hex').slice(0, 32);

    // ── Cache hit ──
    if (cacheKey) {
      const cached = analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        console.log(`[Cache] Hit: ${cacheKey}`);
        return res.json(cached.data);
      }
    }

    // ── 1. Gemini (primaire) ──
    // L'analyse du site passait d'abord par Llama 3.1 8B (Groq) : un petit
    // modèle, aux JSON parfois mal formés et aux textes génériques. Gemini
    // 2.5 Flash est le modèle de Victor ; sa « réflexion » est coupée ici
    // (réponse rapide, et elle consommait le plafond de tokens au point de
    // tronquer le JSON). Les probabilités affichées, elles, viennent toujours
    // des cotes du marché, pas du modèle.
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
        ...(jsonMode && !useSearch ? { responseMimeType: 'application/json' } : {}),
        ...(/^gemini-2\.5-flash/.test(modelName) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      }
    };
    if (useSearch) requestBody.tools = [{ googleSearch: {} }];

    let motifEchec = '';
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await response.json().catch(() => ({}));
      const texte = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (response.ok && !data.error && texte) {
        const formattedResponse = { content: [{ type: 'text', text: texte }] };
        if (cacheKey) analysisCache.set(cacheKey, { data: formattedResponse, ts: Date.now() });
        console.log(`[Gemini] OK (${modelName})`);
        return res.json(formattedResponse);
      }
      motifEchec = data.error?.message || `HTTP ${response.status}${texte ? '' : ', réponse vide'}`;
    } catch (err) {
      motifEchec = err.name === 'TimeoutError' ? 'délai dépassé' : err.message;
    }
    console.warn(`[Gemini] échec (${String(motifEchec).slice(0, 140)}) — bascule Groq`);

    // ── 2. Groq (secours, autre fournisseur ; sans recherche Google) ──
    try {
      const groqResult = await callGroq(messages, maxTokens, jsonMode);
      if (cacheKey) analysisCache.set(cacheKey, { data: groqResult, ts: Date.now() });
      console.log('[Groq] OK (secours)');
      return res.json(groqResult);
    } catch (groqErr) {
      console.error('[Groq secours]', groqErr.message);
      return res.status(503).json({
        error: { message: '⏳ Les moteurs d\'analyse sont saturés. Réessaie dans une minute.' }
      });
    }
  } catch (err) {
    console.error('[Gemini Proxy]', err.message);
    res.status(500).json({ error: { message: 'Erreur serveur proxy: ' + err.message } });
  }
});

// ══════════════════════════════════════════════
// ROUTE: The Odds API Proxy
// ══════════════════════════════════════════════
// ⚠️ regions et markets sont FIGÉS côté serveur, jamais lus dans la query.
//
// The Odds API facture au produit regions × markets : « regions=eu&markets=
// =h2h,totals » coûte 2 crédits, pas 1. En laissant l'appelant choisir, un
// appel forgé avec 4 régions et 4 marchés coûtait 16 crédits. À 20 requêtes
// par minute autorisées, le quota mensuel entier (500) partait en moins de
// deux minutes — et sans cotes, Victor ne peut plus rien arbitrer.
//
// Le frontend n'a jamais demandé autre chose que eu + h2h
// (public/js/modules/api.js:312) : figer ne lui retire rien et ramène le
// coût de 16 crédits à 1.



// Cache et budget quotidien : voir victor/cache-proxy-cotes.js. Sans eux,
// chaque visiteur consommait les crédits dont Victor a besoin pour publier.
const cacheProxyCotes = creerCacheProxyCotes();

app.get('/api/odds/:sportKey', oddsLimiter, async (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(404).json({ error: 'Clé Odds API non configurée' });
  }

  try {
    const { sportKey } = req.params;
    // Le sportKey atterrit dans le chemin de l'URL amont : on le borne à la
    // forme réelle des clés The Odds API (soccer_epl, soccer_france_ligue_one…).
    if (!sportKeyValide(sportKey)) {
      return res.status(400).json({ error: 'sportKey invalide' });
    }
    const { bookmakers } = req.query;

    // Victor a souvent déjà payé ces cotes le matin (même process, même
    // cache) : on les sert gratuitement plutôt que de racheter un crédit.
    const deVictor = cotesDeVictor(sportKey);
    if (deVictor) return res.set('X-Cotes-Cache', 'victor').json(deVictor);

    const cle = `${sportKey}|${bookmakers && bookmakersValides(bookmakers) ? bookmakers : ''}`;
    const frais = cacheProxyCotes.frais(cle);
    if (frais) return res.set('X-Cotes-Cache', 'frais').json(frais);
    // Deux plafonds : le budget du jour du site, et la réserve mensuelle de
    // Victor (victor/quota-cotes.js). Au-delà, cotes périmées si on en a,
    // sinon rien : l'analyse s'affiche alors sans chiffres, jamais inventés.
    if (!cacheProxyCotes.peutPayer() || !sitePeutAcheter()) {
      const perime = cacheProxyCotes.perime(cle);
      if (perime) return res.set('X-Cotes-Cache', 'perime').json(perime);
      return res.status(503).json({ error: sitePeutAcheter()
        ? 'Cotes momentanément indisponibles (quota du jour atteint)'
        : 'Cotes réservées aux analyses de Victor jusqu\'à la fin du mois' });
    }

    const params = new URLSearchParams({
      apiKey,
      regions: ODDS_REGIONS,
      markets: ODDS_MARKETS,
      oddsFormat: 'decimal'
    });
    // bookmakers filtre la réponse sans multiplier le coût — on le conserve.
    if (bookmakers && bookmakersValides(bookmakers)) params.set('bookmakers', bookmakers);

    const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds/?${params}`;
    const response = await fetch(url);
    noterQuota(response.headers);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Odds API HTTP ' + response.status });
    }

    const data = await response.json();
    cacheProxyCotes.enregistrer(cle, data);
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

    // Liste blanche : le frontend n'appelle que deux formes
    // (public/js/modules/api.js — competitions/<code>/matches et /standings).
    // Sans elle, n'importe quel endpoint football-data était atteignable via
    // le proxy, et surtout n'importe quel volume d'appels : le palier gratuit
    // plafonne à 10 requêtes/minute, partagées avec victor/sources.js qui en
    // consomme 8 par analyse. Saturer ce débit prive Victor de TOUTE sa couche
    // statistique — forme, classement, confrontations directes, buteurs.
    if (!cheminFootballDataAutorise(fdPath)) {
      return res.status(400).json({ error: 'Chemin football-data non autorisé' });
    }

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

  // Liste blanche : seuls les quatre endpoints appelés par le frontend
  // (public/js/modules/api.js — apifFetch).
  if (!cheminApiFootballAutorise(path)) {
    return res.status(400).json({ error: 'Chemin api-football non autorisé' });
  }

  const qs = new URLSearchParams(req.query).toString();
  const url = `https://v3.football.api-sports.io/${path}${qs ? '?' + qs : ''}`;
  try {
    const resp = await fetch(url, {
      headers: { 'x-apisports-key': key }
    });
    const data = await resp.json();

    // ⚠️ Cette API répond HTTP 200 avec l'erreur dans le corps : un compte
    // suspendu ou un quota épuisé renvoie { errors: { access: "..." } } avec
    // un statut 200. Relayer la réponse telle quelle faisait croire au
    // frontend qu'il avait reçu des données. Le compte est suspendu depuis le
    // 21/08 — sans ce contrôle, l'échec est invisible côté client.
    const errs = data?.errors;
    const enErreur = Array.isArray(errs) ? errs.length > 0 : (errs && Object.keys(errs).length > 0);
    if (enErreur) {
      console.warn('[APIF Proxy] refus amont:', JSON.stringify(errs).slice(0, 200));
      return res.status(502).json({ error: 'api-football indisponible' });
    }

    res.json(data);
  } catch (e) {
    console.error('[APIF Proxy]', e.message);
    res.status(502).json({ error: 'api-football indisponible' });
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
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // Solde The Odds API connu (null tant qu'aucun appel depuis le démarrage).
    cotes_quota: etatQuota(),

    // Quelle version tourne réellement ? Sans ce repère, on en était
    // réduit à deviner via l'uptime après chaque déploiement — et donc
    // à ne jamais pouvoir affirmer que la prod exécute bien le dernier
    // commit. Render renseigne RENDER_GIT_COMMIT automatiquement.
    commit:  (process.env.RENDER_GIT_COMMIT || 'inconnu').slice(0, 7),
    branche: process.env.RENDER_GIT_BRANCH || 'inconnue',
    demarre: new Date(Date.now() - process.uptime() * 1000).toISOString(),
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

  console.log('🔄 [Victor/refresh] Refresh manuel demandé → file PostgreSQL');

  try {
    const job = await addLiveJob({ triggeredBy: 'manual-refresh', source: 'api' });
    res.json({
      status:  'queued',
      jobId:   job.id,
      message: `Job live #${job.id} ajouté à la file. Résultats dans /api/victor/today dans 30-90 secondes.`,
    });
  } catch (queueErr) {
    // Fallback synchrone si la BDD est indisponible
    console.warn('⚠️  File indisponible, fallback synchrone:', queueErr.message);
    runVictor().then(async (result) => {
      if (result?.events?.length > 0) {
        await broadcastDaily(result).catch(e => console.error('Telegram:', e.message));
      }
    }).catch(err => console.error('❌ [Victor/refresh] Erreur fallback:', err.message));

    res.json({
      status:  'started',
      message: 'Victor lance l\'analyse (mode direct — file indisponible).',
    });
  }
});

// ── Values de marché et bilan vérifiable (app web) ──
// Mêmes chiffres que /value et /bilan sur Telegram : ce que l'app affiche
// doit pouvoir être recoupé, et rien n'y est arrondi en notre faveur.
app.get('/api/victor/valeurs', generalLimiter, async (req, res) => {
  try {
    const jours = Math.min(Math.max(parseInt(req.query.jours) || 14, 1), 60);
    const rows = await valeursRecentes({ jours });
    const aujourdhui = new Date().toISOString().slice(0, 10);
    res.json({
      date: aujourdhui,
      aujourdhui: rows.filter(r => r.date === aujourdhui),
      notees: rows.filter(r => r.gagne === true || r.gagne === false),
    });
  } catch (err) {
    console.error('[Victor/valeurs]', err.message);
    res.status(500).json({ error: 'Erreur récupération des values de marché' });
  }
});

// ── Sélections combinables : values et pronos RÉELS du jour, à leur vraie cote ──
app.get('/api/combines/selections', generalLimiter, async (req, res) => {
  try {
    const [{ rows: valeurs }, { rows: pronos }] = await Promise.all([
      dbQuery(`SELECT id, match, competition, debut_utc, pari_code, libelle, cote, bookmaker, proba_juste
               FROM ps_valeurs_marche WHERE date = CURRENT_DATE`),
      dbQuery(`SELECT id, to_char(date, 'YYYY-MM-DD') AS date, heure, equipe_a, equipe_b, competition,
                      pari_code, pronostic_principal, cote_estimee, cote_confirmee
               FROM ps_pronostics WHERE date = CURRENT_DATE AND pronostic_correct IS NULL`),
    ]);
    res.json({
      date: new Date().toISOString().slice(0, 10),
      selections: selectionsDuJour({ valeurs, pronos, caches: cachesActifs() }),
    });
  } catch (err) {
    console.error('[Combinés]', err.message);
    res.status(500).json({ error: 'Sélections indisponibles' });
  }
});

// ── Règlement automatique de « Mes paris » sur les vrais scores ──
// Les résultats d'un jour sont mis en cache : un jour passé ne change plus,
// et chaque lecture coûte des requêtes aux sources (API-Football : 100/jour).
const _cacheResultats = new Map();   // dateISO -> { ts, finis }
async function resultatsDu(dateISO) {
  const recent = Date.now() - Date.parse(`${dateISO}T00:00:00Z`) < 2 * 864e5;
  const ttl = recent ? 15 * 60 * 1000 : 12 * 3600 * 1000;
  const c = _cacheResultats.get(dateISO);
  if (c && Date.now() - c.ts < ttl) return c.finis;
  const finis = await getResultsOfDay(dateISO).catch(() => []);
  _cacheResultats.set(dateISO, { ts: Date.now(), finis });
  return finis;
}

app.post('/api/paris/regler', generalLimiter, async (req, res) => {
  try {
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const paris = (Array.isArray(req.body?.paris) ? req.body.paris : []).slice(0, 40)
      .filter(p => p && typeof p.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') && p.date <= aujourdhui);
    // Le jour du pari et le lendemain (matchs du soir en heure UTC) ; 7 jours distincts au plus.
    const jours = [...new Set(paris.flatMap(p => {
      const lendemain = new Date(Date.parse(`${p.date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
      return lendemain <= aujourdhui ? [p.date, lendemain] : [p.date];
    }))].sort().slice(-7);
    const parJour = new Map();
    for (const j of jours) parJour.set(j, await resultatsDu(j));
    const resultats = paris.map(p => {
      const lendemain = new Date(Date.parse(`${p.date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
      const finis = [...(parJour.get(p.date) || []), ...(parJour.get(lendemain) || [])];
      return regler(p, finis);
    });
    res.json({ resultats });
  } catch (err) {
    console.error('[Paris/régler]', err.message);
    res.status(500).json({ error: 'Règlement indisponible' });
  }
});

app.get('/api/victor/bilan', generalLimiter, async (req, res) => {
  try {
    const [victor, marche] = await Promise.all([bilanVictor(), bilanValeursMarche()]);
    res.json({ victor, marche });
  } catch (err) {
    console.error('[Victor/bilan]', err.message);
    res.status(500).json({ error: 'Erreur récupération du bilan' });
  }
});

// ── ROUTE santé — diagnostic complet du système Victor ──
app.get('/api/victor/health', generalLimiter, async (req, res) => {
  try {
    const { runHealthcheck } = await import('./victor/healthcheck.js');
    const diag = await runHealthcheck({ verifierSources: req.query.sources !== '0' });
    res.status(diag.problemes.length === 0 ? 200 : 503).json({
      ok: diag.problemes.length === 0,
      ...diag,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// ROUTE: matchs du jour — source unique de vérité
//
// Le front maintenait sa propre table d'identifiants TheSportsDB
// (TSDB_LEAGUE_MAP). 14 correspondances sur 38 étaient fausses :
// « Coupe du Monde » renvoyait la WWE, « League Cup » l'UFC,
// « Conference League » l'EliteXC. Les identifiants 4395-4399 se
// suivaient et désignaient cinq compétitions sans rapport — devinés
// en séquence, jamais vérifiés.
//
// Cette route expose les mêmes matchs normalisés que Victor consomme.
// Le front cesse de deviner : il lit ce qui se joue réellement.
// ══════════════════════════════════════════════
const _cacheMatchs = new Map();          // dateISO -> { ts, charge }
const CACHE_MATCHS_MS = 2 * 60 * 1000;   // assez frais pour l'onglet Live

app.get('/api/matchs', generalLimiter, async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  const enCache = _cacheMatchs.get(date);
  if (enCache && Date.now() - enCache.ts < CACHE_MATCHS_MS) {
    return res.json({ ...enCache.charge, cache: true });
  }

  try {
    const extra    = await getOddsEvents(date).catch(() => []);
    const fixtures = await getFixturesOfDay(date, { extra });

    // Regroupement par compétition, tel que le front l'affichera
    const parCompet = new Map();
    for (const f of fixtures) {
      const cle = `${f.sport} — ${f.competition}`;
      if (!parCompet.has(cle)) {
        parCompet.set(cle, { sport: f.sport, competition: f.competition, nbMatchs: 0, aVenir: 0 });
      }
      const c = parCompet.get(cle);
      c.nbMatchs++;
      if (f.status !== 'FT') c.aVenir++;
    }

    const charge = {
      date,
      total:   fixtures.length,
      aVenir:  fixtures.filter(f => f.status !== 'FT').length,
      competitions: [...parCompet.values()].sort((a, b) => b.aVenir - a.aVenir || b.nbMatchs - a.nbMatchs),
      matchs: fixtures.map(f => ({
        sport: f.sport, competition: f.competition, match: f.match,
        equipe_a: f.home, equipe_b: f.away, heure: f.heure, debut_utc: f.debutUTC || null,
        statut: f.status, score: f.homeGoals != null ? `${f.homeGoals}-${f.awayGoals}` : null,
        source: f.source,
        // Clé The Odds API : l'analyse du site va chercher LES cotes de CE
        // championnat, au lieu de la Premier League par défaut.
        sport_key: sportDe(f),
      })),
    };

    _cacheMatchs.set(date, { ts: Date.now(), charge });
    res.json({ ...charge, cache: false });
  } catch (err) {
    console.error('[/api/matchs]', err.message);
    res.status(500).json({ error: 'Calendrier indisponible', detail: err.message });
  }
});

// ── ROUTE keepalive — évite le sleep Render free tier ──
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) });
});

// ── ROUTE diagnostic file de jobs ──────────────
app.get('/api/queue-status', async (req, res) => {
  try {
    const counts = await getQueueCounts();
    res.json({ backend: 'postgres', table: 'victor_jobs', counts });
  } catch (e) {
    res.status(500).json({ backend: 'postgres', error: e.message });
  }
});

// ── ROUTE 6 : GET /api/victor/status ──────────
app.get('/api/victor/status', async (req, res) => {
  // Helper : timeout sur n'importe quelle promesse
  const withTimeout = (p, ms, fallback) =>
    Promise.race([p, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

  let dbStatus = 'disconnected';
  let dbTime   = null;
  let pronosticsToday = 0;
  let patternsActifs  = 0;

  // DB avec timeout 5 s
  try {
    const result = await withTimeout(dbQuery('SELECT NOW() as db_time'), 5000, null);
    if (result) {
      dbStatus = 'connected';
      dbTime   = result.rows[0].db_time;
    } else {
      dbStatus = 'timeout';
    }
  } catch { dbStatus = 'error'; }

  if (dbStatus === 'connected') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const counts = await withTimeout(Promise.all([
        dbQuery('SELECT COUNT(*) FROM ps_pronostics WHERE date = $1', [today]),
        dbQuery('SELECT COUNT(*) FROM ps_victor_patterns WHERE actif = true'),
      ]), 5000, null);
      if (counts) {
        pronosticsToday = parseInt(counts[0].rows[0].count) || 0;
        patternsActifs  = parseInt(counts[1].rows[0].count) || 0;
      }
    } catch { /* counts fallback to 0 */ }
  }

  // ── État de la file PostgreSQL ───────────────
  let queueCounts = null;
  try {
    queueCounts = await withTimeout(getQueueCounts(), 3000, null);
  } catch { /* file indisponible = counts null */ }

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
    queue: {
      backend: 'postgres',
      active:  !!victorQueue,
      counts:  queueCounts,
    },
  });
});

// ── Nexus multi-agent system ──────────────────
app.use('/nexus', nexusAuthLimiter, nexusLimiter, nexusRouter);

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
  console.log(`    Gemma (fallback):${process.env.GEMINI_API_KEY   ? `✅ (${process.env.GEMMA_MODEL || 'gemma-3-27b-it'})` : '❌ (nécessite GEMINI_API_KEY)'}`);
  console.log(`    Odds API:       ${process.env.ODDS_API_KEY      ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    Football-Data:  ${process.env.FOOTBALL_DATA_KEY ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    API-Football:   ${process.env.RAPIDAPI_KEY      ? '✅' : '⚠️  optionnelle'}`);
  console.log(`    PostgreSQL:     ${process.env.DATABASE_URL      ? '✅' : '❌ manquante'}`);
  console.log(`    Telegram:       ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '⚠️  optionnelle'}\n`);

  // ── Surveillance du process ───────────────────
  // À installer AVANT le worker : c'est pendant les jobs lourds que le
  // process meurt, et jusqu'ici sans laisser la moindre trace.
  try {
    installerSurveillanceProcess();
  } catch (survErr) {
    console.warn('⚠️  Surveillance process non installée:', survErr.message);
  }

  // ── Démarrage Worker Victor (poller PostgreSQL) ──
  try {
    startWorker();
  } catch (workerErr) {
    console.warn('⚠️  Worker Victor non démarré:', workerErr.message);
  }

  // ── Dashboard file Victor ─────────────────────
  try {
    setupQueueDashboard(app);
  } catch (boardErr) {
    console.warn('⚠️  Dashboard file non monté:', boardErr.message);
  }

  // ── Démarrage du scheduler Victor ────────────
  startScheduler();

  // ── Nexus multi-agent system ──────────────────
  //
  // En veille par défaut. Nexus déclenchait 17 tâches planifiées, dont une
  // toutes les 30 minutes, chacune suivie d'appels IA et d'écritures en
  // base. Sur le palier gratuit Neon, ce travail de fond consommait le
  // quota mensuel avant la fin du mois — épuisé le 18/08 à 01:26, base
  // injoignable, Victor à l'arrêt avec elle.
  //
  // Le worker, lui, reste démarré : depuis qu'il est réveillé à
  // l'insertion au lieu de sonder, il ne coûte plus rien au repos. Et il
  // est indispensable — c'est LUI qui répond aux commandes Telegram et au
  // chat web. Le couper rendrait Nexus muet plutôt qu'économe.
  //
  // Pour réactiver les planifications : NEXUS_MODE=actif sur Render.
  const nexusMode = (process.env.NEXUS_MODE || 'veille').toLowerCase();
  try {
    startNexusWorker();
    startTelegramHandler();
    if (nexusMode === 'actif') {
      startNexusCron();
      console.log('🧠 Nexus ACTIF — tâches planifiées comprises');
    } else {
      console.log('😴 Nexus EN VEILLE — chat et bot répondent, aucune tâche planifiée');
      console.log('   (NEXUS_MODE=actif pour réactiver les 17 planifications)');
    }
  } catch (nexusErr) {
    console.warn('⚠️  Nexus non démarré:', nexusErr.message);
  }
  // ── Maintien en éveil ─────────────────────────
  // La route /api/ping existait avec le commentaire « évite le sleep
  // Render free tier »… mais rien ne l'appelait. Le service s'endormait
  // donc après ~15 min sans trafic, et le worker avec lui.
  //
  // Constaté le 07/08/2026 : le job prematch de 7h00 est resté 40 minutes
  // en file avant d'être pris, puis a été interrompu trois fois de suite.
  // Les temps d'exécution réels sont pourtant de 13 à 39 secondes : le
  // problème n'a jamais été la lenteur, mais l'endormissement.
  //
  // Une requête sur l'URL publique compte comme trafic entrant côté
  // Render : c'est ce qui empêche la mise en veille.
  const urlPublique = process.env.RENDER_EXTERNAL_URL;
  if (urlPublique) {
    const PERIODE_MS = 10 * 60 * 1000; // < 15 min, le seuil de Render
    setInterval(async () => {
      try {
        const r = await fetch(`${urlPublique}/api/ping`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) console.warn(`⚠️  Maintien en éveil: HTTP ${r.status}`);
      } catch (err) {
        console.warn('⚠️  Maintien en éveil échoué:', err.name === 'TimeoutError' ? 'timeout' : err.message);
      }
    }, PERIODE_MS).unref(); // n'empêche pas un arrêt propre du process
    console.log(`    Maintien éveil: ✅ ping toutes les 10 min sur ${urlPublique}`);
  } else {
    console.log('    Maintien éveil: ⚠️  RENDER_EXTERNAL_URL absente (normal en local)');
  }

  console.log('    File de jobs:   ✅ PostgreSQL (victor_jobs) — zéro Redis');
  console.log('🎙️  PronoSight v4.1 — Victor opérationnel\n');
});