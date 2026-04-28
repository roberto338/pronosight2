// ══════════════════════════════════════════════
// nexus/autonomous/opportunityEngine.js
// Detects business opportunities every 6h.
// Scores them 1-10. Creates decisions for 7+.
// ══════════════════════════════════════════════

import { runResearch } from '../agents/researchAgent.js';
import { callAI }      from '../lib/ai.js';
import { createDecision } from './decisionEngine.js';

const ROBERTO_CONTEXT = `
Roberto est un entrepreneur solo francophone:
- Projets actifs: PronoSight (paris IA), MÉTAFICTION (fiction mobile), NutriPlan AI (nutrition), Nexus (agent IA), Fruity Arena (vidéo IA)
- Stack: Node.js, PostgreSQL, Render, Claude API, React Native
- Marchés: francophone, diaspora haïtienne, anglophone
- Contrainte: seul, 5 projets actifs simultanés
- Atout: maîtrise technique full-stack + IA
`;

// ── Type 1: Market gaps ───────────────────────────

export async function detectMarketGaps() {
  const queries = [
    'Reddit entrepreneurs francophones outils manquants 2025 2026 "j\'aimerais un outil" OR "il manque"',
    'producthunt trending saas francophone 2025 outils niche',
    'hacker news "Show HN" new saas tool indie 2026',
    'Twitter X indie hacker francophone tool missing gap underserved',
  ];

  const opportunities = [];

  for (const q of queries) {
    try {
      const { output } = await runResearch({
        input: `Recherche: "${q}"\n\nIdentifie les 2-3 meilleures opportunités de SaaS non couverts pour un développeur solo francophone. Pour chaque opportunité, retourne JSON: { "title": "", "description": "", "market": "", "competitors": "", "effort": "", "revenue": "" }`,
        meta: { useSearch: true, task: 'market_gap_detection' },
      });

      // Extract JSON opportunities from output
      const jsonMatches = output.match(/\{[^{}]+\}/g) || [];
      for (const match of jsonMatches) {
        try {
          const opp = JSON.parse(match.replace(/,\s*}/g, '}'));
          if (opp.title && opp.description) {
            opportunities.push({ ...opp, type: 'saas', source: 'market_gap' });
          }
        } catch { /* skip malformed */ }
      }

      // Fallback: parse as text if no JSON
      if (jsonMatches.length === 0 && output.length > 100) {
        opportunities.push({
          title:       `Opportunité détectée — ${q.slice(0, 40)}`,
          description: output.slice(0, 400),
          market:      'francophone',
          effort:      '1-2 semaines',
          revenue:     '100-500€/mois',
          type:        'saas',
          source:      'market_gap',
        });
      }
    } catch (err) {
      console.error('[OpportunityEngine] market gap query error:', err.message);
    }
  }

  return opportunities.slice(0, 6);
}

// ── Type 2: Trending content topics ──────────────

export async function detectTrendingTopics() {
  const projects = [
    { name: 'PronoSight',   niche: 'paris sportifs IA' },
    { name: 'MÉTAFICTION',  niche: 'fiction interactive mobile' },
    { name: 'NutriPlan AI', niche: 'nutrition personnalisée IA' },
    { name: 'Fruity Arena', niche: 'production vidéo IA' },
  ];

  const opportunities = [];

  for (const project of projects) {
    try {
      const prompt = `Pour le projet "${project.name}" (${project.niche}), génère 2 idées de contenu viral EN CE MOMENT en 2025-2026 pour un public francophone. Format JSON array: [{ "title": "", "angle": "", "format": "linkedin|tiktok|blog", "hook": "" }]`;

      const raw = await callAI(
        `Tu es un expert content marketing francophone. ${ROBERTO_CONTEXT}`,
        prompt,
        { provider: 'claude', maxTokens: 500, temperature: 0.7 }
      );

      const match = raw.match(/\[[\s\S]*?\]/);
      if (match) {
        const ideas = JSON.parse(match[0].replace(/,\s*]/g, ']'));
        for (const idea of (Array.isArray(ideas) ? ideas : [])) {
          if (idea.title) {
            opportunities.push({
              title:       `[${project.name}] ${idea.title}`,
              description: idea.hook || idea.angle || idea.title,
              project:     project.name,
              format:      idea.format || 'linkedin',
              type:        'content',
              source:      'trending_topics',
            });
          }
        }
      }
    } catch (err) {
      console.error(`[OpportunityEngine] trending topics error (${project.name}):`, err.message);
    }
  }

  return opportunities.slice(0, 8);
}

// ── Type 3: Revenue opportunities ────────────────

export async function detectRevenueOpportunities() {
  try {
    const { output } = await runResearch({
      input: `Pour ces projets SaaS: PronoSight (paris sportifs IA), NutriPlan AI (nutrition), MÉTAFICTION (fiction), Nexus (agent IA) — identifie 3 opportunités de revenus rapides en 2025: nouvelles fonctionnalités payantes, partenariats, upsells, nouveaux marchés. Format JSON array: [{ "project": "", "opportunity": "", "action": "", "revenueEstimate": "" }]`,
      meta: { task: 'revenue_opportunity', useSearch: false },
    });

    const match = output.match(/\[[\s\S]*?\]/);
    if (match) {
      const opps = JSON.parse(match[0].replace(/,\s*]/g, ']'));
      return (Array.isArray(opps) ? opps : []).map(o => ({
        title:       `Revenue: ${o.project} — ${o.opportunity}`,
        description: o.action || o.opportunity,
        analysis:    { revenue: o.revenueEstimate, market: o.project },
        type:        'feature',
        source:      'revenue_scan',
      }));
    }
  } catch (err) {
    console.error('[OpportunityEngine] revenue opportunities error:', err.message);
  }
  return [];
}

