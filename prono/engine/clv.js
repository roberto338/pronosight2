// ══════════════════════════════════════════════
// prono/engine/clv.js — Victor bat-il la cote de clôture ?
// ══════════════════════════════════════════════
//
// Le rendement de Victor (+6 % sur 58 paris) ne prouve rien : son intervalle
// à 95 % va de −20 % à +32 %, et il faudrait environ 900 paris pour conclure.
// Le résultat d'un match est un tirage très bruité ; la cote de clôture, elle,
// résume tout ce que le marché sait au coup d'envoi.
//
// Le CLV (closing line value) compare donc la cote publiée au prix JUSTE de
// clôture : prendre régulièrement un prix meilleur que celui-ci est la seule
// preuve d'avantage qui converge en quelques dizaines de paris, parce que sa
// dispersion est de quelques pour cent au lieu de cent.
//
// Deux mesures, à ne pas confondre :
//
//   valeur     = cote publiée × probabilité juste de clôture − 1
//                L'espérance réelle d'une mise prise à la cote publiée.
//                C'est elle qui dit si un abonné gagne de l'argent.
//
//   mouvement  = cote publiée / cote moyenne de clôture − 1
//                Positif quand la cote a BAISSÉ après publication : le
//                marché est allé dans le sens de Victor. Les deux cotes
//                portent la marge des bookmakers, qui s'annule à peu près.
//
// La cote publiée est une MOYENNE de bookmakers (victor/odds.js) : elle
// porte leur marge, quelques pour cent. La valeur part donc avec ce handicap
// — c'est honnête, c'est le prix que l'abonné a vu.
//
// Pur : aucune base, aucun réseau.

import { devigoriser } from './odds.js';

// Références de clôture, de la plus juste à la moins juste. Betfair Exchange
// est une bourse (marge quasi nulle, prix fixé par les parieurs eux-mêmes) ;
// Pinnacle a disparu des fichiers 2026-27 de football-data.co.uk ; la
// moyenne du marché sert de dernier recours.
export const REFERENCES = [
  { nom: 'Betfair Exchange', h: 'BFECH', d: 'BFECD', a: 'BFECA', over: 'BFEC>2.5', under: 'BFEC<2.5' },
  { nom: 'Pinnacle',         h: 'PSCH',  d: 'PSCD',  a: 'PSCA',  over: 'PC>2.5',   under: 'PC<2.5' },
  { nom: 'moyenne marché',   h: 'AvgCH', d: 'AvgCD', a: 'AvgCA', over: 'AvgC>2.5', under: 'AvgC<2.5' },
];
const MOYENNE = REFERENCES[2];

const nombre = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 1.01 ? n : null;
};

/** Famille d'un code de pari, ou null si le CLV ne sait pas le mesurer. */
export function familleMarche(code = '') {
  if (/^1X2:(HOME|DRAW|AWAY)$/.test(code)) return '1X2';
  if (/^DC:(1X|X2|12)$/.test(code)) return 'DC';
  if (/^OU:(OVER|UNDER):2\.5$/.test(code)) return 'OU2.5';
  return null;
}

// Probabilités (et cotes) d'un marché selon une référence donnée.
function lireMarche(ligne, ref, famille) {
  if (famille === 'OU2.5') {
    const o = nombre(ligne[ref.over]), u = nombre(ligne[ref.under]);
    if (!o || !u) return null;
    const { probaMarche } = devigoriser({ 'OU:OVER': o, 'OU:UNDER': u });
    return { p: { 'OU:OVER:2.5': probaMarche['OU:OVER'], 'OU:UNDER:2.5': probaMarche['OU:UNDER'] },
             c: { 'OU:OVER:2.5': o, 'OU:UNDER:2.5': u } };
  }
  const h = nombre(ligne[ref.h]), d = nombre(ligne[ref.d]), a = nombre(ligne[ref.a]);
  if (!h || !d || !a) return null;
  const { probaMarche: pm } = devigoriser({ '1X2:HOME': h, '1X2:DRAW': d, '1X2:AWAY': a });
  const p = { ...pm,
    'DC:1X': pm['1X2:HOME'] + pm['1X2:DRAW'],
    'DC:X2': pm['1X2:DRAW'] + pm['1X2:AWAY'],
    'DC:12': pm['1X2:HOME'] + pm['1X2:AWAY'] };
  // Cote « marge incluse » d'une double chance : celle qu'un bookmaker
  // afficherait en combinant ses deux cotes simples.
  const comb = (x, y) => 1 / (1 / x + 1 / y);
  const c = { '1X2:HOME': h, '1X2:DRAW': d, '1X2:AWAY': a,
    'DC:1X': comb(h, d), 'DC:X2': comb(d, a), 'DC:12': comb(h, a) };
  return { p, c };
}

