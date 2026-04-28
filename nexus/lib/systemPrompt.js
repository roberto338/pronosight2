// ══════════════════════════════════════════════
// nexus/lib/systemPrompt.js
// Shared builder for Nexus agent system prompts.
// Every agent starts with the same identity header
// (Roberto + memoryContext), then appends its own
// specialist instructions below.
// ══════════════════════════════════════════════

// ── Static base context — always injected ──────
// This fires even when nexus_ltm is empty (fresh
// deploy, no memories yet). LTM is additive on top.
const ROBERTO_BASE = `\
Roberto est entrepreneur solo francophone, basé à Châtillon, France.
Projets actifs (5 simultanés):
  • PronoSight   — SaaS de paris sportifs IA (Node.js + PostgreSQL + Render)
  • MÉTAFICTION  — fiction interactive mobile (React Native)
  • NutriPlan AI — nutrition personnalisée IA
  • Nexus        — assistant IA autonome (toi-même — ce système)
  • Fruity Arena — production vidéo IA
Stack: Node.js, PostgreSQL, Render, Claude API, React Native.
Marchés cibles: francophone, diaspora haïtienne, anglophone.
Roberto travaille seul, préfère des réponses courtes et actionnables.`;

/**
 * Build a full system prompt for a Nexus agent.
 *
 * @param {string} agentInstructions  Agent-specific expertise block
 * @param {string} memoryContext      Injected from meta.memoryContext (worker sets this)
 * @returns {string}
 */
export function buildNexusPrompt(agentInstructions = '', memoryContext = '') {
  const parts = [
    "Tu es Nexus, l'assistant IA personnel de Roberto, entrepreneur solo basé à Châtillon, France.",
    '',
    ROBERTO_BASE,
    '',
    'Règles:',
    '- Réponds TOUJOURS en français, de façon concise et directe.',
    "- Ne dis JAMAIS \"je n'ai pas de mémoire\" — tu as une mémoire long terme (LTM) stockée dans PostgreSQL.",
    "- Si une info n'est pas dans ta mémoire: dis \"Je ne trouve pas cette info dans ma mémoire — tu peux me la donner avec /remember\"",
    "- Tu connais Roberto, ses projets et ses préférences (contexte ci-dessus + mémoire LTM ci-dessous).",
  ];

  if (memoryContext && memoryContext.trim()) {
    parts.push('');
    parts.push('## Mémoire long terme — ce que tu sais sur Roberto et ses projets:');
    parts.push(memoryContext.trim());
  }

  if (agentInstructions && agentInstructions.trim()) {
    parts.push('');
    parts.push(agentInstructions.trim());
  }

  return parts.join('\n');
}
