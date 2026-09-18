// ══════════════════════════════════════════════
// prono/audit-victor.js — ce que valent les signaux déjà publiés
// ══════════════════════════════════════════════
//
//   node prono/audit-victor.js
//   node prono/audit-victor.js --depuis=2026-06-01
//
// LECTURE SEULE sur ps_pronostics. N'écrit rien, ne consomme aucun quota.
//
// ── Pourquoi cet audit ──
//
// Le moteur statistique a été mesuré et jugé insuffisant AVANT d'être montré
// à quiconque. Victor, lui, publie sur Telegram depuis des mois sans que
// personne n'ait vérifié ses chiffres. Cet écart de traitement n'a aucune
// justification : c'est même l'inverse qui serait logique, puisque Victor
// est celui que des gens suivent.
//
// ── Ce qui est mesuré, et ce qui ne peut pas l'être ──
//
// Seuls les pronostics dont la cote a été CONFIRMÉE par un bookmaker
// (cote_confirmee = true) permettent un rendement honnête. Quand
// cote_confirmee vaut false, la cote affichée a été écrite par le modèle de
// langage lui-même : calculer un rendement dessus reviendrait à mesurer une
// performance contre un adversaire imaginaire. Ces pronostics sont comptés
// pour leur taux de réussite, jamais pour leur rendement.

import { resumerParis, bootstrapRoi, verifierBandes, echelleOrdonnee } from './engine/audit.js';
import { mulberry32 } from './engine/montecarlo.js';
import { chargerPronosticsNotes, etatPronostics } from './data/audit-lecture.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const depuis = (args.find(a => a.startsWith('--depuis=')) || '').split('=')[1] || null;

const pct = (x) => x == null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)} %`;
const signe = (x) => x == null ? '   —  ' : `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1).padStart(5)} %`;

console.log('\n── Audit de Victor ──');
if (depuis) console.log(`Depuis le ${depuis}`);

const etat = await etatPronostics();
console.log(`\n${etat.total} pronostic(s) en base, dont ${etat.notes} noté(s) et ${etat.cotes_reelles} à cote confirmée.`);
if (etat.total > 0) {
  console.log(`Période : du ${String(etat.plus_ancien).slice(0, 10)} au ${String(etat.plus_recent).slice(0, 10)}`);
}

const rows = await chargerPronosticsNotes({ depuis });
if (rows.length === 0) {
  console.log('\nAucun pronostic noté — rien à auditer.');
  await pool.end();
  process.exit(0);
}

const paris = rows.map(r => ({
  correct: r.pronostic_correct === true,
  cote: Number(r.cote_estimee),
  coteReelle: r.cote_confirmee === true,
  confianceScore: r.confiance_score,
  sport: r.sport || 'inconnu',
  moteur: r.moteur || 'inconnu',
}));

const confirmes = paris.filter(p => p.coteReelle);
const inventes = paris.filter(p => !p.coteReelle);

// ── Taux de réussite : mesurable sur tout ──
const tous = resumerParis(paris.map(p => ({ ...p, cote: p.cote || 2 })));
const reussisTous = paris.filter(p => p.correct).length;

console.log('\n┌─ Taux de réussite ────────────────────────────────────');
console.log(`│ Tous pronostics notés       ${String(paris.length).padStart(5)}   ${pct(reussisTous / paris.length)}`);
console.log(`│   à cote confirmée          ${String(confirmes.length).padStart(5)}   ${pct(confirmes.filter(p => p.correct).length / (confirmes.length || 1))}`);
console.log(`│   à cote écrite par l'IA    ${String(inventes.length).padStart(5)}   ${pct(inventes.filter(p => p.correct).length / (inventes.length || 1))}`);
console.log('└───────────────────────────────────────────────────────');

// ── Rendement : uniquement sur les cotes réelles ──
console.log('\n┌─ Rendement, sur les seules cotes confirmées ───────────');
if (confirmes.length === 0) {
  console.log('│ Aucune cote confirmée : le rendement n\'est pas mesurable.');
  console.log('│ Tout ce qui est publié l\'est alors face à une cote inventée.');
} else {
  const r = resumerParis(confirmes);
  const bs = bootstrapRoi(confirmes, { iterations: 3000, rnd: mulberry32(19) });
  console.log(`│ Paris                       ${String(r.n).padStart(5)}`);
  console.log(`│ Taux de réussite            ${pct(r.tauxReussite)}`);
  console.log(`│ Cote moyenne                ${r.coteMoyenne.toFixed(2).padStart(5)}`);
  console.log(`│ Seuil de rentabilité        ${pct(r.tauxRentabilite)}   ← taux nécessaire à l'équilibre`);
  console.log('│');
  console.log(`│ RENDEMENT                   ${signe(r.roi)}   (${r.gainTotal >= 0 ? '+' : ''}${r.gainTotal.toFixed(2)} unités sur ${r.n} mises)`);
  if (bs) {
    console.log(`│ Intervalle à 95 %           ${signe(bs.basse)} à ${signe(bs.haute)}`);
  } else {
    console.log('│ Intervalle                  non calculable (moins de 20 paris)');
  }
}
console.log('└───────────────────────────────────────────────────────');

