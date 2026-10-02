// ══════════════════════════════════════════════
// prono/historique.js — le moteur statistique face au marché, sur 6 saisons
// ══════════════════════════════════════════════
//
//   node prono/historique.js
//   node prono/historique.js --saisons=2223,2324,2425,2526,2627 --divisions=E0,SP1
//
// AUCUNE BASE. Télécharge les fichiers publics de football-data.co.uk.
//
// Le backtest sur pa_match_results disposait d'environ 10 matchs par équipe :
// trop peu pour qu'un modèle de forces apprenne quoi que ce soit, et c'est ce
// qu'il a conclu (aucun gain sur le taux de base). Ici, plusieurs saisons de
// huit championnats : des centaines de matchs par équipe, et surtout les
// COTES — d'avant-match et de clôture — de chaque rencontre.
//
// Le juge n'est donc plus le taux de base mais le marché :
//   1. log-loss du modèle face à celui des cotes dévigorisées ;
//   2. CLV des paris où le modèle voit une value face à la meilleure cote
//      d'avant-match. Seul un CLV positif et significatif montre un avantage.
//
// Le rejeu est le même que celui du backtest (prono/engine/rejeu.js) :
// chaque rencontre est prédite avec les seules rencontres antérieures.

import { rejouer } from './engine/rejeu.js';
import { resumer } from './engine/backtest.js';
import { comparerLogLoss, apportAuMarche, parisDuModele, bilanParis } from './engine/marche.js';
import { mulberry32 } from './engine/montecarlo.js';
import { chargerHistorique } from './data/football-data-uk.js';
import { MODEL_VERSION } from './engine/index.js';

const arg = (nom, defaut) => (process.argv.slice(2).find(a => a.startsWith(`--${nom}=`)) || '').split('=')[1] || defaut;
const saisons = arg('saisons', '2122,2223,2324,2425,2526,2627').split(',');
const divisions = arg('divisions', 'E0,E1,SP1,D1,I1,F1,N1,P1').split(',');
const seuil = Number(arg('seuil', '10'));

const pct = (x, d = 1) => (x == null ? '   —   ' : `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(d).padStart(d + 3)} %`);
const ic = (i) => (i ? `[${pct(i.basse)} ; ${pct(i.haute)}]` : '');

console.log('\n── Le moteur statistique face au marché ──');
console.log(`Modèle ${MODEL_VERSION} · saisons ${saisons.join(', ')} · ${divisions.join(', ')} · ${seuil} matchs minimum par équipe\n`);

const { rencontres, rapport } = await chargerHistorique({ saisons, divisions });
const erreurs = rapport.filter(r => r.erreur);
console.log(`${rencontres.length} rencontre(s) jouées chargées (${rapport.length - erreurs.length}/${rapport.length} fichiers).`);
if (erreurs.length) console.log(`Fichiers manquants : ${erreurs.map(e => `${e.saison}/${e.div} (${e.erreur})`).join(', ')}`);

const debut = Date.now();
const { notees, ignorees } = rejouer(rencontres, { seuil });
console.log(`${notees.length} notée(s), ${ignorees} ignorée(s) faute d'historique (${((Date.now() - debut) / 1000).toFixed(0)} s).\n`);

// ── 1. Qualité des probabilités ──
const s = resumer(notees);
const ll = comparerLogLoss(notees);
console.log('── 1. Probabilités 1X2 : log-loss (plus bas = meilleur) ──');
console.log(`  sur ${ll.n} rencontre(s) où les trois existent`);
console.log(`  modèle                ${ll.modele?.toFixed(4)}`);
console.log(`  cotes d'avant-match   ${ll.avantMatch?.toFixed(4)}`);
console.log(`  cotes de clôture      ${ll.cloture?.toFixed(4)}`);
const ecart = ll.n ? (ll.modele - ll.avantMatch) / ll.avantMatch : null;
console.log(`  écart modèle / avant-match : ${pct(ecart, 2)} ${ecart > 0 ? '(le modèle est MOINS précis que le marché)' : '(le modèle est plus précis que le marché)'}`);
console.log(`  favori du modèle juste : ${(s.tauxFavori * 100).toFixed(1)} %\n`);

