// ══════════════════════════════════════════════
// prono/engine/marche.js — le modèle face au marché
// ══════════════════════════════════════════════
//
// Battre le taux de base ne prouve rien d'utile : n'importe quel bookmaker
// le bat. Pour qu'un modèle serve à parier, il doit battre LE MARCHÉ, et
// deux questions le tranchent :
//
//   1. Ses probabilités sont-elles meilleures que celles des cotes ?
//      Log-loss du modèle contre log-loss des cotes dévigorisées, d'avant-
//      match et de clôture, sur les mêmes rencontres.
//
//   2. Quand il voit une value face aux cotes d'avant-match, le marché lui
//      donne-t-il raison ensuite ? C'est le CLV de ses paris : la cote prise
//      face au prix juste de clôture. Un modèle sans avantage « trouve »
//      quand même des value — ce sont ses erreurs — et la clôture les
//      contredit.
//
// Pur : aucune base, aucun réseau.

import { devigoriser } from './odds.js';
import { bootstrapMoyenne } from './clv.js';

// Colonnes football-data.co.uk.
export const AVANT_MATCH = {
  meilleure: { h: 'MaxH', d: 'MaxD', a: 'MaxA', over: 'Max>2.5', under: 'Max<2.5' },
  moyenne:   { h: 'AvgH', d: 'AvgD', a: 'AvgA', over: 'Avg>2.5', under: 'Avg<2.5' },
};
// Clôture, de la plus juste à la moins juste : Pinnacle (jusqu'en 2025-26),
// Betfair Exchange, puis la moyenne du marché.
export const CLOTURES = [
  { nom: 'Pinnacle',         h: 'PSCH',  d: 'PSCD',  a: 'PSCA',  over: 'PC>2.5',   under: 'PC<2.5' },
  { nom: 'Betfair Exchange', h: 'BFECH', d: 'BFECD', a: 'BFECA', over: 'BFEC>2.5', under: 'BFEC<2.5' },
  { nom: 'moyenne marché',   h: 'AvgCH', d: 'AvgCD', a: 'AvgCA', over: 'AvgC>2.5', under: 'AvgC<2.5' },
];

const cote = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 1.01 ? n : null;
};

/** Cotes brutes d'un jeu de colonnes : { '1','X','2','over','under' } (null si absente). */
export function cotesDe(ligne = {}, cols) {
  return { '1': cote(ligne[cols.h]), 'X': cote(ligne[cols.d]), '2': cote(ligne[cols.a]),
           over: cote(ligne[cols.over]), under: cote(ligne[cols.under]) };
}

/** Probabilités sans marge : { '1','X','2' } et { over, under }, chacun null si incomplet. */
export function probasJustes(ligne = {}, cols) {
  const c = cotesDe(ligne, cols);
  let x12 = null, ou = null;
  if (c['1'] && c['X'] && c['2']) {
    const { probaMarche: p } = devigoriser({ '1X2:1': c['1'], '1X2:X': c['X'], '1X2:2': c['2'] });
    x12 = { '1': p['1X2:1'], 'X': p['1X2:X'], '2': p['1X2:2'] };
  }
  if (c.over && c.under) {
    const { probaMarche: p } = devigoriser({ 'OU:o': c.over, 'OU:u': c.under });
    ou = { over: p['OU:o'], under: p['OU:u'] };
  }
  return { x12, ou };
}

/** Clôture la plus juste disponible pour une ligne, marché par marché. */
export function clotureJuste(ligne = {}) {
  let x12 = null, ou = null, refX12 = null, refOu = null;
  for (const ref of CLOTURES) {
    const p = probasJustes(ligne, ref);
    if (!x12 && p.x12) { x12 = p.x12; refX12 = ref.nom; }
    if (!ou && p.ou) { ou = p.ou; refOu = ref.nom; }
  }
  return { x12, ou, refX12, refOu };
}

const PLANCHER = 1e-6;
const ll = (p) => -Math.log(Math.max(p, PLANCHER));

/**
 * Log-loss 1X2 du modèle, des cotes d'avant-match et de clôture, sur les
 * SEULES rencontres où les trois existent — sinon la comparaison triche.
 */
export function comparerLogLoss(notees = []) {
  let n = 0, modele = 0, avant = 0, cloture = 0;
  for (const r of notees) {
    const ligne = r.extra?.ligne;
    const pa = probasJustes(ligne, AVANT_MATCH.moyenne).x12;
    const pc = clotureJuste(ligne).x12;
    if (!pa || !pc || !r.probas?.[r.issue]) continue;
    n++;
    modele += ll(r.probas[r.issue]);
    avant += ll(pa[r.issue]);
    cloture += ll(pc[r.issue]);
  }
  return n ? { n, modele: modele / n, avantMatch: avant / n, cloture: cloture / n } : { n: 0 };
}

/**
 * Paris qu'aurait pris le modèle : chaque issue dont l'espérance face à la
 * meilleure cote d'avant-match dépasse `seuilEdge`.
 * @returns {Array<{marche, issue, cote, pModele, gagne, gain, clv}>}
 */
export function parisDuModele(notees = [], { seuilEdge = 0.05, coteMax = 10 } = {}) {
  const paris = [];
  for (const r of notees) {
    const ligne = r.extra?.ligne;
    if (!ligne) continue;
    const c = cotesDe(ligne, AVANT_MATCH.meilleure);
    const clo = clotureJuste(ligne);
    const candidats = [
      ['1X2', '1', r.probas?.['1'], c['1'], clo.x12?.['1'], r.issue === '1'],
      ['1X2', 'X', r.probas?.['X'], c['X'], clo.x12?.['X'], r.issue === 'X'],
      ['1X2', '2', r.probas?.['2'], c['2'], clo.x12?.['2'], r.issue === '2'],
      ['OU2.5', 'over', r.over?.proba, c.over, clo.ou?.over, r.over?.reel === true],
      ['OU2.5', 'under', r.over?.proba == null ? null : 1 - r.over.proba, c.under, clo.ou?.under, r.over?.reel === false],
    ];
    for (const [marche, issue, p, k, pClo, gagne] of candidats) {
      if (!(p > 0) || !k || k > coteMax) continue;
      if (p * k - 1 <= seuilEdge) continue;
      paris.push({
        marche, issue, cote: k, pModele: p, gagne,
        gain: gagne ? k - 1 : -1,
        clv: pClo ? k * pClo - 1 : null,
        date: r.date, competition: r.competition,
      });
    }
  }
  return paris;
}

/** Rendement et CLV d'un ensemble de paris, avec intervalles à 95 %. */
export function bilanParis(paris = [], { rnd } = {}) {
  const gains = paris.map(p => p.gain);
  const clvs = paris.map(p => p.clv).filter(Number.isFinite);
  const moy = (t) => (t.length ? t.reduce((a, b) => a + b, 0) / t.length : null);
  const icClv = bootstrapMoyenne(clvs, { rnd });
  let verdict = 'insuffisant';
  if (clvs.length >= 100 && icClv) {
    verdict = icClv.basse > 0 ? 'bat la clôture' : icClv.haute < 0 ? 'ne bat pas la clôture' : 'non concluant';
  }
  return {
    n: paris.length,
    roi: moy(gains),
    icRoi: bootstrapMoyenne(gains, { rnd }),
    nClv: clvs.length,
    clv: moy(clvs),
    icClv,
    verdict,
  };
}

export default { AVANT_MATCH, CLOTURES, cotesDe, probasJustes, clotureJuste, comparerLogLoss, parisDuModele, bilanParis };
