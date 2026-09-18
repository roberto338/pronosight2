// ══════════════════════════════════════════════
// prono/engine/rejeu.js — rejouer l'historique, sans jamais voir le futur
// ══════════════════════════════════════════════
//
// Extrait de prono/backtest.js pour que le backtest et le balayage
// d'hyper-paramètres partagent EXACTEMENT la même mécanique. Deux
// implémentations du rejeu dériveraient, et le balayage optimiserait alors
// un modèle qui n'est pas celui qu'on mesure.
//
// Pur : reçoit les rencontres, rend les notations. Aucune base, aucun
// réseau, aucune date système.
//
// ── L'invariant ──
//
// Une rencontre n'entre dans l'historique qu'APRÈS avoir été notée. Tout ce
// qui sert à la prédire — forces des deux équipes, moyennes de la ligue,
// pondération par ancienneté — ne voit que des rencontres strictement
// antérieures. C'est la seule chose qui sépare une mesure d'une illusion.

import { calculerForces, calculerLambdas, DEMI_VIE_JOURS, K_SHRINKAGE } from './ratings.js';
import { matriceScores, RHO_DEFAUT } from './poisson.js';
import { marchesDepuisMatrice } from './markets.js';
import { noterRencontre } from './backtest.js';
import { moyennesDepuisLignes } from '../data/normalisation.js';

/**
 * Buts attendus, avec ou sans séparation domicile / extérieur.
 *
 * SANS : une attaque unique par équipe, tous lieux confondus. L'avantage du
 * terrain vit entièrement dans les moyennes de ligue. C'est la formulation
 * classique de Dixon-Coles.
 *
 * AVEC : on ne retient, pour l'équipe à domicile, que ses matchs à domicile,
 * et réciproquement. Plus fidèle au réel — une équipe n'est pas la même à
 * l'extérieur — mais chaque paramètre est estimé sur deux fois moins de
 * rencontres. Sur dix matchs, le remède peut être pire que le mal. C'est
 * précisément ce que le balayage doit trancher, plutôt qu'un avis.
 */
function estimerLambdas(dom, ext, ligue, ctx, separerLieu) {
  if (!separerLieu) {
    const fd = calculerForces(dom, ctx);
    const fe = calculerForces(ext, ctx);
    return { ...calculerLambdas(fd, fe, ligue), forcesDom: fd, forcesExt: fe };
  }

  const domChezSoi = dom.filter(m => m.domicile);
  const extDehors  = ext.filter(m => !m.domicile);

  // Les buts encaissés par une équipe à l'extérieur sont des buts marqués
  // par des équipes à domicile : ils se normalisent donc par moyButsDom.
  const ctxDom = { ...ctx, moyLigue: ligue.moyButsDom };
  const ctxExt = { ...ctx, moyLigue: ligue.moyButsExt };

  const attDom = calculerForces(domChezSoi, ctxDom).attaque;
  const defExt = calculerForces(extDehors,  ctxDom).defense;
  const attExt = calculerForces(extDehors,  ctxExt).attaque;
  const defDom = calculerForces(domChezSoi, ctxExt).defense;

  const borne = (x) => Math.min(Math.max(x, 0.05), 6);
  return {
    lambdaDom: borne(ligue.moyButsDom * attDom * defExt),
    lambdaExt: borne(ligue.moyButsExt * attExt * defDom),
    forcesDom: { attaque: attDom, defense: defDom, nMatchs: domChezSoi.length },
    forcesExt: { attaque: attExt, defense: defExt, nMatchs: extDehors.length },
  };
}

/**
 * @param {Array} rencontres  lignes pa_match_results, triées du plus ancien au plus récent
 * @param {Object} params     {seuil, k, demiVieJours, rho, separerLieu, fenetreJours}
 * @returns {{notees:Array, ignorees:number}}
 */
export function rejouer(rencontres, params = {}) {
  const {
    seuil = 5,
    k = K_SHRINKAGE,
    demiVieJours = DEMI_VIE_JOURS,
    rho = RHO_DEFAUT,
    separerLieu = false,
    fenetreJours = null,   // null = tout l'historique disponible
  } = params;

  const historique = new Map();
  const ligues = new Map();
  const notees = [];
  let ignorees = 0;

  const pousser = (id, ligne) => {
    if (!historique.has(id)) historique.set(id, []);
    historique.get(id).push(ligne);
  };

  // Ne garder que les rencontres assez récentes par rapport à celle qu'on
  // note. Sert à tester si la fin de la saison précédente aide ou nuit.
  const filtrerFenetre = (liste, dateMatch) => {
    if (!fenetreJours) return liste;
    const limite = dateMatch.getTime() - fenetreJours * 864e5;
    return liste.filter(m => new Date(m.date).getTime() >= limite);
  };

  for (const m of rencontres) {
    const dateMatch = new Date(m.joue_le);
    const domTout = historique.get(m.equipe_dom_id) ?? [];
    const extTout = historique.get(m.equipe_ext_id) ?? [];
    const dom = filtrerFenetre(domTout, dateMatch);
    const ext = filtrerFenetre(extTout, dateMatch);
    const lignesLigue = ligues.get(m.competition_code) ?? [];

    const assezDom = separerLieu ? dom.filter(x => x.domicile).length : dom.length;
    const assezExt = separerLieu ? ext.filter(x => !x.domicile).length : ext.length;

    if (assezDom >= seuil && assezExt >= seuil) {
      const ligue = moyennesDepuisLignes(lignesLigue);
      const ctx = {
        moyLigue: (ligue.moyButsDom + ligue.moyButsExt) / 2,
        demiVieJours,
        k,
        aujourdhui: dateMatch,
      };
      const { lambdaDom, lambdaExt } = estimerLambdas(dom, ext, ligue, ctx, separerLieu);
      const { parCle } = marchesDepuisMatrice(matriceScores(lambdaDom, lambdaExt, { rho }));

      notees.push(noterRencontre(
        { butsDom: Number(m.buts_dom), butsExt: Number(m.buts_ext) },
        parCle,
        {
          date: String(m.joue_le).slice(0, 10),
          competition: m.competition,
          affiche: `${m.equipe_dom} — ${m.equipe_ext}`,
          nDom: assezDom,
          nExt: assezExt,
          ligueMesuree: ligue.mesuree,
          lambdaDom,
          lambdaExt,
        },
      ));
    } else {
      ignorees++;
    }

    const date = String(m.joue_le).slice(0, 10);
    pousser(m.equipe_dom_id, { date, butsMarques: Number(m.buts_dom), butsEncaisses: Number(m.buts_ext), domicile: true });
    pousser(m.equipe_ext_id, { date, butsMarques: Number(m.buts_ext), butsEncaisses: Number(m.buts_dom), domicile: false });
    lignesLigue.push({ buts_dom: m.buts_dom, buts_ext: m.buts_ext });
    ligues.set(m.competition_code, lignesLigue);
  }

  return { notees, ignorees };
}

export default { rejouer };
