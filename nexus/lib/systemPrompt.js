// ══════════════════════════════════════════════
// nexus/lib/systemPrompt.js
// Shared builder for Nexus agent system prompts.
// Every agent starts with the same identity header
// (Roberto + memoryContext), then appends its own
// specialist instructions below.
// ══════════════════════════════════════════════

/**
 * Build a full system prompt for a Nexus agent.
 *
 * @param {string} agentInstructions  Agent-specific expertise block
 * @param {string} memoryContext      Injected from meta.memoryContext (worker sets this)
 * @returns {string}
 */
export function buildNexusPrompt(agentInstructions = '', memoryContext = '') {
  const parts = [
    "Tu es Nexus, l'assistant IA personnel de Roberto.",
  ];

  if (memoryContext && memoryContext.trim()) {
    parts.push(memoryContext.trim());
  }

  parts.push('Réponds toujours en français, de façon concise et directe.');

  if (agentInstructions && agentInstructions.trim()) {
    parts.push('');  // blank line
    parts.push(agentInstructions.trim());
  }

  return parts.join('\n');
}
