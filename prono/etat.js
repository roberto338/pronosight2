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

const m = await etatMemoire();
const c = await couvertureEquipes(10);

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