// ── Scoring ───────────────────────────────────────

export async function scoreOpportunity(opportunity) {
  try {
    const prompt = `Évalue cette opportunité pour Roberto (entrepreneur solo, Node.js, francophone, 5 projets actifs):

Titre: ${opportunity.title}
Description: ${opportunity.description}
${opportunity.market ? `Marché: ${opportunity.market}` : ''}
${opportunity.effort ? `Effort: ${opportunity.effort}` : ''}

Score 1-10 sur ces critères:
1. Effort réalisable seul < 2 semaines
2. Taille marché francophone adressable
3. Potentiel revenue (délai 1er €)
4. Compatibilité stack Node.js/Render
5. Synergie avec PronoSight/NutriPlan/Nexus

Réponds UNIQUEMENT avec un JSON: { "score": N, "scores": { "effort": N, "market": N, "revenue": N, "stack": N, "synergy": N }, "verdict": "une phrase" }`;

    const raw = await callAI(
      `Tu es un business advisor expert en SaaS solo. ${ROBERTO_CONTEXT}`,
      prompt,
      { provider: 'claude', maxTokens: 300, temperature: 0.1 }
    );

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0].replace(/,\s*}/g, '}'));
      return {
        ...opportunity,
        score:       Math.min(10, Math.max(1, Math.round(result.score || 5))),
        scores:      result.scores || {},
        verdict:     result.verdict || '',
      };
    }
  } catch (err) {
    console.error('[OpportunityEngine] scoring error:', err.message);
  }

  return { ...opportunity, score: 5, scores: {}, verdict: 'Analyse non disponible' };
}

// ── Main detection cycle ──────────────────────────

export async function runDetectionCycle() {
  console.log('[OpportunityEngine] Démarrage cycle de détection...');
  const createdDecisions = [];

  try {
    // Run all 3 detectors in parallel
    const [gaps, topics, revenue] = await Promise.all([
      detectMarketGaps().catch(e => { console.error('[OE] gaps:', e.message); return []; }),
      detectTrendingTopics().catch(e => { console.error('[OE] topics:', e.message); return []; }),
      detectRevenueOpportunities().catch(e => { console.error('[OE] revenue:', e.message); return []; }),
    ]);

    const allOpportunities = [...gaps, ...topics, ...revenue];
    console.log(`[OpportunityEngine] ${allOpportunities.length} opportunités trouvées, scoring...`);

    // Score all in parallel
    const scored = await Promise.all(allOpportunities.map(opp => scoreOpportunity(opp)));

    // Create decisions for score >= 7
    const qualified = scored
      .filter(o => o.score >= 7)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // max 5 new decisions per cycle

    for (const opp of qualified) {
      try {
        const actionPlan = buildActionPlan(opp);
        const decision   = await createDecision({
          type:        opp.type || 'saas',
          title:       opp.title,
          description: opp.description + (opp.verdict ? `\n\n_${opp.verdict}_` : ''),
          analysis: {
            market:         opp.market       || 'francophone',
            effort:         opp.effort        || '1-2 semaines',
            revenue:        opp.revenue       || 'à déterminer',
            competitors:    opp.competitors   || 'à analyser',
            compatibility:  'Node.js ✅ Render ✅ Claude ✅',
            source:         opp.source,
          },
          actionPlan,
          score: opp.score,
        });
        createdDecisions.push(decision);
        console.log(`[OpportunityEngine] ✅ Décision créée: "${opp.title}" (score: ${opp.score})`);
      } catch (err) {
        console.error('[OpportunityEngine] createDecision error:', err.message);
      }
    }

    console.log(`[OpportunityEngine] Cycle terminé — ${createdDecisions.length} décisions créées`);
  } catch (err) {
    console.error('[OpportunityEngine] runDetectionCycle fatal error:', err.message);
  }

  return createdDecisions;
}

// ── Action plan builder ───────────────────────────

function buildActionPlan(opportunity) {
  if (opportunity.type === 'saas') {
    return [
      'Générer spec technique + architecture (Claude)',
      'Builder le MVP Node.js + PostgreSQL',
      'Déployer sur Render (gratuit)',
      'Créer landing page Netlify + lien Stripe',
      'Créer séquence email Brevo',
      'Envoyer 10 cold emails aux prospects cibles',
    ];
  }
  if (opportunity.type === 'content') {
    return [
      `Générer le contenu ${opportunity.format || 'LinkedIn + Twitter'}`,
      'Optimiser pour l\'algorithme (hook + CTA)',
      'Programmer via Buffer',
      'Monitorer les 48h d\'engagement',
    ];
  }
  if (opportunity.type === 'feature') {
    return [
      `Analyser la faisabilité pour ${opportunity.analysis?.market || 'le projet'}`,
      'Coder la fonctionnalité (codeAgent)',
      'Déployer la mise à jour',
      'Notifier les utilisateurs existants',
    ];
  }
  return ['Analyser l\'opportunité', 'Planifier l\'exécution', 'Lancer le projet'];
}
