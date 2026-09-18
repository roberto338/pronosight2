// ══════════════════════════════════════════════
// prono/engine/backtest.js — noter le modèle sur le passé
// ══════════════════════════════════════════════
//
// Un modèle qui annonce 60 % doit avoir raison six fois sur dix. Tant que
// ce n'est pas mesuré, « 60 % » est une décoration.
//
// Ce module ne calcule pas de probabilités : il note celles qu'on lui donne
// contre ce qui s'est réellement passé. Comme le reste de prono/engine/, il
// est pur — aucune base, aucun réseau, aucune date système.
//
// ── Les trois mesures, et pourquoi il en faut trois ──
//
// TAUX DE RÉUSSITE DU FAVORI. Le plus lisible, et le moins informatif : il
// ignore la confiance annoncée. Un modèle qui dirait 34 % / 33 % / 33 %
// partout obtiendrait le même taux qu'un modèle sûr de lui.
//
// LOG-LOSS. Pénalise la certitude mal placée, et brutalement : annoncer 5 %
// sur ce qui arrive coûte très cher. C'est la mesure qui détecte un modèle
// arrogant.
//
// SCORE DE BRIER. Même esprit, pénalité quadratique donc moins explosive.
// Se lit comme une distance moyenne à la vérité.
//
// Aucune des trois ne dit si le modèle est CALIBRÉ — c'est le rôle de la
// courbe de fiabilité, plus bas. Un modèle peut avoir un bon log-loss et
// mentir systématiquement de dix points.

/**
 * ÉTALON DE RÉFÉRENCE — pourquoi « mieux que le hasard » ne veut rien dire.
 *
 * Comparer un modèle au hasard uniforme (33/33/33) est trop facile : le
 * football n'est pas uniforme. Les équipes à domicile gagnent nettement plus
 * souvent, et un « modèle » qui se contenterait d'annoncer les FRÉQUENCES
 * OBSERVÉES du championnat, sans rien savoir des équipes, bat déjà le hasard
 * uniforme sans contenir la moindre information.
 *
 * C'est donc lui, le taux de base, qui est la vraie barre à franchir. Un
 * modèle qui ne le dépasse pas n'apporte rien, quelle que soit sa calibration.
 *
 * Premier passage du backtest sur 718 rencontres : log-loss 1,083 contre
 * 1,099 pour le hasard uniforme — ce que le verdict d'alors saluait d'un ✅.
 * Sauf qu'aucune probabilité ne dépassait 60 % : le modèle était calibré
 * parce qu'il ne s'engageait jamais. La calibration sans pouvoir discriminant
 * est une forme polie de silence.
 */
export function etalonTauxDeBase(rows) {
  const n = rows.length;
  if (n === 0) return null;

  const compte = { '1': 0, 'X': 0, '2': 0 };
  let over = 0, btts = 0;
  for (const r of rows) {
    compte[r.issue]++;
    if (r.over.reel) over++;
    if (r.btts.reel) btts++;
  }
  const taux = { '1': compte['1'] / n, 'X': compte['X'] / n, '2': compte['2'] / n };
  const tauxOver = over / n, tauxBtts = btts / n;

  // Log-loss et Brier d'un prédicteur qui annoncerait CES fréquences partout.
  let logLoss = 0, brier = 0;
  for (const r of rows) {
    logLoss -= Math.log(Math.max(taux[r.issue], PLANCHER));
    for (const k of ['1', 'X', '2']) brier += (taux[k] - (k === r.issue ? 1 : 0)) ** 2;
  }

  // Brier binaire d'une constante p sur une base q : q(1−p)² + (1−q)p².
  const brierConstante = (q) => q * (1 - q) ** 2 + (1 - q) * q ** 2;

  return {
    taux,
    tauxOver,
    tauxBtts,
    logLoss: logLoss / n,
    brier: brier / n,
    brierOver: brierConstante(tauxOver),
    brierBtts: brierConstante(tauxBtts),
    // « Toujours parier le domicile » : le réflexe du parieur du dimanche,
    // et une barre que beaucoup de modèles publiés ne franchissent pas.
    tauxToujoursDomicile: taux['1'],
  };
}

/**
 * Gain relatif d'un score par rapport à son étalon. Positif = le modèle
 * apporte quelque chose ; négatif ou nul = il n'apporte rien.
 */
export function gainRelatif(score, etalon) {
  if (!Number.isFinite(score) || !Number.isFinite(etalon) || etalon === 0) return null;
  return (etalon - score) / etalon;
}

/** Repères du hasard pur sur un marché à trois issues équiprobables. */
export const HASARD_1X2 = {
  logLoss: Math.log(3),        // 1,0986
  brier: 2 / 3,                // 0,6667 — Brier multiclasse, somme sur les 3 issues
};

/** Plancher de probabilité pour le log-loss. */
// Grok plafonnait à 0,04, ce qui borne la pénalité d'une prédiction
// catastrophique à -ln(0,04) = 3,2 et rend le score plus flatteur qu'il ne
// devrait. On plafonne à 1e-6 : assez pour éviter -Infinity, assez bas pour
// que se tromper avec certitude coûte ce que ça doit coûter.
const PLANCHER = 1e-6;

/** Issue réelle d'une rencontre. */
export function issueReelle(butsDom, butsExt) {
  if (butsDom > butsExt) return '1';
  if (butsDom < butsExt) return '2';
  return 'X';
}

