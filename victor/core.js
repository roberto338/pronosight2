// ══════════════════════════════════════════════
// victor/core.js — Cerveau de Victor
// ══════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { query } from '../db/database.js';
import { VICTOR_PROMPT } from './prompt.js';
import { detectPatterns, formatPatternsForVictor } from './patterns.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL      = 'claude-sonnet-4-20250514';
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// ══════════════════════════════════════════════
// BRIEFING — Contexte injecté dans chaque analyse
// ══════════════════════════════════════════════

/**
 * Construit le briefing contextuel pour Victor :
 * erreurs récentes, forces par sport, patterns actifs, règles.
 * @returns {string} Texte formaté à injecter dans le prompt
 */
export async function getVictorBriefing() {
  const lines = [];

  // ── Erreurs des 14 derniers jours ────────────
  try {
    const { rows: erreurs } = await query(`
      SELECT sport, competition, match, pronostic_principal,
             score_reel, date
      FROM ps_pronostics
      WHERE pronostic_correct = false
        AND date >= NOW() - INTERVAL '14 days'
      ORDER BY date DESC
      LIMIT 10
    `);

    if (erreurs.length > 0) {
      lines.push('=== ERREURS RÉCENTES (14 derniers jours) ===');
      erreurs.forEach(e => {
        lines.push(`• [${e.date?.toISOString().slice(0,10)}] ${e.match} — Paris raté: "${e.pronostic_principal}" | Résultat: ${e.score_reel || 'N/A'}`);
      });
      lines.push('→ Éviter de reproduire ces erreurs.\n');
    }
  } catch (err) {
    console.warn('⚠️ [Briefing] Erreurs récentes non disponibles:', err.message);
  }

  // ── Taux de réussite par sport (30 jours) ────
  try {
    const { rows: stats } = await query(`
      SELECT sport,
             COUNT(*) AS total,
             SUM(CASE WHEN pronostic_correct = true THEN 1 ELSE 0 END) AS corrects,
             ROUND(
               100.0 * SUM(CASE WHEN pronostic_correct = true THEN 1 ELSE 0 END)
               / NULLIF(COUNT(*), 0), 1
             ) AS taux
      FROM ps_pronostics
      WHERE pronostic_correct IS NOT NULL
        AND date >= NOW() - INTERVAL '30 days'
      GROUP BY sport
      ORDER BY taux DESC
    `);

    if (stats.length > 0) {
      lines.push('=== PERFORMANCE PAR SPORT (30 jours) ===');
      stats.forEach(s => {
        const emoji = s.taux >= 65 ? '🟢' : s.taux >= 50 ? '🟡' : '🔴';
        lines.push(`${emoji} ${s.sport}: ${s.taux}% (${s.corrects}/${s.total})`);
      });
      lines.push('');
    }
  } catch (err) {
    console.warn('⚠️ [Briefing] Stats sport non disponibles:', err.message);
  }

  // ── Patterns actifs ──────────────────────────
  try {
    const { rows: patterns } = await query(`
      SELECT nom, type, sport, equipe_a, equipe_b,
             condition_trigger, pattern_observe,
             taux_confirmation, pari_suggere, fiabilite
      FROM ps_victor_patterns
      WHERE actif = true
      ORDER BY
        CASE fiabilite WHEN 'Fort' THEN 1 WHEN 'Moyen' THEN 2 ELSE 3 END,
        taux_confirmation DESC
    `);

    if (patterns.length > 0) {
      lines.push('=== PATTERNS STATISTIQUES ACTIFS ===');
      patterns.forEach(p => {
        const badge = p.fiabilite === 'Fort' ? '🔥' : p.fiabilite === 'Moyen' ? '📊' : '🔍';
        const equipes = (p.equipe_a || p.equipe_b)
          ? ` [${[p.equipe_a, p.equipe_b].filter(Boolean).join(' / ')}]`
          : '';
        lines.push(`${badge} [${p.fiabilite} ${p.taux_confirmation}%] ${p.nom}${equipes}`);
        lines.push(`   Trigger: ${p.condition_trigger}`);
        lines.push(`   Pari: ${p.pari_suggere}\n`);
      });
    }
  } catch (err) {
    console.warn('⚠️ [Briefing] Patterns non disponibles:', err.message);
  }

  // ── Dernières règles Victor ──────────────────
  try {
    const { rows: rules } = await query(`
      SELECT semaine, regles, biais, sports_prudence
      FROM ps_victor_rules
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (rules.length > 0) {
      const r = rules[0];
      lines.push(`=== RÈGLES VICTOR (semaine ${r.semaine}) ===`);
      if (Array.isArray(r.regles) && r.regles.length > 0) {
        r.regles.forEach(regle => lines.push(`• ${regle}`));
      }
      if (r.sports_prudence && Object.keys(r.sports_prudence).length > 0) {
        lines.push(`⚠️ Sports à aborder avec prudence: ${JSON.stringify(r.sports_prudence)}`);
      }
      lines.push('');
    }
  } catch (err) {
    console.warn('⚠️ [Briefing] Règles non disponibles:', err.message);
  }

  return lines.length > 0
    ? lines.join('\n')
    : '(Première analyse — aucun historique disponible)';
}

// ══════════════════════════════════════════════
// APPEL CLAUDE API
// ══════════════════════════════════════════════

// ── Appel Gemini (primaire) ───────────────────
async function callGemini(systemPrompt, userMessage, maxTokens = 8000) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquante');

  const body = {
    contents: [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\n---\n\n${userMessage}` }] }
    ],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 8192),
      temperature: 0.4,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API HTTP ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  if (data.error) throw new Error(`Gemini API: ${data.error.message}`);
  return data;
}