/**
 * Prix de clôture d'un pari dans une ligne football-data.co.uk.
 * @returns {{probaJuste:number, reference:string, coteMoyenne:number|null}|{erreur:string}}
 */
export function prixCloture(ligne = {}, code = '') {
  const famille = familleMarche(code);
  if (!famille) return { erreur: 'marché non couvert' };
  for (const ref of REFERENCES) {
    const m = lireMarche(ligne, ref, famille);
    if (m && Number.isFinite(m.p[code])) {
      const moy = lireMarche(ligne, MOYENNE, famille);
      return { probaJuste: m.p[code], reference: ref.nom, coteMoyenne: moy ? moy.c[code] : null };
    }
  }
  return { erreur: 'cote de clôture absente' };
}

/**
 * CLV d'un pari publié.
 * @returns {{valeur:number, mouvement:number|null, reference:string}|{erreur:string}}
 */
export function clvPari(cotePubliee, ligne, code) {
  const c = Number(cotePubliee);
  if (!Number.isFinite(c) || c < 1.01) return { erreur: 'cote publiée invalide' };
  const prix = prixCloture(ligne, code);
  if (prix.erreur) return prix;
  return {
    valeur: c * prix.probaJuste - 1,
    mouvement: prix.coteMoyenne ? c / prix.coteMoyenne - 1 : null,
    reference: prix.reference,
    probaJuste: prix.probaJuste,
  };
}

/** Intervalle à 95 % de la moyenne, par rééchantillonnage avec remise. */
export function bootstrapMoyenne(valeurs, { iterations = 2000, rnd } = {}) {
  const v = valeurs.filter(Number.isFinite);
  if (v.length < 2 || typeof rnd !== 'function') return null;
  const tirages = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[Math.floor(rnd() * v.length)];
    tirages[i] = s / v.length;
  }
  tirages.sort((a, b) => a - b);
  const q = (p) => tirages[Math.min(iterations - 1, Math.max(0, Math.round(p * (iterations - 1))))];
  return { basse: q(0.025), haute: q(0.975) };
}

export const N_MIN_VERDICT = 30;

/**
 * Synthèse d'un ensemble de CLV.
 * Le verdict n'est rendu qu'au-delà de 30 paris, et seulement si
 * l'intervalle exclut zéro : sinon, « non concluant », sans arrondi flatteur.
 */
export function resumerClv(clvs = [], { rnd } = {}) {
  const valeurs = clvs.map(c => c.valeur).filter(Number.isFinite);
  const mouvements = clvs.map(c => c.mouvement).filter(Number.isFinite);
  const moy = (t) => (t.length ? t.reduce((a, b) => a + b, 0) / t.length : null);
  const n = valeurs.length;
  const ic = bootstrapMoyenne(valeurs, { rnd });
  const icMouv = bootstrapMoyenne(mouvements, { rnd });

  let verdict;
  if (n < N_MIN_VERDICT || !ic) verdict = 'insuffisant';
  else if (ic.basse > 0) verdict = 'bat le marché';
  else if (ic.haute < 0) verdict = 'ne bat pas le marché';
  else verdict = 'non concluant';

  return {
    n,
    valeurMoyenne: moy(valeurs),
    partPositive: n ? valeurs.filter(v => v > 0).length / n : null,
    ic,
    mouvementMoyen: moy(mouvements),
    icMouvement: icMouv,
    nMouvement: mouvements.length,
    verdict,
  };
}

export default { REFERENCES, familleMarche, prixCloture, clvPari, bootstrapMoyenne, resumerClv, N_MIN_VERDICT };
