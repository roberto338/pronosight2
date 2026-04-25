// ══════════════════════════════════════════════
// nexus/agents/plannerAgent.js
// Reçoit un objectif → crée un plan → exécute
// chaque étape avec les agents appropriés
// ══════════════════════════════════════════════

import { callAI } from '../lib/ai.js';
import { runResearch } from './researchAgent.js';
import { runWrite    } from './writeAgent.js';
import { runCode     } from './codeAgent.js';
import { runMonitor  } from './monitorAgent.js';
import { runNotify   } from './notifyAgent.js';
import { runCustom   } from './customAgent.js';
import { runRadar    } from './radarAgent.js';
import { runExec     } from './execAgent.js';
import { runApi      } from './apiAgent.js';
import { runBrowser  } from './browserAgent.js';

const AGENT_EXECUTORS = {
  research: runResearch,
  write:    runWrite,
  code:     runCode,
  monitor:  runMonitor,
  notify:   runNotify,
  custom:   runCustom,
  radar:    runRadar,
  exec:     runExec,
  api:      runApi,
  browser:  runBrowser,
};

const PLANNER_SYSTEM = `Tu es un planificateur d'agents IA expert.
Tu reçois un objectif en langage naturel et tu crées un plan d'exécution précis.

IMPORTANT: Retourne UNIQUEMENT du JSON pur et valide. Aucun texte avant ou après. Aucun markdown. Aucun commentaire. Juste le JSON brut.

Format exact:
{
  "goal": "résumé de l'objectif",
  "steps": [
    {
      "step": 1,
      "agent": "research",
      "input": "instruction précise pour cet agent",
      "description": "ce que cette étape accomplit",
      "depends_on_previous": false
    }
  ],
  "estimated_duration": "X minutes"
}

Agents disponibles:
- research : recherche web temps réel (Google Search) — actualités, faits, veille
- write    : rédaction de contenu structuré — articles, rapports, emails, résumés
- code     : génération ou review de code dans n'importe quel langage
- monitor  : surveillance URL, endpoint ou base de données
- notify   : envoi d'une notification Telegram à l'utilisateur
- custom   : tâche IA libre — analyse, conseil, réflexion, réponse générale
- radar    : analyse sportive — paris, statistiques, matchs football
- exec     : écrit et exécute du code Node.js — calculs, transformations, automatisations
- api      : appelle une API externe (REST/JSON) et interprète la réponse
- browser  : navigue sur un site web et extrait des données

Règles:
- Maximum 5 étapes
- Chaque étape doit être précise et actionnable
- depends_on_previous: true si l'étape utilise le résultat de la précédente
- Toujours terminer par une étape "notify" ou "write" pour livrer le résultat final
- Rester réaliste : ne planifie que ce que les agents peuvent réellement faire`;

// ── Helper : notifie le chatId pendant l'exécution ──
async function progress(chatId, msg) {
  if (!chatId) return;
  try {
    const { sendNexusMessage } = await import('../telegramHandler.js');
    await sendNexusMessage(chatId, msg);
  } catch { /* ignore */ }
}

/**
 * Planner agent — décompose un objectif et exécute les étapes
 * @param {Object} ctx
 * @param {string} ctx.input   Objectif en langage naturel
 * @param {Object} ctx.meta    { chatId? }
 */