// ── Appel Claude (fallback si ANTHROPIC_API_KEY présente) ────
async function callClaude(systemPrompt, userMessage, maxTokens = 8000) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquante');

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: userMessage }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API HTTP ${resp.status}: ${errText}`);
  }

  return resp.json();
}

// ── callAI : Gemini en primaire, Claude en fallback ──────────
async function callAI(systemPrompt, userMessage, maxTokens = 8000) {
  // Gemini disponible → prioritaire
  if (GEMINI_API_KEY) {
    try {
      const result = await callGemini(systemPrompt, userMessage, maxTokens);
      console.log('   🤖 Moteur : Gemini (Google Search activé)');
      return { source: 'gemini', data: result };
    } catch (err) {
      console.warn(`   ⚠️  Gemini échoué (${err.message}) — bascule Claude`);
    }
  }
  // Claude en fallback
  if (ANTHROPIC_API_KEY) {
    const result = await callClaude(systemPrompt, userMessage, maxTokens);
    console.log('   🤖 Moteur : Claude (web_search activé)');
    return { source: 'claude', data: result };
  }
  throw new Error('Aucune clé API disponible (GEMINI_API_KEY et ANTHROPIC_API_KEY manquantes)');
}

// ══════════════════════════════════════════════
// EXTRACTION JSON ROBUSTE
// ══════════════════════════════════════════════

function extractJSON(aiResponse) {
  // Normalise les deux formats : { source, data } de callAI ou réponse brute
  const resp = aiResponse?.source ? aiResponse.data : aiResponse;

  let raw = '';

  // Format Gemini : candidates[0].content.parts[].text
  if (resp?.candidates) {
    raw = resp.candidates
      .flatMap(c => c.content?.parts || [])
      .filter(p => p.text)
      .map(p => p.text)
      .join('');
  }
  // Format Claude : content[].type=text
  else if (Array.isArray(resp?.content)) {
    raw = resp.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  // Fallback string brut
  else if (typeof resp === 'string') {
    raw = resp;
  }

  if (!raw) throw new Error('Réponse IA vide ou format inconnu');

  // Nettoie les blocs markdown
  let clean = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Cherche le premier { et le dernier }
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Aucun JSON trouvé dans la réponse IA');
  }

  clean = clean.slice(start, end + 1);

  try {
    return JSON.parse(clean);
  } catch (e) {
    const sanitized = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return JSON.parse(sanitized);
  }
}

// ══════════════════════════════════════════════
// RUN VICTOR — Analyse complète du jour
// ══════════════════════════════════════════════

/**
 * Lance l'analyse complète de Victor :
 * recherche web → JSON → sauvegarde DB.
 * @returns {Object} Données JSON parsées
 */
export async function runVictor() {
  console.log('\n🎙️  Victor démarre l\'analyse...\n');

  // ── Briefing contextuel ──────────────────────
  console.log('📋 Récupération du briefing...');
  const briefing = await getVictorBriefing();

  // ── Patterns généraux du jour (tous sports) ──
  // Victor découvrant lui-même les matchs via web_search,
  // on injecte les patterns situationnels multi-sport
  // (H2H génériques inclus — les équipes seront filtrées par Victor).
  console.log('🧠 Chargement des patterns actifs...');
  let patternsTexte = 'Aucun pattern historique significatif détecté.';
  try {
    // Patterns situationnels / psychologiques actifs (multi-sport)
    const { rows: patternsActifs } = await query(
      `SELECT nom, type, sport, equipe_a, equipe_b,
              condition_trigger, pattern_observe,
              taux_confirmation, pari_suggere, fiabilite
       FROM ps_victor_patterns
       WHERE actif = true
         AND taux_confirmation >= 55
       ORDER BY
         CASE fiabilite WHEN 'Fort' THEN 1 WHEN 'Moyen' THEN 2 ELSE 3 END,
         taux_confirmation DESC
       LIMIT 20`
    );

    if (patternsActifs.length > 0) {
      const result = {
        h2h: patternsActifs.filter(p => p.type === 'H2H'),
        situationnels: patternsActifs.filter(p => p.type !== 'H2H'),
        signal_fort: patternsActifs.filter(p => parseFloat(p.taux_confirmation) >= 70),
      };
      patternsTexte = formatPatternsForVictor(result);
      console.log(`   ✅ ${patternsActifs.length} pattern(s) chargés (${result.signal_fort.length} signal(s) fort(s))`);
    } else {
      console.log('   ℹ️  Aucun pattern actif');
    }
  } catch (err) {
    console.warn('   ⚠️  Patterns non disponibles:', err.message);
  }

  // ── Date du jour ─────────────────────────────
  const today = new Date();
  const dateStr = today.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Paris'
  });
  const dateISO = today.toISOString().slice(0, 10);
  const dateEN  = today.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Europe/Paris'
  });

  // ── Détection fenêtre FIFA (trêve internationale) ──
  // Fenêtres 2025/2026 : mars 20-25 / sept 1-9 / oct 6-14 / nov 10-18
  const parisDate = new Date(today.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const m = parisDate.getMonth() + 1; // 1-12
  const d = parisDate.getDate();
  const isFifaWindow = (m === 3  && d >= 20 && d <= 31)  // Mars
                    || (m === 6  && d >= 1  && d <= 10)  // Juin
                    || (m === 9  && d >= 1  && d <= 9)   // Septembre
                    || (m === 10 && d >= 6  && d <= 14)  // Octobre
                    || (m === 11 && d >= 10 && d <= 18); // Novembre

  const fifaContext = isFifaWindow ? `