// ── Les bandes de confiance tiennent-elles leur promesse ? ──
const bandes = verifierBandes(paris);
console.log('\n┌─ Les promesses de l\'échelle de confiance ─────────────');
if (bandes.length === 0) {
  console.log('│ Aucun confiance_score renseigné.');
} else {
  console.log('│  bande          promesse   réalisé       n');
  for (const b of bandes) {
    const marque = b.n < 20 ? ' (peu de données)' : b.tientPromesse ? ' ✅' : ' ⛔';
    console.log(`│  ${b.libelle.padEnd(13)} ${b.promesse.padStart(8)}   ${pct(b.realise)}  ${String(b.n).padStart(5)}${marque}`);
  }
}
console.log('└───────────────────────────────────────────────────────');

const ordre = echelleOrdonnee(bandes);
if (ordre === false) {
  console.log('\n⛔ L\'échelle est INVERSÉE : une confiance plus haute ne passe pas plus souvent.');
  console.log('   Un abonné qui mise davantage sur « Très élevée » est trompé par la graduation.');
} else if (ordre === true) {
  console.log('\nL\'échelle est au moins ordonnée : une confiance plus haute passe plus souvent.');
}

// ── Par sport ──
const sports = [...new Set(paris.map(p => p.sport))]
  .map(s => ({ sport: s, lot: paris.filter(p => p.sport === s && p.coteReelle) }))
  .filter(x => x.lot.length >= 10)
  .map(x => ({ sport: x.sport, ...resumerParis(x.lot) }))
  .sort((a, b) => b.n - a.n);
if (sports.length) {
  console.log('\n┌─ Par sport, cotes confirmées, au moins 10 paris ───────');
  console.log('│  sport              n    réussite   rendement');
  for (const s of sports) {
    console.log(`│  ${s.sport.padEnd(15)} ${String(s.n).padStart(4)}    ${pct(s.tauxReussite)}    ${signe(s.roi)}`);
  }
  console.log('└───────────────────────────────────────────────────────');
}

// ── Verdict ──
console.log('\n── Verdict ──');
const bs = confirmes.length ? bootstrapRoi(confirmes, { iterations: 3000, rnd: mulberry32(19) }) : null;
const promessesTenues = bandes.filter(b => b.n >= 20).every(b => b.tientPromesse);

if (!bs) {
  console.log('⚠️  Pas assez de paris à cote confirmée pour conclure sur le rendement.');
  console.log('   Le taux de réussite seul ne dit rien : il dépend entièrement des cotes jouées.');
} else if (bs.perdant) {
  console.log(`⛔ PERTE DÉMONTRÉE : rendement ${signe(bs.roi)}, intervalle ${signe(bs.basse)} à ${signe(bs.haute)}.`);
  console.log('   La borne haute est sous zéro : ce n\'est pas de la malchance.');
} else if (bs.rentable) {
  console.log(`✅ Rendement positif démontré : ${signe(bs.roi)}, intervalle ${signe(bs.basse)} à ${signe(bs.haute)}.`);
  console.log('   À reconfirmer en avant : un rendement passé ne se reproduit pas de lui-même.');
} else {
  console.log(`⚠️  Rendement ${signe(bs.roi)}, mais l'intervalle (${signe(bs.basse)} à ${signe(bs.haute)}) contient zéro.`);
  console.log(`   Sur ${bs.n} paris, rien ne permet de dire que Victor gagne ou perd de l'argent.`);
}

if (bandes.some(b => b.n >= 20) && !promessesTenues) {
  console.log('\n⛔ Au moins une bande de confiance ne tient pas la promesse du prompt.');
  console.log('   victor/prompt.js:176-178 engage des probabilités chiffrées. Si elles ne sont');
  console.log('   pas tenues, soit le prompt doit changer, soit l\'échelle affichée doit l\'être.');
}

console.log('\nRappel : ces chiffres portent sur le passé. Ils ne promettent aucun gain futur.');
console.log(`\n::AUDIT_N::${confirmes.length}`);
console.log(`::AUDIT_ROI::${bs ? (bs.roi * 100).toFixed(2) : 'NA'}`);
console.log(`::AUDIT_VERDICT::${!bs ? 'indetermine' : bs.perdant ? 'perdant' : bs.rentable ? 'rentable' : 'indetermine'}`);

await pool.end();
