// ══════════════════════════════════════════════
// prono/engine/ratings.js — forces d'attaque et de défense
// ══════════════════════════════════════════════
//
// Une force vaut 1 quand l'équipe est exactement dans la moyenne de sa
// ligue : 1,20 en attaque = elle marque 20 % de plus que la moyenne.
//
// Deux précautions, sans lesquelles le modèle produit des chiffres absurdes :
//
// 1. PONDÉRATION PAR ANCIENNETÉ — un 4-0 d'il y a cinq mois ne dit plus
//    grand-chose de l'équipe d'aujourd'hui. Chaque rencontre pèse
//    exp(-ln2 × âge / demi-vie) : à 90 jours elle compte pour moitié.
//
// 2. RÉTRÉCISSEMENT (shrinkage) — une équipe à trois matchs dont un 5-0
//    afficherait une attaque à 2,3 et des probabilités délirantes. On tire
//    la force vers 1 à hauteur de k rencontres fictives de moyenne exacte.
//    Sans données du tout, la force vaut 1 : le modèle dit « je ne sais
//    rien », au lieu d'inventer.

export const DEMI_VIE_JOURS = 90;
export const K_SHRINKAGE    = 5;

/** Poids d'une rencontre vieille de `ageJours` jours. */
export function poidsAnciennete(ageJours, demiVieJours = DEMI_VIE_JOURS) {
  if (!Number.isFinite(ageJours) || ageJours < 0) return 0;
  return Math.exp(-Math.LN2 * ageJours / demiVieJours);
}

/** Nombre de jours entre deux dates ISO (ou objets Date). */
export function ageEnJours(date, reference) {
  const d = date instanceof Date ? date : new Date(date);
  const r = reference instanceof Date ? reference : new Date(reference);
  if (Number.isNaN(d.getTime()) || Number.isNaN(r.getTime())) return NaN;
  return (r.getTime() - d.getTime()) / 864e5;
}

/**
 * Forces d'une équipe à partir de son historique.
 * @param {Array<{date:string, butsMarques:number, butsEncaisses:number}>} matchs
 * @param {{moyLigue:number, demiVieJours?:number, k?:number, aujourdhui?:string}} ctx
 * @returns {{attaque:number, defense:number, nMatchs:number, poidsTotal:number}}
 */
export function calculerForces(matchs = [], ctx = {}) {
  const {
    moyLigue = 1.35,
    demiVieJours = DEMI_VIE_JOURS,
    k = K_SHRINKAGE,
    aujourdhui = new Date(),
  } = ctx;

  if (!(moyLigue > 0)) throw new Error('calculerForces: moyLigue doit être > 0');

  let poidsTotal = 0, sommeMarques = 0, sommeEncaisses = 0, nMatchs = 0;

  for (const m of matchs) {
    // null et undefined DOIVENT être écartés avant toute conversion :
    // Number(null) vaut 0, qui est fini et positif. Une donnée absente
    // entrerait donc dans le calcul comme un match sans but marqué, et
    // ferait chuter l'attaque d'une équipe sans le moindre signal.
    if (m?.butsMarques == null || m?.butsEncaisses == null) continue;
    const bp = Number(m.butsMarques), bc = Number(m.butsEncaisses);
    if (!Number.isFinite(bp) || !Number.isFinite(bc) || bp < 0 || bc < 0) continue;

    const age = ageEnJours(m.date, aujourdhui);
    // Une rencontre postérieure à la date de référence est une anomalie de
    // données (fuseau, match reporté mal daté) : on la compte à poids plein
    // plutôt que de la jeter, mais jamais avec un poids > 1.
    const poids = Number.isNaN(age) ? 1 : poidsAnciennete(Math.max(age, 0), demiVieJours);
    if (poids <= 0) continue;

    poidsTotal     += poids;
    sommeMarques   += poids * bp;
    sommeEncaisses += poids * bc;
    nMatchs++;
  }

  // (Σw·buts + k·moyLigue) / ((Σw + k) · moyLigue) — vaut exactement 1 sans données.
  const denominateur = (poidsTotal + k) * moyLigue;
  return {
    attaque:  (sommeMarques   + k * moyLigue) / denominateur,
    defense:  (sommeEncaisses + k * moyLigue) / denominateur,
    nMatchs,
    poidsTotal,
  };
}

/**
 * Buts attendus de chaque camp.
 *
 * L'avantage du terrain n'est PAS un coefficient arbitraire : il est déjà
 * contenu dans l'écart entre la moyenne à domicile et la moyenne à
 * l'extérieur de la ligue (typiquement 1,55 contre 1,20).
 */
export function calculerLambdas(forcesDom, forcesExt, ligue) {
  const { moyButsDom, moyButsExt } = ligue;
  if (!(moyButsDom > 0) || !(moyButsExt > 0)) {
    throw new Error('calculerLambdas: moyennes de ligue invalides');
  }
  // Bornes de sûreté : au-delà, on est face à des données corrompues, pas à
  // une équipe exceptionnelle. 6 buts attendus n'existe pas en football.
  const borne = (x) => Math.min(Math.max(x, 0.05), 6);
  return {
    lambdaDom: borne(moyButsDom * forcesDom.attaque * forcesExt.defense),
    lambdaExt: borne(moyButsExt * forcesExt.attaque * forcesDom.defense),
  };
}

export default { poidsAnciennete, ageEnJours, calculerForces, calculerLambdas, DEMI_VIE_JOURS, K_SHRINKAGE };