CONTEXTE FENÊTRE FIFA ACTIVE — PRIORITÉ ABSOLUE :
Aujourd'hui ${dateStr} des matchs internationaux se jouent partout dans le monde.
Recherche OBLIGATOIRE :
1. "qualifications coupe du monde 2026 ${dateStr}"
2. "World Cup 2026 qualifiers ${dateEN}"
3. "international friendlies ${dateEN}"
4. "matchs amicaux internationaux ce soir"
5. "friendly football matches today ${dateEN}"
6. "matchs foot ce soir ${dateStr}"
Les qualifications ET amicaux internationaux sont prioritaires sur les championnats domestiques.
` : `
CONTEXTE CHAMPIONNATS DOMESTIQUES :
Aujourd'hui ${dateStr} les championnats nationaux et coupes continentales sont en cours.
Recherche OBLIGATOIRE :
1. "football matches today ${dateEN}"
2. "matchs foot ce soir ${dateStr}"
3. "Ligue 1 Premier League Liga Bundesliga Serie A ${dateEN}"
4. "Champions League Europa League Coupe de France ${dateEN}"
5. "NBA basketball matches tonight"
6. "tennis results today ${dateEN}"
Couvre TOUS les sports disponibles : football clubs, basketball, tennis, MMA...
`;

  // ── Message utilisateur ──────────────────────
  const userMessage = `Nous sommes le ${dateStr}.

${briefing}

${patternsTexte}
${fifaContext}
Tu dois trouver un maximum de matchs avec des enjeux réels. Minimum 3 matchs, idéalement 5-8.

