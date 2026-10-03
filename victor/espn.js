// ══════════════════════════════════════════════
// victor/espn.js — Secours : forme et classement depuis ESPN
// ══════════════════════════════════════════════
//
// Depuis le 21/09, football-data ne renvoie plus aucun match de la saison
// européenne 2026-27, et API-Football ne sert aucun match sur le plan
// gratuit. Le 02/10, Victor avait 68 équipes au programme et aucune donnée
// pour une seule d'entre elles : prompt.js:30 interdit alors tout pari.
//
// ESPN (API publique, sans clé, non documentée) a les classements 2026-27
// de toutes les grandes ligues — sondé le 02/10, voir scripts/sonde-espn.js.
// Deux points imposés par ce qu'elle rend réellement :
//
//   1. Le scoreboard refuse les plages de dates (HTTP 400). La forme vient
//      donc du calendrier de chaque équipe : une requête par équipe.
//   2. Ses identifiants ne correspondent à aucune autre source. Le
//      rapprochement se fait par le NOM — le piège documenté dans
//      sources.js (Vitória SC confondu avec Vitória). D'où trois garde-fous :
//      on ne cherche que dans la ligue du match, on n'accepte qu'un candidat
//      UNIQUE, et les deux équipes d'un match doivent être distinctes. Dans
//      le doute, l'équipe reste « aucune donnée » : une absence de donnée
//      est honnête, une donnée fausse ne l'est pas.
//
// Ce secours ne remplace rien : il ne complète que les équipes encore sans
// données après football-data et API-Football.

import { normalizeTeam, fetchWithTimeout, aDesDonnees } from './sources.js';

const BASE = 'https://site.api.espn.com/apis';
const DELAI_MS = 8_000;
const CACHE_MS = 8 * 3600_000;              // même raison que le secours API-Football : 05:00 et 11:00 UTC
const BUDGET_MS = 45_000;                    // le secours ne doit jamais retenir le job indéfiniment
const PARALLELE = 6;
export const MAX_EQUIPES_ESPN = 60;
export const MAX_LIGUES_ESPN = 12;

const _cache = new Map();                    // url → { ts, json }
export function viderCacheEspn() { _cache.clear(); }

// ── Ligue ESPN d'un match ─────────────────────────────────────
// Trois sources de matchs, trois façons de nommer une ligue. On ne devine
// jamais : une ligue absente de ces tables n'est simplement pas couverte.

// The Odds API : la clé de sport est stable et sans ambiguïté.
// Écartées après vérification le 02/10 (classement vide ou HTTP 400 chez
// ESPN) : Suisse, Pologne, Irlande, Finlande, Corée du Sud.
const PAR_CLE_ODDS = {
  soccer_epl: 'eng.1', soccer_efl_champ: 'eng.2', soccer_england_league1: 'eng.3', soccer_england_league2: 'eng.4',
  soccer_spain_la_liga: 'esp.1', soccer_spain_segunda_division: 'esp.2',
  soccer_germany_bundesliga: 'ger.1', soccer_germany_bundesliga2: 'ger.2',
  soccer_italy_serie_a: 'ita.1', soccer_italy_serie_b: 'ita.2',
  soccer_france_ligue_one: 'fra.1', soccer_france_ligue_two: 'fra.2',
  soccer_netherlands_eredivisie: 'ned.1', soccer_portugal_primeira_liga: 'por.1',
  soccer_belgium_first_div: 'bel.1', soccer_spl: 'sco.1', soccer_turkey_super_league: 'tur.1',
  soccer_greece_super_league: 'gre.1', soccer_austria_bundesliga: 'aut.1', soccer_denmark_superliga: 'den.1',
  soccer_sweden_allsvenskan: 'swe.1', soccer_norway_eliteserien: 'nor.1',
  soccer_usa_mls: 'usa.1', soccer_mexico_ligamx: 'mex.1',
  soccer_brazil_campeonato: 'bra.1', soccer_brazil_serie_b: 'bra.2',
  soccer_argentina_primera_division: 'arg.1', soccer_chile_campeonato: 'chi.1',
  soccer_japan_j_league: 'jpn.1', soccer_china_superleague: 'chn.1',
  soccer_australia_aleague: 'aus.1', soccer_saudi_arabia_pro_league: 'ksa.1',
  soccer_uefa_champs_league: 'uefa.champions', soccer_uefa_europa_league: 'uefa.europa',
  soccer_uefa_europa_conference_league: 'uefa.europa.conf',
  soccer_conmebol_copa_libertadores: 'conmebol.libertadores', soccer_conmebol_copa_sudamericana: 'conmebol.sudamericana',
};

