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

import { devigoriser, probasPuissance } from './odds.js';
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

/**
 * Probabilités sans marge : { '1','X','2' } et { over, under }, chacun null si incomplet.
 * @param {'proportionnelle'|'puissance'} methode  voir probasPuissance
 */
export function probasJustes(ligne = {}, cols, methode = 'proportionnelle') {
  const c = cotesDe(ligne, cols);
  let x12 = null, ou = null;
  if (methode === 'puissance') {
    if (c['1'] && c['X'] && c['2']) {
      const p = probasPuissance([c['1'], c['X'], c['2']]);
      if (p) x12 = { '1': p[0], 'X': p[1], '2': p[2] };
    }
    if (c.over && c.under) {
      const p = probasPuissance([c.over, c.under]);
      if (p) ou = { over: p[0], under: p[1] };
    }
    return { x12, ou };
  }
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
export function clotureJuste(ligne = {}, methode = 'proportionnelle') {
  let x12 = null, ou = null, refX12 = null, refOu = null;
  for (const ref of CLOTURES) {
    const p = probasJustes(ligne, ref, methode);
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
 * Le modèle apporte-t-il une information que le marché n'a pas ?
 *
 * On mélange : p = w × modèle + (1 − w) × cotes d'avant-match. Si un poids
 * w > 0 fait baisser la log-loss sous celle du marché seul, le modèle
 * contient quelque chose que les cotes ignorent — même s'il est moins bon
 * qu'elles pris isolément. Si aucun poids n'aide, il n'a rien à ajouter.
 * Le poids est jugé sur les rencontres paires et vérifié sur les impaires :
 * le choisir et le mesurer sur les mêmes données flatterait le résultat.
 */
export function apportAuMarche(notees = [], poids = [0, 0.05, 0.1, 0.2, 0.3]) {
  const lignes = [];
  for (const r of notees) {
    const pa = probasJustes(r.extra?.ligne, AVANT_MATCH.moyenne).x12;
    if (!pa || !(r.probas?.[r.issue] > 0)) continue;
    lignes.push({ pm: r.probas[r.issue], pa: pa[r.issue] });
  }
  const mesurer = (sous, w) => sous.reduce((a, l) => a + ll(w * l.pm + (1 - w) * l.pa), 0) / (sous.length || 1);
  const pairs = lignes.filter((_, i) => i % 2 === 0), impairs = lignes.filter((_, i) => i % 2 === 1);
  const parPoids = poids.map(w => ({ w, apprentissage: mesurer(pairs, w), validation: mesurer(impairs, w) }));
  const marcheSeul = parPoids.find(p => p.w === 0);
  // Un gain de l'ordre de l'arrondi n'est pas une information.
  const meilleur = parPoids.reduce((a, b) => (b.apprentissage < a.apprentissage - 1e-6 ? b : a), marcheSeul || parPoids[0]);
  return {
    n: lignes.length, parPoids, poidsRetenu: meilleur.w,
    gainValidation: marcheSeul ? (marcheSeul.validation - meilleur.validation) / marcheSeul.validation : null,
  };
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

/**
 * Value DE MARCHÉ, sans aucun modèle : un bookmaker propose-t-il plus que
 * le prix juste du consensus ?
 *
 * Le consensus est la moyenne de tous les bookmakers, marge retirée. Quand
 * la meilleure cote dépasse la cote juste de ce consensus de plus de
 * `seuilEdge`, ce bookmaker est en retard sur les autres. Victor peut faire
 * exactement ce calcul en direct avec The Odds API (moyenne et meilleure
 * cote par issue) : c'est donc une stratégie testable ET exploitable.
 *
 * @param {Array} rencontres  lignes au format rejouer(), avec extra.ligne
 */
export function parisValeurMarche(rencontres = [], { seuilEdge = 0.02, coteMax = 10, methode = 'proportionnelle' } = {}) {
  const paris = [];
  for (const m of rencontres) {
    const ligne = m.extra?.ligne;
    if (!ligne) continue;
    const juste = probasJustes(ligne, AVANT_MATCH.moyenne, methode);
    const best = cotesDe(ligne, AVANT_MATCH.meilleure);
    const clo = clotureJuste(ligne, methode);
    const bd = Number(m.buts_dom), be = Number(m.buts_ext);
    const issue = bd > be ? '1' : bd < be ? '2' : 'X';
    const over = bd + be >= 3;
    const candidats = [
      ['1X2', '1', juste.x12?.['1'], best['1'], clo.x12?.['1'], issue === '1'],
      ['1X2', 'X', juste.x12?.['X'], best['X'], clo.x12?.['X'], issue === 'X'],
      ['1X2', '2', juste.x12?.['2'], best['2'], clo.x12?.['2'], issue === '2'],
      ['OU2.5', 'over', juste.ou?.over, best.over, clo.ou?.over, over],
      ['OU2.5', 'under', juste.ou?.under, best.under, clo.ou?.under, !over],
    ];
    for (const [marche, iss, p, k, pClo, gagne] of candidats) {
      if (!(p > 0) || !k || k > coteMax) continue;
      if (p * k - 1 <= seuilEdge) continue;
      paris.push({
        marche, issue: iss, cote: k, pModele: p, gagne,
        gain: gagne ? k - 1 : -1,
        clv: pClo ? k * pClo - 1 : null,
        date: String(m.joue_le).slice(0, 10), competition: m.competition,
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

export default { AVANT_MATCH, CLOTURES, cotesDe, probasJustes, clotureJuste, comparerLogLoss, apportAuMarche, parisDuModele, parisValeurMarche, bilanParis };
