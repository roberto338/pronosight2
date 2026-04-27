// ══════════════════════════════════════════════
// nexus/jarvis.js
// Natural language command parser
// Transforms any message into a Nexus task
// ══════════════════════════════════════════════

import { callAI } from './lib/ai.js';
import { buildMemoryContext } from './lib/longTermMemory.js';

const JARVIS_SYSTEM = `Tu es Jarvis, l'assistant IA personnel de Roberto.
Tu reçois des messages en langage naturel (français ou anglais) et tu les convertis en tâches Nexus structurées.

Retourne UNIQUEMENT du JSON valide. Aucun texte avant ou après:
{
  "type": "research|write|code|monitor|notify|custom|business|vision|radar|planner|exec|api|finance",
  "payload": { ... },
  "priority": 1,
  "explanation": "ce que Nexus va faire en une phrase courte"
}

Priorité: 1=urgent, 2=normal, 3=background

Contexte Roberto — entrepreneur tech:
- Projets: PronoSight (paris sportifs IA), MÉTAFICTION (app mobile fiction), NutriPlan AI (nutrition), Nexus (agent IA), Fruity Arena (production vidéo IA)
- Stack: Node.js, React Native, PostgreSQL, Render, Claude API, Gemini
- URLs: PronoSight=https://pronosight2.onrender.com | NutriPlan=https://nutriplan-ai-w6nc.polsia.app | Nexus=/nexus/dashboard

Règles de mapping:
- "vérifie/check/ping si X tourne/fonctionne/est up" → monitor + url du projet
- "recherche/trouve/qu'est-ce que/actualités/news" → research
- "écris/rédige/génère un article/post/email/contenu" → write
- "lance/crée/démarre un business/SaaS/startup" → business + { idea, market, budget }
- "calcule/analyse des données/stats" → exec
- "écris du code/génère un script" → code
- "appelle une API/récupère depuis" → api
- "navigue sur/récupère le prix de/scrape" → browser
- "analyse ce screenshot/image" → vision
- "paris/match/pronostic/cote/radar" → radar
- "planifie/décompose/fais-moi un plan" → planner
- "bankroll/mise/bet/finance" → finance
- tout le reste → custom + { prompt: message }

Payload par type:
- research: { query: "..." }
- write: { format: "article|email|post|rapport", topic: "...", style: "pro|casual" }
- monitor: { url: "...", type: "url" }
- business: { idea: "...", market: "...", budget: 0 }
- exec: { task: "..." }
- code: { prompt: "...", language: "JS|Python|SQL|HTML" }
- api: { description: "..." }
- custom: { prompt: "..." }
- radar: { match: "...", mode: "pre-match|live|value" }
- planner: { goal: "..." }`;

/**
 * Parse a natural language message into a structured Nexus task.
 *
 * @param {string} message    User's message
 * @param {string|null} chatId For memory context personalization
 * @returns {Promise<{type, payload, priority, explanation}>}
 */
export async function parseNaturalCommand(message, chatId = null) {
  try {
    // Inject recent memories for better personalization
    const memCtx  = await buildMemoryContext('custom', message, 6);
    const system  = memCtx ? JARVIS_SYSTEM + memCtx : JARVIS_SYSTEM;

    const raw = await callAI(system, message, {
      maxTokens:   500,
      temperature: 0.1,
      provider:    'claude',
    });

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Jarvis response');

    const cleaned = match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    const parsed  = JSON.parse(cleaned);

    return {
      type:        parsed.type        || 'custom',
      payload:     parsed.payload     || { prompt: message },
      priority:    Number(parsed.priority)    || 2,
      explanation: parsed.explanation || 'Traitement en cours...',
    };
  } catch (err) {
    console.error('[Jarvis] Parse error:', err.message);
    // Graceful fallback: treat as custom task
    return {
      type:        'custom',
      payload:     { prompt: message },
      priority:    2,
      explanation: 'Je traite ça comme une demande personnalisée.',
    };
  }
}

/**
 * Map a Jarvis-parsed task to the agentType + input format used by dispatchTask.
 *
 * @param {{ type, payload }} task
 * @returns {{ agentType, input, meta }}
 */
export function jarvisTaskToDispatch(task) {
  const { type, payload } = task;

  // Derive a natural language "input" from payload for logging/storage
  const input =
    payload.prompt    ||
    payload.query     ||
    payload.goal      ||
    payload.topic     ||
    payload.task      ||
    payload.idea      ||
    payload.match     ||
    payload.description ||
    JSON.stringify(payload).slice(0, 200);

  // Merge everything into meta so agents can read structured fields
  return { agentType: type, input, meta: payload };
}
