// ══════════════════════════════════════════════
// prono/backfill.js — amorçage de la mémoire du moteur
// ══════════════════════════════════════════════
//
// Sans argument : APERÇU seulement. Avec --appliquer : collecte réellement.
//
//   node prono/backfill.js
//   node prono/backfill.js --appliquer
//   node prono/backfill.js --jours=120 --appliquer
//
// POURQUOI CE SCRIPT EXISTE
//
// Le modèle de Poisson a besoin d'une dizaine de rencontres par équipe. Si
// l'on se contentait d'accumuler à partir d'aujourd'hui, le moteur resterait
// muet pendant une dizaine de semaines — et invérifiable pendant tout ce
// temps. Une collecte unique de 90 jours le rend opérationnel le jour même.
//
// COÛT
//
// football-data limite les plages à 10 jours : 90 jours = 9 requêtes, à
// comparer au plafond de 10 par MINUTE. Le throttle de victor/sources.js est
// partagé et fait les pauses nécessaires. Aucun crédit The Odds API n'est
// consommé : ce script ne touche pas aux cotes.
//
// Ce script écrit UNIQUEMENT dans pa_match_results. Aucune table ps_* ou
// nexus_* n'est lue ni modifiée.

import { fetchResultatsPeriode, requetesPourPeriode } from '../victor/sources.js';
import { enregistrerResultats, ligneDepuisFixture, etatMemoire, couvertureEquipes } from './data/repository.js';
import { SOURCES_MEMORISEES } from './data/normalisation.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const appliquer = args.includes('--appliquer');
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 90;

if (!Number.isInteger(jours) || jours < 10 || jours > 365) {
  console.error('❌ --jours doit être un entier entre 10 et 365.');
  process.exit(1);
}

console.log(`\n── Amorçage du moteur statistique ──`);
console.log(`Période demandée : ${jours} jours`);
console.log(`Requêtes football-data : ${requetesPourPeriode(jours)} (plafond 10/min, pauses automatiques)`);
console.log(`Crédits The Odds API consommés : 0`);

if (!process.env.FOOTBALL_DATA_KEY) {
  console.error('\n❌ FOOTBALL_DATA_KEY absente — la collecte est impossible.');
  await pool.end();
  process.exit(1);
}

const avant = await etatMemoire();
console.log(`\nMémoire actuelle : ${avant.total} rencontre(s)`
  + (avant.total > 0 ? `, ${avant.competitions} compétition(s), du ${String(avant.plus_ancien).slice(0, 10)} au ${String(avant.plus_recent).slice(0, 10)}` : ''));

if (!appliquer) {
  console.log('\nAPERÇU — aucune requête envoyée, rien n\'a été écrit.');
  console.log('Relancer avec --appliquer pour lancer la collecte.');
  await pool.end();
  process.exit(0);
}

console.log('\nCollecte en cours…');
const debut = Date.now();
const fixtures = await fetchResultatsPeriode(jours);
console.log(`   ${fixtures.length} rencontre(s) reçue(s) en ${Math.round((Date.now() - debut) / 1000)}s`);

// Ce qui est écarté, et pourquoi — sinon l'écart entre reçu et retenu
// resterait inexpliqué, et on ne saurait pas si la collecte a échoué.
const motifs = { 'autre sport': 0, 'autre source': 0, 'non terminé': 0, 'sans score': 0, 'sans identifiant': 0 };
for (const f of fixtures) {
  if (ligneDepuisFixture(f)) continue;
  if (f.sport && f.sport !== 'Football') motifs['autre sport']++;
  else if (!SOURCES_MEMORISEES.has(f.source)) motifs['autre source']++;
  else if (f.status !== 'FT') motifs['non terminé']++;
  else if (f.homeGoals == null || f.awayGoals == null) motifs['sans score']++;
  else motifs['sans identifiant']++;
}

const bilan = await enregistrerResultats(fixtures);
console.log(`   ${bilan.retenus} exploitable(s), ${bilan.inseres} nouvelle(s) en base`);
const ecartes = Object.entries(motifs).filter(([, n]) => n > 0);
if (ecartes.length) console.log(`   écartées : ${ecartes.map(([m, n]) => `${n} ${m}`).join(', ')}`);
if (bilan.retenus > bilan.inseres) {
  console.log(`   ${bilan.retenus - bilan.inseres} déjà connue(s) — insertion idempotente, aucun doublon`);
}

const apres = await etatMemoire();
const couv = await couvertureEquipes(10);
console.log(`\nMémoire : ${avant.total} → ${apres.total} rencontre(s), ${apres.competitions} compétition(s)`);
console.log(`Équipes connues : ${couv.equipes}, dont ${couv.suffisantes} avec au moins 10 matchs (moyenne ${couv.moyenne})`);

// Le verdict qui compte : le moteur est-il utilisable, et sur quoi ?
//
// Le premier jet de ce script affichait « ✅ 4% des équipes sont exploitables ».
// Une coche verte sur un résultat inexploitable est pire que pas de verdict :
// elle invite à passer à la suite. Les seuils ci-dessous sont explicites.
const part = Math.round(100 * couv.suffisantes / Math.max(couv.equipes, 1));
console.log('');
if (part >= 50) {
  console.log(`✅ ${part}% des équipes sont exploitables par le modèle.`);
} else if (part >= 25) {
  console.log(`⚠️  ${part}% seulement des équipes sont exploitables.`);
  console.log(`   Le moteur tournera, mais refusera de conclure sur la majorité des matchs.`);
} else {
  console.log(`⛔ ${part}% des équipes sont exploitables — le moteur est inutilisable en l'état.`);
  console.log(`   Les intervalles seront muets et les confiances nulles presque partout.`);
}
if (part < 50) {
  console.log(`\n   Élargir la fenêtre : --jours=180 (aligné sur FENETRE_JOURS, que`);
  console.log(`   repository.js utilise déjà pour lire l'historique).`);
  console.log(`   En Europe, 90 jours depuis septembre tombent en pleine trêve estivale :`);
  console.log(`   la collecte est correcte, c'est le calendrier qui est vide.`);
}

await pool.end();
