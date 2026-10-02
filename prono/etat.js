// ══════════════════════════════════════════════
// prono/etat.js — état de la mémoire du moteur (lecture seule)
// ══════════════════════════════════════════════
//
//   node prono/etat.js
//
// N'écrit rien, ne consomme aucun quota API. Sert à répondre à la seule
// question qui compte avant d'allumer le moteur : a-t-il de quoi travailler ?

import { etatMemoire, couvertureEquipes } from './data/repository.js';
import pool from '../db/database.js';

let m, c;
try {
  m = await etatMemoire();
  c = await couvertureEquipes(10);
} catch (err) {
  // 42P01 = relation inexistante. Avant la migration 014, c'est l'état
  // NORMAL, pas une panne : le dire en une phrase vaut mieux qu'une trace
  // d'exception de quarante lignes à déchiffrer sur un écran de téléphone.
  if (err.code === '42P01') {
    console.log('\nLes tables du moteur n\'existent pas encore.');
    console.log('La connexion à la base fonctionne — c\'est déjà vérifié.');
    console.log('\nÉtape suivante : écrire « migration » dans prono/DECLENCHEUR.txt.');
    await pool.end();
    process.exit(0);
  }
  console.error(`\n❌ Lecture impossible : ${err.message}`);
  await pool.end();
  process.exit(1);
}

console.log(`\nRencontres mémorisées : ${m.total}`);
if (m.total > 0) {
  console.log(`Compétitions          : ${m.competitions}`);
  console.log(`Période couverte      : ${String(m.plus_ancien).slice(0, 10)} → ${String(m.plus_recent).slice(0, 10)}`);
}
console.log(`Équipes connues       : ${c.equipes}`);
console.log(`  dont ≥ 10 matchs    : ${c.suffisantes} (moyenne ${c.moyenne} matchs/équipe)`);

const part = c.equipes > 0 ? Math.round(100 * c.suffisantes / c.equipes) : 0;
console.log(`\nVerdict : ${
  c.suffisantes === 0 ? '⛔ moteur inexploitable — lancer le backfill'
  : part < 50         ? `⚠️  ${part}% des équipes exploitables — élargir la période`
  : `✅ ${part}% des équipes exploitables`}`);

await pool.end();
