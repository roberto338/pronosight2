// ══════════════════════════════════════════════
// api.js — Tous les appels API (version GEMINI)
// ══════════════════════════════════════════════

import { ODDS_SPORT_MAP, BOOKMAKERS_EU } from './config.js';
import { state } from './state.js';

// ══════════════════════════════════════════════
// GEMINI API (via /api/gemini)
// ══════════════════════════════════════════════
export async function callGemini(messages, { useSearch = false, maxTokens = 1000, model = null } = {}) {
  // Détection automatique : Render ou localhost
  const baseUrl = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000' 
    : 'https://pronosight2.onrender.com';
  
  const url = `${baseUrl}/api/gemini`;
  
  console.log('📤 Envoi à:', url);

  const body = { 
    messages: messages, 
    useSearch: useSearch, 
    maxTokens: maxTokens,
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
// Alias pour compatibilité avec le code existant
export const callClaude = callGemini;

export function extractText(data) {
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

export function extractJSON(text) {
  if (!text) return null;
  
  console.log('🔍 Texte brut reçu:', text.substring(0, 200) + '...');
  
  // Étape 1: Nettoyer les backticks et balises json
  let clean = text.replace(/```json|```/g, '').trim();
  
  // Étape 2: Supprimer les backslashes devant les guillemets
  clean = clean.replace(/\\"/g, '"');
  
  // Étape 3: Si la réponse est dupliquée (deux objets JSON), prendre le premier
  // On cherche le pattern où un objet se termine et un autre commence
  if (clean.includes('}{')) {
    const firstEnd = clean.indexOf('}') + 1;
    clean = clean.substring(0, firstEnd);
  }
  
  // Étape 4: Si la réponse contient deux fois le même début, prendre le premier bloc
  const matches = clean.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (matches && matches.length > 0) {
    // Prendre le premier match
    clean = matches[0];
  }
  
  // Étape 5: Nettoyer les virgules en trop
  clean = clean.replace(/,(\s*[}\]])/g, '$1');
  
  console.log('📊 JSON extrait:', clean.substring(0, 200));
  
  // Étape 6: Essayer de parser
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.warn('⚠️ Premier échec JSON:', e.message);
    
    // Tentative 2: Nettoyer les guillemets non échappés
    try {
      // Remplacer les guillemets problématiques
      let fixed = clean.replace(/"([^"]*?)(?<!\\)"([^"]*?)"/g, '"$1$2"');
      return JSON.parse(fixed);
    } catch {}
    
    // Tentative 3: Extraction manuelle pour les matchs
    try {
      // Pour le format {"matches": [...]}
      const matchArray = clean.match(/\{"matches":\[.*?\]\}/);
      if (matchArray) {
        return JSON.parse(matchArray[0]);
      }
    } catch {}
    
    // Tentative 4: Construction manuelle du JSON
    try {
      // Extraire tous les objets match individuellement
      const matchObjects = clean.match(/\{"team1":"[^"]*","team2":"[^"]*","date":"[^"]*","time":"[^"]*","live":(?:true|false)\}/g);
      if (matchObjects && matchObjects.length > 0) {
        return { matches: matchObjects.map(m => JSON.parse(m)) };
      }
    } catch {}
    
    console.error('❌ Échec total du parsing JSON');
    return null;
  }
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

export async function getLeagueEvents(tsdbLeagueId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const season = new Date().getFullYear();
  let allEvents = [];

  // 1. Next matches
  try {
    const d = await tsdbFetch('eventsnextleague.php', { id: tsdbLeagueId });
    if (d?.events?.length) {
      const events = d.events.filter(e => e.idLeague == tsdbLeagueId);
      if (events.length) allEvents = allEvents.concat(events);
    }
  } catch { /* ignore */ }

  // 2. Past matches
  try {
    const d = await tsdbFetch('eventspastleague.php', { id: tsdbLeagueId });
    if (d?.events?.length) {
      const events = d.events.filter(e => e.idLeague == tsdbLeagueId);
      const todayEvs = events.filter(e => e.dateEvent === todayStr);
      allEvents = todayEvs.concat(allEvents);
    }
  } catch { /* ignore */ }

  // 3. Season events
  if (!allEvents.length) {
    try {
      const d = await tsdbFetch('eventsseason.php', { id: tsdbLeagueId, s: season });
      if (d?.events?.length) {
        const events = d.events.filter(e => e.idLeague == tsdbLeagueId);
        allEvents = events.filter(e => e.dateEvent && e.dateEvent >= todayStr).slice(0, 15);
      }
    } catch { /* ignore */ }
  }

  // 4. Today's events
  try {
    const d = await tsdbFetch('eventsday.php', { d: todayStr });
    if (d?.events?.length) {
      const leagueEvents = d.events.filter(e => e.idLeague == tsdbLeagueId);
      leagueEvents.forEach(e => {
        if (!allEvents.some(x => x.idEvent === e.idEvent)) allEvents.unshift(e);
      });
    }
  } catch { /* ignore */ }

  // 5. Filtre final
  if (allEvents.length > 0) {
    allEvents = allEvents.filter(e => e.idLeague == tsdbLeagueId);
  }

  return allEvents;
}

