// ══════════════════════════════════════════════
// nexus/agents/businessAgent.js
// Autonomous Business Builder — meta-agent
// Orchestrates 7 phases to build a complete MVP
// ══════════════════════════════════════════════

import { runResearch } from './researchAgent.js';
import { runWrite    } from './writeAgent.js';
import { runCustom   } from './customAgent.js';
import { remember    } from '../lib/longTermMemory.js';

function slug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
}

async function progress(chatId, msg) {
  if (!chatId) return;
  try {
    const { sendNexusMessage } = await import('../telegramHandler.js');
    await sendNexusMessage(chatId, msg);
  } catch { /* ignore */ }
}

/**
 * @param {Object} ctx
 * @param {string} ctx.input        idea description (fallback)
 * @param {Object} ctx.meta         { idea, market, budget, language, chatId, memoryContext }
 */
export async function runBusiness({ input, meta = {} }) {
  const idea     = meta.idea     || input;
  const market   = meta.market   || 'global';
  const budget   = meta.budget   ?? 0;
  const chatId   = meta.chatId   || null;
  const name     = slug(idea);

  console.log(`[BusinessAgent] Building: "${idea}" | market: ${market} | budget: ${budget}`);

  const subMeta = { chatId: null, memoryContext: meta.memoryContext };
  const results = {};

  // ── Phase 1: Market Research ────────────────
  await progress(chatId, `🚀 *Business Builder — "${idea}"*\n${'━'.repeat(20)}\n\n⏳ *Phase 1/6* — Analyse de marché...`);

  const research = await runResearch({
    input: `Analyse le marché pour: "${idea}". Cible: ${market}. Trouve en JSON structuré: taille du marché, top 5 concurrents (avec tarifs), niches sous-exploitées, canaux d'acquisition principaux, barrières à l'entrée.`,
    meta: subMeta,
  });
  results.research = research.output;

  // ── Phase 2: Strategy ───────────────────────
  await progress(chatId, `✅ Phase 1 — Marché analysé\n⏳ *Phase 2/6* — Stratégie go-to-market...`);

  const strategy = await runCustom({
    input: `Basé sur cette analyse de marché:\n${results.research.slice(0, 1800)}\n\nCrée une stratégie go-to-market complète pour "${idea}" (marché: ${market}, budget: ${budget}€).\n\nInclure: proposition de valeur unique, modèle de pricing (free + pro), profil client idéal, top 3 canaux d'acquisition avec budget estimé, plan 30 jours semaine par semaine.`,
    meta: subMeta,
  });
  results.strategy = strategy.output;

  // ── Phase 3: Landing Page ───────────────────
  await progress(chatId, `✅ Phase 2 — Stratégie créée\n⏳ *Phase 3/6* — Landing page HTML...`);

  // Extract value prop from strategy for the landing page
  const landingPrompt = `Génère une landing page HTML complète et moderne pour "${idea}".\n\nStratégie:\n${results.strategy.slice(0, 1200)}\n\nRequis OBLIGATOIRES:\n- Fichier HTML unique avec CSS inline et JS minimal\n- Hero: titre accrocheur + sous-titre + bouton CTA\n- Section Features: 3 avantages clés avec icônes emoji\n- Section Pricing: plan Gratuit + plan Pro (avec prix)\n- Formulaire capture email avec bouton CTA\n- Design dark/moderne, responsive mobile\n- Couleurs: fond #0f1117, accents #a78bfa et #34d399\nRetourne UNIQUEMENT le code HTML complet, rien d'autre.`;

  const landing = await runCustom({
    input: landingPrompt,
    meta: { ...subMeta, systemPrompt: 'Tu es un développeur frontend expert. Tu génères UNIQUEMENT du code HTML/CSS/JS pur, sans explications, sans markdown.' },
  });
  results.landing = landing.output;

  // ── Phase 4: Email Sequences ────────────────
  await progress(chatId, `✅ Phase 3 — Landing page générée\n⏳ *Phase 4/6* — Séquences email...`);

  const emails = await runWrite({
    input: `Séquence de 5 emails d'onboarding pour "${idea}" (${market}).\n\nStratégie:\n${results.strategy.slice(0, 800)}\n\nFormat pour chaque email:\n## Email N — Sujet: ...\n**Délai**: J+X\n**Corps**: ...\n\nEmails: 1=Bienvenue+valeur, 2=Feature clé, 3=Cas d'usage concret, 4=Nudge upgrade, 5=Win-back inactif`,
    meta: { ...subMeta, format: 'email sequence markdown' },
  });
  results.emails = emails.output;

  // ── Phase 5: Outreach Targets ───────────────
  await progress(chatId, `✅ Phase 4 — Emails rédigés\n⏳ *Phase 5/6* — Cibles d'outreach...`);

  const outreach = await runResearch({
    input: `Trouve 10 profils concrets pour "${idea}" sur le marché "${market}": clients potentiels, partenaires, influenceurs. Pour chaque: nom/handle, plateforme, pourquoi pertinent, message d'approche suggéré.`,
    meta: subMeta,
  });
  results.outreach = outreach.output;

  // ── Phase 6: Launch Report ──────────────────
  await progress(chatId, `✅ Phase 5 — Outreach prêt\n⏳ *Phase 6/6* — Rapport de lancement...`);

  const report = await runWrite({
    input: `Rapport de lancement exécutif pour "${idea}".\n\nRecherche marché: ${results.research.slice(0, 600)}\nStratégie: ${results.strategy.slice(0, 600)}\nOutreach: ${results.outreach.slice(0, 400)}\n\nRapport: résumé exécutif, insights marché clés, stratégie retenue, assets créés (landing page ✅, 5 emails ✅, 10 cibles outreach ✅), 7 actions prioritaires cette semaine.`,
    meta: { ...subMeta, format: 'executive launch report markdown' },
  });
  results.report = report.output;

  // ── Save to long-term memory ─────────────────
  await Promise.allSettled([
    remember('project', `${name}_status`,   `Business créé — landing + emails + outreach générés`),
    remember('project', `${name}_market`,   results.research.slice(0, 200)),
    remember('project', `${name}_strategy`, results.strategy.slice(0, 200)),
  ]);

  // ── Telegram notification ────────────────────
  const summary =
    `🚀 *"${idea}" — Business créé !*\n${'━'.repeat(22)}\n\n` +
    `🌍 Marché: ${market} | 💰 Budget: ${budget}€\n\n` +
    `📦 *Assets livrés:*\n` +
    `• 🌐 Landing page HTML (${results.landing.length.toLocaleString()} chars)\n` +
    `• 📧 Séquence 5 emails d'onboarding\n` +
    `• 👥 10 cibles d'outreach identifiées\n` +
    `• 📋 Rapport de lancement complet\n\n` +
    `📊 *Insight marché clé:*\n${results.research.slice(0, 300)}...\n\n` +
    `${'━'.repeat(22)}\n_Assets sauvegardés en mémoire Nexus_`;

  // ── Compile full output ──────────────────────
  const fullOutput = [
    `# 🚀 Business Report: ${idea}`,
    `**Marché:** ${market} | **Budget:** ${budget}€\n`,
    `---\n## 📊 Analyse de marché\n${results.research}`,
    `---\n## 🎯 Stratégie go-to-market\n${results.strategy}`,
    `---\n## 🌐 Landing Page HTML\n\`\`\`html\n${results.landing.slice(0, 4000)}\n\`\`\``,
    `---\n## 📧 Séquences Email\n${results.emails}`,
    `---\n## 👥 Outreach Targets\n${results.outreach}`,
    `---\n## 📋 Rapport de lancement\n${results.report}`,
  ].join('\n\n');

  return {
    output: fullOutput,
    meta: {
      agent:          'business',
      idea,
      market,
      budget,
      phasesCompleted: 6,
      assets:          ['landing_page', 'email_sequences', 'outreach_targets', 'launch_report'],
      summary,
    },
  };
}
