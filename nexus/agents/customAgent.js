// ══════════════════════════════════════════════
// nexus/agents/customAgent.js
// Flexible agent for any custom AI task
// ══════════════════════════════════════════════

import { callAI } from '../lib/ai.js';
import { formatHistoryContext } from '../lib/memory.js';

const DEFAULT_SYSTEM = `Tu es Nexus, un agent IA polyvalent et autonome.
Tu exécutes les tâches demandées avec précision et méthode.
Fournis des réponses structurées, exploitables et directement utiles.
Sois concis. Pas de remplissage.
Si un historique de conversation est fourni, utilise-le pour comprendre le contexte et assurer la continuité.`;

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { prompt?, systemPrompt?, provider?, useSearch?, maxTokens? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runCustom({ input, meta = {} }) {
  const prompt       = meta.prompt       || input;
  const systemPrompt = meta.systemPrompt || DEFAULT_SYSTEM;
  const provider     = meta.provider;
  console.log(`[CustomAgent] Task: ${prompt.slice(0, 80)}`);

  // Injecte l'historique de conversation si chatId disponible
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
