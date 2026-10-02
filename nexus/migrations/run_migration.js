// ══════════════════════════════════════════════
// nexus/migrations/run_migration.js — exécuteur générique, additif seulement
// ══════════════════════════════════════════════
//
//   node nexus/migrations/run_migration.js 015              aperçu
//   node nexus/migrations/run_migration.js 015 --appliquer  application
//
// Mêmes garde-fous que run_014_moteur_statistique.js, pour n'importe quel
// fichier NNN_*.sql : refus de tout ordre destructeur ou de toute
// modification d'une table existante, application dans une transaction,
// contrôle qu'aucune table n'a disparu. Étape suivante, imposée par
// CLAUDE.md : node db/introspect.js.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool, { query } from '../../db/database.js';

const ici = dirname(fileURLToPath(import.meta.url));
const numero = process.argv[2];
const appliquer = process.argv.includes('--appliquer');

if (!/^\d{3}$/.test(numero || '')) {
  console.error('Usage : node nexus/migrations/run_migration.js NNN [--appliquer]');
  process.exit(1);
}
const fichier = (await readdir(ici)).find(f => f.startsWith(`${numero}_`) && f.endsWith('.sql'));
if (!fichier) {
  console.error(`❌ Aucun fichier ${numero}_*.sql dans nexus/migrations/`);
  process.exit(1);
}
const sql = await readFile(join(ici, fichier), 'utf8');
console.log(`\nMigration : ${fichier}`);

// ── Garde-fou : strictement additive ──
const ordres = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').toUpperCase();
const interdits = [
  ['DROP', /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA|VIEW)\b/],
  ['TRUNCATE', /\bTRUNCATE\b/],
  ['DELETE FROM', /\bDELETE\s+FROM\b/],
  ['UPDATE', /\bUPDATE\s+\w/],
  ['ALTER TABLE', /\bALTER\s+TABLE\b/],
];
const violations = interdits.filter(([, m]) => m.test(ordres)).map(([n]) => n);
if (violations.length) {
  console.error(`❌ REFUS — ordres non additifs : ${violations.join(', ')}`);
  await pool.end();
  process.exit(1);
}

const tables = async () => (await query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map(r => r.table_name);

const creees = [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map(m => m[1]);
const avant = await tables();
console.log(`Tables en base : ${avant.length}`);
console.log(`Créées par cette migration : ${creees.join(', ') || 'aucune'}`);
const dejaLa = creees.filter(t => avant.includes(t));
if (dejaLa.length) console.log(`  (déjà présentes, sans effet : ${dejaLa.join(', ')})`);
console.log('Ordres destructeurs ou modifiant l\'existant : aucun ✅');

if (!appliquer) {
  console.log('\nAPERÇU — rien n\'a été modifié. Relancer avec --appliquer.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log(`\n✅ Migration ${numero} appliquée.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n❌ Échec, transaction annulée :', err.message);
  client.release();
  await pool.end();
  process.exit(1);
}
client.release();

const apres = await tables();
const perdues = avant.filter(t => !apres.includes(t));
if (perdues.length) {
  console.error(`🚨 ANOMALIE — tables disparues : ${perdues.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Tables : ${avant.length} → ${apres.length} (aucune perdue).`);
}
await pool.end();
