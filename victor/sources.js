// ══════════════════════════════════════════════
// victor/sources.js — Sources de données factuelles
//
// Remplace la découverte de matchs par googleSearch (quota Gemini
// épuisé + hallucinations de matchs inexistants).
//
// Sources, par ordre de fiabilité :
//   1. football-data.org — 13 compétitions, gratuit, 10 req/min
//   2. TheSportsDB       — multi-sport, gratuit, plafonné à 3/sport
//   3. API-Football      — si le compte est réactivé (suspendu au 03/08/2026)
//
// Règle : ces fonctions ne renvoient QUE des matchs réels. Aucun LLM
// n'intervient ici. L'IA ne fait plus que l'analyse, jamais la
// découverte — c'est ce qui supprime les hallucinations.
// ══════════════════════════════════════════════

const FD_KEY  = process.env.FOOTBALL_DATA_KEY;
const AF_KEY  = process.env.API_FOOTBALL_KEY || process.env.RAPIDAPI_KEY;
const TSDB_KEY = process.env.TSDB_KEY || '3'; // '3' = clé de test publique

const FETCH_TIMEOUT_MS = 20_000;

// Sports TheSportsDB interrogés en complément du football
const TSDB_SPORTS = ['Soccer', 'Basketball', 'Tennis', 'Rugby', 'Ice Hockey', 'Baseball'];

// ── Fetch avec timeout — sans ça un blocage réseau fige le worker ──
export async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalisation d'un nom d'équipe (comparaisons) ───────────
export function normalizeTeam(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|sc|ac|as|ss|us|rc|sv|afc|cd|ud|club|de|of|d|l)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Forme normalisée d'un match, commune à toutes les sources.
 * @typedef {{sport:string, competition:string, match:string, home:string,
 *            away:string, heure:string, dateISO:string, status:'NS'|'LIVE'|'FT'|'OTHER',
 *            homeGoals:number|null, awayGoals:number|null, venue:string, source:string}} Fixture
 */

const FD_STATUS = {
  SCHEDULED: 'NS', TIMED: 'NS', IN_PLAY: 'LIVE', PAUSED: 'LIVE',
  FINISHED: 'FT', AWARDED: 'FT',
  POSTPONED: 'OTHER', SUSPENDED: 'OTHER', CANCELLED: 'OTHER',
};

function fromFootballData(m) {
  return {
    sport:       'Football',
    competition: m.competition?.name || '',
    match:       `${m.homeTeam?.shortName || m.homeTeam?.name} vs ${m.awayTeam?.shortName || m.awayTeam?.name}`,
    home:        m.homeTeam?.shortName || m.homeTeam?.name || '',
    away:        m.awayTeam?.shortName || m.awayTeam?.name || '',
    heure:       m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : '',
    dateISO:     m.utcDate?.slice(0, 10) || '',
    status:      FD_STATUS[m.status] || 'OTHER',
    homeGoals:   m.score?.fullTime?.home ?? null,
    awayGoals:   m.score?.fullTime?.away ?? null,
    venue:       '',
    source:      'football-data',
  };
}

function fromTsdb(e) {
  const hg = e.intHomeScore !== null && e.intHomeScore !== undefined && e.intHomeScore !== '' ? Number(e.intHomeScore) : null;
  const ag = e.intAwayScore !== null && e.intAwayScore !== undefined && e.intAwayScore !== '' ? Number(e.intAwayScore) : null;
  const st = (e.strStatus || '').toUpperCase();
  let status = 'NS';
  if (['FT', 'AET', 'PEN', 'AOT', 'FINISHED'].includes(st) || (hg !== null && ag !== null)) status = 'FT';
  else if (['1H', '2H', 'HT', 'LIVE', 'IN PLAY'].includes(st)) status = 'LIVE';

  return {
    sport:       e.strSport || '',
    competition: e.strLeague || '',
    match:       `${e.strHomeTeam} vs ${e.strAwayTeam}`,
    home:        e.strHomeTeam || '',
    away:        e.strAwayTeam || '',
    heure:       e.strTimestamp ? new Date(e.strTimestamp + 'Z').toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : (e.strTime || '').slice(0, 5),
    dateISO:     e.dateEvent || '',
    status,
    homeGoals:   hg,
    awayGoals:   ag,
    venue:       e.strVenue || '',
    source:      'thesportsdb',
  };
}

// ══════════════════════════════════════════════
// FOOTBALL-DATA.ORG
// ══════════════════════════════════════════════

