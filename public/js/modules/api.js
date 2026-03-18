// ══════════════════════════════════════════════
// api.js — Tous les appels API (version GEMINI)
// VERSION PROPRE — Aucun doublon
// ══════════════════════════════════════════════

import { ODDS_SPORT_MAP, BOOKMAKERS_EU, TSDB_LEAGUE_MAP, FD_COMP_MAP, APIF_LEAGUE_MAP } from './config.js';
import { state } from './state.js';

// ══════════════════════════════════════════════
// GEMINI API (via /api/gemini)
// ══════════════════════════════════════════════
export async function callGemini(messages, { useSearch = false, maxTokens = 4096, model = null, jsonMode = false, cacheKey = null } = {}) {
  const body = { messages, maxTokens, jsonMode };
  if (model) body.model = model;
  if (useSearch) body.useSearch = true;
  if (cacheKey) body.cacheKey = cacheKey;

  console.log('📤 Envoi à /api/gemini:', { maxTokens, useSearch, jsonMode });

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

  console.log('✅ Réponse reçue');
  return data;
}

// Alias pour compatibilité
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

// ══════════════════════════════════════════════
// EXTRACTION JSON — 4 niveaux de récupération
// ══════════════════════════════════════════════
export function extractJSON(text) {
  // Nettoyage markdown
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Trouve le premier { et le dernier }
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) {
    console.warn('🔍 Pas de { dans la réponse');
    return null;
  }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  } else {
    clean = clean.substring(firstBrace);
  }

  // Supprime les caractères de contrôle (retours ligne, tabs dans les strings)
  clean = clean.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

  // ESSAI 1: Parse direct
  try {
    const result = JSON.parse(clean);
    console.log('✅ JSON parsé directement (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e) {
    console.warn('⚠️ Essai 1 échec:', e.message);
  }

  // ESSAI 2: Compacte sur une ligne
  let oneLine = clean.replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ');
  try {
    const result = JSON.parse(oneLine);
    console.log('✅ JSON parsé après compactage');
    return result;
  } catch (e) {
    console.warn('⚠️ Essai 2 échec:', e.message);
  }

  // ESSAI 3: Réparation du JSON tronqué
  let repaired = oneLine;

  // Coupe après la dernière propriété complète
  const lastComplete = Math.max(
    repaired.lastIndexOf('",'),
    repaired.lastIndexOf('},'),
    repaired.lastIndexOf('],')
  );
  if (lastComplete > repaired.length * 0.3) {
    repaired = repaired.substring(0, lastComplete + 1);
  }

  // Nettoyage fin de chaîne
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Ferme guillemets ouverts
  if ((repaired.match(/"/g) || []).length % 2 !== 0) repaired += '"';

  // Ferme crochets et accolades
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
    console.warn('⚠️ Essai 3 échec:', e.message);
  }

  // ESSAI 4: Troncature progressive
  for (let cut = repaired.length - 1; cut > repaired.length * 0.3; cut -= 50) {
    let chunk = repaired.substring(0, cut);
    chunk = chunk.replace(/,\s*"[^"]*$/, '');
    chunk = chunk.replace(/,\s*$/, '');
    if ((chunk.match(/"/g) || []).length % 2 !== 0) chunk += '"';
    let a = (chunk.match(/\[/g) || []).length - (chunk.match(/\]/g) || []).length;
    let b = (chunk.match(/\{/g) || []).length - (chunk.match(/\}/g) || []).length;
    while (a > 0) { chunk += ']'; a--; }
    while (b > 0) { chunk += '}'; b--; }
    try {
      const result = JSON.parse(chunk);
      if (Object.keys(result).length >= 5) {
        console.log('✅ JSON récupéré par troncature (' + Object.keys(result).length + ' clés)');
        return result;
      }
    } catch { /* continue */ }
  }

  console.error('❌ ÉCHEC TOTAL du parsing JSON');
  return null;
}

// ══════════════════════════════════════════════
// THESPORTSDB (via /api/tsdb)
// ══════════════════════════════════════════════
export async function tsdbFetch(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `/api/tsdb/${endpoint}${qs ? '?' + qs : ''}`;
  try {
    const resp = await fetch(url);
    return await resp.json();
  } catch {
    return { events: [] };
  }
}

export async function getLeagueEvents(tsdbLeagueId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const season = new Date().getFullYear();
  // TSDB peut injecter des events d'autres ligues quand la ligue demandée
  // est en trêve — on filtre strictement par idLeague pour éviter ça.
  const belongsToLeague = e => String(e.idLeague) === String(tsdbLeagueId);
  let allEvents = [];

  try {
    const d = await tsdbFetch('eventsnextleague.php', { id: tsdbLeagueId });
    if (d?.events?.length) allEvents = allEvents.concat(d.events.filter(belongsToLeague));
  } catch { /* continue */ }

  try {
    const d = await tsdbFetch('eventspastleague.php', { id: tsdbLeagueId });
    if (d?.events?.length) {
      const todayEvs = d.events.filter(e => e.dateEvent === todayStr && belongsToLeague(e));
      allEvents = todayEvs.concat(allEvents);
    }
  } catch { /* continue */ }

  if (!allEvents.length) {
    try {
      const d = await tsdbFetch('eventsseason.php', { id: tsdbLeagueId, s: season });
      if (d?.events?.length) {
        allEvents = d.events
          .filter(e => e.dateEvent && e.dateEvent >= todayStr && belongsToLeague(e))
          .slice(0, 15);
      }
    } catch { /* continue */ }
  }

  try {
    const d = await tsdbFetch('eventsday.php', { d: todayStr, l: tsdbLeagueId });
    if (d?.events?.length) {
      d.events
        .filter(belongsToLeague)
        .forEach(e => {
          if (!allEvents.some(x => x.idEvent === e.idEvent)) allEvents.unshift(e);
        });
    }
  } catch { /* continue */ }

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
      const offset = (month >= 4 && month <= 10) ? 120 : 60;
      const mins = (h * 60 + m + offset) % (24 * 60);
      timeLabel = String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    } catch { timeLabel = e.strTime.slice(0, 5); }
  }

  const isLive = e.strStatus === 'In Progress' || (e.intHomeScore !== null && e.intHomeScore !== '' && dateEvent === today && e.strStatus !== 'Match Finished');

  return {
    team1: e.strHomeTeam || '?', team2: e.strAwayTeam || '?',
    date: dateLabel, time: timeLabel, live: isLive,
    score1: e.intHomeScore, score2: e.intAwayScore,
    status: e.strStatus || 'NS', league: e.strLeague || '',
    tsdb_id: e.idEvent,
    home_team_id: e.idHomeTeam || null,
    away_team_id: e.idAwayTeam || null
  };
}

export async function fetchH2H(homeTeamId, awayTeamId) {
  if (!homeTeamId || !awayTeamId) return null;
  try {
    const d = await tsdbFetch('eventsh2h.php', { id: homeTeamId, id2: awayTeamId });
    const results = d?.results || [];
    return results
      .filter(e => e.intHomeScore !== null && e.intHomeScore !== '')
      .slice(0, 6);
  } catch { return null; }
}

// ══════════════════════════════════════════════
// FOOTBALL-DATA.ORG (via /api/football-data)
// ══════════════════════════════════════════════
export async function fdFetch(pathAndParams) {
  const url = `/api/football-data/${pathAndParams}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

export function fdToMatch(m, leagueMeta) {
  const dateStr = (m.utcDate || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dateLabel = dateStr === today ? "Aujourd'hui" : dateStr === tomorrow ? 'Demain' : dateStr ? dateStr.slice(8, 10) + '/' + dateStr.slice(5, 7) : '?';

  let timeLabel = 'TBD';
  if (m.utcDate) {
    try {
      const dt = new Date(m.utcDate);
      const month = dt.getUTCMonth() + 1;
      const offset = (month >= 4 && month <= 10) ? 2 : 1;
      const h = (dt.getUTCHours() + offset) % 24;
      timeLabel = String(h).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0');
    } catch { /* keep TBD */ }
  }

  const status = m.status || '';
  return {
    team1: m.homeTeam?.shortName || m.homeTeam?.name || '?',
    team2: m.awayTeam?.shortName || m.awayTeam?.name || '?',
    date: dateLabel, time: timeLabel,
    live: status === 'IN_PLAY' || status === 'PAUSED',
    score1: m.score?.fullTime?.home ?? null,
    score2: m.score?.fullTime?.away ?? null,
    status: status === 'FINISHED' ? 'FT' : status === 'IN_PLAY' ? 'LIVE' : status,
    leagueName: leagueMeta?.name || m.competition?.name || '',
    leagueFlag: leagueMeta?.flag || '⚽',
    leagueId: leagueMeta?.id || '', sport: 'soccer'
  };
}

// ══════════════════════════════════════════════
// ODDS API (via /api/odds)
// ══════════════════════════════════════════════
export async function fetchRealOdds(team1, team2, leagueId) {
  const sportKey = ODDS_SPORT_MAP[leagueId] || 'soccer_epl';
  try {
    const resp = await fetch(`/api/odds/${sportKey}?` + new URLSearchParams({
      regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', bookmakers: BOOKMAKERS_EU.join(',')
    }));
    if (!resp.ok) return null;
    const games = await resp.json();
    if (!Array.isArray(games)) return null;

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n1 = normalize(team1), n2 = normalize(team2);

    const match = games.find(g => {
      const hn = normalize(g.home_team || ''), an = normalize(g.away_team || '');
      return (hn.includes(n1) || n1.includes(hn)) && (an.includes(n2) || n2.includes(an));
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
      if (home && away) oddsMap[bk.title] = { home: home.price, draw: draw?.price ?? null, away: away.price };
    });
    if (!Object.keys(oddsMap).length) return null;

    return { bookmakers: oddsMap, count: Object.keys(oddsMap).length, home_team: match.home_team, away_team: match.away_team };
  } catch (e) {
    console.warn('Odds API:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════
// MATCH DETAILS (football-data.org)
// ══════════════════════════════════════════════
export async function fetchMatchDetails(team1, team2, leagueId) {
  if (!state.apiStatus?.footballData || !leagueId) return null;
  const compId = FD_COMP_MAP[leagueId];
  if (!compId) return null;
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const data = await fdFetch(`competitions/${compId}/matches?dateFrom=${todayStr}&dateTo=${nextWeek}`);
    return data;
  } catch { return null; }
}

// Placeholder — pas encore implémenté
export async function fetchLiveStats() { return null; }

// ══════════════════════════════════════════════
// API-FOOTBALL (RapidAPI) via /api/apifootball
// Forme réelle, blessures, H2H — 100 req/jour free
// ══════════════════════════════════════════════
async function apifFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `/api/apifootball/${path}${qs ? '?' + qs : ''}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// Cache localStorage 7 jours pour éviter de gaspiller des requêtes sur les IDs d'équipes
async function fetchTeamId(teamName) {
  if (!teamName) return null;
  const cacheKey = `apif_tid_${teamName.toLowerCase().replace(/\s+/g, '_')}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { id, ts } = JSON.parse(cached);
      if (Date.now() - ts < 7 * 24 * 60 * 60 * 1000) return id;
    }
  } catch { /* ignore */ }
  try {
    // Normaliser : supprimer tirets et caractères spéciaux qui cassent la recherche
    const normalized = teamName.replace(/-/g, ' ').replace(/[^\w\s]/g, '').trim();
    let data = await apifFetch('teams', { search: normalized });
    // Fallback : premier mot seulement si aucun résultat
    if (!data?.response?.length && normalized.includes(' ')) {
      data = await apifFetch('teams', { search: normalized.split(' ')[0] });
    }
    const id = data?.response?.[0]?.team?.id || null;
    if (id) {
      try { localStorage.setItem(cacheKey, JSON.stringify({ id, ts: Date.now() })); } catch { /* ignore */ }
    }
    return id;
  } catch { return null; }
}

// Trie les fixtures et retourne les N derniers matchs joués
function lastNPlayed(fixtures, n = 5) {
  return (fixtures || [])
    .filter(f => f.fixture.status.short === 'FT' || f.fixture.status.short === 'AET' || f.fixture.status.short === 'PEN')
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, n);
}

// Récupère forme, H2H et blessures depuis API-Football en parallèle
// Plan gratuit : utilise season= à la place de last= (non supporté)
export async function fetchRealStats(team1, team2, leagueId) {
  if (!state.apiStatus?.apifootball) return null;
  try {
    const [id1, id2] = await Promise.all([fetchTeamId(team1), fetchTeamId(team2)]);
    if (!id1 && !id2) return null;

    const season = new Date().getMonth() < 6
      ? new Date().getFullYear() - 1
      : new Date().getFullYear();

    const apifLeague = APIF_LEAGUE_MAP[leagueId];
    const fix1Params = { team: id1, season };
    const fix2Params = { team: id2, season };
    if (apifLeague) { fix1Params.league = apifLeague; fix2Params.league = apifLeague; }

    const [fix1, fix2, h2h, inj1, inj2] = await Promise.all([
      id1 ? apifFetch('fixtures', fix1Params) : Promise.resolve(null),
      id2 ? apifFetch('fixtures', fix2Params) : Promise.resolve(null),
      (id1 && id2) ? apifFetch('fixtures/headtohead', { h2h: `${id1}-${id2}`, season }) : Promise.resolve(null),
      id1 ? apifFetch('injuries', { team: id1, season }) : Promise.resolve(null),
      id2 ? apifFetch('injuries', { team: id2, season }) : Promise.resolve(null),
    ]);

    return {
      form1: lastNPlayed(fix1?.response, 5),
      form2: lastNPlayed(fix2?.response, 5),
      h2h: lastNPlayed(h2h?.response, 5),
      injuries1: inj1?.response || [],
      injuries2: inj2?.response || [],
      team1Id: id1,
      team2Id: id2
    };
  } catch (e) {
    console.warn('[fetchRealStats]', e.message);
    return null;
  }
}

// ── Classement football-data.org ──
export async function fetchLeagueStandings(leagueId) {
  if (!state.apiStatus?.footballData) return null;
  const compId = FD_COMP_MAP[leagueId];
  if (!compId) return null;
  try {
    const data = await fdFetch(`competitions/${compId}/standings`);
    if (!data?.standings?.length) return null;
    const table = data.standings.find(s => s.type === 'TOTAL')?.table || data.standings[0]?.table;
    return table || null;
  } catch { return null; }
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
