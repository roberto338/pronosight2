// ══════════════════════════════════════════════
// victor/odds.js — Cotes réelles des bookmakers
//
// Jusqu'ici, la « value » était AFFIRMÉE par le LLM : Victor estimait
// lui-même une cote, puis jugeait si sa propre estimation était mal
// pricée. Raisonnement circulaire, donc sans valeur.
//
// Ici la value devient une SOUSTRACTION :
//     value = (probabilité estimée × cote réelle) − 1
// Le modèle ne fournit que la probabilité. La cote vient du marché.
// Le verdict est calculé en code, pas déclaré par l'IA.
//
// Source : The Odds API — 500 crédits/mois en gratuit.
// Coût : 1 crédit par marché et par région et par requête.
//        markets=h2h,totals & regions=eu  →  2 crédits par compétition.
// ══════════════════════════════════════════════

import { fetchWithTimeout, normalizeTeam } from './sources.js';

const ODDS_KEY = process.env.ODDS_API_KEY;

// Plafond de compétitions interrogées par exécution — garde-fou de quota.
const MAX_COMPETS = Number(process.env.ODDS_MAX_COMPETS || 6);

// Codes football-data → clés de sport The Odds API
const SPORT_KEYS = {
  PL:  'soccer_epl',
  ELC: 'soccer_efl_champ',
  FL1: 'soccer_france_ligue_one',
  PD:  'soccer_spain_la_liga',
  SA:  'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
  DED: 'soccer_netherlands_eredivisie',
  PPL: 'soccer_portugal_primeira_liga',
  BSA: 'soccer_brazil_campeonato',
  CL:  'soccer_uefa_champs_league',
  CLI: 'soccer_conmebol_copa_libertadores',
};

/**
 * Value d'un pari : espérance de gain par unité misée.
 *   value > 0  → le pari est rentable sur la durée
 *   value = 0  → neutre
 *   value < 0  → perdant sur la durée
 * @param {number} probabilite  0 à 1, estimée par Victor
 * @param {number} cote         cote décimale du marché
 * @returns {number|null}
 */
export function calculerValue(probabilite, cote) {
  const p = Number(probabilite), c = Number(cote);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  if (p <= 0 || p > 1 || c < 1.01) return null;
  return Number((p * c - 1).toFixed(4));
}

/** Probabilité implicite du marché, marge bookmaker incluse. */
export function probaImplicite(cote) {
  const c = Number(cote);
  if (!Number.isFinite(c) || c < 1.01) return null;
  return Number((1 / c).toFixed(4));
}

/** Moyenne des cotes proposées par les bookmakers pour une issue. */
function moyenne(valeurs) {
  const v = valeurs.filter(x => Number.isFinite(x) && x >= 1.01);
  if (v.length === 0) return null;
  return Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2));
}

/** Agrège les bookmakers d'un évènement en cotes moyennes par marché. */
function agregerEvenement(ev) {
  const h2h = { home: [], draw: [], away: [] };
  const totals = new Map(); // seuil -> { over: [], under: [] }

  for (const bk of ev.bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key === 'h2h') {
        for (const o of m.outcomes || []) {
          if (o.name === ev.home_team)      h2h.home.push(o.price);
          else if (o.name === ev.away_team) h2h.away.push(o.price);
          else if (o.name === 'Draw')       h2h.draw.push(o.price);
        }
      } else if (m.key === 'totals') {
        for (const o of m.outcomes || []) {
          const seuil = o.point;
          if (seuil == null) continue;
          if (!totals.has(seuil)) totals.set(seuil, { over: [], under: [] });
          if (o.name === 'Over')       totals.get(seuil).over.push(o.price);
          else if (o.name === 'Under') totals.get(seuil).under.push(o.price);
        }
      }
    }
  }

  const marches = {
    '1X2:HOME': moyenne(h2h.home),
    '1X2:DRAW': moyenne(h2h.draw),
    '1X2:AWAY': moyenne(h2h.away),
  };
  for (const [seuil, o] of totals) {
    const over = moyenne(o.over), under = moyenne(o.under);
    if (over)  marches[`OU:OVER:${seuil}`]  = over;
    if (under) marches[`OU:UNDER:${seuil}`] = under;
  }

  return { marches, bookmakers: (ev.bookmakers || []).length };
}

