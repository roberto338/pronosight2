// ══════════════════════════════════════════════
// prono/sweep.js — chercher des réglages, sans se mentir
// ══════════════════════════════════════════════
//
//   node prono/sweep.js
//
// LECTURE SEULE. N'écrit rien, ne consomme aucun quota API.
//
// ── Pourquoi un découpage, et pourquoi il n'est pas négociable ──
//
// Essayer 480 combinaisons et garder la meilleure garantit d'en trouver une
// qui brille. Sur des données purement aléatoires, la meilleure de 480
// paraîtrait excellente : c'est une propriété du nombre d'essais, pas du
// modèle.
//
// Les réglages sont donc choisis sur les deux tiers les plus ANCIENS, et
// mesurés sur le tiers le plus RÉCENT, qui n'a jamais servi au choix. Si le
// gain s'évapore entre les deux, le réglage ne captait que du bruit — et
// c'est une réponse, pas un échec.
//
// C'est exactement l'erreur que commet learn.ts dans Prono-App : il ajuste
// les forces sur les matchs ratés, puis se félicite sur ces mêmes matchs.

import { resumer, etalonTauxDeBase, gainRelatif, comparerAuTauxDeBase } from './engine/backtest.js';
import { rejouer } from './engine/rejeu.js';
import { chargerToutesRencontres } from './data/repository.js';
import { DEMI_VIE_JOURS, K_SHRINKAGE } from './engine/ratings.js';
import { RHO_DEFAUT } from './engine/poisson.js';
import pool from '../db/database.js';

const SEUIL = 5;
const GRILLE = {
  k:            [0, 1, 2, 3, 5, 8],
  demiVieJours: [30, 45, 60, 90, 180],
  rho:          [-0.15, -0.10, -0.05, 0],
  separerLieu:  [false, true],
  fenetreJours: [null, 120],
};

const pct = (x) => x == null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)} %`;
const signe = (x) => x == null ? '   —  ' : `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(2).padStart(5)} %`;

const rencontres = await chargerToutesRencontres();
console.log(`\n── Balayage d'hyper-paramètres ──`);
console.log(`${rencontres.length} rencontre(s) chargée(s).`);
if (rencontres.length < 200) {
  console.log('Trop peu de données pour un balayage crédible.');
  await pool.end();
  process.exit(0);
}

// ── Découpage chronologique ──
const dates = rencontres.map(m => String(m.joue_le).slice(0, 10)).sort();
const coupure = dates[Math.floor(dates.length * 2 / 3)];
console.log(`Réglage   : jusqu'au ${coupure} (exclu)`);
console.log(`Validation: à partir du ${coupure} — jamais vu pendant le choix\n`);

const combinaisons = [];
for (const k of GRILLE.k)
  for (const demiVieJours of GRILLE.demiVieJours)
    for (const rho of GRILLE.rho)
      for (const separerLieu of GRILLE.separerLieu)
        for (const fenetreJours of GRILLE.fenetreJours)
          combinaisons.push({ k, demiVieJours, rho, separerLieu, fenetreJours, seuil: SEUIL });

console.log(`${combinaisons.length} combinaison(s) à évaluer…`);

/** Note un ensemble de rencontres et rend le gain par rapport au taux de base. */
function evaluer(rows) {
  if (rows.length < 50) return null;
  const r = resumer(rows);
  const base = etalonTauxDeBase(rows);
  return {
    n: rows.length,
    logLoss: r.logLoss,
    logLossBase: base.logLoss,
    gain: gainRelatif(r.logLoss, base.logLoss),
    gainBrier: gainRelatif(r.brier, base.brier),
    tauxFavori: r.tauxFavori,
    tauxDomicile: base.tauxToujoursDomicile,
  };
}

const resultats = [];
const debut = Date.now();
for (const [i, params] of combinaisons.entries()) {
  const { notees } = rejouer(rencontres, params);
  const reglage = evaluer(notees.filter(r => r.date < coupure));
  const validation = evaluer(notees.filter(r => r.date >= coupure));
  if (reglage && validation) resultats.push({ params, reglage, validation });
  if ((i + 1) % 100 === 0) console.log(`   ${i + 1}/${combinaisons.length}…`);
}
console.log(`Terminé en ${Math.round((Date.now() - debut) / 1000)}s — ${resultats.length} combinaison(s) exploitable(s).\n`);

if (resultats.length === 0) {
  console.log('Aucune combinaison n\'a produit assez de rencontres notables.');
  await pool.end();
  process.exit(0);
}

const nomParams = (p) =>
  `k=${p.k} dv=${p.demiVieJours} ρ=${p.rho} ${p.separerLieu ? 'lieu' : '    '} ${p.fenetreJours ?? 'tout'}`;

// ── Classement par la période de RÉGLAGE uniquement ──
resultats.sort((a, b) => b.reglage.gain - a.reglage.gain);

console.log('┌─ Meilleures combinaisons, choisies sur le RÉGLAGE ────────────────────────');
console.log('│  paramètres                          réglage    validation      n valid.');
for (const r of resultats.slice(0, 10)) {
  console.log(`│  ${nomParams(r.params).padEnd(34)} ${signe(r.reglage.gain)}     ${signe(r.validation.gain)}    ${String(r.validation.n).padStart(5)}`);
}
console.log('└──────────────────────────────────────────────────────────────────────────');

