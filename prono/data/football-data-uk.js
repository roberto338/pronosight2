// ══════════════════════════════════════════════
// prono/data/football-data-uk.js — cotes de clôture publiques
// ══════════════════════════════════════════════
//
// football-data.co.uk publie, gratuitement et depuis vingt ans, un fichier
// CSV par championnat et par saison : résultats ET cotes de clôture de
// plusieurs bookmakers et de Betfair Exchange. C'est la référence d'usage
// pour mesurer un CLV sans rien payer — The Odds API facture chaque cote,
// et le palier gratuit est déjà épuisé par les analyses quotidiennes.
//
// Ce module ne fait que TÉLÉCHARGER, LIRE et APPARIER. Le calcul est dans
// prono/engine/clv.js. Les fonctions de lecture et d'appariement sont pures
// et testées sans réseau.

const BASE = 'https://www.football-data.co.uk';
const DELAI_MS = 20_000;

// ── Compétition de ps_pronostics → fichier ────────────────────
// Les libellés sont ceux qu'écrit Victor (noms football-data.org pour
// l'essentiel). Comparaison à l'identique après normalisation : « Serie A »
// est italienne, la brésilienne s'appelle « Campeonato Brasileiro Série A ».
const PRINCIPAUX = {
  'premier league': 'E0', 'championship': 'E1', 'league one': 'E2', 'league two': 'E3',
  'primera division': 'SP1', 'la liga': 'SP1', 'segunda division': 'SP2',
  'bundesliga': 'D1', '2 bundesliga': 'D2',
  'serie a': 'I1', 'serie b': 'I2',
  'ligue 1': 'F1', 'ligue 2': 'F2',
  'eredivisie': 'N1', 'primeira liga': 'P1', 'jupiler pro league': 'B1',
  'scottish premiership': 'SC0', 'super lig': 'T1',
};
const AUTRES = {
  'campeonato brasileiro serie a': 'BRA', 'brasileirao': 'BRA',
  'liga profesional': 'ARG', 'argentinian primera division': 'ARG',
  'major league soccer': 'USA', 'mls': 'USA', 'liga mx': 'MEX', 'j1 league': 'JPN',
};

const simplifier = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Saison football-data.co.uk d'une date : 2026-08-15 → « 2627 ». */
export function saisonDe(dateISO) {
  const [a, m] = String(dateISO).split('-').map(Number);
  const debut = m >= 7 ? a : a - 1;
  return `${String(debut).slice(2)}${String(debut + 1).slice(2)}`;
}

/** Fichier à lire pour un pronostic, ou null si la compétition n'est pas couverte. */
export function fichierPour(competition, dateISO) {
  const c = simplifier(competition);
  if (PRINCIPAUX[c]) return { cle: `${saisonDe(dateISO)}/${PRINCIPAUX[c]}`, url: `${BASE}/mmz4281/${saisonDe(dateISO)}/${PRINCIPAUX[c]}.csv` };
  if (AUTRES[c]) return { cle: AUTRES[c], url: `${BASE}/new/${AUTRES[c]}.csv` };
  return null;
}

// ── Lecture du CSV ────────────────────────────────────────────

/** CSV simple, guillemets compris. */
export function lireCsv(texte = '') {
  const lignes = String(texte).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lignes.length === 0) return [];
  const decouper = (l) => {
    const out = [];
    let cur = '', guillemet = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (guillemet && l[i + 1] === '"') { cur += '"'; i++; } else guillemet = !guillemet; }
      else if (ch === ',' && !guillemet) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const entete = decouper(lignes[0]).map(s => s.trim());
  return lignes.slice(1).map(l => {
    const v = decouper(l);
    const o = {};
    entete.forEach((k, i) => { if (k) o[k] = (v[i] ?? '').trim(); });
    return o;
  });
}

/** Ligne → rencontre { date: AAAA-MM-JJ, home, away, ligne }. */
export function versRencontre(ligne) {
  const m = String(ligne.Date || '').match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const annee = m[3].length === 2 ? `20${m[3]}` : m[3];
  const home = ligne.HomeTeam || ligne.Home, away = ligne.AwayTeam || ligne.Away;
  if (!home || !away) return null;
  return { date: `${annee}-${m[2]}-${m[1]}`, home, away, ligne };
}

