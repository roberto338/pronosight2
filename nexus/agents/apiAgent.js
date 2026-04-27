// ══════════════════════════════════════════════
// nexus/agents/apiAgent.js
// Appelle n'importe quelle API externe
// Gestion des credentials via env vars
// Résumé intelligent de la réponse
// ══════════════════════════════════════════════

import { callAI }           from '../lib/ai.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';

// Credentials disponibles (depuis les env vars du projet)
function getAvailableCredentials() {
  return {
    GEMINI_API_KEY:       !!process.env.GEMINI_API_KEY,
    GROQ_API_KEY:         !!process.env.GROQ_API_KEY,
    ODDS_API_KEY:         !!process.env.ODDS_API_KEY,
    FOOTBALL_DATA_KEY:    !!process.env.FOOTBALL_DATA_KEY,
    RAPIDAPI_KEY:         !!process.env.RAPIDAPI_KEY,
    TELEGRAM_BOT_TOKEN:   !!process.env.TELEGRAM_BOT_TOKEN,
    ANTHROPIC_API_KEY:    !!process.env.ANTHROPIC_API_KEY,
  };
}

const API_SYSTEM = `Tu es un expert en intégration d'APIs REST.
Tu reçois une demande en langage naturel et tu génères un appel API structuré.

Credentials disponibles via variables d'environnement:
- ODDS_API_KEY      → The Odds API (paris sportifs, cotes)
- FOOTBALL_DATA_KEY → football-data.org (matchs, classements, équipes)
- RAPIDAPI_KEY      → API-Football via RapidAPI (stats détaillées)
- GEMINI_API_KEY    → Google Gemini AI
- GROQ_API_KEY      → Groq AI (LLM rapide)
- ANTHROPIC_API_KEY → Claude AI

APIs internes PronoSight disponibles (pas besoin d'auth):
- GET /api/victor/today     → pronostics du jour
- GET /api/victor/stats     → statistiques Victor
- GET /api/victor/patterns  → patterns détectés
- GET /api/status           → état du serveur

Retourne UNIQUEMENT un JSON valide:
{
  "description": "ce que cet appel fait",
  "url": "URL complète avec paramètres",
  "method": "GET|POST|PUT|DELETE",
  "headers": { "key": "value" },
  "body": null,
  "credential_used": "NOM_ENV_VAR ou null",
  "base_url": "https://pronosight2.onrender.com pour les API internes"
}

Pour les credentials, utilise la syntaxe: "Bearer __CREDENTIAL_NAME__"
Ex: { "Authorization": "Bearer __ODDS_API_KEY__" }
Ne jamais mettre la valeur réelle dans le JSON — utilise le placeholder __NOM_VAR__.`;

const SUMMARY_SYSTEM = `Tu es un analyste expert. Tu reçois une réponse JSON d'une API et tu en fais un résumé clair et utile en français.
Extrais les informations les plus pertinentes. Sois concis et structuré. Pas de JSON brut dans ta réponse.`;

/**
 * Remplace les placeholders __VAR__ par les valeurs réelles des env vars
 */
function injectCredentials(obj) {
  const str = JSON.stringify(obj);
  const replaced = str.replace(/__([A-Z_]+)__/g, (_, varName) => {
    return process.env[varName] || '';
  });
  return JSON.parse(replaced);
}

/**
 * @param {Object} ctx
 * @param {string} ctx.input   Description de l'appel API à faire
 * @param {Object} ctx.meta    { summarize?: boolean, rawOutput?: boolean }
 */
export async function runApi({ input, meta = {} }) {
  const task          = meta.task || input;
  const memoryContext = meta.memoryContext || '';
  console.log(`[ApiAgent] Tâche: ${task.slice(0, 80)}`);

  const creds = getAvailableCredentials();
  const credsList = Object.entries(creds)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');

  const apiSystem = buildNexusPrompt(
    API_SYSTEM + `\n\nCredentials actuellement configurés: ${credsList}`,
    memoryContext
  );

  // ── Étape 1 : Génère la spec d'appel ─────────
  let spec;
  try {
    const raw = await callAI(
      apiSystem,
      `Demande: ${task}`,
      { maxTokens: 1024, temperature: 0.1 }
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Réponse non-JSON');
    spec = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`Impossible de parser la demande API: ${err.message}`);
  }

  console.log(`[ApiAgent] Appel: ${spec.method} ${spec.url.slice(0, 80)}`);

  // ── Étape 2 : Injecte les credentials ────────
  const callSpec = injectCredentials(spec);

  // ── Étape 3 : Exécute l'appel ─────────────────
  let responseData;
  let responseStatus;
  try {
    const fetchOpts = {
      method:  callSpec.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(callSpec.headers || {}) },
      signal:  AbortSignal.timeout(15000),
    };
    if (callSpec.body && callSpec.method !== 'GET') {
      fetchOpts.body = JSON.stringify(callSpec.body);
    }

    const resp = await fetch(callSpec.url, fetchOpts);
    responseStatus = resp.status;

    const text = await resp.text();
    try {
      responseData = JSON.parse(text);
    } catch {
      responseData = { raw: text.slice(0, 2000) };
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    throw new Error(`Appel API échoué (${spec.url.slice(0, 60)}): ${err.message}`);
  }

  // ── Étape 4 : Résume la réponse ───────────────
  if (meta.rawOutput) {
    return {
      output: `\`\`\`json\n${JSON.stringify(responseData, null, 2).slice(0, 3000)}\n\`\`\``,
      meta: { agent: 'api', url: spec.url, status: responseStatus },
    };
  }

  const dataStr = JSON.stringify(responseData).slice(0, 4000);
  const summary = await callAI(
    SUMMARY_SYSTEM,
    `Demande originale: ${task}\n\nRéponse API (HTTP ${responseStatus}):\n${dataStr}`,
    { maxTokens: 1024 }
  );

  return {
    output: `🌐 *API: ${spec.description || spec.url.slice(0, 50)}*\n${'─'.repeat(22)}\n\n${summary}`,
    meta: {
      agent:      'api',
      url:        spec.url,
      method:     spec.method,
      status:     responseStatus,
      credential: spec.credential_used || null,
    },
  };
}