Lance l'analyse complète et retourne le JSON avec tous les matchs trouvés. Réponds UNIQUEMENT avec ce JSON :
{
  "date": "YYYY-MM-DD",
  "generated_at": "HH:MM",
  "events": [{
    "sport": "",
    "competition": "",
    "match": "",
    "equipe_a": "",
    "equipe_b": "",
    "heure": "",
    "enjeu": "",
    "contexte": "",
    "forme_equipe_a": "",
    "forme_equipe_b": "",
    "infirmerie": "",
    "stats_cles": [],
    "analyse_tactique": "",
    "pronostic_principal": "",
    "cote_estimee": 0.00,
    "cote_estimee_min": 0.00,
    "cote_estimee_max": 0.00,
    "confiance": "",
    "confiance_score": 0,
    "value_bet": "",
    "cote_value": 0.00,
    "cote_value_min": 0.00,
    "cote_value_max": 0.00,
    "justification_value_bet": "",
    "pari_a_eviter": "",
    "score_predit": "",
    "impact_enjeu_motivation": 3,
    "analyse_courte": "",
    "phrase_signature": ""
  }],
  "combine_victor": {
    "selections": [],
    "cote_combinee": 0.00,
    "justification": "",
    "risque": ""
  },
  "verdict_journee": ""
}`;

  // ── Appel Claude ─────────────────────────────
  console.log('🤖 Appel Claude API (web_search activé)...');
  let claudeResp;
  try {
    claudeResp = await callAI(VICTOR_PROMPT, userMessage, 8000);
  } catch (err) {
    console.error('❌ Erreur IA API:', err.message);
    throw err;
  }

  // ── Parse JSON ───────────────────────────────
  console.log('🔍 Extraction du JSON...');
  let victorData;
  try {
    victorData = extractJSON(claudeResp.content);
  } catch (err) {
    console.error('❌ Impossible de parser la réponse JSON:', err.message);
    console.error('   Réponse brute:', JSON.stringify(claudeResp.content).slice(0, 500));
    throw err;
  }

  // ── Sauvegarde PostgreSQL ────────────────────
  const events = victorData.events || [];
  console.log(`\n💾 Sauvegarde de ${events.length} pronostic(s) en DB...`);

  for (const ev of events) {
    try {
      await query(
        `INSERT INTO ps_pronostics
          (date, sport, competition, match, equipe_a, equipe_b, heure,
           enjeu, contexte, forme_equipe_a, forme_equipe_b, infirmerie,
           stats_cles, analyse_tactique, pronostic_principal, cote_estimee,
           confiance, value_bet, cote_value, pari_a_eviter, score_predit,
           confiance_score, analyse_courte, phrase_signature)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          dateISO,
          ev.sport        || null,
          ev.competition  || null,
          ev.match        || null,
          ev.equipe_a     || null,
          ev.equipe_b     || null,
          ev.heure        || null,
          ev.enjeu        || null,
          ev.contexte     || null,
          ev.forme_equipe_a  || null,
          ev.forme_equipe_b  || null,
          ev.infirmerie      || null,
          JSON.stringify(ev.stats_cles || []),
          ev.analyse_tactique    || null,
          ev.pronostic_principal || null,
          ev.cote_estimee || (ev.cote_estimee_min && ev.cote_estimee_max ? (ev.cote_estimee_min + ev.cote_estimee_max) / 2 : null),
          ev.confiance           || null,
          ev.value_bet           || null,
          ev.cote_value || (ev.cote_value_min && ev.cote_value_max ? (ev.cote_value_min + ev.cote_value_max) / 2 : null),
          ev.pari_a_eviter       || null,
          ev.score_predit        || null,
          ev.confiance_score     || null,
          ev.analyse_courte      || null,
          ev.phrase_signature    || null,
        ]
      );
      console.log(`   ✅ ${ev.match} — ${ev.pronostic_principal} (${ev.confiance})`);
    } catch (err) {
      console.error(`   ❌ Erreur sauvegarde "${ev.match}":`, err.message);
    }
  }

  console.log(`\n✅ Victor a généré ${events.length} pronostic(s)\n`);
  return victorData;
}

// ══════════════════════════════════════════════
// CHECK RESULTS — Vérification post-match
// ══════════════════════════════════════════════

/**
 * Pour chaque pronostic du jour sans résultat,
 * demande à Claude de chercher le score réel.
 */
// ── Helpers checkResults ─────────────────────

/**
 * Récupère tous les matchs terminés du jour via API-Football.
 * Retourne un tableau plat de fixtures avec score.
 */