// football-data : le code de compétition.
const PAR_CODE_FD = {
  PL: 'eng.1', ELC: 'eng.2', PD: 'esp.1', BL1: 'ger.1', SA: 'ita.1', FL1: 'fra.1',
  DED: 'ned.1', PPL: 'por.1', BSA: 'bra.1', CL: 'uefa.champions', CLI: 'conmebol.libertadores',
};

// TheSportsDB et API-Football : le nom complet, comparé à l'identique
// (minuscules, sans accents). Jamais de recherche partielle : « Premier
// League » seul désigne aussi la Russie, l'Ukraine ou l'Égypte.
const PAR_NOM = {
  'english premier league': 'eng.1', 'english league championship': 'eng.2',
  'english league 1': 'eng.3', 'english league 2': 'eng.4',
  'spanish la liga': 'esp.1', 'spanish la liga 2': 'esp.2',
  'german bundesliga': 'ger.1', 'german 2 bundesliga': 'ger.2',
  'italian serie a': 'ita.1', 'italian serie b': 'ita.2',
  'french ligue 1': 'fra.1', 'french ligue 2': 'fra.2',
  'dutch eredivisie': 'ned.1', 'portuguese primeira liga': 'por.1', 'belgian pro league': 'bel.1',
  'scottish premiership': 'sco.1', 'turkish super lig': 'tur.1', 'greek superleague greece': 'gre.1',
  'austrian bundesliga': 'aut.1', 'danish superliga': 'den.1', 'swedish allsvenskan': 'swe.1',
  'norwegian eliteserien': 'nor.1', 'american major league soccer': 'usa.1', 'american usl championship': 'usa.usl.1', 'mexican primera league': 'mex.1',
  'brazilian serie a': 'bra.1', 'argentinian primera division': 'arg.1', 'japanese j league': 'jpn.1',
  'uefa champions league': 'uefa.champions', 'uefa europa league': 'uefa.europa',
  'uefa europa conference league': 'uefa.europa.conf', 'uefa conference league': 'uefa.europa.conf',
  'copa libertadores': 'conmebol.libertadores', 'conmebol libertadores': 'conmebol.libertadores',
};

const nomLigue = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Code de ligue ESPN d'un match, ou null si la ligue n'est pas couverte. */
export function ligueEspn(f = {}) {
  if (f.sportKey && PAR_CLE_ODDS[f.sportKey]) return PAR_CLE_ODDS[f.sportKey];
  if (f.codeCompet && PAR_CODE_FD[f.codeCompet]) return PAR_CODE_FD[f.codeCompet];
  return PAR_NOM[nomLigue(f.competition)] || null;
}

/** Toutes les ligues ESPN que le secours peut interroger (sonde). */
export function liguesConnues() {
  return [...new Set([...Object.values(PAR_CLE_ODDS), ...Object.values(PAR_CODE_FD), ...Object.values(PAR_NOM)])];
}

// ── Lecture des réponses (pures : aucun appel réseau) ─────────

const stat = (e, nom) => e?.stats?.find(s => s.name === nom)?.value;

/**
 * Lit /v2/sports/soccer/{ligue}/standings.
 * @returns {{equipes: {id:string, noms:string[], position:number, points:number, joues:number, bp:number|null, bc:number|null, total:number, compet:string}[], erreur:string|null}}
 */
