// ══════════════════════════════════════════════
// nexus/autonomous/saasFactory.js
// Build + deploy a complete SaaS autonomously.
// Called by decisionEngine when Roberto says OUI.
//
// Pipeline:
//  1. generateSpec     → Claude: JSON spec
//  2. generateFullApp  → codeAgent: all files
//  3. createGitHubRepo → GitHub API: push code
//  4. deployToRender   → Render API: live service
//  5. createStripeProduct → payment link
//  6. deployLandingPage   → Netlify
//  7. createBrevoSequence → email list + campaigns
//  8. saveSaasToDb     → nexus_saas record
//  9. notifyRoberto    → Telegram summary
// ══════════════════════════════════════════════

import { runCustom } from '../agents/customAgent.js';
import { runCode   } from '../agents/codeAgent.js';
import { deployLandingPage   } from '../lib/integrations/netlify.js';
import { createStripeProduct } from '../lib/integrations/stripe.js';
import { createBrevoSequence } from '../lib/integrations/brevo.js';
import { remember }            from '../lib/longTermMemory.js';
import { query  }              from '../../db/database.js';
import fetch                   from 'node-fetch';
import { writeFile, mkdir }    from 'fs/promises';
import { join, dirname }       from 'path';
import { fileURLToPath }       from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUTS    = join(__dirname, '..', '..', 'nexus', 'outputs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendProgress(msg) {
  const ADMIN = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN) return;
  try {
    const { sendNexusMessage } = await import('../telegramHandler.js');
    await sendNexusMessage(ADMIN, msg);
  } catch { /* ignore */ }
}

// ── Step 1: Generate spec ────────────────────────

export async function generateSpec(opportunity) {
  const { output } = await runCustom({
    input: `Génère une spec technique JSON pour ce SaaS:\n\nOpportunité: ${opportunity.title}\nDescription: ${opportunity.description}\nMarché: ${opportunity.analysis?.market || 'francophone'}\n\nRetourne UNIQUEMENT ce JSON (sans markdown):\n{\n  "name": "nom-kebab-case",\n  "displayName": "Nom Affiché",\n  "concept": "description courte",\n  "template": "subscription|one-time|freemium",\n  "pricing": { "free": "description plan gratuit", "pro": { "amount": 29, "currency": "eur", "label": "29€/mois" } },\n  "features": ["feature 1", "feature 2", "feature 3"],\n  "targetUser": "description ICP",\n  "stack": "Node.js + PostgreSQL + Render"\n}`,
    meta: { provider: 'claude' },
  });

  try {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } catch { /* fallback */ }

  return {
    name:        'saas-nexus-' + Date.now().toString(36),
    displayName: opportunity.title,
    concept:     opportunity.description?.slice(0, 200),
    template:    'subscription',
    pricing:     { free: 'Plan gratuit limité', pro: { amount: 29, currency: 'eur', label: '29€/mois' } },
    features:    ['Fonctionnalité principale', 'Dashboard', 'API'],
    targetUser:  opportunity.analysis?.market || 'Entrepreneurs francophones',
    stack:       'Node.js + PostgreSQL + Render',
  };
}

// ── Step 2: Generate full app code ───────────────

export async function generateFullApp(spec) {
  const { output } = await runCode({
    input: `Génère une application Node.js complète pour: "${spec.displayName}"\n\nSpec:\n${JSON.stringify(spec, null, 2)}\n\nGénère ces fichiers avec le format // FILE: nom_fichier.ext avant chaque fichier:\n- server.js (Express, routes /api, Stripe webhook, auth JWT)\n- package.json (dependencies: express, pg, stripe, jsonwebtoken, bcryptjs, cors, dotenv)\n- public/index.html (landing page basique)\n- db/schema.sql (tables: users, sessions)\n- .env.example (PORT, DATABASE_URL, STRIPE_SECRET_KEY, JWT_SECRET)\n\nCode production-ready, commenté.`,
    meta: { language: 'JS', provider: 'claude' },
  });

  // Parse // FILE: sections
  const files = {};
  const sections = output.split(/\/\/ FILE:\s*/);
  for (let i = 1; i < sections.length; i++) {
    const lines    = sections[i].split('\n');
    const filename = lines[0].trim();
    const content  = lines.slice(1).join('\n').replace(/^```[\w]*\n?|```$/gm, '').trim();
    if (filename && content) files[filename] = content;
  }

  // Fallback if parsing failed
  if (Object.keys(files).length === 0) {
    files['server.js']    = output.slice(0, 5000);
    files['package.json'] = JSON.stringify({ name: spec.name, version: '1.0.0', type: 'module', main: 'server.js', dependencies: { express: '^4.21.0', pg: '^8.13.0', dotenv: '^16.0.0' } }, null, 2);
  }

  return files;
}