export function tsdbToMatch(e) {
  const dateEvent = e.dateEvent || '';
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const dateLabel = dateEvent === today ? "Aujourd'hui"
    : dateEvent === tomorrow ? 'Demain'
      : dateEvent ? dateEvent.slice(8, 10) + '/' + dateEvent.slice(5, 7) : 'À venir';

  let timeLabel = 'TBD';
  if (e.strTime && e.strTime !== 'null' && e.dateEvent) {
    try {
      const h = parseInt(e.strTime.slice(0, 2)), m = parseInt(e.strTime.slice(3, 5));
      const month = parseInt(e.dateEvent.slice(5, 7));
      const parisOffset = (month >= 4 && month <= 10) ? 120 : 60;
      const parisMins = (h * 60 + m + parisOffset) % (24 * 60);
      const ph = Math.floor(parisMins / 60), pm = parisMins % 60;
      timeLabel = String(ph).padStart(2, '0') + ':' + String(pm).padStart(2, '0');
    } catch { timeLabel = e.strTime.slice(0, 5); }
  }

  const isLive = e.strStatus === 'Match Finished' ? false
    : e.strStatus === 'In Progress' ? true
      : e.intHomeScore !== null && e.intHomeScore !== '' && dateEvent === today;

  return {
    team1: e.strHomeTeam || '?',
    team2: e.strAwayTeam || '?',
    date: dateLabel, time: timeLabel, live: isLive,
    score1: e.intHomeScore, score2: e.intAwayScore,
    status: e.strStatus || 'NS',
    league: e.strLeague || '',
    tsdb_id: e.idEvent
  };
}

// ══════════════════════════════════════════════
// FOOTBALL-DATA.ORG
// ══════════════════════════════════════════════
export async function fdFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `/api/football-data/${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url);
  if (resp.status === 429) throw new Error('rate_limit');
  if (resp.status === 404) throw new Error('no_key');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

export function fdToMatch(m, leagueMeta) {
  const dateStr = (m.utcDate || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dateLabel = dateStr === today ? "Aujourd'hui"
    : dateStr === tomorrow ? 'Demain'
      : dateStr ? dateStr.slice(8, 10) + '/' + dateStr.slice(5, 7) : '?';

  let timeLabel = 'TBD';
  if (m.utcDate) {
    try {
      const dt = new Date(m.utcDate);
      const month = dt.getUTCMonth() + 1;
      const offset = (month >= 4 && month <= 10) ? 2 : 1;
      const h = (dt.getUTCHours() + offset) % 24;
      const mn = dt.getUTCMinutes();
      timeLabel = String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
    } catch { /* keep TBD */ }
  }

  const status = m.status || '';
  const isLive = status === 'IN_PLAY' || status === 'PAUSED';
  const isFT = status === 'FINISHED';

  let score1 = null, score2 = null;
  if (m.score?.fullTime) {
    score1 = m.score.fullTime.home;
    score2 = m.score.fullTime.away;
  }

  return {
    team1: m.homeTeam?.shortName || m.homeTeam?.name || '?',
    team2: m.awayTeam?.shortName || m.awayTeam?.name || '?',
    date: dateLabel, time: timeLabel, live: isLive,
    score1, score2,
    status: isFT ? 'FT' : isLive ? 'LIVE' : status,
    leagueName: leagueMeta?.name || m.competition?.name || '',
    leagueFlag: leagueMeta?.flag || '⚽',
    leagueId: leagueMeta?.id || '',
    sport: 'soccer'
  };
}

// ══════════════════════════════════════════════
// THE ODDS API
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

    if (resp.status === 404) return null;
    if (!resp.ok) return null;

    const games = await resp.json();
    if (!Array.isArray(games)) return null;

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n1 = normalize(team1), n2 = normalize(team2);

    let match = null;
    for (let ml = 7; ml >= 4 && !match; ml--) {
      match = games.find(g => {
        const hn = normalize(g.home_team || ''), an = normalize(g.away_team || '');
        return (hn.includes(n1.slice(0, ml)) || n1.includes(hn.slice(0, ml)))
          && (an.includes(n2.slice(0, ml)) || n2.includes(an.slice(0, ml)));
      });
    }
    if (!match) {
      match = games.find(g => {
        const hn = normalize(g.home_team || ''), an = normalize(g.away_team || '');
        return (hn.includes(n1) || n1.includes(hn)) && (an.includes(n2) || n2.includes(an));
      });
    }
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
          home: Math.round(home.price * 100) / 100,
          draw: draw ? Math.round(draw.price * 100) / 100 : null,
          away: Math.round(away.price * 100) / 100
        };
      }
    });

    if (!Object.keys(oddsMap).length) return null;

    const vals = Object.values(oddsMap);
    const allHome = vals.map(o => o.home);
    const allDraw = vals.map(o => o.draw).filter(Boolean);
    const allAway = vals.map(o => o.away);
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : 0;

    return {
      bookmakers: oddsMap,
      best: {
        home: Math.max(...allHome),
        draw: allDraw.length ? Math.max(...allDraw) : null,
        away: Math.max(...allAway)
      },
      avg: { home: avg(allHome), draw: allDraw.length ? avg(allDraw) : null, away: avg(allAway) },
      count: Object.keys(oddsMap).length,
      match_time: match.commence_time,
      home_team: match.home_team,
      away_team: match.away_team
    };
  } catch (e) {
    console.warn('Odds API:', e.message);
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
    state.apiStatus = { claude: false, gemini: false, odds: false, footballData: false };
    return state.apiStatus;
  }
}