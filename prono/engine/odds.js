// ══════════════════════════════════════════════
// prono/engine/odds.js — marché, marge et value
// ══════════════════════════════════════════════
//
// victor/odds.js:98 documente honnêtement son propre défaut :
//
//     /** Probabilité implicite du marché, marge bookmaker incluse. */
//     export function probaImplicite(cote) { return 1 / cote; }
//
// « marge incluse » veut dire que la somme des probabilités implicites d'un
// 1X2 vaut 1,05 à 1,08, jamais 1. Comparer une probabilité de modèle à ce
// chiffre gonflé fausse toute détection de value, systématiquement dans le
// même sens : le marché paraît plus confiant qu'il ne l'est, donc les value
// réelles sont manquées et de fausses value apparaissent ailleurs.
//
// On retire donc la marge avant toute comparaison. La méthode utilisée est
// proportionnelle : simple, sans paramètre, et suffisante à 1X2. Elle sous-
// estime légèrement les gros outsiders (biais favori-outsider bien documenté) ;
// la méthode de Shin corrigerait cela, au prix d'une résolution numérique.
// À revoir quand la calibration montrera que ce biais coûte quelque chose —
// pas avant, et sur preuve chiffrée.

export const SEUIL_EDGE      = 0.04;   // 4 % — en deçà, le bruit domine
export const SEUIL_CONFIANCE = 60;     // sous ce seuil, aucune value n'est déclarée

/** Cote sans marge correspondant à une probabilité. */
export function coteJuste(proba) {
  if (!(proba > 0)) return null;
  return 1 / proba;
}

/**
 * Retire la marge du bookmaker, marché par marché.
 * @param {Object<string, number>} cotes  clés "MARCHE:selection"
 * @returns {{probaMarche:Object, overround:Object}}
 */
export function devigoriser(cotes = {}) {
  const parMarche = new Map();
  for (const [k, cote] of Object.entries(cotes)) {
    const c = Number(cote);
    if (!Number.isFinite(c) || c < 1.01) continue;
    const marche = k.slice(0, k.indexOf(':'));
    if (!parMarche.has(marche)) parMarche.set(marche, []);
    parMarche.get(marche).push([k, 1 / c]);
  }

  const probaMarche = {}, overround = {};
  for (const [marche, entrees] of parMarche) {
    const somme = entrees.reduce((s, [, p]) => s + p, 0);
    // Un marché incomplet (une seule cote sur trois) ne permet pas de mesurer
    // la marge : on refuse de dévigoriser plutôt que de diviser par un total
    // qui n'en est pas un. Mieux vaut pas de comparaison qu'une fausse.
    const complet = (marche === '1X2' && entrees.length === 3) || entrees.length === 2;
    overround[marche] = complet ? somme - 1 : null;
    for (const [k, p] of entrees) probaMarche[k] = complet ? p / somme : null;
  }
  return { probaMarche, overround };
}

/** Espérance par unité misée : p × cote − 1. Positive = value théorique. */
export function edge(proba, cote) {
  const p = Number(proba), c = Number(cote);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || p > 1 || c < 1.01) return null;
  return p * c - 1;
}

/**
 * Fraction de Kelly. Rendue pour information : à pleine fraction, la
 * volatilité est telle qu'une erreur d'estimation de quelques points ruine
 * la bankroll. Un quart de Kelly est l'usage prudent, et l'interface ne doit
 * jamais présenter ce chiffre comme une recommandation de mise.
 */
export function kelly(proba, cote) {
  const b = Number(cote) - 1;
  const p = Number(proba);
  if (!(b > 0) || !(p > 0) || p > 1) return null;
  return Math.max(0, (p * b - (1 - p)) / b);
}

/**
 * Une value exige DEUX conditions. Un edge élevé sur données minces n'est pas
 * une opportunité, c'est une erreur de mesure — et un écart énorme avec le
 * marché signale le plus souvent une information que le modèle n'a pas
 * (blessure, turnover, match sans enjeu) plutôt qu'une inefficience.
 */
export function estValue(edgeCalcule, scoreConfiance, options = {}) {
  const { seuilEdge = SEUIL_EDGE, seuilConfiance = SEUIL_CONFIANCE } = options;
  return Number.isFinite(edgeCalcule) && edgeCalcule > seuilEdge
      && Number.isFinite(scoreConfiance) && scoreConfiance >= seuilConfiance;
}

export default { coteJuste, devigoriser, edge, kelly, estValue, SEUIL_EDGE, SEUIL_CONFIANCE };
