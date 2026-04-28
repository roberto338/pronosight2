// ══════════════════════════════════════════════
// nexus/agents/businessAgent.js
// Autonomous Business Builder — meta-agent v2
//
// 8-phase pipeline:
//  Phase 1  — Market research (researchAgent)
//  Phase 2  — Go-to-market strategy (customAgent)
//  Phase 3  — Landing page HTML (customAgent)
//  Phase 3b — AUTO-DEPLOY to Netlify
//  Phase 4  — Email sequences (writeAgent)
//  Phase 4b — AUTO-CREATE in Brevo (list + campaigns)
//  Phase 5  — Outreach targets (researchAgent)
//  Phase 6  — Stripe product + payment link
//  Phase 7  — Executive launch report
//  Phase 8  — Telegram notification with all live URLs
// ══════════════════════════════════════════════

import { runResearch } from './researchAgent.js';
import { runWrite    } from './writeAgent.js';
import { runCustom   } from './customAgent.js';
import { remember    } from '../lib/longTermMemory.js';
import { deployLandingPage   } from '../lib/integrations/netlify.js';
import { createBrevoSequence } from '../lib/integrations/brevo.js';
import { createStripeProduct } from '../lib/integrations/stripe.js';

// ── Helpers ─────────────────────────────────────

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

// ── Main export ──────────────────────────────────

/**
 * @param {Object} ctx
 * @param {string} ctx.input      idea description (fallback)
 * @param {Object} ctx.meta       { idea, market, budget, language, chatId, memoryContext }
 */
