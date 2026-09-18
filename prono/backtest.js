// ══════════════════════════════════════════════
// prono/backtest.js — rejouer le passé, honnêtement
// ══════════════════════════════════════════════
//
//   node prono/backtest.js
//   node prono/backtest.js --seuil=10
//
// LECTURE SEULE. N'écrit rien, ne consomme aucun quota API.
//
// ── La règle qui rend le chiffre valable ──
//
// Pour noter la rencontre du 12 septembre, le modèle ne reçoit QUE les
// rencontres antérieures au 12 septembre. Jamais le résultat qu'il doit
// prédire, jamais les matchs suivants, jamais les moyennes de ligue
// calculées sur la saison entière.
//
// Sans cette discipline — « walk-forward » — on mesure un modèle qui a vu
// la réponse. Le chiffre obtenu est alors flatteur, et faux. C'est l'erreur
// la plus courante des backtests de paris, et la plus difficile à détecter
// après coup, puisque rien ne plante.
//
// Conséquence assumée : les premières journées de la fenêtre ne sont pas
// notables, faute d'historique. Elles sont comptées et annoncées.

import { calculerForces, calculerLambdas } from './engine/ratings.js';
import { matriceScores } from './engine/poisson.js';
import { marchesDepuisMatrice } from './engine/markets.js';
import {
  noterRencontre, resumer, paniersCalibration, ecartCalibration,
  etalonTauxDeBase, gainRelatif, HASARD_1X2,
} from './engine/backtest.js';
import { moyennesDepuisLignes } from './data/normalisation.js';
import { chargerToutesRencontres } from './data/repository.js';
import { MODEL_VERSION } from './engine/index.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const seuil = Number((args.find(a => a.startsWith('--seuil=')) || '').split('=')[1]) || 5;

const pct = (x) => x == null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)} %`;
const num = (x, d = 3) => x == null ? '  —  ' : x.toFixed(d);

console.log(`\n── Backtest du moteur statistique ──`);
console.log(`Version du modèle : ${MODEL_VERSION}`);
console.log(`Seuil d'inclusion : ${seuil} rencontre(s) préalables par équipe\n`);

const rencontres = await chargerToutesRencontres();
console.log(`${rencontres.length} rencontre(s) chargée(s).`);
if (rencontres.length === 0) {
  console.log('Rien à noter — lancer le backfill d\'abord.');
  await pool.end();
  process.exit(0);
}

// ── Rejeu chronologique ──
const historique = new Map();   // equipeId → [{date, butsMarques, butsEncaisses}]
const ligues = new Map();       // competition_code → [{buts_dom, buts_ext}]
const notees = [];
let ignorees = 0;

const pousser = (id, ligne) => {
  if (!historique.has(id)) historique.set(id, []);
  historique.get(id).push(ligne);
};

for (const m of rencontres) {
  const dom = historique.get(m.equipe_dom_id) ?? [];
  const ext = historique.get(m.equipe_ext_id) ?? [];
  const lignesLigue = ligues.get(m.competition_code) ?? [];

  // Note : tout ce qui suit n'utilise QUE les rencontres déjà poussées,
  // c'est-à-dire strictement antérieures à celle-ci.
  if (dom.length >= seuil && ext.length >= seuil) {
    const ligue = moyennesDepuisLignes(lignesLigue);
    const moyLigue = (ligue.moyButsDom + ligue.moyButsExt) / 2;
    // La pondération par ancienneté se calcule depuis la date du match noté,
    // pas depuis aujourd'hui : sinon les rencontres anciennes seraient
    // dépréciées deux fois.
    const ctx = { moyLigue, aujourdhui: new Date(m.joue_le) };

    const forcesDom = calculerForces(dom, ctx);
    const forcesExt = calculerForces(ext, ctx);
    const { lambdaDom, lambdaExt } = calculerLambdas(forcesDom, forcesExt,
      { moyButsDom: ligue.moyButsDom, moyButsExt: ligue.moyButsExt });
    const { parCle } = marchesDepuisMatrice(matriceScores(lambdaDom, lambdaExt));

    notees.push(noterRencontre(
      { butsDom: Number(m.buts_dom), butsExt: Number(m.buts_ext) },
      parCle,
      {
        date: String(m.joue_le).slice(0, 10),
        competition: m.competition,
        affiche: `${m.equipe_dom} — ${m.equipe_ext}`,
        nDom: dom.length,
        nExt: ext.length,
        ligueMesuree: ligue.mesuree,
      },
    ));
  } else {
    ignorees++;
  }

  // Ce n'est qu'APRÈS la notation que la rencontre entre dans l'historique.
  const date = String(m.joue_le).slice(0, 10);
  pousser(m.equipe_dom_id, { date, butsMarques: Number(m.buts_dom), butsEncaisses: Number(m.buts_ext) });
  pousser(m.equipe_ext_id, { date, butsMarques: Number(m.buts_ext), butsEncaisses: Number(m.buts_dom) });
  lignesLigue.push({ buts_dom: m.buts_dom, buts_ext: m.buts_ext });
  ligues.set(m.competition_code, lignesLigue);
}

console.log(`${notees.length} notée(s), ${ignorees} ignorée(s) faute d'historique suffisant.\n`);

if (notees.length === 0) {
  console.log('Aucune rencontre notable. Élargir la fenêtre ou abaisser --seuil.');
  await pool.end();
  process.exit(0);
}

