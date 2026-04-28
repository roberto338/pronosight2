// ══════════════════════════════════════════════
// nexus/agents/customAgent.js
// Flexible agent for any custom AI task
// ══════════════════════════════════════════════

import { callAI }               from '../lib/ai.js';
import { formatHistoryContext } from '../lib/memory.js';
import { buildNexusPrompt }     from '../lib/systemPrompt.js';
import { query }                from '../../db/database.js';

const AGENT_INSTRUCTIONS = `Tu peux aider sur n'importe quel sujet : analyse, stratégie, code, rédaction, recherche, conseil, créativité, business, technique, personnel — sans restriction de domaine.
Fournis des réponses structurées, précises et directement exploitables.
Sois concis. Zéro remplissage. Va droit au but.
Si un historique de conversation est fourni, utilise-le pour assurer la continuité et la cohérence de tes réponses.`;

// ── Stats question detection ─────────────────────
// Detects questions about usage frequency / counts
const STATS_PATTERN = /\b(combien|nombre\s+de\s+fois|utilisé|utilisation|statistics?|stats?|statistiques?|fréquence|souvent|times?\b|usage|how\s+many|count)\b/i;

/**
 * Fetch all LTM feedback entries and return them as an
 * authoritative context block for stats questions.
 * These values MUST take priority over any live DB count.
 */
async function getLTMFeedbackContext() {
  try {
    const { rows } = await query(
      `SELECT key, value FROM nexus_ltm
       WHERE category = 'feedback' AND confidence > 0
       ORDER BY times_confirmed DESC, last_seen DESC
       LIMIT 15`
    );
    if (!rows.length) return '';
    const lines = rows.map(r => `- ${r.key}: ${r.value}`).join('\n');
    console.log(`[CustomAgent] LTM feedback: ${rows.length} entrées chargées`);
    return (
      `\n\n## Statistiques d'usage (LTM — PRIORITÉ ABSOLUE):\n` +
      `${lines}\n` +
      `⚠️ Utilise UNIQUEMENT ces chiffres pour répondre aux questions sur les comptages et statistiques. ` +
      `Ne recalcule PAS depuis la base de données — les valeurs LTM font foi.`
    );
  } catch (err) {
    console.warn('[CustomAgent] LTM feedback fetch error:', err.message);
    return '';
  }
}

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { prompt?, systemPrompt?, provider?, useSearch?, maxTokens?, memoryContext?, chatId? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runCustom({ input, meta = {} }) {
  const prompt        = meta.prompt || input;
  const provider      = meta.provider;
  const memoryContext = meta.memoryContext || '';

  // Bug 1 fix: for stats questions, explicitly fetch LTM feedback category
  // (it's cut off by the priority limit in buildMemoryContext for 'custom' agent)
  let ltmFeedback = '';
  if (STATS_PATTERN.test(prompt)) {
    ltmFeedback = await getLTMFeedbackContext();
  }
  const effectiveContext = memoryContext + ltmFeedback;

  // Build system prompt: identity + memory + agent instructions
  // Allow full override via meta.systemPrompt (e.g. business agent passes HTML prompt)
  const systemPrompt = meta.systemPrompt
    ? (effectiveContext ? meta.systemPrompt + '\n' + effectiveContext : meta.systemPrompt)
    : buildNexusPrompt(AGENT_INSTRUCTIONS, effectiveContext);

  console.log(`[CustomAgent] Task: ${prompt.slice(0, 80)} | memory: ${effectiveContext.length}c`);

  // Inject conversational history (short-term) into user message
  let contextualPrompt = prompt;
  if (meta.chatId) {
    const historyContext = await formatHistoryContext(meta.chatId);
    if (historyContext) {
      contextualPrompt = historyContext + '\nMessage actuel: ' + prompt;
    }
  }

  const output = await callAI(systemPrompt, contextualPrompt, {
    maxTokens:  meta.maxTokens  || 4096,
    useSearch:  meta.useSearch  || false,
    provider,
  });

  return {
    output,
    meta: { agent: 'custom', promptLength: prompt.length, provider: provider || 'auto' },
  };
}
