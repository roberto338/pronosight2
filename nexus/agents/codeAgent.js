// ══════════════════════════════════════════════
// nexus/agents/codeAgent.js
// Code generation and review via Claude
// ══════════════════════════════════════════════

import { callAI } from '../lib/ai.js';

const SYSTEM = `Tu es un développeur senior expert. Tu génères du code propre, commenté et fonctionnel.
Respecte les conventions du projet. Utilise les imports ES6 (import/export).
Si on te demande une review, identifie les bugs, les risques et les améliorations possibles.
Réponds en markdown avec des blocs de code bien formatés.
Ne génère que ce qui est demandé — pas de boilerplate inutile.`;

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { prompt?, language?, provider? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runCode({ input, meta = {} }) {
  const prompt   = meta.prompt   || input;
  const language = meta.language || 'JavaScript';
  console.log(`[CodeAgent] Code [${language}]: ${prompt.slice(0, 80)}`);

  const fullPrompt = `Langage: ${language}\n\n${prompt}`;

  const output = await callAI(SYSTEM, fullPrompt, {
    maxTokens: meta.maxTokens || 8192,
    provider:  'claude', // Claude preferred for code quality
  });

  return {
    output,
    meta: { agent: 'code', language, promptLength: prompt.length },
  };
}
