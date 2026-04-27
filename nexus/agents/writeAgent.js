// ══════════════════════════════════════════════
// nexus/agents/writeAgent.js
// Content generation: articles, reports, messages
// ══════════════════════════════════════════════

import { callAI }           from '../lib/ai.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';

const AGENT_INSTRUCTIONS = `Tu es un rédacteur expert. Tu produis du contenu clair, structuré et adapté au contexte.
Respecte le format demandé (article, rapport, résumé, message, etc.).
Sois précis, professionnel et engageant. Pas de remplissage inutile.`;

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { prompt?, format?, provider?, memoryContext? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runWrite({ input, meta = {} }) {
  const prompt        = meta.prompt || input;
  const format        = meta.format || 'texte libre';
  const memoryContext = meta.memoryContext || '';
  console.log(`[WriteAgent] Rédaction [${format}]: ${prompt.slice(0, 80)}`);

  const systemPrompt = buildNexusPrompt(AGENT_INSTRUCTIONS, memoryContext);

  const fullPrompt = meta.format
    ? `Format attendu: ${meta.format}\n\n${prompt}`
    : prompt;

  const output = await callAI(systemPrompt, fullPrompt, {
    maxTokens: meta.maxTokens || 8192,
    provider:  meta.provider  || undefined,
  });

  return {
    output,
    meta: { agent: 'write', format, length: output.length },
  };
}
