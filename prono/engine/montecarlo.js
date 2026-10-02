// ══════════════════════════════════════════════
// prono/engine/montecarlo.js — l'incertitude, pas la probabilité
// ══════════════════════════════════════════════
//
// Simuler 100 000 matchs pour obtenir le 1X2 serait du gaspillage : la
// matrice de scores donne déjà la réponse EXACTE. Beaucoup d'outils font
// pourtant exactement ça, et présentent le bruit de leur simulation comme
// une profondeur d'analyse.
//
// L'incertitude qui compte n'est pas là. Elle est dans les PARAMÈTRES : les
// forces d'attaque et de défense sont estimées sur une poignée de matchs,
// donc elles-mêmes incertaines. On rééchantillonne l'historique avec remise
// (bootstrap), on recalcule tout à chaque tirage, et on observe à quel point
// les probabilités bougent.
//
// Le résultat n'est plus « 47 % » mais « 47 %, entre 39 % et 55 % ».
// C'est exactement ce qu'un outil honnête doit afficher : quand l'intervalle
// est large, le modèle l'avoue au lieu de laisser croire à une précision
// qu'il n'a pas.

import { calculerForces, calculerLambdas } from './ratings.js';
import { matriceScores } from './poisson.js';
import { marchesDepuisMatrice } from './markets.js';

export const ITERATIONS_DEFAUT = 500;

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 * Math.random rendrait les tests non reproductibles et deux analyses du même
 * match non comparables. Une graine fixe garantit qu'un même historique
 * produit toujours le même intervalle.
 */
export function mulberry32(graine) {
  let a = graine >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tirage avec remise de même taille que l'échantillon d'origine. */
export function echantillonner(matchs, rnd) {
  const n = matchs.length;
  if (n === 0) return [];
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = matchs[Math.floor(rnd() * n)];
  return out;
}

/** Quantile d'un tableau trié (interpolation non nécessaire à cette précision). */
export function quantile(trie, q) {
  if (trie.length === 0) return null;
  const i = Math.min(trie.length - 1, Math.max(0, Math.round(q * (trie.length - 1))));
  return trie[i];
}

/**
 * Intervalles de confiance par sélection.
 * @returns {{intervalles:Object, iterations:number}}
 */
export function simuler(entree, options = {}) {
  const {
    iterations = ITERATIONS_DEFAUT,
    graine = 42,
    quantileBas = 0.05,
    quantileHaut = 0.95,
  } = options;

  const { matchsDom, matchsExt, ligue, ctxForces = {}, optionsMatrice = {} } = entree;
  const rnd = mulberry32(graine);
  const tirages = new Map();   // clé de sélection → tableau de probabilités

  for (let i = 0; i < iterations; i++) {
    const forcesDom = calculerForces(echantillonner(matchsDom, rnd), { ...ctxForces, moyLigue: ligue.moyLigue });
    const forcesExt = calculerForces(echantillonner(matchsExt, rnd), { ...ctxForces, moyLigue: ligue.moyLigue });
    const { lambdaDom, lambdaExt } = calculerLambdas(forcesDom, forcesExt, ligue);
    const { parCle } = marchesDepuisMatrice(matriceScores(lambdaDom, lambdaExt, optionsMatrice), optionsMatrice);

    for (const [k, p] of Object.entries(parCle)) {
      if (!tirages.has(k)) tirages.set(k, []);
      tirages.get(k).push(p);
    }
  }

  const intervalles = {};
  for (const [k, valeurs] of tirages) {
    valeurs.sort((a, b) => a - b);
    intervalles[k] = {
      basse:   quantile(valeurs, quantileBas),
      haute:   quantile(valeurs, quantileHaut),
      largeur: quantile(valeurs, quantileHaut) - quantile(valeurs, quantileBas),
    };
  }

  return { intervalles, iterations };
}

export default { simuler, mulberry32, echantillonner, quantile, ITERATIONS_DEFAUT };