export function lireClassementEspn(json) {
  // Ligue à un seul tableau : `children[0].standings` ; certaines réponses
  // portent `standings` à la racine ; la MLS en a deux (conférences).
  const groupes = Array.isArray(json?.children) && json.children.length
    ? json.children.map(c => c.standings).filter(Boolean)
    : (json?.standings ? [json.standings] : []);
  const equipes = [];
  const vus = new Set();
  for (const g of groupes) {
    const entrees = Array.isArray(g.entries) ? g.entries : [];
    for (const e of entrees) {
      const id = e?.team?.id;
      if (id == null || vus.has(String(id))) continue;
      const position = stat(e, 'rank');
      const joues = stat(e, 'gamesPlayed');
      if (position == null || joues == null) continue;
      vus.add(String(id));
      const t = e.team;
      equipes.push({
        id: String(id),
        noms: [...new Set([t.displayName, t.shortDisplayName, t.name, t.location].filter(Boolean))],
        position, points: stat(e, 'points') ?? 0, joues,
        bp: stat(e, 'pointsFor') ?? null, bc: stat(e, 'pointsAgainst') ?? null,
        total: entrees.length, compet: json?.name || '',
      });
    }
  }
  if (equipes.length === 0) return { equipes, erreur: 'classement vide (ligue inconnue ou hors saison)' };
  return { equipes, erreur: null };
}

const valeurScore = (s) => {
  const v = typeof s === 'object' && s !== null ? (s.value ?? s.displayValue) : s;
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
};

/**
 * Lit /site/v2/sports/soccer/{ligue}/teams/{id}/schedule et en tire la
 * forme : cinq derniers matchs terminés avant `avantISO`, du plus ancien au
 * plus récent, comme buildFormIndex.
 * @returns {{nom:string, forme:string, bilan:string, marques:number, encaisses:number, matchs:number}|null}
 */
export function lireCalendrierEspn(json, idEquipe, avantISO = new Date().toISOString()) {
  const id = String(idEquipe);
  const res = [];
  let nom = '';
  for (const ev of Array.isArray(json?.events) ? json.events : []) {
    const c = ev?.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const date = c.date || ev.date;
    if (!date || date >= avantISO) continue;
    const moi = c.competitors?.find(k => String(k.team?.id ?? k.id) === id);
    const lui = c.competitors?.find(k => String(k.team?.id ?? k.id) !== id);
    if (!moi || !lui) continue;
    const bp = valeurScore(moi.score), bc = valeurScore(lui.score);
    if (bp === null || bc === null) continue;
    nom = moi.team?.displayName || nom;
    res.push({ date, res: bp > bc ? 'V' : bp < bc ? 'D' : 'N', bp, bc, adversaire: lui.team?.displayName || '?' });
  }
  if (res.length === 0) return null;
  res.sort((a, b) => (a.date < b.date ? -1 : 1));
  const derniers = res.slice(-5);
  return {
    nom,
    forme: derniers.map(r => r.res).join(''),
    bilan: derniers.map(r => `${r.res} ${r.bp}-${r.bc} vs ${r.adversaire}`).join(' | '),
    marques: derniers.reduce((a, r) => a + r.bp, 0),
    encaisses: derniers.reduce((a, r) => a + r.bc, 0),
    matchs: derniers.length,
  };
}

// ── Rapprochement par le nom, dans une seule ligue ────────────

// Noms d'usage que la normalisation ne peut pas déduire. Volontairement court :
// chaque entrée a été vue dans une source de matchs.
const ALIAS = {
  'inter milan': 'internazionale', 'inter': 'internazionale',
  'psg': 'paris saint germain', 'man utd': 'manchester united', 'man united': 'manchester united',
  'wolves': 'wolverhampton wanderers', 'spurs': 'tottenham hotspur',
  // Relevés le 03/10 (scripts/sonde-alias-espn.js) : un seul candidat ESPN
  // chacun. Le Brésil suffixe certains clubs de leur État chez The Odds API.
  'nautico pe': 'nautico',             // ESPN « Náutico »
  'atletico mineiro': 'atletico mg',   // ESPN « Atlético-MG »
  'bragantino sp': 'bragantino',       // ESPN « Red Bull Bragantino / Bragantino »
};

