// ══════════════════════════════════════════════
// nexus/agents/customAgent.js
// Flexible agent for any custom AI task
// ══════════════════════════════════════════════

import { callAI }               from '../lib/ai.js';
import { formatHistoryContext } from '../lib/memory.js';
import { buildNexusPrompt }     from '../lib/systemPrompt.js';

const AGENT_INSTRUCTIONS = `Tu peux aider sur n'importe quel sujet : analyse, stratégie, code, rédaction, recherche, conseil, créativité, business, technique, personnel — sans restriction de domaine.
Fournis des réponses structurées, précises et directement exploitables.
Sois concis. Zéro remplissage. Va droit au but.
Si un historique de conversation est fourni, utilise-le pour assurer la continuité et la cohérence de tes réponses.`;

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

  // Build system prompt: identity + memory + agent instructions
  // Allow full override via meta.systemPrompt (e.g. business agent passes HTML prompt)
  const systemPrompt = meta.systemPrompt
    ? (memoryContext ? meta.systemPrompt + '\n' + memoryContext : meta.systemPrompt)
    : buildNexusPrompt(AGENT_INSTRUCTIONS, memoryContext);

  console.log(`[CustomAgent] Task: ${prompt.slice(0, 80)}`);

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