export async function runBusiness({ input, meta = {} }) {
  const idea   = meta.idea   || input;
  const market = meta.market || 'global';
  const budget = meta.budget ?? 0;
  const chatId = meta.chatId || null;
  const name   = slug(idea);

  console.log(`[BusinessAgent] Building: "${idea}" | market: ${market} | budget: ${budget}`);

  const subMeta = { chatId: null, memoryContext: meta.memoryContext };
  const results = {};
  const integrations = { netlify: null, brevo: null, stripe: null };

  // ══════════════════════════════════════════════
  // PHASE 1 — Market Research
  // ══════════════════════════════════════════════
  await progress(chatId,
    `🚀 *Business Builder — "${idea}"*\n${'━'.repeat(20)}\n\n⏳ *Phase 1/7* — Analyse de marché...`
  );

  const research = await runResearch({
    input: `Analyse le marché pour: "${idea}". Cible: ${market}. Trouve en JSON structuré: taille du marché, top 5 concurrents (avec tarifs), niches sous-exploitées, canaux d'acquisition principaux, barrières à l'entrée.`,
    meta: subMeta,
  });
  results.research = research.output;

  // ══════════════════════════════════════════════
  // PHASE 2 — Go-to-market Strategy
  // ══════════════════════════════════════════════
  await progress(chatId, `✅ Phase 1 — Marché analysé\n⏳ *Phase 2/7* — Stratégie go-to-market...`);

  const strategy = await runCustom({
    input: `Basé sur cette analyse de marché:\n${results.research.slice(0, 1800)}\n\nCrée une stratégie go-to-market complète pour "${idea}" (marché: ${market}, budget: ${budget}€).\n\nInclure: proposition de valeur unique, modèle de pricing (free + pro avec prix en €), profil client idéal, top 3 canaux d'acquisition avec budget estimé, plan 30 jours semaine par semaine.`,
    meta: subMeta,
  });
  results.strategy = strategy.output;

  // ══════════════════════════════════════════════
  // PHASE 3 — Landing Page HTML + Auto-deploy
  // ══════════════════════════════════════════════
  await progress(chatId, `✅ Phase 2 — Stratégie créée\n⏳ *Phase 3/7* — Landing page + déploiement Netlify...`);

  const landing = await runCustom({
    input: `Génère une landing page HTML complète et moderne pour "${idea}".\n\nStratégie:\n${results.strategy.slice(0, 1200)}\n\nRequis OBLIGATOIRES:\n- Fichier HTML unique avec CSS inline et JS minimal\n- Hero: titre accrocheur + sous-titre + bouton CTA\n- Section Features: 3 avantages clés avec icônes emoji\n- Section Pricing: plan Gratuit + plan Pro (avec prix)\n- Formulaire capture email avec bouton CTA\n- Design dark/moderne, responsive mobile\n- Couleurs: fond #0f1117, accents #a78bfa et #34d399\nRetourne UNIQUEMENT le code HTML complet, rien d'autre.`,
    meta: { ...subMeta, systemPrompt: 'Tu es un développeur frontend expert. Tu génères UNIQUEMENT du code HTML/CSS/JS pur, sans explications, sans markdown.' },
  });
  results.landing = landing.output;

  // 3b — Auto-deploy (non-blocking)
  console.log('[BusinessAgent] Phase 3b — Netlify deploy...');
  integrations.netlify = await deployLandingPage(results.landing, name);

  const netlifyNote = integrations.netlify?.deployed
    ? `🌐 Landing page live: ${integrations.netlify.url}`
    : integrations.netlify?.localPath
      ? `🌐 Landing page sauvegardée localement (Netlify token manquant)`
      : `🌐 Landing page générée (deploy échoué: ${integrations.netlify?.error || 'inconnu'})`;

  await progress(chatId, `✅ Phase 3 — Landing page générée\n${netlifyNote}\n⏳ *Phase 4/7* — Séquences email + Brevo...`);

  // ══════════════════════════════════════════════
  // PHASE 4 — Email Sequences + Auto-create Brevo
  // ══════════════════════════════════════════════
  const emails = await runWrite({
    input: `Séquence de 5 emails d'onboarding pour "${idea}" (${market}).\n\nStratégie:\n${results.strategy.slice(0, 800)}\n\nFormat EXACT pour chaque email:\n## Email N — Sujet: ...\n**Délai**: J+X\n**Corps**: ...\n\nEmails: 1=Bienvenue+valeur, 2=Feature clé, 3=Cas d'usage concret, 4=Nudge upgrade, 5=Win-back inactif`,
    meta: { ...subMeta, format: 'email sequence markdown' },
  });
  results.emails = emails.output;

  // 4b — Auto-create Brevo (non-blocking)
  console.log('[BusinessAgent] Phase 4b — Brevo sequence...');
  integrations.brevo = await createBrevoSequence(results.emails, name);

  const brevoNote = integrations.brevo?.campaignCount > 0
    ? `📧 ${integrations.brevo.campaignCount} campagnes Brevo créées (liste #${integrations.brevo.listId})`
    : `📧 Emails rédigés (Brevo: ${integrations.brevo?.error || 'non configuré'})`;

  await progress(chatId, `✅ Phase 4 — Emails rédigés\n${brevoNote}\n⏳ *Phase 5/7* — Cibles d'outreach...`);

  // ══════════════════════════════════════════════
  // PHASE 5 — Outreach Targets
  // ══════════════════════════════════════════════
  const outreach = await runResearch({
    input: `Trouve 10 profils concrets pour "${idea}" sur le marché "${market}": clients potentiels, partenaires, influenceurs. Pour chaque: nom/handle, plateforme, pourquoi pertinent, message d'approche suggéré.`,
    meta: subMeta,
  });
  results.outreach = outreach.output;

  await progress(chatId, `✅ Phase 5 — Outreach prêt\n⏳ *Phase 6/7* — Stripe produit + lien paiement...`);

  // ══════════════════════════════════════════════
  // PHASE 6 — Stripe Product + Payment Link
  // ══════════════════════════════════════════════
  console.log('[BusinessAgent] Phase 6 — Stripe product...');
  integrations.stripe = await createStripeProduct(idea, results.strategy);

  const stripeNote = integrations.stripe?.paymentUrl
    ? `💳 Lien paiement Stripe: ${integrations.stripe.paymentUrl}`
    : `💳 Stripe: ${integrations.stripe?.error || 'non configuré'} — pricing inclus dans le rapport`;

  await progress(chatId, `✅ Phase 6 — Stripe configuré\n${stripeNote}\n⏳ *Phase 7/7* — Rapport de lancement...`);

  // ══════════════════════════════════════════════
  // PHASE 7 — Executive Launch Report
  // ══════════════════════════════════════════════
  const urlSummary = [
    integrations.netlify?.url   ? `Landing page: ${integrations.netlify.url}`    : '',
    integrations.stripe?.paymentUrl ? `Stripe: ${integrations.stripe.paymentUrl}` : '',
    integrations.brevo?.listId  ? `Brevo liste #${integrations.brevo.listId}`    : '',
  ].filter(Boolean).join('\n');

  const report = await runWrite({
    input: `Rapport de lancement exécutif pour "${idea}".\n\nURLs live:\n${urlSummary || 'Intégrations à configurer'}\n\nRecherche marché: ${results.research.slice(0, 500)}\nStratégie: ${results.strategy.slice(0, 500)}\nOutreach: ${results.outreach.slice(0, 400)}\n\nRapport: résumé exécutif, insights marché clés, stratégie retenue, assets créés (landing page, 5 emails, 10 cibles outreach), 7 actions prioritaires cette semaine.`,
    meta: { ...subMeta, format: 'executive launch report markdown' },
  });
  results.report = report.output;

  // ══════════════════════════════════════════════
  // Save to long-term memory
  // ══════════════════════════════════════════════
  await Promise.allSettled([
    remember('project', `${name}_status`,  `Business lancé — landing + emails + outreach + intégrations`),
    remember('project', `${name}_market`,  results.research.slice(0, 200)),
    remember('project', `${name}_strategy`, results.strategy.slice(0, 200)),
    integrations.netlify?.url
      ? remember('project', `${name}_landing_url`, integrations.netlify.url)
      : Promise.resolve(),
    integrations.stripe?.paymentUrl
      ? remember('project', `${name}_stripe_url`, integrations.stripe.paymentUrl)
      : Promise.resolve(),
    integrations.brevo?.listId
      ? remember('project', `${name}_brevo_list`, String(integrations.brevo.listId))
      : Promise.resolve(),
  ]);

  // ══════════════════════════════════════════════
  // PHASE 8 — Final Telegram Notification
  // ══════════════════════════════════════════════
  const outreachCount = (results.outreach.match(/\d+\./g) || []).length || 10;
  const priceLabel    = integrations.stripe?.amountCents
    ? `${(integrations.stripe.amountCents / 100).toFixed(0)}${integrations.stripe.currency === 'eur' ? '€' : '$'}/mois`
    : 'voir rapport';

  const summary =
    `🚀 *Business lancé en autonomie : ${idea}*\n${'━'.repeat(22)}\n` +
    `🌐 Landing page live : ${integrations.netlify?.url      || '⚠️ configurer NETLIFY_TOKEN'}\n` +
    `💳 Lien paiement Pro : ${integrations.stripe?.paymentUrl || '⚠️ configurer STRIPE_SECRET_KEY'} ${integrations.stripe?.paymentUrl ? `(${priceLabel})` : ''}\n` +
    `📧 Séquence email : ${integrations.brevo?.campaignCount > 0 ? `${integrations.brevo.campaignCount} emails créés (liste #${integrations.brevo.listId})` : '⚠️ configurer BREVO_API_KEY'}\n` +
    `👥 Outreach : ${outreachCount} cibles identifiées\n` +
    `${'━'.repeat(22)}\n` +
    `📋 Rapport complet sauvegardé\n` +
    `⚡ Prêt à acquérir les premiers clients`;

  // ══════════════════════════════════════════════
  // Compile full output
  // ══════════════════════════════════════════════
  const integrationBlock = [
    `### 🌐 Netlify`,
    integrations.netlify?.deployed
      ? `✅ **Live:** ${integrations.netlify.url}`
      : integrations.netlify?.localPath
        ? `⚠️ Sauvegardé localement: \`${integrations.netlify.localPath}\``
        : `❌ Erreur: ${integrations.netlify?.error || 'NETLIFY_TOKEN manquant'}`,
    ``,
    `### 📧 Brevo`,
    integrations.brevo?.campaignCount > 0
      ? `✅ Liste #${integrations.brevo.listId} | ${integrations.brevo.campaignCount} campagnes créées (ids: ${integrations.brevo.campaignIds.join(', ')})`
      : `❌ Erreur: ${integrations.brevo?.error || 'BREVO_API_KEY manquante'}`,
    ``,
    `### 💳 Stripe`,
    integrations.stripe?.paymentUrl
      ? `✅ **Payment link:** ${integrations.stripe.paymentUrl}\nProduit: \`${integrations.stripe.productId}\` | Prix: \`${integrations.stripe.priceId}\` | ${priceLabel}`
      : `❌ Erreur: ${integrations.stripe?.error || 'STRIPE_SECRET_KEY manquante'}`,
  ].join('\n');

  const fullOutput = [
    `# 🚀 Business Report: ${idea}`,
    `**Marché:** ${market} | **Budget:** ${budget}€\n`,
    `---\n## 🔗 Intégrations Live\n${integrationBlock}`,
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
      agent:           'business',
      idea,
      market,
      budget,
      phasesCompleted: 7,
      assets:          ['landing_page', 'email_sequences', 'outreach_targets', 'launch_report'],
      integrations: {
        netlify: integrations.netlify?.url      || null,
        brevo:   integrations.brevo?.listId     || null,
        stripe:  integrations.stripe?.paymentUrl || null,
      },
      summary,
    },
  };
}
