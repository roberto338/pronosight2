// ══════════════════════════════════════════════
// prono/engine/confidence.js — fiabilité de l'estimation
// ══════════════════════════════════════════════
//
// CE QUE CE SCORE N'EST PAS : une probabilité de gagner son pari.
//
// La confusion est le péché originel de ce marché — « confiance 85 % » y
// signifie presque toujours « je pense très fort que ça va passer », ce qui
// ne veut rien dire. Ici, 85 signifie : les données sont abondantes, le
// modèle est stable quand on rééchantillonne, et il ne contredit pas
// frontalement le marché. La probabilité, elle, est ailleurs, et elle peut
// parfaitement valoir 31 % avec une confiance de 90.
//
// Le libellé « fiabilité de l'estimation » est contractuel côté interface
// (voir COMMENT ON COLUMN pa_analyses.score_confiance dans la migration 014).
//
// Quatre composantes. Quand l'une est indisponible — typiquement la
// cohérence avec le marché faute de cotes — son poids est redistribué sur
// les autres plutôt que comptée comme neutre : un score de 50 inventé serait
// une information fausse, l'absence doit rester visible.

export const POIDS = { volume: 0.30, stabilite: 0.30, completude: 0.20, coherence: 0.20 };

export const MATCHS_SUFFISANTS = 10;   // en deçà, le Poisson n'a pas de quoi travailler
export const MATCHS_MIN_STABILITE = 3; // en deçà, l'intervalle ne mesure rien (voir plus bas)
export const LARGEUR_IC_MAX    = 0.30; // 30 points d'amplitude = modèle inexploitable
export const ECART_MARCHE_MAX  = 0.15; // 15 points d'écart = signal manquant probable

const borner = (x) => Math.min(1, Math.max(0, x));

/**
 * @param {{nMatchsDom:number, nMatchsExt:number, largeurIC:number|null,
 *          ecartMarche:number|null, champsManquants?:number, champsAttendus?:number}} e
 * @returns {{score:number, composantes:Object, alertes:string[]}}
 */
export function scoreConfiance(e) {
  const alertes = [];
  const composantes = {};

  // 1. VOLUME — l'équipe la moins documentée fixe le plafond. Une analyse ne
  //    vaut pas mieux que le plus faible de ses deux historiques.
  const nMin = Math.min(e.nMatchsDom ?? 0, e.nMatchsExt ?? 0);
  composantes.volume = borner(nMin / MATCHS_SUFFISANTS);
  if (nMin < MATCHS_SUFFISANTS) {
    alertes.push(`Historique incomplet : ${nMin} match(s) exploitable(s) pour l'équipe la moins documentée (${MATCHS_SUFFISANTS} recommandés).`);
  }

  // 2. STABILITÉ — largeur de l'intervalle du marché principal.
  //
  // Piège révélé par le test « Sans données, confiance faible » : le
  // rééchantillonnage d'un historique vide ne varie jamais, donc l'intervalle
  // est de largeur nulle, donc la stabilité ressortait à 1. Le modèle se
  // déclarait parfaitement stable au moment précis où il ne savait rien, et
  // aurait affiché « 47 % [47 % – 47 %] » : une précision inventée.
  //
  // En dessous de MATCHS_MIN_STABILITE, l'intervalle n'est pas une mesure
  // d'incertitude, c'est un artefact. On le déclare indisponible.
  if (nMin < MATCHS_MIN_STABILITE) {
    composantes.stabilite = null;
    alertes.push(`Intervalle non significatif : ${nMin} match(s) ne permettent pas d'estimer l'incertitude.`);
  } else if (Number.isFinite(e.largeurIC)) {
    composantes.stabilite = borner(1 - e.largeurIC / LARGEUR_IC_MAX);
    if (e.largeurIC > LARGEUR_IC_MAX * 0.66) {
      alertes.push(`Estimation instable : l'intervalle couvre ${Math.round(e.largeurIC * 100)} points.`);
    }
  } else {
    composantes.stabilite = null;
  }

  // 3. COMPLÉTUDE des données d'entrée.
  const attendus = e.champsAttendus ?? 0;
  composantes.completude = attendus > 0 ? borner(1 - (e.champsManquants ?? 0) / attendus) : 1;

  // 4. COHÉRENCE avec le marché — sans cote, non mesurable. On ne l'invente pas.
  if (Number.isFinite(e.ecartMarche)) {
    composantes.coherence = borner(1 - Math.abs(e.ecartMarche) / ECART_MARCHE_MAX);
    if (Math.abs(e.ecartMarche) > ECART_MARCHE_MAX) {
      alertes.push(`Écart important avec le marché (${Math.round(e.ecartMarche * 100)} points) : le modèle ignore probablement une information (blessure, enjeu, rotation).`);
    }
  } else {
    composantes.coherence = null;
    alertes.push('Aucune cote disponible : la cohérence avec le marché n\'a pas pu être évaluée.');
  }

  // Redistribution du poids des composantes indisponibles.
  let poidsUtile = 0, somme = 0;
  for (const [nom, poids] of Object.entries(POIDS)) {
    if (composantes[nom] === null || composantes[nom] === undefined) continue;
    poidsUtile += poids;
    somme += poids * composantes[nom];
  }
  const score = poidsUtile > 0 ? Math.round(100 * somme / poidsUtile) : 0;

  return { score, composantes, alertes };
}

export default { scoreConfiance, POIDS, MATCHS_SUFFISANTS, MATCHS_MIN_STABILITE, LARGEUR_IC_MAX, ECART_MARCHE_MAX };