// ── Step 3: GitHub repo creation ─────────────────

export async function createGitHubRepo(repoName, files) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('[SaasFactory] GITHUB_TOKEN absent — sauvegarde locale');
    const dir = join(OUTPUTS, repoName);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      const parts = filename.split('/');
      if (parts.length > 1) await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(dir, filename), content, 'utf8');
    }
    return { repoUrl: null, localPath: dir };
  }

  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    // Get authenticated user
    const userResp = await fetch('https://api.github.com/user', { headers });
    const user     = await userResp.json();
    const owner    = user.login;

    // Create repo
    const createResp = await fetch('https://api.github.com/user/repos', {
      method:  'POST',
      headers,
      body:    JSON.stringify({ name: repoName, private: false, auto_init: false, description: `SaaS built by Nexus Autonomous` }),
    });
    const repo = await createResp.json();
    if (!createResp.ok) throw new Error(`GitHub create repo: ${repo.message}`);

    await sleep(2000); // Let GitHub initialize

    // Push each file
    for (const [filename, content] of Object.entries(files)) {
      try {
        await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${filename}`, {
          method:  'PUT',
          headers,
          body:    JSON.stringify({
            message: `feat: add ${filename}`,
            content: Buffer.from(content).toString('base64'),
          }),
        });
      } catch (fileErr) {
        console.warn(`[SaasFactory] File push error (${filename}):`, fileErr.message);
      }
    }

    const repoUrl = `https://github.com/${owner}/${repoName}`;
    console.log(`[SaasFactory] ✅ GitHub repo: ${repoUrl}`);
    return { repoUrl, owner, repo: repoName };
  } catch (err) {
    console.error('[SaasFactory] GitHub error:', err.message);
    return { repoUrl: null, error: err.message };
  }
}

// ── Step 4: Deploy to Render ─────────────────────

export async function deployToRender(repoUrl, name, envVars = {}) {
  if (!process.env.RENDER_API_KEY || !repoUrl) {
    console.warn('[SaasFactory] RENDER_API_KEY absent ou pas de repoUrl — deploy skipped');
    return { deployUrl: null };
  }

  const headers = {
    Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Get owner ID
    const ownersResp = await fetch('https://api.render.com/v1/owners?limit=1', { headers });
    const ownersData = await ownersResp.json();
    const ownerId    = ownersData[0]?.owner?.id || ownersData[0]?.id;
    if (!ownerId) throw new Error('Render owner ID not found');

    // Create service
    const servicePayload = {
      type: 'web_service',
      name,
      ownerId,
      serviceDetails: {
        env:            'node',
        buildCommand:   'npm install',
        startCommand:   'node server.js',
        plan:           'free',
        region:         'oregon',
        numInstances:   1,
        envVars: [
          { key: 'NODE_ENV', value: 'production' },
          ...Object.entries(envVars).map(([key, value]) => ({ key, value })),
        ],
      },
      repo: {
        url:    repoUrl,
        branch: 'main',
      },
    };

    const createResp = await fetch('https://api.render.com/v1/services', {
      method: 'POST', headers,
      body:   JSON.stringify(servicePayload),
    });
    const svc = await createResp.json();
    if (!createResp.ok) throw new Error(`Render create service: ${JSON.stringify(svc).slice(0, 200)}`);

    const serviceId = svc.service?.id || svc.id;
    const slug      = svc.service?.slug || svc.slug || name;
    const deployUrl = `https://${slug}.onrender.com`;

    console.log(`[SaasFactory] ✅ Render service: ${deployUrl} (building...)`);

    // Poll for live status (max 5 min)
    for (let i = 0; i < 10; i++) {
      await sleep(30_000);
      try {
        const deplResp = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, { headers });
        const deplData = await deplResp.json();
        const status   = deplData[0]?.deploy?.status || deplData[0]?.status;
        console.log(`[SaasFactory] Render deploy status: ${status}`);
        if (status === 'live') break;
        if (status === 'failed') throw new Error('Render deploy failed');
      } catch { /* continue polling */ }
    }

    return { deployUrl, serviceId };
  } catch (err) {
    console.error('[SaasFactory] Render error:', err.message);
    return { deployUrl: null, error: err.message };
  }
}