// ── Résultats ──
const r = resumer(notees);
const base = etalonTauxDeBase(notees);
const paniers = paniersCalibration(notees);
const ece = ecartCalibration(paniers);

const gain = (x) => {
  const g = gainRelatif(x.score, x.etalon);
  if (g == null) return '     ';
  const signe = g >= 0 ? '+' : '−';
  return `${signe}${(Math.abs(g) * 100).toFixed(1).padStart(4)} %`;
};

console.log('┌─ Performance ────────────────────────────────────────────────────────');
console.log(`│ Rencontres notées          ${String(r.n).padStart(7)}`);
console.log('│');
console.log(`│ Fréquences observées       1 : ${pct(base.taux['1'])}   X : ${pct(base.taux['X'])}   2 : ${pct(base.taux['2'])}`);
console.log('│');
console.log('│                            modèle   taux de base   hasard    gain');
console.log(`│ Log-loss                   ${num(r.logLoss)}       ${num(base.logLoss)}     ${num(HASARD_1X2.logLoss)}   ${gain({ score: r.logLoss, etalon: base.logLoss })}`);
console.log(`│ Brier (1X2)                ${num(r.brier)}       ${num(base.brier)}     ${num(HASARD_1X2.brier)}   ${gain({ score: r.brier, etalon: base.brier })}`);
console.log(`│ Brier Over 2,5             ${num(r.brierOver)}       ${num(base.brierOver)}     0.250   ${gain({ score: r.brierOver, etalon: base.brierOver })}`);
console.log(`│ Brier BTTS                 ${num(r.brierBtts)}       ${num(base.brierBtts)}     0.250   ${gain({ score: r.brierBtts, etalon: base.brierBtts })}`);
console.log('│');
console.log(`│ Taux de réussite du favori ${pct(r.tauxFavori)}`);
console.log(`│ « Toujours le domicile »   ${pct(base.tauxToujoursDomicile)}   ← la barre du parieur du dimanche`);
console.log('└──────────────────────────────────────────────────────────────────────');

console.log('\n┌─ Fiabilité : le modèle dit-il la vérité ? ───────────');
console.log('│  panier        annoncé   réalisé    écart       n');
for (const b of paniers) {
  const signe = b.ecart >= 0 ? '+' : '−';
  const alerte = Math.abs(b.ecart) > 0.05 && b.n >= 30 ? ' ⚠' : '';
  console.log(`│  ${b.libelle.padEnd(12)} ${pct(b.annonce)}   ${pct(b.realise)}   ${signe}${(Math.abs(b.ecart) * 100).toFixed(1).padStart(4)} pt ${String(b.n).padStart(6)}${alerte}`);
}
console.log('└──────────────────────────────────────────────────────');
console.log(`\nÉcart de calibration moyen (ECE) : ${pct(ece)}`);

// ── Verdict ──
//
// Deux questions distinctes, et il faut répondre oui aux DEUX.
//
//   DISCRIMINE-T-IL ?  Bat-il le taux de base, c'est-à-dire un prédicteur
//                      qui ne connaît rien aux équipes et se contente
//                      d'annoncer les fréquences du championnat ?
//   MENT-IL ?          Ses pourcentages correspondent-ils au réalisé ?
//
// Un modèle peut être parfaitement calibré et parfaitement inutile : celui
// qui annonce toujours les fréquences de base a un ECE nul par construction.
// Ne tester que la calibration, c'est se décerner une bonne note pour avoir
// refusé de s'engager.
console.log('\n── Verdict ──');
const gainLog = gainRelatif(r.logLoss, base.logLoss);
const gainBrier = gainRelatif(r.brier, base.brier);
const discrimine = gainLog > 0.01 && gainBrier > 0;
const calibre = ece <= 0.04;

console.log(`Pouvoir discriminant : ${gainLog > 0 ? '+' : '−'}${(Math.abs(gainLog) * 100).toFixed(1)} % de log-loss contre le taux de base`);
console.log(`Calibration          : ${pct(ece)} d'écart moyen`);
console.log('');

if (!discrimine) {
  console.log('⛔ LE MODÈLE N\'APPORTE RIEN.');
  console.log('   Il ne bat pas un prédicteur qui annoncerait simplement les fréquences');
  console.log('   du championnat sans rien savoir des équipes. Une bonne calibration ne');
  console.log('   rachète pas cela : annoncer les taux de base est calibré par nature.');
  console.log('   NE RIEN PUBLIER. Chercher d\'où vient le manque de pouvoir discriminant');
  console.log('   avant toute autre chose.');
  process.exitCode = 0;
} else if (!calibre) {
  console.log(`⚠️  Discriminant mais mal calibré (${pct(ece)} d'écart).`);
  console.log('   Le classement des issues est informatif, les pourcentages mentent.');
  console.log('   Publier un ordre, jamais un chiffre nu.');
} else {
  console.log(`✅ Discriminant (+${(gainLog * 100).toFixed(1)} %) ET calibré (${pct(ece)}).`);
}

if (r.tauxFavori < base.tauxToujoursDomicile) {
  console.log(`\n⚠️  Le favori du modèle (${pct(r.tauxFavori)}) fait moins bien que`);
  console.log(`   « toujours parier le domicile » (${pct(base.tauxToujoursDomicile)}).`);
}

console.log('\nRappel : ces chiffres portent sur le passé. Ils ne promettent aucun gain futur.');

await pool.end();