async function fetchApiFootballResults(dateISO) {
  // Accepte les deux noms de variable (cohérence server.js vs victor)
  const API_KEY = process.env.API_FOOTBALL_KEY || process.env.RAPIDAPI_KEY;
  if (!API_KEY) return [];
  try {
    const url = `https://v3.football.api-sports.io/fixtures?date=${dateISO}&status=FT`;
    const resp = await fetch(url, {
      headers: { 'x-apisports-key': API_KEY },
    });
    if (!resp.ok) {
      console.warn(`   ⚠️  API-Football HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return data.response || [];
  } catch (err) {
    console.warn(`   ⚠️  API-Football indisponible: ${err.message}`);
    return [];
  }
}

/**
 * Normalise un nom d'équipe pour la comparaison : minuscules, sans accents, sans ponctuation.
 */
function normalizeTeam(name = '') {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// Alias noms officiels ↔ noms courants pour les sélections nationales
const TEAM_ALIASES = new Map([
  ['usa',             ['united states', 'etats unis', 'us mens']],
  ['united states',   ['usa', 'etats unis', 'us mens national']],
  ['south korea',     ['korea republic', 'republic of korea']],
  ['korea republic',  ['south korea', 'republic of korea']],
  ['ivory coast',     ['cote d ivoire', 'cote divoire']],
  ['cote d ivoire',   ['ivory coast', 'cote divoire']],
  ['iran',            ['ir iran']],
  ['ir iran',         ['iran']],
  ['czech republic',  ['czechia', 'republique tcheque']],
  ['czechia',         ['czech republic']],
  ['north macedonia', ['macedonia']],
  ['dr congo',        ['rd congo', 'drc', 'congo dr', 'democratic republic of congo']],
  ['rd congo',        ['dr congo', 'drc', 'congo dr']],
  ['cape verde',      ['cap vert']],
  ['guinea bissau',   ['guinee bissau']],
  ['trinidad',        ['trinidad and tobago', 'trinidad tobago']],
  ['trinidad and tobago', ['trinidad', 'trinidad tobago']],
]);

/**
 * Teste si deux noms d'équipes normalisés désignent la même équipe.
 * 3 passes : égalité exacte → substring (≥4 chars) → alias → overlap tokens.
 */
function teamsMatch(a, b) {
  if (a === b) return true;

  // Substring : le plus court contenu dans le plus long, min 4 chars pour éviter faux positifs
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length >  b.length ? a : b;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  // Alias dictionary (bidirectionnel)
  const aliasA = TEAM_ALIASES.get(a);
  if (aliasA?.includes(b)) return true;
  const aliasB = TEAM_ALIASES.get(b);
  if (aliasB?.includes(a)) return true;

  // Token overlap : mots significatifs (≥4 lettres) en commun
  // "south korea" ↔ "korea republic" → partagent "korea" → match
  // "england"     ↔ "manchester"     → aucun token commun → no match
  const tokA = a.split(' ').filter(t => t.length >= 4);
  const tokB = b.split(' ').filter(t => t.length >= 4);
  if (tokA.length > 0 && tokB.length > 0) {
    const shared = tokA.filter(t => tokB.includes(t));
    if (shared.length > 0 && shared.length / Math.min(tokA.length, tokB.length) >= 0.5) return true;
  }

  return false;
}

/**
 * Tente de matcher un pronostic DB (string "TeamA vs TeamB") avec un fixture API-Football.
 * Retourne le fixture correspondant ou null.
 */
function matchFixture(pronoMatch, fixtures) {
  const parts = pronoMatch.split(/\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  const [a, b] = parts.map(normalizeTeam);

  return fixtures.find(f => {
    const home = normalizeTeam(f.teams?.home?.name || '');
    const away = normalizeTeam(f.teams?.away?.name || '');
    return (teamsMatch(home, a) && teamsMatch(away, b))
        || (teamsMatch(home, b) && teamsMatch(away, a));
  }) || null;
}

/**
 * Évalue si le pronostic principal est correct d'après le score réel.
 * Logique simple sur les cas fréquents — Claude prend le relais pour les cas complexes.
 */
function evalPronostic(pronosticPrincipal, homeGoals, awayGoals) {
  const p = (pronosticPrincipal || '').toLowerCase();
  const diff = homeGoals - awayGoals;

  if (/victoire.*(dom|home|équipe a|team a|\b1\b)/i.test(p) || /home win/i.test(p)) return diff > 0;
  if (/victoire.*(ext|away|équipe b|team b|\b2\b)/i.test(p) || /away win/i.test(p)) return diff < 0;
  if (/nul|draw|\b[xX]\b/.test(p)) return diff === 0;
  if (/\+2\.5|over 2\.5|plus de 2\.5/i.test(p)) return (homeGoals + awayGoals) > 2.5;
  if (/-2\.5|under 2\.5|moins de 2\.5/i.test(p)) return (homeGoals + awayGoals) < 2.5;
  if (/\+1\.5|over 1\.5/i.test(p)) return (homeGoals + awayGoals) > 1.5;
  if (/btts|les deux.*marquent|both.*score/i.test(p)) return homeGoals > 0 && awayGoals > 0;
  return null; // cas non géré → fallback Claude
}

/**
 * Évalue si le value_bet est correct (même logique simple).
 */
function evalValueBet(valueBet, homeGoals, awayGoals) {
  if (!valueBet || valueBet === 'aucun') return null;
  return evalPronostic(valueBet, homeGoals, awayGoals);
}

export async function checkResults() {
  console.log('\n🔎 Vérification des résultats du jour...\n');

  const dateISO = new Date().toISOString().slice(0, 10);

  const { rows: pronostics } = await query(
    `SELECT id, match, sport, pronostic_principal, value_bet
     FROM ps_pronostics
     WHERE date = $1 AND resultat_reel IS NULL`,
    [dateISO]
  );

  if (pronostics.length === 0) {
    console.log('ℹ️  Aucun pronostic à vérifier pour aujourd\'hui.');
    return;
  }

  console.log(`📋 ${pronostics.length} pronostic(s) à vérifier...`);

  // ── Source primaire : API-Football ────────────
  const fixtures = await fetchApiFootballResults(dateISO);
  console.log(`   📡 API-Football: ${fixtures.length} match(s) terminé(s) récupéré(s)`);

  for (const p of pronostics) {
    try {
      let scoreReel = null, resultatReel = null, pronosticCorrect = null, valueBetCorrect = null;
      let source = 'claude';

      // ── Tentative API-Football ─────────────────
      const fixture = matchFixture(p.match, fixtures);

      if (fixture) {
        const status = fixture.fixture?.status?.short;
        // Guard : match pas encore terminé
        if (!['FT', 'AET', 'PEN'].includes(status)) {
          console.log(`   ⏳ ${p.match} — Pas encore terminé (${status}), skip`);
          continue;
        }

        const hg = fixture.goals?.home ?? 0;
        const ag = fixture.goals?.away ?? 0;
        scoreReel = `${hg}-${ag}`;
        resultatReel = `${fixture.teams?.home?.name} ${hg}-${ag} ${fixture.teams?.away?.name}`;
        pronosticCorrect = evalPronostic(p.pronostic_principal, hg, ag);
        valueBetCorrect  = evalValueBet(p.value_bet, hg, ag);
        source = 'api-football';
      }

      // ── Fallback Claude si match absent ou eval impossible ─
      if (source === 'claude' || pronosticCorrect === null) {
        console.log(`   🤖 Fallback Claude pour "${p.match}"...`);
        const userMsg = `Quel est le résultat final du match "${p.match}" joué aujourd'hui (${dateISO}) ?
Réponds UNIQUEMENT avec ce JSON (pas de texte autour) :
{
  "score_reel": "X-X",
  "resultat_reel": "description courte",
  "pronostic_correct": true,
  "value_bet_correct": true,
  "commentaire": ""
}
Le pronostic principal était : "${p.pronostic_principal}"
Le value bet était : "${p.value_bet || 'aucun'}"
Si le match n'est pas encore terminé, réponds : { "skip": true }`;

        try {
          const resp = await callAI(
            'Tu cherches les résultats sportifs réels du jour. Réponds uniquement en JSON.',
            userMsg,
            400
          );
          const result = extractJSON(resp.content);
          if (result.skip) {
            console.log(`   ⏳ ${p.match} — Pas encore terminé selon Claude, skip`);
            continue;
          }
          scoreReel        = result.score_reel      || scoreReel;
          resultatReel     = result.resultat_reel   || resultatReel;
          pronosticCorrect = result.pronostic_correct ?? pronosticCorrect;
          valueBetCorrect  = result.value_bet_correct ?? valueBetCorrect;
          source = 'claude';
        } catch (claudeErr) {
          console.warn(`   ⚠️  Claude fallback échoué pour "${p.match}": ${claudeErr.message}`);
          continue;
        }
      }

      // ── Sauvegarde ────────────────────────────
      await query(
        `UPDATE ps_pronostics
         SET resultat_reel      = $1,
             score_reel         = $2,
             pronostic_correct  = $3,
             value_bet_correct  = $4,
             updated_at         = NOW()
         WHERE id = $5`,
        [resultatReel, scoreReel, pronosticCorrect ?? null, valueBetCorrect ?? null, p.id]
      );

      const emoji = pronosticCorrect === true ? '✅' : pronosticCorrect === false ? '❌' : '❓';
      console.log(`   ${emoji} [${source}] ${p.match} — ${scoreReel} | Pronostic: ${pronosticCorrect === true ? 'Correct' : pronosticCorrect === false ? 'Raté' : 'Inconnu'}`);

    } catch (err) {
      console.error(`   ❌ Erreur vérification "${p.match}":`, err.message);
    }
  }

  console.log('\n✅ Vérification terminée\n');
}