// ── Appariement ───────────────────────────────────────────────

// Noms d'usage que la normalisation ne peut pas déduire, côté Victor et côté
// football-data.co.uk, ramenés à une même forme.
const ALIAS = {
  'atleti': 'ath madrid', 'atletico madrid': 'ath madrid', 'club atletico de madrid': 'ath madrid',
  'athletic club': 'ath bilbao', 'athletic bilbao': 'ath bilbao',
  'paris saint germain': 'paris sg', 'psg': 'paris sg',
  'manchester united': 'man united', 'man utd': 'man united', 'manchester city': 'man city',
  'nottingham forest': 'nott m forest', 'nottm forest': 'nott m forest',
  'wolverhampton wanderers': 'wolves', 'wolverhampton': 'wolves',
  'sheffield wednesday': 'sheffield weds', 'queens park rangers': 'qpr', 'west bromwich albion': 'west brom',
  'eintracht frankfurt': 'ein frankfurt', 'frankfurt': 'ein frankfurt',
  'borussia monchengladbach': 'm gladbach', 'monchengladbach': 'm gladbach', 'gladbach': 'm gladbach',
  'bayer leverkusen': 'leverkusen', 'bayer 04 leverkusen': 'leverkusen',
  'internazionale': 'inter', 'inter milan': 'inter', 'ac milan': 'milan',
  'sporting cp': 'sp lisbon', 'sporting': 'sp lisbon', 'sporting lisbon': 'sp lisbon',
  'sporting braga': 'sp braga', 'braga': 'sp braga',
  'psv eindhoven': 'psv eindhoven', 'psv': 'psv eindhoven', 'az alkmaar': 'az alkmaar', 'az': 'az alkmaar',
  'nec nijmegen': 'nijmegen', 'nec': 'nijmegen', 'go ahead': 'go ahead eagles',
};

// Mots qui ne distinguent pas une équipe : préfixes de forme juridique.
const VIDES = new Set(['fc', 'cf', 'sc', 'ac', 'as', 'ss', 'us', 'rc', 'sv', 'afc', 'cd', 'ud', 'club', 'de', 'the', 'and', 'calcio', '1907', '1909', '1910']);

export function nomCanonique(nom = '') {
  const s = simplifier(String(nom).replace(/&/g, ' and ').replace(/'/g, ' '));
  if (ALIAS[s]) return ALIAS[s];
  const sansVides = s.split(' ').filter(m => m && !VIDES.has(m)).join(' ');
  return ALIAS[sansVides] || sansVides;
}

/** Deux noms désignent-ils la même équipe ? Identiques, ou l'un contient tous les mots de l'autre. */
export function memeEquipe(a, b) {
  const x = nomCanonique(a), y = nomCanonique(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const mx = x.split(' '), my = new Set(y.split(' '));
  const mxSet = new Set(mx);
  return mx.every(m => my.has(m)) || [...my].every(m => mxSet.has(m));
}

const ecartJours = (a, b) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);

/**
 * La rencontre d'un pronostic : même jour (±1, décalage horaire), même
 * championnat, LES DEUX équipes reconnues, candidat unique. Sinon null.
 */
export function apparier(prono, rencontres = []) {
  const cands = rencontres.filter(r =>
    ecartJours(r.date, prono.date) <= 1
    && memeEquipe(prono.equipe_a, r.home) && memeEquipe(prono.equipe_b, r.away));
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) {
    // Deux candidats sur deux jours : le jour exact tranche.
    const exacts = cands.filter(r => r.date === prono.date);
    return exacts.length === 1 ? exacts[0] : null;
  }
  return null;
}

// ── Réseau ────────────────────────────────────────────────────

const _cache = new Map();
/** Rencontres d'un fichier, téléchargé une seule fois par exécution. */
export async function chargerFichier(url) {
  if (_cache.has(url)) return _cache.get(url);
  const promesse = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DELAI_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PronoSight-clv/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return lireCsv(await r.text()).map(versRencontre).filter(Boolean);
    } finally {
      clearTimeout(t);
    }
  })();
  _cache.set(url, promesse);
  return promesse;
}

export default { saisonDe, fichierPour, lireCsv, versRencontre, nomCanonique, memeEquipe, apparier, chargerFichier };
