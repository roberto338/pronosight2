// ══════════════════════════════════════════════
// prono/engine/poisson.js — loi de Poisson et correction de Dixon-Coles
// ══════════════════════════════════════════════
//
// Le Poisson simple suppose que les deux scores sont indépendants. C'est
// faux, et de façon mesurable : sur les petits scores, il sous-estime les
// 0-0 et les 1-1 et surestime les 1-0 et 0-1. Dixon & Coles (1997) corrigent
// ces quatre cases par un facteur tau, gouverné par un seul paramètre rho.
//
// C'est ce détail qui sépare un modèle jouet d'un modèle utilisable : sans
// lui, la probabilité du nul est systématiquement trop basse, et toute
// « value » détectée sur le X est un artefact.

export const RHO_DEFAUT     = -0.08;
export const MAX_BUTS_DEFAUT = 8;

/** P(X = k) pour X ~ Poisson(lambda). Calculé en log pour rester stable. */
export function poissonPmf(k, lambda) {
  if (!Number.isInteger(k) || k < 0) return 0;
  if (!(lambda > 0)) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);   // -log(k!)
  return Math.exp(logP);
}

/**
 * Facteur correctif de Dixon-Coles sur les quatre scores bas.
 * Avec rho < 0 : 0-0 et 1-1 sont rehaussés, 1-0 et 0-1 abaissés.
 */
export function tau(x, y, lambdaDom, lambdaExt, rho = RHO_DEFAUT) {
  if (x === 0 && y === 0) return Math.max(0, 1 - lambdaDom * lambdaExt * rho);
  if (x === 0 && y === 1) return Math.max(0, 1 + lambdaDom * rho);
  if (x === 1 && y === 0) return Math.max(0, 1 + lambdaExt * rho);
  if (x === 1 && y === 1) return Math.max(0, 1 - rho);
  return 1;
}

/**
 * Matrice des probabilités de score exact, normalisée à somme 1.
 * matrice[x][y] = P(domicile marque x, extérieur marque y)
 *
 * Deux renormalisations en une : la troncature à maxButs et la correction
 * tau brisent toutes deux la somme à 1. On divise une seule fois, à la fin.
 */
export function matriceScores(lambdaDom, lambdaExt, options = {}) {
  const { rho = RHO_DEFAUT, maxButs = MAX_BUTS_DEFAUT } = options;

  const pDom = Array.from({ length: maxButs + 1 }, (_, x) => poissonPmf(x, lambdaDom));
  const pExt = Array.from({ length: maxButs + 1 }, (_, y) => poissonPmf(y, lambdaExt));

  const matrice = [];
  let total = 0;
  for (let x = 0; x <= maxButs; x++) {
    const ligne = new Array(maxButs + 1);
    for (let y = 0; y <= maxButs; y++) {
      const p = pDom[x] * pExt[y] * tau(x, y, lambdaDom, lambdaExt, rho);
      ligne[y] = p;
      total += p;
    }
    matrice.push(ligne);
  }

  if (!(total > 0)) throw new Error('matriceScores: masse totale nulle');
  for (let x = 0; x <= maxButs; x++) {
    for (let y = 0; y <= maxButs; y++) matrice[x][y] /= total;
  }
  return matrice;
}

export default { poissonPmf, tau, matriceScores, RHO_DEFAUT, MAX_BUTS_DEFAUT };