/** Résumé lisible injecté dans le prompt. */
function resumer(marches) {
  const bouts = [];
  if (marches['1X2:HOME']) bouts.push(`1 ${marches['1X2:HOME']}`);
  if (marches['1X2:DRAW']) bouts.push(`N ${marches['1X2:DRAW']}`);
  if (marches['1X2:AWAY']) bouts.push(`2 ${marches['1X2:AWAY']}`);
  if (marches['OU:OVER:2.5'])  bouts.push(`+2.5 ${marches['OU:OVER:2.5']}`);
  if (marches['OU:UNDER:2.5']) bouts.push(`-2.5 ${marches['OU:UNDER:2.5']}`);
  return bouts.join(' · ');
}

/**
 * Liste des compétitions de football actives chez The Odds API.
 * Cet appel ne consomme aucun crédit.
 */
async function sportsActifs() {
  if (!ODDS_KEY) return [];
  try {
    const r = await fetchWithTimeout(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`, {}, 20_000);
    if (!r.ok) return [];
    return (await r.json()).filter(s => s.key?.startsWith('soccer_') && s.active);
  } catch { return []; }
}

/**
 * Calendrier via The Odds API — 45 compétitions, **sans consommer de crédit**.
 *
 * Vérifié : /events laisse le compteur inchangé (498 → 498 sur 3 appels).
 * Couvre MLS, Liga MX, championnats scandinaves, asiatiques, 2e divisions
 * et coupes — soit 3,5× la couverture de football-data.
 *
 * ⚠️ Ces matchs n'ont ni classement ni forme : Victor les verra mais
 * refusera de parier dessus tant qu'aucune statistique n'est disponible.
 * Leur intérêt est la visibilité du programme et la présence de cotes.
 *
 * @returns {Promise<Fixture[]>}
 */
export async function getOddsEvents(dateISO) {
  if (!ODDS_KEY) return [];
  const sports = await sportsActifs();
  if (sports.length === 0) return [];

  const out = [];
  const LOT = 5; // concurrence modérée : gratuit en crédits, pas en débit HTTP

  for (let i = 0; i < sports.length; i += LOT) {
    const lot = sports.slice(i, i + LOT);
    const res = await Promise.all(lot.map(async (s) => {
      try {
        const r = await fetchWithTimeout(
          `https://api.the-odds-api.com/v4/sports/${s.key}/events?apiKey=${ODDS_KEY}&dateFormat=iso`, {}, 20_000);
        if (!r.ok) return [];
        const evenements = await r.json();
        return (Array.isArray(evenements) ? evenements : [])
          .filter(e => (e.commence_time || '').slice(0, 10) === dateISO)
          .map(e => ({
            sport: 'Football',
            competition: s.title || s.key,
            codeCompet: '',
            fixtureId: e.id ?? null,
            homeId: null, awayId: null,   // pas d'identifiant commun avec football-data
            match: `${e.home_team} vs ${e.away_team}`,
            home: e.home_team || '',
            away: e.away_team || '',
            heure: e.commence_time
              ? new Date(e.commence_time).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
              : '',
            dateISO,
            status: 'NS',
            homeGoals: null, awayGoals: null,
            venue: '',
            source: 'odds-api',
            sportKey: s.key,
          }));
      } catch { return []; }
    }));
    out.push(...res.flat());
  }

  console.log(`   🗓️  The Odds API: ${out.length} match(s) sur ${sports.length} compétition(s) (0 crédit)`);
  return out;
}

/**
 * Récupère les cotes du marché pour les matchs du jour.
 * Silencieux et inoffensif si ODDS_API_KEY est absente.
 *
 * @param {Array} fixtures  matchs normalisés (victor/sources.js)
 * @returns {Promise<Map<number|string, {marches:object, resume:string, bookmakers:number}>>}
 */
