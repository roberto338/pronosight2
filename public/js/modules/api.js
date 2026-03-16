
// ══════════════════════════════════════════════
// api.js — Tous les appels API (version GEMINI)
// ══════════════════════════════════════════════

import { ODDS_SPORT_MAP, BOOKMAKERS_EU, FD_COMP_MAP } from './config.js';
import { state } from './state.js';

// ══════════════════════════════════════════════
// GEMINI API (via /api/gemini)
// ══════════════════════════════════════════════
export async function callGemini(messages, { useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = {}) {
  const body = { messages, maxTokens, jsonMode };
  if (model) body.model = model;
  if (useSearch) body.useSearch = true;

  console.log('📤 Envoi à /api/gemini:', { maxTokens, useSearch, jsonMode, model });

  const resp = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('❌ Erreur HTTP:', resp.status, errText);
    throw new Error('HTTP ' + resp.status + ': ' + errText);
  }

  const data = await resp.json();

  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  if (!data.content || !data.content.length) throw new Error('Réponse vide');
  
  console.log('✅ Réponse reçue:', data);
  return data;
} = {}) {
  const baseUrl = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://pronosight2.onrender.com';

  const url = `${baseUrl}/api/gemini`;

  console.log('📤 Envoi à:', url);

  const body = {
    messages,
    useSearch,
    maxTokens,
    model: model || null
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    console.log('📥 Statut réponse:', resp.status);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('❌ Erreur HTTP:', resp.status, text);
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    console.log('✅ Réponse reçue:', data);

    if (data.error) {
      throw new Error(data.error.message || 'Erreur API');
    }

    return data;

  } catch (e) {
    console.error('❌ Erreur fetch:', e);
    throw e;
  }
}

export const callClaude = callGemini;

// ══════════════════════════════════════════════
// EXTRACTION TEXTE
// ══════════════════════════════════════════════
export function extractText(data) {
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

/** Extract JSON from Gemini text response — with auto-repair for truncated JSON */
export function extractJSON(text) {
  // Nettoyage agressif
  let clean = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  // Supprime TOUT ce qui est avant le premier {
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) {
    console.warn('🔍 Pas de { trouvé dans:', clean.slice(0, 200));
    return null;
  }
  clean = clean.substring(firstBrace);

  // Supprime TOUT ce qui est après le dernier }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1) {
    clean = clean.substring(0, lastBrace + 1);
  }

  // Supprime les caractères de contrôle
  clean = clean.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

  // Essai 1: Parse direct
  try {
    const result = JSON.parse(clean);
    console.log('✅ JSON parsé directement (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e) {
    console.warn('⚠️ Échec parse direct:', e.message);
  }

  // Essai 2: Compacte tout sur une ligne et re-parse
  let oneLine = clean.replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ');
  try {
    const result = JSON.parse(oneLine);
    console.log('✅ JSON parsé après compactage');
    return result;
  } catch (e) {
    console.warn('⚠️ Échec compactage:', e.message);
  }

  // Essai 3: Réparation agressive du JSON tronqué
  let repaired = oneLine;

  // Coupe après la dernière propriété complète "key":"value" ou "key":number
  const lastComplete = Math.max(
    repaired.lastIndexOf('",'),
    repaired.lastIndexOf('},'),
    repaired.lastIndexOf('],'),
    repaired.lastIndexOf('e,'),  // true/false
    repaired.search(/\d,(?=[^"]*$)/)  // number,
  );

  if (lastComplete > repaired.length * 0.3) {
    repaired = repaired.substring(0, lastComplete + 1);
  }

  // Supprime les virgules traînantes
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Ferme les guillemets
  const quotes = (repaired.match(/"/g) || []).length;
  if (quotes % 2 !== 0) repaired += '"';

  // Ferme les crochets et accolades
  let ob = (repaired.match(/\[/g) || []).length;
  let cb = (repaired.match(/\]/g) || []).length;
  let oc = (repaired.match(/\{/g) || []).length;
  let cc = (repaired.match(/\}/g) || []).length;
  while (cb < ob) { repaired += ']'; cb++; }
  while (cc < oc) { repaired += '}'; cc++; }

  try {
    const result = JSON.parse(repaired);
    console.log('✅ JSON réparé (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e) {
    console.error('❌ Échec réparation:', e.message);
    console.error('   Fin du JSON:', repaired.slice(-150));
  }

  // Essai 4: Troncature brutale — coupe de plus en plus jusqu'à ce que ça parse
  for (let cutoff = repaired.length - 1; cutoff > repaired.length * 0.3; cutoff -= 50) {
    let chunk = repaired.substring(0, cutoff);
    // Nettoie la fin
    chunk = chunk.replace(/,\s*"[^"]*$/, '');
    chunk = chunk.replace(/,\s*$/, '');
    const q = (chunk.match(/"/g) || []).length;
    if (q % 2 !== 0) chunk += '"';
    ob = (chunk.match(/\[/g) || []).length;
    cb = (chunk.match(/\]/g) || []).length;
    oc = (chunk.match(/\{/g) || []).length;
    cc = (chunk.match(/\}/g) || []).length;
    while (cb < ob) { chunk += ']'; cb++; }
    while (cc < oc) { chunk += '}'; cc++; }
    try {
      const result = JSON.parse(chunk);
      if (Object.keys(result).length >= 5) {
        console.log('✅ JSON récupéré par troncature (' + Object.keys(result).length + ' clés)');
        return result;
      }
    } catch { /* continue cutting */ }
  }

  console.error('❌ ÉCHEC TOTAL — impossible de parser le JSON');
  return null;
}\]]*$/, '')  // trailing incomplete kv
    .replace(/,\s*$/, '')                                     // trailing comma
    .replace(/:\s*$/, ': null')                                // trailing colon
    .replace(/,\s*\]/, ']')                                  // comma before ]
    .replace(/,\s*\}/, '}');                                 // comma before }
  
  // Ferme les guillemets ouverts
  const quoteCount = (repaired.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) repaired += '"';
  
  // Ferme les crochets et accolades manquants
  let openBrackets = (repaired.match(/\[/g) || []).length;
  let closeBrackets = (repaired.match(/\]/g) || []).length;
  let openBraces = (repaired.match(/\{/g) || []).length;
  let closeBraces = (repaired.match(/\}/g) || []).length;
  
  while (closeBrackets < openBrackets) { repaired += ']'; closeBrackets++; }
  while (closeBraces < openBraces) { repaired += '}'; closeBraces++; }
  
  try {
    const result = JSON.parse(repaired);
    console.log('✅ JSON réparé avec succès (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e2) {
    console.error('❌ Échec réparation:', e2.message);
    console.error('📝 JSON tronqué (fin):', repaired.slice(-200));
  }
  
  // Essai 3: Coupe tout après la dernière propriété valide
  try {
    // Trouve la dernière virgule suivie d'une clé complète
    const lastValidComma = repaired.lastIndexOf('",');
    if (lastValidComma > 0) {
      let truncated = repaired.substring(0, lastValidComma + 1);
      // Re-ferme les brackets
      openBrackets = (truncated.match(/\[/g) || []).length;
      closeBrackets = (truncated.match(/\]/g) || []).length;
      openBraces = (truncated.match(/\{/g) || []).length;
      closeBraces = (truncated.match(/\}/g) || []).length;
      while (closeBrackets < openBrackets) { truncated += ']'; }
      while (closeBraces < openBraces) { truncated += '}'; }
      const result = JSON.parse(truncated);
      console.log('✅ JSON récupéré par troncature (' + Object.keys(result).length + ' clés)');
      return result;
    }
  } catch (e3) {
    console.error('❌ Échec total du parsing JSON');
  }
  
  return null;
}\]]*$/, '');
  
  let openBraces = (repaired.match(/\{/g) || []).length;
  let closeBraces = (repaired.match(/\}/g) || []).length;
  let openBrackets = (repaired.match(/\[/g) || []).length;
  let closeBrackets = (repaired.match(/\]/g) || []).length;
  
  const quoteCount = (repaired.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) repaired += '"';
  
  while (closeBrackets < openBrackets) { repaired += ']'; closeBrackets++; }
  while (closeBraces < openBraces) { repaired += '}'; closeBraces++; }
  
  try {
    repaired = repaired.replace(/[\x00-\x1F\x7F]/g, ' ');
    const result = JSON.parse(repaired);
    console.log('✅ JSON réparé avec succès');
    return result;
  } catch (e2) {
    console.error('❌ Échec réparation JSON:', repaired.slice(0, 300));
  }
  
  return null;
}