/**
 * Note une rencontre passée contre les probabilités que le modèle aurait
 * produites AVANT elle.
 *
 * @param {{butsDom:number, butsExt:number}} reel
 * @param {Object<string,number>} parCle  sortie de marchesDepuisMatrice
 */
export function noterRencontre(reel, parCle, contexte = {}) {
  const probas = {
    '1': parCle['1X2:1'],
    'X': parCle['1X2:X'],
    '2': parCle['1X2:2'],
  };
  const issue = issueReelle(reel.butsDom, reel.butsExt);
  const favori = ['1', 'X', '2'].reduce((a, b) => (probas[b] > probas[a] ? b : a));

  const totalButs = reel.butsDom + reel.butsExt;
  const overReel = totalButs >= 3;
  const bttsReel = reel.butsDom >= 1 && reel.butsExt >= 1;

  return {
    ...contexte,
    probas,
    issue,
    favori,
    favoriJuste: favori === issue,
    probaFavori: probas[favori],
    probaIssue: probas[issue],
    over: { proba: parCle['OU_2.5:over'], reel: overReel },
    btts: { proba: parCle['BTTS:oui'], reel: bttsReel },
    score: `${reel.butsDom}-${reel.butsExt}`,
  };
}

/** Brier binaire moyen sur un marché à deux issues. */
function brierBinaire(rows, cle) {
  if (rows.length === 0) return null;
  let s = 0;
  for (const r of rows) s += (r[cle].proba - (r[cle].reel ? 1 : 0)) ** 2;
  return s / rows.length;
}

/**
 * Agrégats sur un ensemble de rencontres notées.
 * @returns {{n, tauxFavori, logLoss, brier, brierOver, brierBtts, tauxOver, tauxBtts}}
 */
export function resumer(rows) {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, tauxFavori: null, logLoss: null, brier: null,
             brierOver: null, brierBtts: null, tauxOver: null, tauxBtts: null };
  }

  let favorisJustes = 0, sommeLog = 0, sommeBrier = 0, over = 0, btts = 0;
  for (const r of rows) {
    if (r.favoriJuste) favorisJustes++;
    sommeLog -= Math.log(Math.max(r.probaIssue, PLANCHER));
    // Brier multiclasse : somme des écarts au carré sur les TROIS issues,
    // pas seulement sur celle qui est arrivée. Ne noter que l'issue réalisée
    // récompenserait un modèle qui répartit mal le reste.
    for (const k of ['1', 'X', '2']) {
      sommeBrier += (r.probas[k] - (k === r.issue ? 1 : 0)) ** 2;
    }
    if (r.over.reel) over++;
    if (r.btts.reel) btts++;
  }

  return {
    n,
    tauxFavori: favorisJustes / n,
    logLoss: sommeLog / n,
    brier: sommeBrier / n,
    brierOver: brierBinaire(rows, 'over'),
    brierBtts: brierBinaire(rows, 'btts'),
    tauxOver: over / n,
    tauxBtts: btts / n,
  };
}

/**
 * Courbe de fiabilité.
 *
 * Deux écarts volontaires avec l'implémentation de Prono-App :
 *
 *  1. Elle notait UNIQUEMENT la probabilité du favori, et ses paniers
 *     commençaient à 35 % : tout ce que le modèle annonçait en dessous
 *     disparaissait de la mesure. On verse ici les TROIS sélections de
 *     chaque rencontre, ce qui couvre [0,1] et triple l'échantillon.
 *  2. Elle affichait le milieu du panier comme probabilité annoncée. On
 *     affiche la MOYENNE des probabilités réellement prédites dans le
 *     panier : le milieu ment dès que la distribution n'est pas centrée.
 */
export function paniersCalibration(rows, options = {}) {
  const { largeur = 0.1 } = options;
  const nb = Math.round(1 / largeur);

  const paniers = Array.from({ length: nb }, (_, i) => ({
    min: i * largeur,
    max: (i + 1) * largeur,
    n: 0,
    sommeAnnonce: 0,
    realises: 0,
  }));

  for (const r of rows) {
    for (const k of ['1', 'X', '2']) {
      const p = r.probas[k];
      if (!Number.isFinite(p)) continue;
      const i = Math.min(nb - 1, Math.floor(p / largeur));
      paniers[i].n++;
      paniers[i].sommeAnnonce += p;
      if (k === r.issue) paniers[i].realises++;
    }
  }

  return paniers
    .filter(b => b.n > 0)
    .map(b => ({
      libelle: `${Math.round(b.min * 100)}–${Math.round(b.max * 100)} %`,
      n: b.n,
      annonce: b.sommeAnnonce / b.n,
      realise: b.realises / b.n,
      ecart: b.realises / b.n - b.sommeAnnonce / b.n,
    }));
}

/**
 * Écart de calibration moyen, pondéré par l'effectif de chaque panier (ECE).
 * Un seul nombre pour répondre à « de combien le modèle ment-il, en moyenne ? ».
 */
export function ecartCalibration(paniers) {
  const total = paniers.reduce((s, b) => s + b.n, 0);
  if (total === 0) return null;
  return paniers.reduce((s, b) => s + b.n * Math.abs(b.ecart), 0) / total;
}

export default {
  issueReelle, noterRencontre, resumer, paniersCalibration, ecartCalibration,
  etalonTauxDeBase, gainRelatif, HASARD_1X2,
};