export async function getOdds(fixtures = []) {
  const out = new Map();
  if (!ODDS_KEY) {
    console.log('   💰 Cotes: ODDS_API_KEY absente — value bet non calculable');
    return out;
  }

  const codes = [...new Set(fixtures.map(f => f.codeCompet).filter(c => SPORT_KEYS[c]))].slice(0, MAX_COMPETS);
  if (codes.length === 0) {
    console.log('   💰 Cotes: aucune compétition couverte par The Odds API aujourd\'hui');
    return out;
  }

  let restants = null;

  for (const code of codes) {
    const sport = SPORT_KEYS[code];
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/`
        + `?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
      const resp = await fetchWithTimeout(url, {}, 20_000);
      restants = resp.headers.get('x-requests-remaining') ?? restants;

      if (resp.status === 401) { console.warn('   ⚠️  Cotes: clé refusée (401)'); return out; }
      if (resp.status === 429) { console.warn('   ⚠️  Cotes: quota mensuel épuisé'); return out; }
      if (!resp.ok) { console.warn(`   ⚠️  Cotes ${sport}: HTTP ${resp.status}`); continue; }

      const evenements = await resp.json();

      // Rapprochement avec nos matchs : équipes normalisées + même jour.
      for (const ev of evenements) {
        const dom = normalizeTeam(ev.home_team), ext = normalizeTeam(ev.away_team);
        const jour = (ev.commence_time || '').slice(0, 10);

        const f = fixtures.find(x => {
          if (x.codeCompet !== code) return false;
          const a = normalizeTeam(x.home), b = normalizeTeam(x.away);
          const memeJour = !x.dateISO || !jour || Math.abs(new Date(x.dateISO) - new Date(jour)) <= 864e5;
          return memeJour
            && (a.includes(dom) || dom.includes(a))
            && (b.includes(ext) || ext.includes(b));
        });
        if (!f || !f.fixtureId) continue;

        const { marches, bookmakers } = agregerEvenement(ev);
        if (Object.keys(marches).length === 0) continue;
        out.set(f.fixtureId, { marches, bookmakers, resume: resumer(marches) });
      }
    } catch (err) {
      console.warn(`   ⚠️  Cotes ${sport}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    }
  }

  console.log(`   💰 Cotes: ${out.size} match(s) cotés sur ${codes.length} compétition(s)`
    + (restants != null ? ` — ${restants} crédit(s) restant(s) ce mois` : ''));
  return out;
}

/**
 * Traduit un pronostic en clé de marché, pour retrouver sa cote.
 * Volontairement conservateur : en cas de doute, on renvoie null plutôt
 * que d'associer une cote au mauvais pari.
 */
export function cleMarche(pronostic, homeName = '', awayName = '') {
  const p = String(pronostic || '').toLowerCase().replace(',', '.');
  const dom = normalizeTeam(homeName), ext = normalizeTeam(awayName);
  const pn  = normalizeTeam(p);
  const viseDom = dom && pn.includes(dom);
  const viseExt = ext && pn.includes(ext);

  const mTot = p.match(/(over|under|plus de|moins de)\s*(\d+(?:\.\d+)?)/);
  if (mTot) {
    const sens = /over|plus de/.test(mTot[1]) ? 'OVER' : 'UNDER';
    return `OU:${sens}:${parseFloat(mTot[2])}`;
  }

  if (/\bnul\b|\bdraw\b/.test(p) && !/double|ou\b/.test(p)) return '1X2:DRAW';

  if (/victoire|win|gagne/.test(p) && !/double/.test(p)) {
    if (viseDom && !viseExt) return '1X2:HOME';
    if (viseExt && !viseDom) return '1X2:AWAY';
    if (/dom|home|\b1\b/.test(p)) return '1X2:HOME';
    if (/ext|away|\b2\b/.test(p)) return '1X2:AWAY';
  }

  return null; // double chance, handicap, BTTS : non couverts par h2h/totals
}

/**
 * Enrichit un event de Victor avec la cote réelle et la value calculée.
 * @returns {{cote:number, value:number, probaMarche:number}|null}
 */
export function evaluerValue(ev, cotesDuMatch) {
  if (!cotesDuMatch?.marches) return null;
  const cle  = cleMarche(ev?.pronostic_principal, ev?.equipe_a, ev?.equipe_b);
  const cote = cle ? cotesDuMatch.marches[cle] : null;
  if (!cote) return null;

  const value = calculerValue(ev?.probabilite, cote);
  if (value === null) return null;

  return { cote, value, probaMarche: probaImplicite(cote) };
}

export default { getOdds, calculerValue, probaImplicite, cleMarche, evaluerValue };