// ── 1 bis. Le modèle ajoute-t-il quelque chose aux cotes ? ──
const apport = apportAuMarche(notees);
console.log('── 1 bis. Mélange modèle + cotes d\'avant-match (poids choisi sur la moitié des matchs, vérifié sur l\'autre) ──');
for (const p of apport.parPoids) {
  console.log(`  poids du modèle ${String(p.w * 100).padStart(3)} %   log-loss ${p.validation.toFixed(4)}${p.w === apport.poidsRetenu ? '   ← retenu' : ''}`);
}
console.log(apport.poidsRetenu > 0 && apport.gainValidation > 0
  ? `  ✅ Le modèle apporte une information : ${pct(apport.gainValidation, 2)} de log-loss en moins sur la moitié de vérification.\n`
  : '  ❌ Le modèle n\'ajoute rien aux cotes : le mélange le plus précis est le marché seul.\n');

// ── 2. Les value du modèle tiennent-elles face à la clôture ? ──
const rnd = mulberry32(20261002);
console.log('── 2. Paris où le modèle voit une value face à la meilleure cote d\'avant-match ──');
console.log('  seuil    paris     rendement [IC 95 %]              CLV face à la clôture [IC 95 %]');
const bilans = {};
for (const seuilEdge of [0.03, 0.05, 0.10, 0.20]) {
  const b = bilanParis(parisDuModele(notees, { seuilEdge }), { rnd });
  bilans[seuilEdge] = b;
  console.log(`  > ${String(seuilEdge * 100).padStart(2)} %  ${String(b.n).padStart(6)}   ${pct(b.roi)} ${ic(b.icRoi).padEnd(22)}   ${pct(b.clv)} ${ic(b.icClv)}`);
}

// Le seuil de 5 % est fixé AVANT de regarder : c'est lui qui rend le verdict.
// Les autres sont montrés pour la forme de la courbe, pas pour y piocher le
// meilleur — choisir après coup le seuil qui gagne, c'est tricher.
const principal = bilans[0.05];
console.log('\n── Par marché et par saison (seuil 5 %) ──');
const paris5 = parisDuModele(notees, { seuilEdge: 0.05 });
for (const marche of ['1X2', 'OU2.5']) {
  const b = bilanParis(paris5.filter(p => p.marche === marche), { rnd });
  console.log(`  ${marche.padEnd(6)} ${String(b.n).padStart(6)} paris · rendement ${pct(b.roi)} · CLV ${pct(b.clv)} ${ic(b.icClv)}`);
}
for (const saison of saisons) {
  const a = 2000 + Number(saison.slice(0, 2));
  const dansSaison = paris5.filter(p => p.date >= `${a}-07-01` && p.date < `${a + 1}-07-01`);
  if (!dansSaison.length) continue;
  const b = bilanParis(dansSaison, { rnd });
  console.log(`  ${saison}   ${String(b.n).padStart(6)} paris · rendement ${pct(b.roi)} · CLV ${pct(b.clv)}`);
}

const VERDICTS = {
  'bat la clôture': '✅ Le modèle bat la clôture : ses value tiennent face au marché. Il peut servir de filtre.',
  'ne bat pas la clôture': '❌ Le modèle ne bat pas la clôture : ses « value » sont ses erreurs, le marché les corrige.',
  'non concluant': '➖ Non concluant : l\'intervalle du CLV contient zéro.',
  'insuffisant': '⏳ Moins de 100 paris mesurables : aucun verdict.',
};
console.log(`\n${VERDICTS[principal.verdict]}`);
console.log(`::HIST_N::${principal.n}`);
console.log(`::HIST_CLV::${principal.clv == null ? '' : (principal.clv * 100).toFixed(2)}`);
console.log(`::HIST_VERDICT::${principal.verdict}`);
console.log('\nRappel : mesures sur le passé. Elles ne promettent aucun gain futur.');
process.exit(0);