export async function runPlanner({ input, meta = {} }) {
  const goal   = input;
  const chatId = meta.chatId || null;
  console.log(`[PlannerAgent] Objectif: ${goal.slice(0, 100)}`);

  // Build planner system prompt enriched with long-term memory
  const plannerSystem = meta.memoryContext
    ? PLANNER_SYSTEM + meta.memoryContext
    : PLANNER_SYSTEM;

  // ── Étape 0 : Notifie la création du plan ──
  await progress(chatId, `🧠 *Nexus analyse ton objectif...*\n_Création du plan d'action en cours_`);

  // ── Étape 1 : Génère le plan via IA ──────────
  let plan;
  try {
    const raw = await callAI(plannerSystem, `Objectif: ${goal}`, {
      maxTokens:   1024,
      temperature: 0.2,
    });
    // Extrait le JSON même s'il y a du texte autour
    // Extrait le JSON même si du texte parasite est présent
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Réponse non-JSON');
    // Nettoie les trailing commas invalides avant parse
    const cleaned = match[0]
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    plan = JSON.parse(cleaned);
    if (!plan.steps?.length) throw new Error('Plan sans étapes');
  } catch (err) {
    throw new Error(`Impossible de créer un plan: ${err.message}`);
  }

  // ── Notifie le plan ──────────────────────────
  let planMsg = `📋 *Plan — ${plan.steps.length} étapes*\n${'─'.repeat(22)}\n`;
  plan.steps.forEach(s => {
    const icon = { research:'🔍', write:'✍️', code:'💻', monitor:'📡', notify:'📣', custom:'🤖', radar:'⚽', exec:'⚙️', api:'🔌', browser:'🌐' }[s.agent] || '▸';
    planMsg += `${s.step}. ${icon} *${s.description}*\n`;
  });
  planMsg += `\n⏱ Durée estimée: ${plan.estimated_duration || '2-5 min'}`;
  await progress(chatId, planMsg);

  // ── Étape 2 : Exécute chaque étape ───────────
  const results = [];
  for (const step of plan.steps) {
    console.log(`[PlannerAgent] Étape ${step.step}/${plan.steps.length}: ${step.description}`);

    await progress(chatId,
      `⚙️ *Étape ${step.step}/${plan.steps.length}* — ${step.description}\n_Agent: ${step.agent}_`
    );

    const handler = AGENT_EXECUTORS[step.agent];
    if (!handler) {
      results.push({ step: step.step, error: `Agent '${step.agent}' inconnu` });
      continue;
    }

    // Si dépend de l'étape précédente, injecte le résultat
    let stepInput = step.input;
    if (step.depends_on_previous && results.length > 0) {
      const prev = [...results].reverse().find(r => r.output);
      if (prev?.output) {
        stepInput = `${step.input}\n\nContexte (étape précédente):\n${prev.output.slice(0, 1500)}`;
      }
    }

    try {
      // chatId: null → le sous-agent ne répond pas directement à Telegram
      const result = await handler({ input: stepInput, meta: { ...meta, chatId: null } });
      results.push({
        step:        step.step,
        description: step.description,
        agent:       step.agent,
        output:      result.output,
      });
      console.log(`[PlannerAgent] ✅ Étape ${step.step} terminée (${result.output?.length || 0} chars)`);
    } catch (err) {
      console.error(`[PlannerAgent] ❌ Étape ${step.step} échouée:`, err.message);
      results.push({ step: step.step, description: step.description, agent: step.agent, error: err.message });
    }
  }

  // ── Étape 3 : Résumé final ───────────────────
  const ok   = results.filter(r => !r.error);
  const fail = results.filter(r =>  r.error);

  // Prend le dernier résultat réussi comme livrable principal
  const lastOk = ok[ok.length - 1];

  let summary = `✅ *Plan terminé — ${ok.length}/${plan.steps.length} étapes réussies*\n${'─'.repeat(22)}\n\n`;

  if (lastOk?.output) {
    summary += lastOk.output.slice(0, 3000);
  } else {
    summary += '_Aucun résultat exploitable produit._';
  }

  if (fail.length > 0) {
    summary += `\n\n⚠️ *${fail.length} étape(s) échouée(s):*\n`;
    fail.forEach(r => { summary += `• Étape ${r.step} (${r.agent}): ${r.error}\n`; });
  }

  return {
    output: summary,
    meta: {
      agent:        'planner',
      goal:         goal.slice(0, 200),
      stepsTotal:   plan.steps.length,
      stepsSuccess: ok.length,
      stepsFailed:  fail.length,
    },
  };
}
