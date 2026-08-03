// ══════════════════════════════════════════════
// victor/core.js — Cerveau de Victor
// ══════════════════════════════════════════════

// ⚠️ Doit rester le TOUT PREMIER import : les imports ESM sont hoistés,
// donc db/database.js s'évaluerait avant un dotenv.config() placé dans le
// corps du module — et lirait un process.env.DATABASE_URL encore vide.
import 'dotenv/config';
import { query } from '../db/database.js';
import { VICTOR_PROMPT } from './prompt.js';
import { detectPatterns, formatPatternsForVictor } from './patterns.js';
import {
  getFixturesOfDay, getResultsOfDay, buildFormIndex, getStandings, getH2H,
  getScorers, formatFixturesForPrompt, fetchWithTimeout,
} from './sources.js';
import { getOdds, evaluerValue } from './odds.js';

const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_MODEL        = process.env.GEMINI_MODEL        || 'gemini-flash-latest';
const GEMINI_SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-flash-latest';
const GEMMA_MODEL       = process.env.GEMMA_MODEL        || 'gemma-4-31b-it';
const GROQ_API_KEY      = process.env.GROQ_API_KEY;
const GROQ_MODEL        = process.env.GROQ_MODEL         || 'llama-3.3-70b-versatile';

// Timeout de tout appel IA. Sans lui un blocage réseau fige le worker.
const AI_TIMEOUT_MS     = Number(process.env.AI_TIMEOUT_MS || 90_000);

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