// ── Step 5: Save to DB ───────────────────────────

export async function saveSaasToDb({ spec, deployUrl, landingUrl, stripeLink, githubRepo, brevoListId, decisionId }) {
  const { rows } = await query(
    `INSERT INTO nexus_saas (name, concept, spec, deploy_url, landing_url, stripe_link, github_repo, brevo_list_id, status, decision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      spec.name, spec.concept?.slice(0, 500), JSON.stringify(spec),
      deployUrl || null, landingUrl || null, stripeLink || null,
      githubRepo || null, brevoListId || null,
      deployUrl ? 'live' : 'partial',
      decisionId || null,
    ]
  );
  return rows[0];
}

// ── Main orchestrator ─────────────────────────────

export async function saasFactory(decision) {
  const decisionId = decision.id;
  const analysis   = typeof decision.analysis === 'string' ? JSON.parse(decision.analysis) : (decision.analysis || {});

  console.log(`[SaasFactory] Building SaaS: "${decision.title}"`);
  await sendProgress(`🏗 *SaaS Factory démarré*\n_${decision.title}_\n\n⏳ Étape 1/7 — Génération spec...`);

  const results = { spec: null, files: {}, github: null, render: null, stripe: null, netlify: null, brevo: null, db: null };

  // Step 1: Spec
  try {
    results.spec = await generateSpec({ title: decision.title, description: decision.description, analysis });
    await sendProgress(`✅ Spec générée: *${results.spec.displayName}*\n⏳ Étape 2/7 — Génération code...`);
  } catch (err) {
    console.error('[SaasFactory] spec error:', err.message);
    return { error: 'spec_failed', message: err.message };
  }

  // Step 2: Full app code
  try {
    results.files = await generateFullApp(results.spec);
    const fileCount = Object.keys(results.files).length;
    await sendProgress(`✅ ${fileCount} fichiers générés\n⏳ Étape 3/7 — Push GitHub...`);
  } catch (err) {
    console.error('[SaasFactory] codegen error:', err.message);
    results.files = {};
  }

  // Step 3: GitHub
  try {
    results.github = await createGitHubRepo(results.spec.name, results.files);
    const msg = results.github.repoUrl ? `✅ GitHub: ${results.github.repoUrl}` : `⚠️ Code sauvegardé localement`;
    await sendProgress(`${msg}\n⏳ Étape 4/7 — Deploy Render...`);
  } catch (err) {
    console.error('[SaasFactory] github error:', err.message);
    results.github = { repoUrl: null };
  }

  // Step 4: Render deploy
  try {
    results.render = await deployToRender(results.github?.repoUrl, results.spec.name, { NODE_ENV: 'production' });
    const msg = results.render.deployUrl ? `✅ Live: ${results.render.deployUrl}` : `⚠️ Deploy Render skipped (token manquant)`;
    await sendProgress(`${msg}\n⏳ Étape 5/7 — Stripe...`);
  } catch (err) {
    results.render = { deployUrl: null };
  }

  // Step 5: Stripe
  try {
    results.stripe = await createStripeProduct(results.spec.displayName, JSON.stringify(results.spec.pricing));
    const msg = results.stripe?.paymentUrl ? `✅ Stripe: ${results.stripe.paymentUrl}` : `⚠️ Stripe skipped`;
    await sendProgress(`${msg}\n⏳ Étape 6/7 — Landing page Netlify...`);
  } catch (err) {
    results.stripe = { paymentUrl: null };
  }

  // Step 6: Landing page
  try {
    const landingHtml = await generateLandingHtml(results.spec, results.render?.deployUrl, results.stripe?.paymentUrl);
    results.netlify   = await deployLandingPage(landingHtml, results.spec.name);
    const msg = results.netlify?.url ? `✅ Landing: ${results.netlify.url}` : `⚠️ Landing sauvegardée localement`;
    await sendProgress(`${msg}\n⏳ Étape 7/7 — Brevo...`);
  } catch (err) {
    results.netlify = { url: null };
  }

  // Step 7: Brevo
  try {
    const emailsMd = generateEmailsMd(results.spec);
    results.brevo  = await createBrevoSequence(emailsMd, results.spec.name);
    const msg = results.brevo?.campaignCount > 0 ? `✅ Brevo: ${results.brevo.campaignCount} emails` : `⚠️ Brevo skipped`;
    await sendProgress(`${msg}\n⏳ Sauvegarde en mémoire...`);
  } catch (err) {
    results.brevo = { listId: null, campaignCount: 0 };
  }

  // Step 8: Save to DB
  try {
    results.db = await saveSaasToDb({
      spec:        results.spec,
      deployUrl:   results.render?.deployUrl,
      landingUrl:  results.netlify?.url,
      stripeLink:  results.stripe?.paymentUrl,
      githubRepo:  results.github?.repoUrl,
      brevoListId: results.brevo?.listId,
      decisionId,
    });
  } catch (err) {
    console.error('[SaasFactory] DB save error:', err.message);
  }

  // Step 9: Memory + final notification
  const name = results.spec.name;
  await Promise.allSettled([
    remember('project', `${name}_status`,  'SaaS lancé par Nexus Autonomous'),
    results.netlify?.url   ? remember('project', `${name}_landing`,  results.netlify.url)  : Promise.resolve(),
    results.stripe?.paymentUrl ? remember('project', `${name}_stripe`, results.stripe.paymentUrl) : Promise.resolve(),
    results.render?.deployUrl  ? remember('project', `${name}_deploy`, results.render.deployUrl)  : Promise.resolve(),
  ]);

  const finalMsg =
    `🚀 *SaaS lancé: ${results.spec.displayName}*\n${'━'.repeat(22)}\n` +
    `🌐 App: ${results.render?.deployUrl    || '⚠️ configurer RENDER_API_KEY'}\n` +
    `🎯 Landing: ${results.netlify?.url     || '⚠️ configurer NETLIFY_TOKEN'}\n` +
    `💳 Stripe: ${results.stripe?.paymentUrl || '⚠️ configurer STRIPE_SECRET_KEY'}\n` +
    `📧 Emails: ${results.brevo?.campaignCount > 0 ? `${results.brevo.campaignCount} créés` : '⚠️ configurer BREVO_API_KEY'}\n` +
    `🐙 GitHub: ${results.github?.repoUrl   || results.github?.localPath || '—'}\n` +
    `${'━'.repeat(22)}\n_Sauvegardé dans nexus_saas_`;

  await sendProgress(finalMsg);

  return {
    spec:       results.spec,
    deployUrl:  results.render?.deployUrl,
    landingUrl: results.netlify?.url,
    stripeLink: results.stripe?.paymentUrl,
    githubRepo: results.github?.repoUrl,
    brevoList:  results.brevo?.listId,
    dbId:       results.db?.id,
  };
}

// ── HTML landing page generator ──────────────────

async function generateLandingHtml(spec, deployUrl, stripeUrl) {
  const { output } = await runCustom({
    input: `Génère une landing page HTML pour: "${spec.displayName}"\nConcept: ${spec.concept}\nFeatures: ${spec.features?.join(', ')}\nPrix: ${spec.pricing?.pro?.label || '29€/mois'}\nCTA Stripe: ${stripeUrl || '#'}\nApp URL: ${deployUrl || '#'}\n\nRetourne UNIQUEMENT du HTML complet avec CSS inline, dark theme (#0f1117), accents violet (#a78bfa).`,
    meta: { systemPrompt: 'Tu génères UNIQUEMENT du code HTML/CSS, sans explications ni markdown.', provider: 'claude' },
  });
  return output;
}

