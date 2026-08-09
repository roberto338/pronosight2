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
    codeCompet:  m.competition?.code || '',
    fixtureId:   m.id ?? null,
    // Identifiants préfixés par source : indexer la forme par NOM provoquait
    // des collisions entre championnats (Vitória SC portugais confondu avec
    // le Vitória brésilien → forme totalement fausse injectée dans le prompt).
    homeId:      m.homeTeam?.id != null ? `fd:${m.homeTeam.id}` : null,
    awayId:      m.awayTeam?.id != null ? `fd:${m.awayTeam.id}` : null,
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
    codeCompet:  '',
    fixtureId:   e.idEvent ?? null,
    // Espace de noms distinct : un id TSDB ne doit jamais être confondu
    // avec un id football-data lors d'une recherche dans l'indice de forme.
    homeId:      e.idHomeTeam ? `tsdb:${e.idHomeTeam}` : null,
    awayId:      e.idAwayTeam ? `tsdb:${e.idAwayTeam}` : null,
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

// ── Limiteur de débit football-data (10 req/min sur le plan gratuit) ──
// Sans lui, l'ajout du classement et des H2H fait dépasser le quota et
// renvoie des 429 en rafale au milieu d'une analyse.
const FD_MAX_PAR_MIN = 9;
let _fdAppels = [];

// ── Budget de temps pour la collecte ─────────────────────────
// Le 09/08, les jobs prematch et value sont restés bloqués plus de
// 20 minutes dans cette couche : chaque 429 déclenchait une attente de
// 60 s, et ces attentes se cumulaient sur classement + H2H + buteurs.
// Le process ne plantait jamais — il attendait. Le balayage des jobs
// figés le requeuait alors toutes les 20 min, jusqu'à épuisement des
// 3 tentatives, en affichant « process interrompu ». Message faux.
//
// Règle : l'enrichissement est OPTIONNEL, l'analyse ne l'est pas.
// Passé le budget, on renonce aux données secondaires et on analyse
// avec ce qu'on a. Une analyse un peu moins riche vaut infiniment
// mieux qu'aucune analyse.
let _echeance = null;

/** Ouvre une fenêtre de temps pour la collecte. */
export function demarrerBudgetSources(ms = 90_000) {
  _echeance = Date.now() + ms;
}
/** Referme la fenêtre : les appels suivants ne sont plus contraints. */
export function arreterBudgetSources() {
  _echeance = null;
}
const tempsRestant = () => _echeance === null ? Infinity : _echeance - Date.now();

/** @returns {Promise<boolean>} false si le budget interdit d'attendre. */
async function fdThrottle() {
  const maintenant = Date.now();
  _fdAppels = _fdAppels.filter(t => maintenant - t < 60_000);

  if (_fdAppels.length >= FD_MAX_PAR_MIN) {
    const attente = 60_000 - (maintenant - _fdAppels[0]) + 250;
    if (attente > tempsRestant()) {
      console.warn(`   ⏭️  football-data: budget épuisé, enrichissement abandonné`);
      return false;
    }
    console.log(`   ⏳ football-data: pause ${Math.ceil(attente / 1000)}s (limite 10 req/min)`);
    await new Promise(r => setTimeout(r, attente));
    return fdThrottle();
  }
  _fdAppels.push(Date.now());
  return true;
}