async function fdMatches(params) {
  if (!FD_KEY) return [];
  try {
    const url  = `https://api.football-data.org/v4/matches?${new URLSearchParams(params)}`;
    const resp = await fetchWithTimeout(url, { headers: { 'X-Auth-Token': FD_KEY } });
    if (resp.status === 429) {
      console.warn('   ⚠️  football-data: rate limit (10 req/min)');
      return [];
    }
    if (!resp.ok) {
      console.warn(`   ⚠️  football-data HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data.message && !data.matches) {
      console.warn(`   ⚠️  football-data: ${data.message}`);
      return [];
    }
    return (data.matches || []).map(fromFootballData);
  } catch (err) {
    console.warn(`   ⚠️  football-data indisponible: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════
// THESPORTSDB
// ══════════════════════════════════════════════

async function tsdbDay(dateISO, sport) {
  try {
    const url  = `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}/eventsday.php?d=${dateISO}&s=${encodeURIComponent(sport)}`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(fromTsdb);
  } catch (err) {
    console.warn(`   ⚠️  TheSportsDB (${sport}) indisponible: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════
// API-FOOTBALL (si le compte redevient actif)
// ══════════════════════════════════════════════

/**
 * Renvoie { fixtures, error } — `error` est non-null quand l'API répond
 * HTTP 200 mais refuse la requête (compte suspendu, quota…). Sans ce
 * contrôle l'échec est totalement silencieux : c'est le bug qui a masqué
 * la suspension du compte pendant des semaines.
 */
export async function fetchApiFootball(dateISO, { status = 'FT' } = {}) {
  if (!AF_KEY) return { fixtures: [], error: 'clé absente' };
  try {
    const url  = `https://v3.football.api-sports.io/fixtures?date=${dateISO}${status ? `&status=${status}` : ''}`;
    const resp = await fetchWithTimeout(url, { headers: { 'x-apisports-key': AF_KEY } });
    if (!resp.ok) return { fixtures: [], error: `HTTP ${resp.status}` };

    const data = await resp.json();

    // ⚠️ HTTP 200 + errors non vide = requête refusée (compte suspendu…)
    const errs = data.errors;
    const hasErr = Array.isArray(errs) ? errs.length > 0 : (errs && Object.keys(errs).length > 0);
    if (hasErr) return { fixtures: [], error: JSON.stringify(errs) };

    const fixtures = (data.response || []).map(f => ({
      sport:       'Football',
      competition: f.league?.name || '',
      match:       `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
      home:        f.teams?.home?.name || '',
      away:        f.teams?.away?.name || '',
      heure:       f.fixture?.date ? new Date(f.fixture.date).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : '',
      dateISO,
      status:      ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short) ? 'FT'
                 : ['1H', '2H', 'HT', 'ET'].includes(f.fixture?.status?.short) ? 'LIVE' : 'NS',
      homeGoals:   f.goals?.home ?? null,
      awayGoals:   f.goals?.away ?? null,
      venue:       f.fixture?.venue?.name || '',
      source:      'api-football',
    }));
    return { fixtures, error: null };
  } catch (err) {
    return { fixtures: [], error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// ══════════════════════════════════════════════
// API PUBLIQUE
// ══════════════════════════════════════════════

/** Déduplique sur (équipes normalisées), en gardant la source la plus fiable. */
function dedupe(fixtures) {
  const rang = { 'football-data': 0, 'api-football': 1, 'thesportsdb': 2 };
  const map  = new Map();
  for (const f of fixtures) {
    if (!f.home || !f.away) continue;
    const cle = [normalizeTeam(f.home), normalizeTeam(f.away)].sort().join('|');
    const prec = map.get(cle);
    if (!prec || (rang[f.source] ?? 9) < (rang[prec.source] ?? 9)) map.set(cle, f);
  }
  return [...map.values()];
}

/**
 * Tous les matchs du jour, toutes sources confondues.
 * @param {string} dateISO  YYYY-MM-DD
 * @returns {Promise<Fixture[]>}
 */
export async function getFixturesOfDay(dateISO) {
  const [fd, ...tsdb] = await Promise.all([
    fdMatches({ date: dateISO }),
    ...TSDB_SPORTS.map(s => tsdbDay(dateISO, s)),
  ]);

  const af = AF_KEY ? await fetchApiFootball(dateISO, { status: '' }) : { fixtures: [], error: null };
  if (af.error && af.error !== 'clé absente') {
    console.warn(`   ⚠️  API-Football écartée: ${af.error}`);
  }

  const tout = dedupe([...fd, ...af.fixtures, ...tsdb.flat()]);
  console.log(`   📡 Sources: football-data=${fd.length} · api-football=${af.fixtures.length} · thesportsdb=${tsdb.flat().length} → ${tout.length} match(s) uniques`);
  return tout;
}

/**
 * Matchs TERMINÉS du jour, avec score — pour checkResults().
 * @returns {Promise<Fixture[]>}
 */
export async function getResultsOfDay(dateISO) {
  const [fd, ...tsdb] = await Promise.all([
    fdMatches({ date: dateISO, status: 'FINISHED' }),
    ...TSDB_SPORTS.map(s => tsdbDay(dateISO, s)),
  ]);

  const af = AF_KEY ? await fetchApiFootball(dateISO, { status: 'FT' }) : { fixtures: [], error: null };
  if (af.error && af.error !== 'clé absente') {
    console.warn(`   ⚠️  API-Football écartée: ${af.error}`);
  }

  const finis = dedupe([...fd, ...af.fixtures, ...tsdb.flat()])
    .filter(f => f.status === 'FT' && f.homeGoals !== null && f.awayGoals !== null);

  console.log(`   📡 Résultats: ${finis.length} match(s) terminé(s) avec score`);
  return finis;
}

/**
 * Indice de forme récente, construit en UNE SEULE requête football-data
 * (tous les matchs terminés de la fenêtre). Évite 1 requête par équipe
 * et donc le rate limit.
 * @returns {Promise<Map<string, {forme:string, bilan:string, marques:number, encaisses:number, matchs:number}>>}
 */
export async function buildFormIndex(jours = 20) {
  // football-data refuse les plages > 10 jours (HTTP 400) : on découpe.
  const FENETRE = 10;
  const tranches = [];
  for (let debut = jours; debut > 0; debut -= FENETRE) {
    tranches.push({
      dateFrom: new Date(Date.now() - debut * 864e5).toISOString().slice(0, 10),
      dateTo:   new Date(Date.now() - Math.max(debut - FENETRE, 0) * 864e5).toISOString().slice(0, 10),
      status:   'FINISHED',
    });
  }

  const matchs = (await Promise.all(tranches.map(fdMatches))).flat();
  const idx = new Map();

  const push = (equipe, res, bp, bc, adversaire) => {
    const cle = normalizeTeam(equipe);
    if (!cle) return;
    if (!idx.has(cle)) idx.set(cle, { nom: equipe, res: [], marques: 0, encaisses: 0 });
    const e = idx.get(cle);
    e.res.push({ res, bp, bc, adversaire });
    e.marques   += bp;
    e.encaisses += bc;
  };

  for (const m of matchs) {
    if (m.homeGoals === null || m.awayGoals === null) continue;
    const diff = m.homeGoals - m.awayGoals;
    push(m.home, diff > 0 ? 'V' : diff < 0 ? 'D' : 'N', m.homeGoals, m.awayGoals, m.away);
    push(m.away, diff < 0 ? 'V' : diff > 0 ? 'D' : 'N', m.awayGoals, m.homeGoals, m.home);
  }

  const out = new Map();
  for (const [cle, e] of idx) {
    const derniers = e.res.slice(-5);
    out.set(cle, {
      nom:       e.nom,
      forme:     derniers.map(r => r.res).join(''),
      bilan:     derniers.map(r => `${r.res} ${r.bp}-${r.bc} vs ${r.adversaire}`).join(' | '),
      marques:   e.marques,
      encaisses: e.encaisses,
      matchs:    e.res.length,
    });
  }
  console.log(`   📊 Indice de forme: ${out.size} équipe(s) sur ${jours} jours (${tranches.length} requête(s))`);
  return out;
}

/**
 * Met en forme les matchs + la forme récente pour le prompt d'analyse.
 * C'est ce bloc qui remplace les étapes 1 et 2 de l'ancien callAI().
 */
export function formatFixturesForPrompt(fixtures, formIndex = new Map()) {
  if (fixtures.length === 0) return '(aucun match trouvé pour cette date)';

  const parGroupe = new Map();
  for (const f of fixtures) {
    const cle = `${f.sport} — ${f.competition}`;
    if (!parGroupe.has(cle)) parGroupe.set(cle, []);
    parGroupe.get(cle).push(f);
  }

  const lignes = [];
  for (const [groupe, list] of parGroupe) {
    lignes.push(`\n### ${groupe}`);
    for (const f of list) {
      const fh = formIndex.get(normalizeTeam(f.home));
      const fa = formIndex.get(normalizeTeam(f.away));
      lignes.push(`- ${f.home} vs ${f.away} — ${f.heure || '??:??'} (source: ${f.source})`);
      if (fh) lignes.push(`    ${f.home} — forme ${fh.forme || 'n/a'} · ${fh.marques} buts marqués / ${fh.encaisses} encaissés sur ${fh.matchs} match(s)`);
      if (fa) lignes.push(`    ${f.away} — forme ${fa.forme || 'n/a'} · ${fa.marques} buts marqués / ${fa.encaisses} encaissés sur ${fa.matchs} match(s)`);
      if (fh && fh.bilan) lignes.push(`    Détail ${f.home}: ${fh.bilan}`);
      if (fa && fa.bilan) lignes.push(`    Détail ${f.away}: ${fa.bilan}`);
    }
  }
  return lignes.join('\n');
}

export default { getFixturesOfDay, getResultsOfDay, buildFormIndex, formatFixturesForPrompt, fetchApiFootball, normalizeTeam, fetchWithTimeout };