const forme1 = (nom) => {
  const n = normalizeTeam(String(nom).replace(/&/g, ' ').replace(/['’]/g, ''))   // « Newell's » = « Newells »
    .replace(/\band\b|\bthe\b|\bsd\b/g, ' ')                                  // « SD Eibar » = « Eibar »
    .replace(/\s+/g, ' ').trim();
  return ALIAS[n] || n;
};
const jetons = (n) => n.split(' ').filter(Boolean);

/**
 * L'équipe ESPN qui porte ce nom, parmi celles d'UNE ligue — ou null.
 * Accepte : le nom identique, ou un nom dont tous les mots figurent dans
 * celui d'une seule équipe (« Brighton » → « Brighton & Hove Albion »).
 * Refuse dès qu'il y a plus d'un candidat.
 */
export function apparierEquipe(nom, equipes = []) {
  const cible = forme1(nom);
  if (!cible) return null;

  const exacts = equipes.filter(e => e.noms.some(n => forme1(n) === cible));
  if (exacts.length === 1) return exacts[0];
  if (exacts.length > 1) return null;

  const mots = jetons(cible);
  const inclus = equipes.filter(e => e.noms.some(n => {
    const leurs = new Set(jetons(forme1(n)));
    // Mes mots tous chez eux (« Brighton » ⊂ « Brighton Hove Albion »)…
    if (mots.every(m => leurs.has(m))) return true;
    // …ou leurs mots tous chez moi, à condition qu'ils soient au moins deux :
    // sinon « Milan » (AC Milan) serait contenu dans « Inter Milan ».
    return leurs.size >= 2 && [...leurs].every(m => mots.includes(m));
  }));
  return inclus.length === 1 ? inclus[0] : null;
}

// ── Réseau ────────────────────────────────────────────────────

async function lireJson(url) {
  const enCache = _cache.get(url);
  if (enCache && Date.now() - enCache.ts < CACHE_MS) return { json: enCache.json, cache: true };
  const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': 'PronoSight/1.0' } }, DELAI_MS);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  _cache.set(url, { ts: Date.now(), json });
  return { json, cache: false };
}

/**
 * Forme et classement ESPN des équipes du jour encore sans données.
 *
 * Les données sont rangées sous l'identifiant que le match porte déjà
 * (tsdb:…, fd:…). Un match de The Odds API n'en a aucun : on lui attribue
 * alors `espn:<id>` — c'est la seule modification faite aux matchs.
 *
 * @param {object[]} fixtures  matchs à venir (modifiés : homeId/awayId nuls complétés)
 * @param {Map} forme        contexte déjà connu (lu, jamais modifié)
 * @param {Map} classement   idem
 * @returns {Promise<{forme:Map, classement:Map, rapport:string, erreurs:string[]}>}
 */
export async function getContexteEspn(fixtures = [], forme = new Map(), classement = new Map(), {
  maxLigues = MAX_LIGUES_ESPN, maxEquipes = MAX_EQUIPES_ESPN, maintenant = new Date(),
} = {}) {
  const sortie = { forme: new Map(), classement: new Map(), erreurs: [] };
  const fin = Date.now() + BUDGET_MS;

  // 1. Équipes à documenter, regroupées par ligue ESPN.
  const parLigue = new Map();
  let horsLigue = 0;
  for (const f of fixtures) {
    const besoin = [f.homeId, f.awayId].some(id => !aDesDonnees(id, forme, classement));
    if (!besoin) continue;
    const code = ligueEspn(f);
    if (!code) { horsLigue++; continue; }
    if (!parLigue.has(code)) parLigue.set(code, []);
    parLigue.get(code).push(f);
  }
  if (parLigue.size === 0) {
    sortie.rapport = `aucune ligue couverte parmi les matchs sans données (${horsLigue} match(s) hors couverture)`;
    return sortie;
  }

  const ligues = [...parLigue.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxLigues);

  // 2. Un classement par ligue, puis rapprochement des équipes.
  let requetes = 0, cache = 0, apparies = 0, nonApparies = 0;
  const refuses = [];
  const calendriers = [];                       // { code, espnId, cles: [id du match] }
  for (const [code, matchs] of ligues) {
    if (Date.now() > fin) { sortie.erreurs.push(`${code} : budget de temps épuisé`); continue; }
    let lu;
    try {
      const r = await lireJson(`${BASE}/v2/sports/soccer/${code}/standings`);
      r.cache ? cache++ : requetes++;
      lu = lireClassementEspn(r.json);
    } catch (err) {
      sortie.erreurs.push(`${code} : ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      continue;
    }
    if (lu.erreur) { sortie.erreurs.push(`${code} : ${lu.erreur}`); continue; }

    for (const f of matchs) {
      const dom = apparierEquipe(f.home, lu.equipes);
      const ext = apparierEquipe(f.away, lu.equipes);
      // Deux noms qui pointent la même équipe : l'un des deux est faux.
      const paire = dom && ext && dom.id === ext.id ? [null, null] : [dom, ext];
      for (const [cote, equipe] of [['home', paire[0]], ['away', paire[1]]]) {
        const champ = cote === 'home' ? 'homeId' : 'awayId';
        if (aDesDonnees(f[champ], forme, classement)) continue;
        if (!equipe) { nonApparies++; refuses.push(`${code}:${cote === 'home' ? f.home : f.away}`); continue; }
        if (!f[champ]) f[champ] = `espn:${equipe.id}`;
        const cle = f[champ];
        apparies++;
        if (!sortie.classement.has(cle)) {
          const { id, noms, ...rang } = equipe;
          sortie.classement.set(cle, rang);
        }
        calendriers.push({ code, espnId: equipe.id, cle });
      }
    }
  }

  // 3. La forme : un calendrier par équipe, en parallèle modéré.
  const aLire = calendriers.slice(0, maxEquipes);
  const avantISO = maintenant.toISOString();
  for (let i = 0; i < aLire.length; i += PARALLELE) {
    if (Date.now() > fin) { sortie.erreurs.push(`forme : budget épuisé après ${i} équipe(s)`); break; }
    await Promise.all(aLire.slice(i, i + PARALLELE).map(async ({ code, espnId, cle }) => {
      try {
        const r = await lireJson(`${BASE}/site/v2/sports/soccer/${code}/teams/${espnId}/schedule`);
        r.cache ? cache++ : requetes++;
        const fo = lireCalendrierEspn(r.json, espnId, avantISO);
        if (fo && !sortie.forme.has(cle)) sortie.forme.set(cle, fo);
      } catch (err) {
        sortie.erreurs.push(`calendrier ${code}/${espnId} : ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      }
    }));
  }

  sortie.rapport = `${apparies} équipe(s) rapprochée(s) sur ${ligues.length} ligue(s)`
    + `${nonApparies ? `, ${nonApparies} sans correspondance sûre` : ''}`
    + `${horsLigue ? `, ${horsLigue} match(s) hors couverture` : ''}`
    + ` (${requetes} requête(s), ${cache} depuis le cache)`
    + `${sortie.erreurs.length ? ` — ${sortie.erreurs.length} erreur(s) : ${sortie.erreurs.slice(0, 2).join(' | ')}` : ''}`;
  console.log(`   🛟 Secours ESPN : ${sortie.rapport}`);
  // Dans les logs seulement, pas dans la raison envoyée sur Telegram : ce
  // sont ces noms qui diront quel alias ajouter.
  if (refuses.length) console.log(`      sans correspondance sûre : ${refuses.slice(0, 15).join(' · ')}`);
  return sortie;
}

export default { ligueEspn, liguesConnues, lireClassementEspn, lireCalendrierEspn, apparierEquipe, getContexteEspn };