/** Appel générique football-data, throttlé. Retourne null en cas d'échec. */
async function fdGet(chemin, tentative = 1) {
  if (!FD_KEY) return null;
  if (!await fdThrottle()) return null;
  try {
    const resp = await fetchWithTimeout(`https://api.football-data.org/v4/${chemin}`,
      { headers: { 'X-Auth-Token': FD_KEY } });

    // Le compteur local peut diverger du compteur serveur (exécutions
    // concurrentes, fenêtre glissante). On réessaie une fois — mais
    // jamais au-delà du budget imparti.
    if (resp.status === 429 && tentative === 1) {
      const attente = Math.min(Number(resp.headers.get('retry-after') || 60), 65) * 1000;
      if (attente > tempsRestant()) {
        console.warn(`   ⏭️  football-data 429 — budget épuisé, on renonce`);
        return null;
      }
      console.warn(`   ⏳ football-data 429 — reprise dans ${Math.round(attente / 1000)}s`);
      await new Promise(r => setTimeout(r, attente));
      _fdAppels = [];
      return fdGet(chemin, 2);
    }
    if (!resp.ok) {
      console.warn(`   ⚠️  football-data /${chemin.split('?')[0]} HTTP ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`   ⚠️  football-data /${chemin.split('?')[0]}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    return null;
  }
}

async function fdMatches(params) {
  if (!FD_KEY) return [];
  try {
    if (!await fdThrottle()) return [];
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
      codeCompet:  '',
      fixtureId:   f.fixture?.id ?? null,
      homeId:      f.teams?.home?.id != null ? `af:${f.teams.home.id}` : null,
      awayId:      f.teams?.away?.id != null ? `af:${f.teams.away.id}` : null,
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
  // Priorité aux sources qui portent des identifiants et des statistiques :
  // en cas de doublon, on garde la version la plus exploitable.
  const rang = { 'football-data': 0, 'api-football': 1, 'thesportsdb': 2, 'odds-api': 3 };
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
export async function getFixturesOfDay(dateISO, { extra = [] } = {}) {
  const [fd, ...tsdb] = await Promise.all([
    fdMatches({ date: dateISO }),
    ...TSDB_SPORTS.map(s => tsdbDay(dateISO, s)),
  ]);

  const af = AF_KEY ? await fetchApiFootball(dateISO, { status: '' }) : { fixtures: [], error: null };
  if (af.error && af.error !== 'clé absente') {
    console.warn(`   ⚠️  API-Football écartée: ${af.error}`);
  }

  // `extra` : matchs fournis par l'appelant (The Odds API). Injectés ici
  // plutôt qu'importés, pour éviter une dépendance circulaire avec odds.js.
  const tout = dedupe([...fd, ...af.fixtures, ...tsdb.flat(), ...extra]);
  console.log(`   📡 Sources: football-data=${fd.length} · api-football=${af.fixtures.length} · thesportsdb=${tsdb.flat().length} · odds-api=${extra.length} → ${tout.length} match(s) uniques`);
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

  // ⚠️ Clé = identifiant d'équipe, JAMAIS le nom. Indexer par nom faisait
  // fusionner les homonymes de championnats différents (Vitória SC / Vitória)
  // et injectait une forme fausse dans le prompt, sans aucun signal.
  const push = (id, equipe, res, bp, bc, adversaire) => {
    if (!id) return;
    if (!idx.has(id)) idx.set(id, { nom: equipe, res: [], marques: 0, encaisses: 0 });
    const e = idx.get(id);
    e.res.push({ res, bp, bc, adversaire });
    e.marques   += bp;
    e.encaisses += bc;
  };

  for (const m of matchs) {
    if (m.homeGoals === null || m.awayGoals === null) continue;
    const diff = m.homeGoals - m.awayGoals;
    push(m.homeId, m.home, diff > 0 ? 'V' : diff < 0 ? 'D' : 'N', m.homeGoals, m.awayGoals, m.away);
    push(m.awayId, m.away, diff < 0 ? 'V' : diff > 0 ? 'D' : 'N', m.awayGoals, m.homeGoals, m.home);
  }

  const out = new Map();
  for (const [id, e] of idx) {
    const derniers = e.res.slice(-5);
    out.set(id, {
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
 * Classement des compétitions concernées.
 * 1 requête par compétition — on ne demande que celles jouées ce jour-là.
 * @param {string[]} codes  ex. ['PPL', 'DED', 'BSA']
 * @returns {Promise<Map<string, {position:number, points:number, joues:number, bp:number, bc:number, compet:string}>>}
 */
export async function getStandings(codes = []) {
  const out = new Map();
  const uniques = [...new Set(codes.filter(Boolean))];
  if (uniques.length === 0 || !FD_KEY) return out;

  for (const code of uniques) {
    const d = await fdGet(`competitions/${code}/standings`);
    const table = d?.standings?.find(s => s.type === 'TOTAL')?.table || d?.standings?.[0]?.table || [];
    for (const t of table) {
      if (t.team?.id == null) continue;
      out.set(`fd:${t.team.id}`, {
        position: t.position, points: t.points, joues: t.playedGames,
        bp: t.goalsFor, bc: t.goalsAgainst, compet: d?.competition?.name || code,
        total: table.length,
      });
    }
  }
  console.log(`   🏆 Classement: ${out.size} équipe(s) sur ${uniques.length} compétition(s)`);
  return out;
}

/**
 * Meilleurs buteurs par compétition — force offensive concrète.
 * Remplace l'ancienne « infirmerie » inventée par des faits vérifiables :
 * qui marque, combien, en combien de matchs.
 * @returns {Promise<Map<string, {nom:string, buts:number, passes:number, matchs:number}[]>>} teamId -> buteurs
 */
export async function getScorers(codes = [], parCompet = 15) {
  const out = new Map();
  const uniques = [...new Set(codes.filter(Boolean))];
  if (uniques.length === 0 || !FD_KEY) return out;

  for (const code of uniques) {
    const d = await fdGet(`competitions/${code}/scorers?limit=${parCompet}`);
    for (const s of d?.scorers || []) {
      if (s.team?.id == null) continue;
      const cle = `fd:${s.team.id}`;
      if (!out.has(cle)) out.set(cle, []);
      out.get(cle).push({
        nom:    s.player?.name || '',
        buts:   s.goals ?? 0,
        passes: s.assists ?? 0,
        matchs: s.playedMatches ?? 0,
      });
    }
  }
  console.log(`   ⚽ Buteurs: ${out.size} équipe(s) documentée(s)`);
  return out;
}

/**
 * Confrontations directes, pour les matchs retenus uniquement.
 * 1 requête par match : on plafonne pour ne pas saturer le quota.
 * @returns {Promise<Map<number, string>>} fixtureId -> résumé lisible
 */
export async function getH2H(fixtures = [], max = 8) {
  const out = new Map();
  if (!FD_KEY) return out;

  const cibles = fixtures.filter(f => f.source === 'football-data' && f.fixtureId).slice(0, max);
  for (const f of cibles) {
    const d = await fdGet(`matches/${f.fixtureId}/head2head?limit=10`);
    const precedents = (d?.matches || [])
      .filter(m => m.score?.fullTime?.home != null)
      .slice(0, 5)
      .map(m => `${m.utcDate.slice(0, 10)} ${m.homeTeam.shortName || m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.shortName || m.awayTeam.name}`);
    if (precedents.length > 0) out.set(f.fixtureId, precedents.join(' | '));
  }
  console.log(`   🤝 H2H: ${out.size} match(s) documenté(s) sur ${cibles.length} interrogé(s)`);
  return out;
}

/**
 * Met en forme les matchs et leur contexte pour le prompt d'analyse.
 * C'est ce bloc qui remplace les étapes 1 et 2 de l'ancien callAI().
 *
 * Règle : on n'écrit QUE ce qu'on a vraiment. Une donnée absente est
 * signalée comme telle — jamais comblée, sinon le modèle l'invente.
 *
 * @param {Fixture[]} fixtures
 * @param {{forme?:Map, classement?:Map, h2h?:Map}} contexte
 */
export function formatFixturesForPrompt(fixtures, contexte = {}) {
  if (fixtures.length === 0) return '(aucun match trouvé pour cette date)';

  // Rétrocompatibilité : un simple Map = l'indice de forme
  const { forme = new Map(), classement = new Map(), h2h = new Map(),
          buteurs = new Map(), cotes = new Map() } =
    contexte instanceof Map ? { forme: contexte } : contexte;

  const parGroupe = new Map();
  for (const f of fixtures) {
    const cle = `${f.sport} — ${f.competition}`;
    if (!parGroupe.has(cle)) parGroupe.set(cle, []);
    parGroupe.get(cle).push(f);
  }

  const decrire = (nom, id) => {
    const fo = id ? forme.get(id) : null;
    const cl = id ? classement.get(id) : null;
    const bouts = [];
    if (cl) bouts.push(`${cl.position}e/${cl.total} · ${cl.points}pts en ${cl.joues}j`);
    if (fo) bouts.push(`forme ${fo.forme || 'n/a'} · ${fo.marques} marqués / ${fo.encaisses} encaissés sur ${fo.matchs} match(s)`);
    if (bouts.length === 0) return `    ${nom} — aucune donnée disponible`;
    return `    ${nom} — ${bouts.join(' · ')}`;
  };

  const lignes = [];
  for (const [groupe, list] of parGroupe) {
    lignes.push(`\n### ${groupe}`);
    for (const f of list) {
      lignes.push(`- ${f.home} vs ${f.away} — ${f.heure || '??:??'} (source: ${f.source})`);
      lignes.push(decrire(f.home, f.homeId));
      lignes.push(decrire(f.away, f.awayId));

      const fh = f.homeId ? forme.get(f.homeId) : null;
      const fa = f.awayId ? forme.get(f.awayId) : null;
      if (fh?.bilan) lignes.push(`    Derniers ${f.home}: ${fh.bilan}`);
      if (fa?.bilan) lignes.push(`    Derniers ${f.away}: ${fa.bilan}`);

      const conf = f.fixtureId ? h2h.get(f.fixtureId) : null;
      if (conf) lignes.push(`    Confrontations directes: ${conf}`);

      for (const [nom, id] of [[f.home, f.homeId], [f.away, f.awayId]]) {
        const bu = id ? buteurs.get(id) : null;
        if (bu?.length) {
          lignes.push(`    Buteurs ${nom}: ${bu.slice(0, 3).map(b => `${b.nom} ${b.buts}b/${b.matchs}j`).join(', ')}`);
        }
      }

      const co = f.fixtureId ? cotes.get(f.fixtureId) : null;
      if (co) lignes.push(`    Cotes marché (${co.bookmakers} bookmakers): ${co.resume}`);
    }
  }
  return lignes.join('\n');
}

export default {
  getFixturesOfDay, getResultsOfDay, buildFormIndex, getStandings, getH2H,
  formatFixturesForPrompt, fetchApiFootball, normalizeTeam, fetchWithTimeout,
};
