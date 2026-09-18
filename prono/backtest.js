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
import { noterRencontre, resumer, paniersCalibration, ecartCalibration, HASARD_1X2 } from './engine/backtest.js';
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
const paniers = paniersCalibration(notees);
const ece = ecartCalibration(paniers);

console.log('┌─ Performance ────────────────────────────────────────');
console.log(`│ Rencontres notées          ${String(r.n).padStart(7)}`);
console.log(`│ Taux de réussite du favori ${pct(r.tauxFavori)}`);
console.log('│');
console.log(`│ Log-loss                   ${num(r.logLoss)}   (hasard : ${num(HASARD_1X2.logLoss)})`);
console.log(`│ Score de Brier (1X2)       ${num(r.brier)}   (hasard : ${num(HASARD_1X2.brier)})`);
console.log(`│ Brier Over 2,5             ${num(r.brierOver)}   (hasard : 0.250)`);
console.log(`│ Brier BTTS                 ${num(r.brierBtts)}   (hasard : 0.250)`);
console.log('│');
console.log(`│ Over 2,5 réalisés          ${pct(r.tauxOver)}`);
console.log(`│ BTTS réalisés              ${pct(r.tauxBtts)}`);
console.log('└──────────────────────────────────────────────────────');

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
console.log('\n── Verdict ──');
const mieuxQueHasard = r.logLoss < HASARD_1X2.logLoss && r.brier < HASARD_1X2.brier;
if (!mieuxQueHasard) {
  console.log('⛔ Le modèle ne fait pas mieux que le hasard. Rien ne doit être publié.');
} else if (ece > 0.08) {
  console.log(`⛔ Mal calibré : ${pct(ece)} d'écart moyen entre annoncé et réalisé.`);
  console.log('   Le modèle discrimine, mais ses pourcentages mentent. Ne pas publier de %.');
} else if (ece > 0.04) {
  console.log(`⚠️  Calibration passable : ${pct(ece)} d'écart moyen.`);
  console.log('   Utilisable en affichant les intervalles, pas en affichant un chiffre nu.');
} else {
  console.log(`✅ Calibré à ${pct(ece)} d'écart moyen, et meilleur que le hasard.`);
}
console.log('\nRappel : ces chiffres portent sur le passé. Ils ne promettent aucun gain futur.');

await pool.end();
