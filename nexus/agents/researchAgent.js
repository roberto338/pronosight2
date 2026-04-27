// ══════════════════════════════════════════════
// nexus/agents/researchAgent.js
// Real-time research via Gemini + Google Search
// ══════════════════════════════════════════════

import { callGemini }       from '../lib/ai.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';

const AGENT_INSTRUCTIONS = `Tu es un agent de recherche expert. Tu utilises Google Search pour obtenir des informations récentes et fiables.
Fournis des réponses structurées, factuelles, et cite tes sources quand possible.
Sois concis et précis. Ne fabrique jamais d'informations.
Si une information n'est pas disponible ou vérifiable, dis-le explicitement.`;

/**
 * @param {Object} ctx
 * @param {string} ctx.input   Research query
 * @param {Object} ctx.meta    { query?, maxTokens?, memoryContext? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runResearch({ input, meta = {} }) {
  const searchQuery   = meta.query || input;
  const memoryContext = meta.memoryContext || '';
  console.log(`[ResearchAgent] Recherche: ${searchQuery.slice(0, 80)}`);

  const systemPrompt = buildNexusPrompt(AGENT_INSTRUCTIONS, memoryContext);

  const output = await callGemini(systemPrompt, searchQuery, {
    useSearch:   true,
    maxTokens:   meta.maxTokens || 4096,
    temperature: 0.3,
  });

  return {
    output,
    meta: { agent: 'research', query: searchQuery.slice(0, 200), usedSearch: true },
  };
}
