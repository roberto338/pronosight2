// ══════════════════════════════════════════════
// victor/valeur.js — Value de marché : le bon prix, sans IA
// ══════════════════════════════════════════════
//
// Ce que les mesures du 02/10 ont établi :
//   · Victor (IA) ne bat pas la cote de clôture : CLV −4,7 % sur 55 paris.
//   · Le moteur statistique non plus : CLV −1,3 % sur 23 799 paris rejoués.
//   · En revanche, sur six saisons et huit championnats (football-data.co.uk),
//     une cote qui dépasse le prix juste du CONSENSUS des bookmakers de plus
//     de 2 % bat la clôture : CLV +3,9 % [+3,3 ; +4,4] sur 1 621 paris, et
//     rendement réel +1,1 % (intervalle encore large : [−6,7 ; +8,8]).
//
// Le principe : la moyenne des bookmakers, marge retirée, donne un prix juste
// très difficile à battre — c'est l'information collective du marché. Quand
// UN bookmaker propose davantage, il est en retard sur les autres. Aucune
// prédiction n'est faite ici ; on repère un prix.
//
// La marge est retirée par la MÉTHODE DE LA PUISSANCE, pas au prorata. Le
// prorata laisse trop de probabilité aux outsiders (biais favori-outsider) :
// mesuré, il affichait un CLV de +1,5 % pour un rendement réel de −6,9 %,
// une contradiction qui disparaît avec la puissance. Celle-ci prédit aussi
// mieux les résultats (log-loss des clôtures 0,97000 contre 0,97038 sur
// 15 198 matchs).
//
// Pur : reçoit les cotes déjà agrégées par victor/odds.js.

import { libelleCode } from './paris.js';

export const SEUIL_VALEUR_MARCHE = Number(process.env.VALEUR_MARCHE_SEUIL || 0.02);
export const COTE_MAX_VALEUR = 10;        // au-delà, une cote isolée est plus souvent une erreur qu'une aubaine
export const MIN_BOOKMAKERS = 5;          // en dessous, la « moyenne » n'est pas un consensus
export const MAX_SIGNAUX = 5;

/**
 * Probabilités sans marge par la méthode de la puissance : p_i = (1/cote_i)^k,
 * avec k tel que la somme fasse 1.
 * @param {number[]} cotes  les cotes d'UN marché complet (2 ou 3 issues)
 * @returns {number[]|null}
 */
export function probasPuissance(cotes = []) {
  const inv = cotes.map(c => 1 / Number(c));
  if (inv.length < 2 || inv.some(x => !Number.isFinite(x) || x <= 0 || x >= 1)) return null;
  const somme = (k) => inv.reduce((a, x) => a + x ** k, 0);
  if (Math.abs(somme(1) - 1) < 1e-12) return inv.slice();
  let bas = 0.5, haut = 3;                 // somme(k) décroît avec k : dichotomie
  for (let i = 0; i < 100; i++) {
    const k = (bas + haut) / 2;
    if (somme(k) > 1) bas = k; else haut = k;
  }
  const k = (bas + haut) / 2;
  return inv.map(x => x ** k);
}

/**
 * Probabilités justes de chaque ligne cotée d'un match, à partir des cotes
 * MOYENNES (le consensus). Un marché incomplet est ignoré.
 * @param {Object<string, number>} marches  clés '1X2:HOME', 'OU:OVER:2.5'…
 * @returns {Object<string, number>}
 */
export function probasJustesMatch(marches = {}) {
  const out = {};
  const x = ['1X2:HOME', '1X2:DRAW', '1X2:AWAY'];
  const p1x2 = x.every(k => marches[k]) ? probasPuissance(x.map(k => marches[k])) : null;
  if (p1x2) x.forEach((k, i) => { out[k] = p1x2[i]; });

  for (const k of Object.keys(marches)) {
    const m = k.match(/^OU:OVER:(.+)$/);
    if (!m) continue;
    const under = `OU:UNDER:${m[1]}`;
    if (!marches[k] || !marches[under]) continue;
    const p = probasPuissance([marches[k], marches[under]]);
    if (p) { out[k] = p[0]; out[under] = p[1]; }
  }
  return out;
}

/**
 * Prix juste d'un pari donné, pour l'afficher à côté d'un pronostic :
 * en dessous de cette cote, le pari est perdant sur la durée face au marché.
 * @returns {{probaJuste:number, coteJuste:number}|null}
 */
export function prixJuste(cotesDuMatch, pariCode) {
  if (!cotesDuMatch?.marches || (cotesDuMatch.bookmakers ?? 0) < MIN_BOOKMAKERS) return null;
  const p = probasJustesMatch(cotesDuMatch.marches)[pariCode];
  return p > 0 ? { probaJuste: p, coteJuste: 1 / p } : null;
}

/**
 * Les lignes où un bookmaker paie plus que le prix juste du consensus.
 * @param {Array} fixtures  matchs à venir (fixtureId, home, away, heure, competition)
 * @param {Map} cotes       fixtureId → { marches, meilleures, bookmakers }
 * @returns {Array<{match, competition, heure, equipe_a, equipe_b, pari_code, libelle,
 *                  cote, bookmaker, probaJuste, coteJuste, avantage}>}
 */
export function detecterValeursMarche(fixtures = [], cotes = new Map(), {
  seuil = SEUIL_VALEUR_MARCHE, coteMax = COTE_MAX_VALEUR, max = MAX_SIGNAUX,
} = {}) {
  const signaux = [];
  for (const f of fixtures) {
    const c = f.fixtureId != null ? cotes.get(f.fixtureId) : null;
    if (!c?.marches || !c.meilleures || (c.bookmakers ?? 0) < MIN_BOOKMAKERS) continue;
    const justes = probasJustesMatch(c.marches);
    for (const [code, p] of Object.entries(justes)) {
      const meilleure = c.meilleures[code];
      if (!meilleure || !(p > 0) || meilleure.cote > coteMax) continue;
      const avantage = meilleure.cote * p - 1;
      if (avantage <= seuil) continue;
      signaux.push({
        match: `${f.home} vs ${f.away}`,
        competition: f.competition || '',
        heure: f.heure || '',
        equipe_a: f.home, equipe_b: f.away,
        pari_code: code,
        libelle: libelleCode(code, f.home, f.away) || code,
        cote: meilleure.cote,
        bookmaker: meilleure.bookmaker,
        probaJuste: p,
        coteJuste: 1 / p,
        avantage,
        bookmakers: c.bookmakers,
        // Pour noter le signal après le match (victor/valeur-suivi.js).
        debutUTC: f.debutUTC || null,
        sportKey: f.sportKey || null,
        codeCompet: f.codeCompet || null,
      });
    }
  }
  // Un seul signal par match : le plus fort. Deux lignes du même match
  // (ex. domicile et over) ne sont pas deux opportunités indépendantes.
  const parMatch = new Map();
  for (const s of signaux) {
    const prec = parMatch.get(s.match);
    if (!prec || s.avantage > prec.avantage) parMatch.set(s.match, s);
  }
  return [...parMatch.values()].sort((a, b) => b.avantage - a.avantage).slice(0, max);
}

export default { probasPuissance, probasJustesMatch, prixJuste, detecterValeursMarche,
  SEUIL_VALEUR_MARCHE, COTE_MAX_VALEUR, MIN_BOOKMAKERS, MAX_SIGNAUX };