// Position des réglages actuels, pour mesurer le chemin parcouru.
const actuel = resultats.find(r =>
  r.params.k === K_SHRINKAGE && r.params.demiVieJours === DEMI_VIE_JOURS
  && Math.abs(r.params.rho - RHO_DEFAUT) < 0.03 && !r.params.separerLieu && r.params.fenetreJours === null);
if (actuel) {
  console.log(`\nRéglages actuels du moteur : réglage ${signe(actuel.reglage.gain)}, validation ${signe(actuel.validation.gain)}`);
}

// ── Le seul chiffre qui compte ──
const retenu = resultats[0];
console.log('\n┌─ Combinaison retenue (choisie sans voir la validation) ───────────────────');
console.log(`│  k (rétrécissement)     ${retenu.params.k}`);
console.log(`│  demi-vie               ${retenu.params.demiVieJours} jours`);
console.log(`│  rho (Dixon-Coles)      ${retenu.params.rho}`);
console.log(`│  séparation dom/ext     ${retenu.params.separerLieu ? 'oui' : 'non'}`);
console.log(`│  fenêtre d'historique   ${retenu.params.fenetreJours ?? 'complète'}`);
console.log('│');
console.log(`│  Réglage    : log-loss ${retenu.reglage.logLoss.toFixed(4)} contre ${retenu.reglage.logLossBase.toFixed(4)} → ${signe(retenu.reglage.gain)}`);
console.log(`│  VALIDATION : log-loss ${retenu.validation.logLoss.toFixed(4)} contre ${retenu.validation.logLossBase.toFixed(4)} → ${signe(retenu.validation.gain)}`);
console.log(`│  Favori ${pct(retenu.validation.tauxFavori)} contre ${pct(retenu.validation.tauxDomicile)} pour « toujours le domicile »`);
console.log('└──────────────────────────────────────────────────────────────────────────');

// L'intervalle de la combinaison retenue, sur la seule validation.
const { notees: notesRetenues } = rejouer(rencontres, retenu.params);
const testValidation = comparerAuTauxDeBase(notesRetenues.filter(r => r.date >= coupure));
if (testValidation) {
  console.log(`\nIntervalle à 95 % du gain en validation : ${signe(testValidation.gainBasse)} à ${signe(testValidation.gainHaute)}`);
  console.log(testValidation.significatif
    ? '  La borne basse est au-dessus de zéro : le gain survit au hasard de l\'échantillon.'
    : '  L\'intervalle contient zéro : rien ne permet de conclure.');
}

// Combien de combinaisons tiennent en validation ? Si une seule, c'est du
// bruit ; si beaucoup, l'effet est probablement réel.
const tiennent = resultats.filter(r => r.validation.gain > 0).length;
console.log(`\n${tiennent} combinaison(s) sur ${resultats.length} gardent un gain positif en validation.`);

console.log('\n── Verdict ──');
if (testValidation && !testValidation.significatif) {
  console.log('⛔ AUCUN GAIN SIGNIFICATIF.');
  console.log(`   Le meilleur réglage rend ${signe(retenu.validation.gain)} en validation, mais son`);
  console.log(`   intervalle à 95 % va de ${signe(testValidation.gainBasse)} à ${signe(testValidation.gainHaute)} : il contient zéro.`);
  console.log(`   Sur ${testValidation.n} rencontres, ce chiffre n'est pas distinguable du hasard.`);
  console.log('   NE RIEN CHANGER aux réglages sur cette base.');
} else if (retenu.validation.gain <= 0) {
  console.log('⛔ AUCUN RÉGLAGE NE FONCTIONNE.');
  console.log('   La meilleure combinaison de la période de réglage ne bat pas le taux');
  console.log('   de base sur des données qu\'elle n\'a pas vues. Le problème n\'est donc');
  console.log('   pas le réglage : c\'est que le Poisson sur cet historique n\'a pas de');
  console.log('   quoi discriminer. Il faut plus de données par équipe (saison complète)');
  console.log('   ou de meilleures entrées (xG, compositions), pas d\'autres constantes.');
} else if (tiennent < resultats.length * 0.1) {
  console.log(`⚠️  Gain de ${signe(retenu.validation.gain)} en validation, mais seulement`);
  console.log(`   ${tiennent} combinaison(s) sur ${resultats.length} tiennent. Probablement du bruit.`);
  console.log('   À reconfirmer sur de nouvelles rencontres avant d\'y toucher.');
} else {
  console.log(`✅ Gain de ${signe(retenu.validation.gain)} en validation, sur des données jamais vues.`);
  console.log(`   ${tiennent}/${resultats.length} combinaisons tiennent : l'effet paraît réel.`);
  console.log('   Reste à confirmer en avant, sur des matchs à venir.');
}
console.log('\nRappel : ces chiffres portent sur le passé. Ils ne promettent aucun gain futur.');

await pool.end();
