// ══════════════════════════════════════════════
// prono/engine/index.js — point d'entrée du moteur
// ══════════════════════════════════════════════
//
// Ce module ne connaît ni Express, ni pg, ni fetch. Entrée : un objet de
// statistiques. Sortie : un objet d'analyse. Rien d'autre.
//
// Cette contrainte n'est pas de l'esthétique d'architecture. Elle a trois
// effets concrets : le modèle se teste sans base ni réseau (`npm test`),
// deux appels sur les mêmes données donnent le même résultat au chiffre
// près, et le jour où les sources de données changent, pas une ligne d'ici
// ne bouge.

import { calculerForces, calculerLambdas, DEMI_VIE_JOURS, K_SHRINKAGE } from './ratings.js';
import { matriceScores, RHO_DEFAUT, MAX_BUTS_DEFAUT } from './poisson.js';
import { marchesDepuisMatrice, cle, SEUILS_OU } from './markets.js';
import { simuler, ITERATIONS_DEFAUT } from './montecarlo.js';
import { devigoriser, edge as calculerEdge, kelly, coteJuste, estValue } from './odds.js';
import { scoreConfiance, MATCHS_MIN_STABILITE } from './confidence.js';

// Toute modification des paramètres par défaut (demi-vie, rho, shrinkage,
// méthode de dévigorisation) impose d'incrémenter cette version : sans quoi
// la calibration compare des analyses produites par des modèles différents
// et ne mesure plus rien.
export const MODEL_VERSION = '1.0.0';

export const AVERTISSEMENT =
  'Estimations statistiques à but informatif. Aucune garantie de gain. '
  + 'Le score de confiance mesure la fiabilité de l\'estimation, pas une probabilité de gagner. 18+';

/**
 * @param {Object} entree
 * @param {{nom:string, matchs:Array}} entree.equipeDom  matchs : {date, butsMarques, butsEncaisses}
 * @param {{nom:string, matchs:Array}} entree.equipeExt
 * @param {{moyButsDom:number, moyButsExt:number, nom?:string}} entree.ligue
 * @param {Object<string,number>} [entree.cotes]  clés "MARCHE:selection"
 */
export function analyserMatch(entree) {
  const {
    equipeDom, equipeExt, ligue, cotes = {},
    competition = null, coupEnvoi = null, options = {},
  } = entree ?? {};

  if (!equipeDom?.nom || !equipeExt?.nom) throw new Error('analyserMatch: équipes manquantes');
  if (!(ligue?.moyButsDom > 0) || !(ligue?.moyButsExt > 0)) {
    throw new Error('analyserMatch: moyennes de buts de la ligue manquantes ou invalides');
  }

  const {
    demiVieJours = DEMI_VIE_JOURS,
    k            = K_SHRINKAGE,
    rho          = RHO_DEFAUT,
    maxButs      = MAX_BUTS_DEFAUT,
    seuils       = SEUILS_OU,
    iterations   = ITERATIONS_DEFAUT,
    graine       = 42,
    aujourdhui   = new Date(),
  } = options;

  const matchsDom = equipeDom.matchs ?? [];
  const matchsExt = equipeExt.matchs ?? [];

  // La moyenne de référence d'une ligue est le nombre de buts marqués par
  // équipe et par match, domicile et extérieur confondus.
  const moyLigue   = (ligue.moyButsDom + ligue.moyButsExt) / 2;
  const ctxForces  = { demiVieJours, k, aujourdhui };
  const ligueCalc  = { ...ligue, moyLigue };

  // ── 1. Estimation ponctuelle ──
  const forcesDom = calculerForces(matchsDom, { ...ctxForces, moyLigue });
  const forcesExt = calculerForces(matchsExt, { ...ctxForces, moyLigue });
  const { lambdaDom, lambdaExt } = calculerLambdas(forcesDom, forcesExt, ligueCalc);

  const optionsMatrice = { rho, maxButs, seuils };
  const matrice = matriceScores(lambdaDom, lambdaExt, optionsMatrice);
  const { marches, parCle, scoresProbables } = marchesDepuisMatrice(matrice, optionsMatrice);

  // ── 2. Incertitude des paramètres ──
  const { intervalles } = simuler(
    { matchsDom, matchsExt, ligue: ligueCalc, ctxForces, optionsMatrice },
    { iterations, graine },
  );

  // ── 3. Marché ──
  const { probaMarche, overround } = devigoriser(cotes);

  // ── 4. Confiance ──
  // La sélection de référence est celle que le modèle juge la plus probable
  // au 1X2 : c'est sur elle que se lisent l'instabilité et l'écart au marché.
  const principale = marches
    .filter(m => m.marche === '1X2')
    .reduce((a, b) => (b.proba > a.proba ? b : a));
  const clePrincipale = cle(principale.marche, principale.selection);

  const pMarchePrincipale = probaMarche[clePrincipale];
  const champs = [matchsDom.length > 0, matchsExt.length > 0, Object.keys(cotes).length > 0];

  const confiance = scoreConfiance({
    nMatchsDom:  forcesDom.nMatchs,
    nMatchsExt:  forcesExt.nMatchs,
    largeurIC:   intervalles[clePrincipale]?.largeur ?? null,
    ecartMarche: Number.isFinite(pMarchePrincipale) ? principale.proba - pMarchePrincipale : null,
    champsAttendus:  champs.length,
    champsManquants: champs.filter(x => !x).length,
  });

  // ── 5. Assemblage ──
  // Sous MATCHS_MIN_STABILITE, le rééchantillonnage ne varie pas assez pour
  // mesurer quoi que ce soit : on ne publie aucun intervalle plutôt qu'un
  // intervalle de largeur nulle, qui se lirait comme une certitude.
  const nMin = Math.min(forcesDom.nMatchs, forcesExt.nMatchs);
  const intervalleFiable = nMin >= MATCHS_MIN_STABILITE;

  const detail = marches.map(m => {
    const k2   = cle(m.marche, m.selection);
    const cote = Number(cotes[k2]);
    const e    = Number.isFinite(cote) ? calculerEdge(m.proba, cote) : null;
    return {
      marche: m.marche,
      selection: m.selection,
      proba: m.proba,
      probaBasse: intervalleFiable ? (intervalles[k2]?.basse ?? null) : null,
      probaHaute: intervalleFiable ? (intervalles[k2]?.haute ?? null) : null,
      coteJuste: coteJuste(m.proba),
      coteOfferte: Number.isFinite(cote) ? cote : null,
      probaMarche: probaMarche[k2] ?? null,
      edge: e,
      kelly: Number.isFinite(cote) ? kelly(m.proba, cote) : null,
      estValue: estValue(e, confiance.score),
    };
  });

  return {
    modelVersion: MODEL_VERSION,
    equipeDom: equipeDom.nom,
    equipeExt: equipeExt.nom,
    competition,
    coupEnvoi,
    parametres: { demiVieJours, k, rho, maxButs, iterations, graine },
    forces: {
      dom: { ...forcesDom },
      ext: { ...forcesExt },
    },
    lambdaDom,
    lambdaExt,
    intervalleFiable,
    marches: detail,
    scoresProbables,
    overround,
    confiance,
    avertissement: AVERTISSEMENT,
  };
}

export default { analyserMatch, MODEL_VERSION, AVERTISSEMENT };