// ══════════════════════════════════════════════
// UPDATE VICTOR STATS — Calcul journalier
// ══════════════════════════════════════════════

/**
 * Calcule et sauvegarde les stats du jour dans ps_victor_stats.
 */
export async function updateVictorStats() {
  console.log('\n📊 Calcul des stats du jour...\n');

  const dateISO = new Date().toISOString().slice(0, 10);

  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)                                                              AS total,
         SUM(CASE WHEN pronostic_correct = true THEN 1 ELSE 0 END)            AS corrects,
         ROUND(100.0 * SUM(CASE WHEN pronostic_correct = true THEN 1 ELSE 0 END)
               / NULLIF(COUNT(*), 0), 2)                                      AS taux_global,
         ROUND(100.0 * SUM(CASE WHEN pronostic_correct = true AND confiance = 'Élevé' THEN 1 ELSE 0 END)
               / NULLIF(SUM(CASE WHEN confiance = 'Élevé' THEN 1 ELSE 0 END), 0), 2)   AS taux_eleve,
         ROUND(100.0 * SUM(CASE WHEN pronostic_correct = true AND confiance = 'Moyen' THEN 1 ELSE 0 END)
               / NULLIF(SUM(CASE WHEN confiance = 'Moyen' THEN 1 ELSE 0 END), 0), 2)   AS taux_moyen,
         ROUND(100.0 * SUM(CASE WHEN value_bet_correct = true THEN 1 ELSE 0 END)
               / NULLIF(SUM(CASE WHEN value_bet IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS taux_value,
         -- ROI simulé mise fixe 10€
         ROUND(SUM(CASE
           WHEN pronostic_correct = true THEN (cote_estimee - 1) * 10
           ELSE -10
         END), 2) AS roi
       FROM ps_pronostics
       WHERE date = $1
         AND pronostic_correct IS NOT NULL`,
      [dateISO]
    );

    const s = rows[0];
    if (!s || parseInt(s.total) === 0) {
      console.log('ℹ️  Aucun résultat vérifié pour aujourd\'hui.');
      return;
    }

    await query(
      `INSERT INTO ps_victor_stats
         (date, taux_global, taux_confiance_eleve, taux_confiance_moyen,
          taux_value_bet, roi_mise_fixe, total_pronostics, pronostics_corrects)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (date) DO UPDATE SET
         taux_global           = EXCLUDED.taux_global,
         taux_confiance_eleve  = EXCLUDED.taux_confiance_eleve,
         taux_confiance_moyen  = EXCLUDED.taux_confiance_moyen,
         taux_value_bet        = EXCLUDED.taux_value_bet,
         roi_mise_fixe         = EXCLUDED.roi_mise_fixe,
         total_pronostics      = EXCLUDED.total_pronostics,
         pronostics_corrects   = EXCLUDED.pronostics_corrects`,
      [
        dateISO,
        s.taux_global  || 0,
        s.taux_eleve   || 0,
        s.taux_moyen   || 0,
        s.taux_value   || 0,
        s.roi          || 0,
        parseInt(s.total),
        parseInt(s.corrects),
      ]
    );

    console.log(`   📅 Date: ${dateISO}`);
    console.log(`   🎯 Taux global: ${s.taux_global}% (${s.corrects}/${s.total})`);
    console.log(`   🔥 Confiance Élevé: ${s.taux_eleve || 'N/A'}%`);
    console.log(`   📊 Confiance Moyen: ${s.taux_moyen || 'N/A'}%`);
    console.log(`   💰 Value Bet: ${s.taux_value || 'N/A'}%`);
    console.log(`   📈 ROI simulé: ${s.roi > 0 ? '+' : ''}${s.roi}€ (mise 10€/prono)`);
    console.log('\n✅ Stats sauvegardées\n');

  } catch (err) {
    console.error('❌ Erreur calcul stats:', err.message);
    throw err;
  }
}

// ══════════════════════════════════════════════
// WEEKLY VICTOR REVIEW — Bilan hebdomadaire
// ══════════════════════════════════════════════

/**
 * Analyse les performances de la semaine et génère
 * de nouvelles règles pour Victor via Claude.
 * Insère le résultat dans ps_victor_rules.
 */
export async function weeklyVictorReview() {
  console.log('\n📊 Weekly Victor Review — démarrage...\n');

  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY manquante — review impossible');
    return;
  }

  // ── Numéro de semaine ISO ─────────────────────
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  const semaine = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  // ── Stats des 7 derniers jours ────────────────
  let statsHebdo;
  try {
    const { rows } = await query(`
      SELECT date, taux_global, taux_confiance_eleve,
             taux_value_bet, roi_mise_fixe,
             total_pronostics, pronostics_corrects
      FROM ps_victor_stats
      WHERE date >= NOW() - INTERVAL '7 days'
      ORDER BY date DESC
    `);
    statsHebdo = rows;
  } catch (err) {
    console.error('❌ [Review] Erreur récupération stats:', err.message);
    return;
  }

  const totalPronostics = statsHebdo.reduce((s, r) => s + (parseInt(r.total_pronostics) || 0), 0);
  if (totalPronostics < 10) {
    console.log(`ℹ️  Pas assez de données cette semaine (${totalPronostics}/10 minimum) — review reportée`);
    return;
  }

  // ── 10 dernières erreurs ──────────────────────
  let erreurs;
  try {
    const { rows } = await query(`
      SELECT sport, competition, match,
             pronostic_principal, confiance,
             resultat_reel, score_reel, date
      FROM ps_pronostics
      WHERE pronostic_correct = false
        AND date >= NOW() - INTERVAL '7 days'
      ORDER BY date DESC
      LIMIT 10
    `);
    erreurs = rows;
  } catch (err) {
    console.error('❌ [Review] Erreur récupération erreurs:', err.message);
    erreurs = [];
  }

  // ── Appel Claude ──────────────────────────────
  console.log('🤖 Analyse des performances par Claude...');

  const prompt = `Tu es l'analyste de Victor, un pronostiqueur sportif IA.
Analyse ces performances de la semaine ${semaine} et génère des directives opérationnelles.

STATS DE LA SEMAINE :
${JSON.stringify(statsHebdo, null, 2)}

ERREURS DE LA SEMAINE :
${JSON.stringify(erreurs, null, 2)}

Identifie :
1. Les 3 biais principaux de Victor (patterns d'erreur récurrents)
2. Les 5 nouvelles règles à appliquer la semaine prochaine
3. Les sports à aborder avec prudence (et pourquoi)
4. Les types de paris sous-performants à éviter

Réponds UNIQUEMENT avec ce JSON :
{
  "biais": ["biais 1", "biais 2", "biais 3"],
  "regles": [
    "Règle 1 : ...",
    "Règle 2 : ...",
    "Règle 3 : ...",
    "Règle 4 : ...",
    "Règle 5 : ..."
  ],
  "sports_prudence": {
    "sport": "raison"
  },
  "paris_eviter": ["type de pari 1", "type de pari 2"]
}`;

  let reviewData;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: 'Tu analyses des données sportives. Réponds uniquement en JSON valide, sans texte hors JSON.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const data = await resp.json();
    reviewData = extractJSON(data.content);
  } catch (err) {
    console.error('❌ [Review] Erreur Claude:', err.message);
    return;
  }

  // ── Sauvegarde dans ps_victor_rules ───────────
  try {
    await query(
      `INSERT INTO ps_victor_rules (semaine, regles, biais, sports_prudence)
       VALUES ($1, $2, $3, $4)`,
      [
        semaine,
        JSON.stringify(reviewData.regles || []),
        JSON.stringify(reviewData.biais || []),
        JSON.stringify(reviewData.sports_prudence || {}),
      ]
    );

    const nbRegles = (reviewData.regles || []).length;
    console.log(`✅ ${nbRegles} nouvelles règles générées pour la semaine ${semaine}`);

    if (reviewData.biais?.length) {
      console.log(`   Biais détectés :`);
      reviewData.biais.forEach(b => console.log(`     • ${b}`));
    }
    if (Object.keys(reviewData.sports_prudence || {}).length) {
      console.log(`   Sports prudence : ${Object.keys(reviewData.sports_prudence).join(', ')}`);
    }

  } catch (err) {
    console.error('❌ [Review] Erreur sauvegarde règles:', err.message);
  }
}