// ── Appel Gemini helper ───────────────────────
async function geminiRequest(contents, { maxTokens = 8000, jsonMode = false, search = false, model = null } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquante');
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 8192),
      temperature: 0.4,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {})
    },
  };
  if (search) body.tools = [{ googleSearch: {} }];
  // Pour les recherches web, utiliser gemini-flash-latest (supporte search + retourne du texte)
  // Pour les analyses JSON, utiliser GEMINI_MODEL (gemini-2.5-flash)
  const modelName = model || (search ? GEMINI_SEARCH_MODEL : GEMINI_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  // Timeout obligatoire : sans lui, un blocage réseau fige le worker
  // (concurrency 1) et le job reste 'running' indéfiniment.
  const resp = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    AI_TIMEOUT_MS
  );
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Gemini HTTP ${resp.status}: ${t.slice(0, 200)}`); }
  const data = await resp.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  return data;
}

// ── Appel Groq (3e moteur — indépendant du quota Google) ──────
//
// ⚠️ Le mode JSON de Groq EXIGE le mot « json » quelque part dans les
// messages, sinon HTTP 400. D'où le suffixe ajouté au system prompt.
// (Vérifié : la casse n'a pas d'importance, « JSON » est accepté.)
async function groqRequest(systemPrompt, userMessage, maxTokens = 8000, tentative = 1) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY manquante');
  const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      max_tokens: Math.min(maxTokens, 8000),
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  }, AI_TIMEOUT_MS);

  // Limite de débit : Groq indique combien de temps attendre. Une seule
  // relance — au-delà, mieux vaut échouer vite et laisser la file retenter.
  if (resp.status === 429 && tentative === 1) {
    const attente = Math.min(Number(resp.headers.get('retry-after') || 20), 60);
    console.warn(`   ⏳ Groq limite de débit — nouvelle tentative dans ${attente}s`);
    await new Promise(r => setTimeout(r, attente * 1000));
    return groqRequest(systemPrompt, userMessage, maxTokens, 2);
  }

  if (!resp.ok) { const t = await resp.text(); throw new Error(`Groq HTTP ${resp.status}: ${t.slice(0, 200)}`); }
  const data = await resp.json();
  if (data.error) throw new Error(`Groq: ${data.error.message}`);
  // Ré-emballé au format Gemini pour qu'extractJSON n'ait qu'un seul format à gérer
  return { candidates: [{ content: { parts: [{ text: data.choices?.[0]?.message?.content || '' }] } }] };
}

// ── callAI : cascade Gemini JSON → Gemma → Groq ───────────────
//
// La découverte des matchs ne passe PLUS par googleSearch (quota
// épuisé + matchs hallucinés). Les faits arrivent déjà dans
// `userMessage`, construits par victor/sources.js. L'IA ne fait
// plus qu'analyser des données réelles.
async function callAI(systemPrompt, userMessage, maxTokens = 8000) {
  const erreurs = [];

  // ── 1. Gemini en mode JSON strict (primaire) ──
  if (GEMINI_API_KEY) {
    try {
      const data = await geminiRequest(
        [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n---\n\n${userMessage}` }] }],
        { maxTokens, jsonMode: true }
      );
      console.log(`   🤖 Moteur : Gemini (${GEMINI_MODEL})`);
      return { source: 'gemini', data };
    } catch (err) {
      erreurs.push(`gemini: ${err.message}`);
      console.warn(`   ⚠️  Gemini échoué (${err.message.slice(0, 120)}) — bascule Gemma`);
    }

    // ── 2. Gemma (même clé, quota distinct) ──
    // Gemma ne supporte pas responseMimeType → extractJSON parse le texte brut.
    try {
      const data = await geminiRequest(
        [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n---\n\n${userMessage}\n\nRéponds UNIQUEMENT avec le JSON brut, sans markdown, sans texte avant ou après.` }] }],
        { maxTokens, jsonMode: false, model: GEMMA_MODEL }
      );
      console.log(`   🤖 Moteur : Gemma (${GEMMA_MODEL})`);
      return { source: 'gemma', data };
    } catch (err) {
      erreurs.push(`gemma: ${err.message}`);
      console.warn(`   ⚠️  Gemma échoué (${err.message.slice(0, 120)}) — bascule Groq`);
    }
  }

  // ── 3. Groq (fournisseur différent : survit à une panne Google) ──
  if (GROQ_API_KEY) {
    try {
      const data = await groqRequest(
        `${systemPrompt}\n\nRéponds UNIQUEMENT avec du JSON valide.`,
        userMessage,
        maxTokens
      );
      console.log(`   🤖 Moteur : Groq (${GROQ_MODEL})`);
      return { source: 'groq', data };
    } catch (err) {
      erreurs.push(`groq: ${err.message}`);
    }
  }

  throw new Error(`Tous les moteurs IA ont échoué — ${erreurs.join(' | ')}`);
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

  // Tentative 1 : parse direct
  try {
    return JSON.parse(clean);
  } catch (_) {}

  // Tentative 2 : remplace les retours ligne littéraux DANS les chaînes JSON
  // (Gemini peut mettre des \n réels dans analyse_tactique, contexte, etc.)
  try {
    const sanitized = clean.replace(
      /"((?:[^"\\]|\\.)*)"/g,
      (m) => m
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    );
    return JSON.parse(sanitized);
  } catch (_) {}

  // Tentative 3 : compacte tout sur une ligne + nettoyage global
  try {
    const oneLine = clean
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\s+/g, ' ');
    return JSON.parse(oneLine);
  } catch (_) {}

  // Tentative 4 : réparation d'une réponse TRONQUÉE.
  // Les modèles à raisonnement (Gemini 2.5) consomment leur budget de
  // sortie en réflexion et peuvent s'arrêter en plein milieu du JSON.
  // Plutôt que de tout perdre, on coupe à la dernière structure complète
  // et on referme. Mieux vaut 5 pronostics que zéro.
  try {
    const repare = repairTruncatedJSON(raw.slice(raw.indexOf('{')));
    const data = JSON.parse(repare);
    console.warn(`   ⚠️  Réponse IA tronquée — JSON réparé (${data.events?.length ?? 0} event(s) récupéré(s))`);
    return data;
  } catch (e) {
    throw new Error(`JSON invalide après 4 tentatives: ${e.message}`);
  }
}

/**
 * Referme un JSON interrompu en cours d'écriture : on tronque à la
 * dernière valeur complète, puis on ferme les structures encore ouvertes.
 * @param {string} s  texte débutant par '{'
 * @returns {string}  JSON syntaxiquement valide
 */
export function repairTruncatedJSON(s) {
  // On ne coupe QUE sur une fermeture de structure ('}' ou ']'). Couper
  // ailleurs laisserait un objet à moitié écrit : un event sans
  // pronostic_principal serait inséré en base avec des colonnes vides.
  // Mieux vaut perdre le dernier match que d'enregistrer une coquille.
  let dansChaine = false, echap = false, coupe = -1;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (echap)      { echap = false; continue; }
    if (c === '\\') { echap = true;  continue; }
    if (c === '"')  { dansChaine = !dansChaine; continue; }
    if (dansChaine) continue;
    if (c === '}' || c === ']') coupe = i;
  }

  if (coupe === -1) throw new Error('Rien de récupérable dans la réponse tronquée');

  const tete = s.slice(0, coupe + 1);

  // Recalcule les structures encore ouvertes à la position de coupe
  const ouverts = [];
  dansChaine = false; echap = false;
  for (let i = 0; i < tete.length; i++) {
    const c = tete[i];
    if (echap)      { echap = false; continue; }
    if (c === '\\') { echap = true;  continue; }
    if (c === '"')  { dansChaine = !dansChaine; continue; }
    if (dansChaine) continue;
    if (c === '{' || c === '[') ouverts.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') ouverts.pop();
  }

  return tete + ouverts.reverse().join('');
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

  // ── Date du jour ─────────────────────────────
  const today = new Date();
  const dateStr = today.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Paris'
  });
  const dateISO = today.toISOString().slice(0, 10);

  // ── Matchs réels du jour (sources factuelles, aucun LLM) ──────
  // Remplace l'ancienne découverte par googleSearch : quota Gemini
  // épuisé, et surtout Victor inventait des matchs inexistants.
  console.log('📡 Récupération des matchs réels du jour...');
  const fixtures = await getFixturesOfDay(dateISO);
  const aVenir   = fixtures.filter(f => f.status !== 'FT');

  if (aVenir.length === 0) {
    console.warn(`⚠️  Aucun match à venir trouvé pour le ${dateISO} — analyse annulée`);
    return {
      date: dateISO,
      generated_at: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
      events: [],
      raison: 'aucun match disponible ce jour',
    };
  }

  // ── Contexte factuel : forme, classement, confrontations directes ──
  // Trois sources structurées qui remplacent l'ancienne « étape 2 » par
  // Google Search. Chaque chiffre est traçable, aucun n'est inventé.
  console.log('📊 Construction du contexte (forme, classement, H2H)...');
  const forme = await buildFormIndex(20).catch(() => new Map());

  const codesCompet = [...new Set(aVenir.map(f => f.codeCompet).filter(Boolean))];
  const classement  = await getStandings(codesCompet).catch(() => new Map());
  const h2h         = await getH2H(aVenir, 8).catch(() => new Map());
  const buteurs     = await getScorers(codesCompet).catch(() => new Map());
  const cotes       = await getOdds(aVenir).catch(() => new Map());

  const matchsReels = formatFixturesForPrompt(aVenir, { forme, classement, h2h, buteurs, cotes });

  // ── Patterns, filtrés sur les matchs du jour ─────────────────
  // Chargés APRÈS les matchs : injecter les patterns de la Bundesliga
  // un soir où seul le Brésil joue n'apporte que du bruit.
  console.log('🧠 Chargement des patterns pertinents...');
  let patternsTexte = 'Aucun pattern historique significatif pour les matchs du jour.';
  try {
    const competitions = [...new Set(aVenir.map(f => `Match de ${f.competition}`))];
    const equipes      = [...new Set(aVenir.flatMap(f => [f.home, f.away]).filter(Boolean))];

    const { rows: patternsActifs } = await query(
      `SELECT nom, type, sport, equipe_a, equipe_b,
              condition_trigger, pattern_observe,
              taux_confirmation, pari_suggere, fiabilite
       FROM ps_victor_patterns
       WHERE actif = true
         AND taux_confirmation >= 55
         AND (condition_trigger = ANY($1) OR equipe_a = ANY($2))
       ORDER BY
         CASE fiabilite WHEN 'Fort' THEN 1 WHEN 'Moyen' THEN 2 ELSE 3 END,
         taux_confirmation DESC
       LIMIT 20`,
      [competitions, equipes]
    );

    if (patternsActifs.length > 0) {
      const result = {
        h2h: patternsActifs.filter(p => p.type === 'H2H'),
        situationnels: patternsActifs.filter(p => p.type !== 'H2H'),
        signal_fort: patternsActifs.filter(p => parseFloat(p.taux_confirmation) >= 70),
      };
      patternsTexte = formatPatternsForVictor(result);
      console.log(`   ✅ ${patternsActifs.length} pattern(s) pertinent(s) (${result.signal_fort.length} signal(s) fort(s))`);
    } else {
      console.log('   ℹ️  Aucun pattern applicable aux matchs du jour');
    }
  } catch (err) {
    console.warn('   ⚠️  Patterns non disponibles:', err.message);
  }

  // ── Message utilisateur ──────────────────────
  const userMessage = `Nous sommes le ${dateStr}.

${briefing}

${patternsTexte}

══ MATCHS RÉELS DU ${dateStr} ══
Cette liste provient d'APIs sportives officielles. Elle est exhaustive et vérifiée.

${matchsReels}

⚠️ RÈGLES ABSOLUES :
- N'analyse QUE des matchs de la liste ci-dessus. N'en invente AUCUN autre.
- Reprends les noms d'équipes EXACTEMENT tels qu'écrits ci-dessus.
- Si la forme d'une équipe n'est pas fournie, ne l'invente pas : n'inclus pas ce match.
- Sélectionne AU MAXIMUM ${Math.min(aVenir.length, 4)} matchs — les plus solides uniquement.
  Moins de paris de meilleure qualité vaut mieux qu'une liste complète.

Lance l'analyse complète et retourne le JSON. Réponds UNIQUEMENT avec ce JSON :
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
    "stats_cles": [],
    "analyse_tactique": "",
    "pronostic_principal": "",
    "probabilite": 0.00,
    "cote_estimee": 0.00,
    "confiance": "",
    "confiance_score": 0,
    "value_bet": "",
    "cote_value": 0.00,
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
  console.log(`🤖 Analyse IA de ${aVenir.length} match(s) réel(s)...`);
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
    victorData = extractJSON(claudeResp); // claudeResp = { source, data } — extractJSON gère le wrapper
  } catch (err) {
    console.error('❌ Impossible de parser la réponse JSON:', err.message);
    console.error('   Réponse brute:', JSON.stringify(claudeResp?.data).slice(0, 500));
    throw err;
  }

  // ── Portillon de validation ──────────────────
  // Un pronostic que evalPronostic() ne sait pas trancher ne pourra
  // JAMAIS être noté : il polluerait le taux de réussite sans jamais le
  // faire bouger. On le rejette ici plutôt que de le découvrir dans un
  // audit six mois plus tard.
  const moteur      = claudeResp?.source || 'inconnu';
  const clesReelles = new Set(aVenir.map(f => `${normalizeTeam(f.home)}|${normalizeTeam(f.away)}`));
  const bruts       = victorData.events || [];
  const events      = [];
  const rejets      = [];

  for (const ev of bruts) {
    const motifs = validerEvent(ev, clesReelles);
    if (motifs.length > 0) { rejets.push({ match: ev?.match || '(sans nom)', motifs }); continue; }

    // ── Value calculée, pas déclarée ──────────────────────────
    // Le modèle fournit une probabilité ; la cote vient du marché.
    // value = p × cote − 1. Une value négative signifie que le pari
    // est perdant sur la durée, même s'il a des chances de passer.
    const fx = aVenir.find(f => normalizeTeam(f.home) === normalizeTeam(ev.equipe_a || '')
                             || normalizeTeam(f.away) === normalizeTeam(ev.equipe_b || ''));
    const vb = fx?.fixtureId ? evaluerValue(ev, cotes.get(fx.fixtureId)) : null;
    if (vb) {
      ev.cote_estimee = vb.cote;              // cote RÉELLE, plus une estimation
      ev.value_calculee = vb.value;
      ev.proba_marche   = vb.probaMarche;
      if (vb.value <= 0) {
        rejets.push({
          match: ev.match,
          motifs: [`value négative (${(vb.value * 100).toFixed(1)}% à la cote ${vb.cote})`],
        });
        continue;
      }
    }

    events.push(ev);
  }

  if (rejets.length > 0) {
    console.warn(`\n🚫 ${rejets.length} pronostic(s) rejeté(s) :`);
    rejets.forEach(r => console.warn(`   • ${r.match} — ${r.motifs.join(' ; ')}`));
  }

  // ── Sauvegarde PostgreSQL ────────────────────
  console.log(`\n💾 Sauvegarde de ${events.length} pronostic(s) en DB (moteur: ${moteur})...`);

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

  console.log(`\n✅ Victor a généré ${events.length} pronostic(s) exploitable(s)\n`);

  // events = uniquement les pronostics validés : le broadcast Telegram
  // et le compteur du job doivent refléter ce qui est réellement en base.
  return {
    ...victorData,
    events,
    moteur,
    rejets,
    raison: events.length === 0
      ? (rejets.length > 0
          ? `${rejets.length} pronostic(s) rejeté(s) au contrôle qualité`
          : 'aucun pronostic produit par l\'IA')
      : undefined,
  };
}

// ══════════════════════════════════════════════
// CHECK RESULTS — Vérification post-match
// ══════════════════════════════════════════════

/**
 * Pour chaque pronostic du jour sans résultat,
 * demande à Claude de chercher le score réel.
 */
// ── Helpers checkResults ─────────────────────

// La récupération des scores vit désormais dans victor/sources.js
// (getResultsOfDay) : multi-sources, avec détection des refus HTTP 200.

/**
 * Normalise un nom d'équipe pour la comparaison : minuscules, sans accents, sans ponctuation.
 */
// ⚠️ NE PAS confondre avec normalizeTeam() de victor/sources.js, qui
// retire en plus les suffixes de club (FC, de, of…). Celui-ci est
// calibré pour TEAM_ALIASES et teamsMatch ci-dessous : le modifier
// casserait la table d'alias. Tout ce qui compare des équipes DANS
// core.js doit utiliser cette version-ci, exclusivement.
export function normalizeTeam(name = '') {
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
 * Tente de matcher un pronostic DB (string "TeamA vs TeamB") avec un
 * match normalisé de victor/sources.js. Retourne le match ou null.
 */
export function matchFixture(pronoMatch, fixtures) {
  const parts = String(pronoMatch || '').split(/\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  const [a, b] = parts.map(normalizeTeam);

  return fixtures.find(f => {
    const home = normalizeTeam(f.home || '');
    const away = normalizeTeam(f.away || '');
    return (teamsMatch(home, a) && teamsMatch(away, b))
        || (teamsMatch(home, b) && teamsMatch(away, a));
  }) || null;
}

/**
 * Évalue si un pronostic est correct d'après le score réel.
 * Déterministe — aucun appel LLM.
 *
 * ⚠️ L'ordre des tests est critique. "Portugal -2.5" est un HANDICAP
 * (gagner par 3+ buts d'écart), pas un "Under 2.5 buts". L'ancienne
 * version testait l'Over/Under en premier et inversait donc tous les
 * handicaps — ce qui corrompait le taux de réussite à la source.
 *
 * @param {string} pronostic          ex. "Victoire Portugal", "Portugal -2.5", "Over 2.5"
 * @param {number} homeGoals
 * @param {number} awayGoals
 * @param {string} [homeName]         nom de l'équipe à domicile (si connu)
 * @param {string} [awayName]         nom de l'équipe à l'extérieur (si connu)
 * @returns {boolean|null}            null = cas non géré → fallback IA
 */
export function evalPronostic(pronostic, homeGoals, awayGoals, homeName = '', awayName = '') {
  const p = String(pronostic || '').toLowerCase().replace(',', '.');
  if (!p) return null;

  const diff  = homeGoals - awayGoals;
  const total = homeGoals + awayGoals;

  const nomDom  = normalizeTeam(homeName);
  const nomExt  = normalizeTeam(awayName);
  const pNorm   = normalizeTeam(p);
  const viseDom = Boolean(nomDom && pNorm.includes(nomDom));
  const viseExt = Boolean(nomExt && pNorm.includes(nomExt));

  // ── 1. HANDICAP — impérativement avant l'Over/Under ──────────
  // Reconnu si : le mot "handicap", ou un ±N accolé à un nom d'équipe.
  const mHcp = p.match(/([+-]\s*\d+(?:\.\d+)?)/);
  const estHandicap = mHcp && (/handicap|hcp/.test(p) || ((viseDom || viseExt) && !/(over|under|plus de|moins de|buts|goals|but)/.test(p)));
  if (estHandicap) {
    const h = parseFloat(mHcp[1].replace(/\s+/g, ''));
    // Handicap appliqué à l'équipe visée : son écart + handicap doit rester > 0
    return viseExt && !viseDom ? (-diff + h) > 0 : (diff + h) > 0;
  }

  // ── 2. OVER / UNDER (buts totaux) ────────────────────────────
  const mTot = p.match(/(over|under|plus de|moins de|\+|-)\s*(\d+(?:\.\d+)?)/);
  if (mTot && /(over|under|plus de|moins de|buts|goals)/.test(p)) {
    const seuil = parseFloat(mTot[2]);
    const estOver = /over|plus de|\+/.test(mTot[1]);
    return estOver ? total > seuil : total < seuil;
  }

  // ── 3. Match nul ─────────────────────────────────────────────
  // "X" seul = nul, mais pas le "X" d'un pari combiné type "1/X"
  // (mi-temps/fin de match), qui doit partir en arbitrage IA.
  if (/\bnul\b|\bdraw\b/.test(p) || /^[xn]$/.test(p.trim())) return diff === 0;

  // ── 4. 1N2, y compris désigné par le nom de l'équipe ─────────
  const estVictoire = /victoire|win|gagne|vainqueur/.test(p);
  if (estVictoire && viseDom && !viseExt) return diff > 0;
  if (estVictoire && viseExt && !viseDom) return diff < 0;
  if (/victoire.*(dom|home|équipe a|team a|\b1\b)|home win/.test(p)) return diff > 0;
  if (/victoire.*(ext|away|équipe b|team b|\b2\b)|away win/.test(p)) return diff < 0;

  // ── 5. Les deux équipes marquent ─────────────────────────────
  if (/btts|les deux.*marquent|both.*score/.test(p)) return homeGoals > 0 && awayGoals > 0;

  return null; // cas non géré → fallback IA
}

/**
 * Un pronostic est « notable » si evalPronostic() sait le trancher.
 *
 * On sonde avec deux scores opposés : si la fonction renvoie null dans
 * les deux cas, le type de pari n'est pas supporté. Publier un tel pari
 * serait une impasse — on ne pourrait JAMAIS le compter gagné ou perdu,
 * et il diluerait le taux de réussite sans jamais le faire bouger.
 *
 * C'est l'invariant qui ferme la boucle génération ↔ notation.
 */
export function estNotable(ev) {
  const p = ev?.pronostic_principal;
  if (!p || typeof p !== 'string' || p.trim().length < 3) return false;
  const a = evalPronostic(p, 3, 0, ev.equipe_a, ev.equipe_b);
  const b = evalPronostic(p, 0, 3, ev.equipe_a, ev.equipe_b);
  return a !== null || b !== null;
}

/**
 * Contrôle qu'un event est publiable. Retourne la liste des motifs de
 * rejet (vide = conforme). Empêche l'IA d'écrire n'importe quoi en base.
 *
 * @param {object} ev
 * @param {Set<string>} clesReelles  clés "domicile|exterieur" des matchs des sources
 */
export function validerEvent(ev, clesReelles = null) {
  const motifs = [];

  if (!ev?.match || !ev.equipe_a || !ev.equipe_b) {
    motifs.push('équipes ou match manquants');
  }

  // Refus explicite de parier : légitime de la part de Victor, mais ça
  // n'a rien à faire dans la table des pronostics.
  if (/^\s*(no bet|aucun pari|pas de pari|n\/a|aucun)\s*$/i.test(ev?.pronostic_principal || '')) {
    motifs.push('pas de pari proposé');
  } else if (!estNotable(ev)) {
    motifs.push(`pronostic non évaluable automatiquement : "${(ev?.pronostic_principal || '').slice(0, 40)}"`);
  }

  // La cote doit rester dans le domaine du plausible
  const cote = Number(ev?.cote_estimee);
  if (ev?.cote_estimee != null && ev.cote_estimee !== '' && (!Number.isFinite(cote) || cote < 1.01 || cote > 51)) {
    motifs.push(`cote implausible : ${ev.cote_estimee}`);
  }

  // Le match doit exister dans les sources — ceinture et bretelles :
  // le prompt l'interdit déjà, mais on ne fait pas confiance à un LLM.
  if (clesReelles && ev?.equipe_a && ev?.equipe_b) {
    const a = normalizeTeam(ev.equipe_a), b = normalizeTeam(ev.equipe_b);
    if (!clesReelles.has(`${a}|${b}`) && !clesReelles.has(`${b}|${a}`)) {
      motifs.push('match absent des sources (inventé)');
    }
  }

  return motifs;
}

/**
 * Évalue si le value_bet est correct (même logique).
 */
export function evalValueBet(valueBet, homeGoals, awayGoals, homeName = '', awayName = '') {
  if (!valueBet || /^aucun$/i.test(String(valueBet).trim())) return null;
  return evalPronostic(valueBet, homeGoals, awayGoals, homeName, awayName);
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

  // ── Source primaire : APIs sportives (football-data / TSDB / API-Football) ──
  const fixtures = await getResultsOfDay(dateISO);

  for (const p of pronostics) {
    try {
      let scoreReel = null, resultatReel = null, pronosticCorrect = null, valueBetCorrect = null;
      let source = 'ia';

      // ── Tentative sources factuelles ───────────
      const fixture = matchFixture(p.match, fixtures);

      if (fixture) {
        // Guard : match pas encore terminé (getResultsOfDay ne renvoie
        // en principe que du FT, mais on ne fait pas confiance à l'amont)
        if (fixture.status !== 'FT') {
          console.log(`   ⏳ ${p.match} — Pas encore terminé (${fixture.status}), skip`);
          continue;
        }

        const hg = fixture.homeGoals ?? 0;
        const ag = fixture.awayGoals ?? 0;
        scoreReel = `${hg}-${ag}`;
        resultatReel = `${fixture.home} ${hg}-${ag} ${fixture.away}`;
        pronosticCorrect = evalPronostic(p.pronostic_principal, hg, ag, fixture.home, fixture.away);
        valueBetCorrect  = evalValueBet(p.value_bet, hg, ag, fixture.home, fixture.away);
        source = fixture.source;
      }

      // ── Match introuvable dans les sources : on NE DEMANDE PAS
      // le score à l'IA. Sans accès web elle l'inventerait, et c'est
      // exactement l'hallucination qu'on cherche à éliminer. On laisse
      // le pronostic en attente : il sera repris au prochain passage.
      if (!fixture) {
        console.log(`   ❔ ${p.match} — Absent des sources, laissé en attente`);
        continue;
      }

      // ── Score connu mais type de pari non géré par evalPronostic :
      // l'IA ne fait qu'ARBITRER un score déjà factuel. Aucun risque
      // d'invention — on lui interdit de fournir le score.
      if (pronosticCorrect === null) {
        console.log(`   🤖 Arbitrage IA pour "${p.match}" (${scoreReel})...`);
        const userMsg = `Score final RÉEL et vérifié : ${resultatReel}
(${fixture.home} a marqué ${fixture.homeGoals}, ${fixture.away} a marqué ${fixture.awayGoals})

Pronostic principal à juger : "${p.pronostic_principal}"
Value bet à juger : "${p.value_bet || 'aucun'}"

Le score ci-dessus est un fait établi : ne le remets pas en cause et n'en propose aucun autre.
Détermine uniquement si chaque pari est gagné. Réponds UNIQUEMENT avec ce JSON :
{ "pronostic_correct": true, "value_bet_correct": true, "commentaire": "" }
Utilise null si un pari est impossible à trancher.`;

        try {
          const resp   = await callAI(
            'Tu arbitres des paris sportifs à partir d\'un score fourni. Réponds uniquement en JSON.',
            userMsg,
            400
          );
          const result = extractJSON(resp);
          pronosticCorrect = result.pronostic_correct ?? null;
          valueBetCorrect  = result.value_bet_correct ?? valueBetCorrect;
          source = `${fixture.source}+ia`;
        } catch (iaErr) {
          console.warn(`   ⚠️  Arbitrage IA échoué pour "${p.match}": ${iaErr.message}`);
          // Le score reste factuel et exploitable : on l'enregistre quand même
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

  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY manquante — review impossible');
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

  // ── Appel Gemma (Google AI) ───────────────────
  console.log(`🤖 Analyse des performances par Gemma (${GEMMA_MODEL})...`);

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
    const resp = await callAI(
      'Tu analyses des données sportives. Réponds uniquement en JSON valide, sans texte hors JSON.',
      prompt,
      2000
    );
    reviewData = extractJSON(resp);
  } catch (err) {
    console.error('❌ [Review] Tous les moteurs IA ont échoué:', err.message);
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