// ── Email markdown generator ─────────────────────

function generateEmailsMd(spec) {
  return `## Email 1 — Sujet: Bienvenue sur ${spec.displayName}
**Délai**: J+0
**Corps**: Bienvenue ! Voici comment démarrer avec ${spec.displayName}. ${spec.features?.[0] || 'Notre fonctionnalité principale'} est disponible dès maintenant.

## Email 2 — Sujet: La fonctionnalité que vous allez adorer
**Délai**: J+2
**Corps**: Avez-vous essayé ${spec.features?.[1] || 'notre dashboard'} ? C'est là que la magie opère.

## Email 3 — Sujet: Cas d'usage concret
**Délai**: J+4
**Corps**: Voici comment nos utilisateurs utilisent ${spec.displayName} pour ${spec.targetUser || 'gagner du temps'}.

## Email 4 — Sujet: Passez au plan Pro
**Délai**: J+7
**Corps**: Débloquez toutes les fonctionnalités avec notre plan Pro à ${spec.pricing?.pro?.label || '29€/mois'}. Annulable à tout moment.

## Email 5 — Sujet: On ne vous a plus vu...
**Délai**: J+14
**Corps**: Vous avez créé un compte il y a 2 semaines. Voici ce que vous manquez. Connectez-vous maintenant.`;
}