// ══════════════════════════════════════════════
// THESPORTSDB
// ══════════════════════════════════════════════
export async function tsdbFetch(endpoint, params = {}) {

  const qs = new URLSearchParams(params).toString();
  const url = `/api/tsdb/${endpoint}${qs ? '?' + qs : ''}`;

  try {

    const resp = await fetch(url);
    const data = await resp.json();
    return data;

  } catch {

    return { events: [] };

  }
}

// ══════════════════════════════════════════════
// ODDS API
// ══════════════════════════════════════════════
export async function fetchRealOdds(team1, team2, leagueId) {

  const sportKey = ODDS_SPORT_MAP[leagueId] || 'soccer_epl';

  try {

    const resp = await fetch(`/api/odds/${sportKey}?` + new URLSearchParams({
      regions: 'eu',
      markets: 'h2h',
      oddsFormat: 'decimal',
      bookmakers: BOOKMAKERS_EU.join(',')
    }));

    if (!resp.ok) return null;

    const games = await resp.json();
    if (!Array.isArray(games)) return null;

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    const n1 = normalize(team1);
    const n2 = normalize(team2);

    const match = games.find(g => {

      const hn = normalize(g.home_team || '');
      const an = normalize(g.away_team || '');

      return (
        (hn.includes(n1) || n1.includes(hn)) &&
        (an.includes(n2) || n2.includes(an))
      );

    });

    if (!match) return null;

    const oddsMap = {};

    (match.bookmakers || []).forEach(bk => {

      const h2h = (bk.markets || []).find(m => m.key === 'h2h');
      if (!h2h) return;

      const outcomes = h2h.outcomes || [];

      const home = outcomes.find(o => o.name === match.home_team);
      const away = outcomes.find(o => o.name === match.away_team);
      const draw = outcomes.find(o => o.name === 'Draw');

      if (home && away) {

        oddsMap[bk.title] = {
          home: home.price,
          draw: draw ? draw.price : null,
          away: away.price
        };

      }

    });

    if (!Object.keys(oddsMap).length) return null;

    return {
      bookmakers: oddsMap,
      count: Object.keys(oddsMap).length,
      home_team: match.home_team,
      away_team: match.away_team
    };

  } catch (e) {

    console.warn("Odds API:", e.message);
    return null;

  }
}

// ══════════════════════════════════════════════
// API STATUS
// ══════════════════════════════════════════════
export async function fetchApiStatus() {

  try {

    const resp = await fetch('/api/status');
    state.apiStatus = await resp.json();
    return state.apiStatus;

  } catch {

    state.apiStatus = { claude:false, gemini:false, odds:false, footballData:false };
    return state.apiStatus;

  }
}
