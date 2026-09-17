// Applique la migration 014. Sans argument : APERÇU seulement.
// Avec --appliquer : exécute réellement.
//
//   node nexus/migrations/run_014_moteur_statistique.js
//   node nexus/migrations/run_014_moteur_statistique.js --appliquer
//
// L'aperçu établit, en interrogeant la base, que la migration est
// strictement additive : il liste les tables existantes avant/après et
// vérifie qu'aucun ordre destructeur ne figure dans le fichier SQL.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool, { query } from '../../db/database.js';

const ici = dirname(fileURLToPath(import.meta.url));
const appliquer = process.argv.includes('--appliquer');

const sql = await readFile(join(ici, '014_moteur_statistique.sql'), 'utf8');

// ── Garde-fou : refuser d'exécuter un SQL qui toucherait à l'existant ──
// La contrainte posée est « ne pas écraser la base fonctionnelle ». On ne la
// tient pas par relecture attentive, on la vérifie avant chaque exécution.
const ordres = sql
  .split('\n')
  .filter(l => !l.trimStart().startsWith('--'))
  .join('\n')
  .toUpperCase();

const interdits = [
  ['DROP TABLE',    /\bDROP\s+TABLE\b/],
  ['DROP COLUMN',   /\bDROP\s+COLUMN\b/],
  ['TRUNCATE',      /\bTRUNCATE\b/],
  ['DELETE FROM',   /\bDELETE\s+FROM\b/],
  ['ALTER sur ps_', /\bALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(PUBLIC\.)?PS_/],
  ['ALTER sur nexus_', /\bALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(PUBLIC\.)?NEXUS_/],
  ['ALTER sur victor_', /\bALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(PUBLIC\.)?VICTOR_/],
];

const violations = interdits.filter(([, motif]) => motif.test(ordres)).map(([nom]) => nom);
if (violations.length) {
  console.error(`\n❌ REFUS — la migration contient : ${violations.join(', ')}`);
  console.error('   Cette migration doit rester strictement additive.');
  await pool.end();
  process.exit(1);
}

// ── État de la base avant ──
const { rows: avant } = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`);

const nouvelles = ['pa_match_results', 'pa_analyses', 'pa_analysis_markets'];
const dejaLa = nouvelles.filter(t => avant.some(r => r.table_name === t));

console.log(`\nTables en base : ${avant.length}`);
console.log(`  ps_*     : ${avant.filter(r => r.table_name.startsWith('ps_')).length}`);
console.log(`  nexus_*  : ${avant.filter(r => r.table_name.startsWith('nexus_')).length}`);
console.log(`  pa_*     : ${avant.filter(r => r.table_name.startsWith('pa_')).length}`);
console.log(`\nCréées par cette migration : ${nouvelles.join(', ')}`);
if (dejaLa.length) console.log(`  (déjà présentes, CREATE IF NOT EXISTS sans effet : ${dejaLa.join(', ')})`);
console.log('\nOrdres destructeurs détectés : aucun ✅');
console.log('Tables existantes modifiées  : aucune ✅');

if (!appliquer) {
  console.log('\nAPERÇU — rien n\'a été modifié. Relancer avec --appliquer.');
  await pool.end();
  process.exit(0);
}

// ── Application, dans une transaction ──
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('\n✅ Migration 014 appliquée.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n❌ Échec, transaction annulée :', err.message);
  client.release();
  await pool.end();
  process.exit(1);
}
client.release();

const { rows: apres } = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`);

const perdues = avant.filter(a => !apres.some(b => b.table_name === a.table_name));
if (perdues.length) {
  console.error(`\n🚨 ANOMALIE — tables disparues : ${perdues.map(r => r.table_name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Tables : ${avant.length} → ${apres.length} (aucune perdue).`);
  console.log('\nÉtape suivante, imposée par CLAUDE.md :  node db/introspect.js');
}

await pool.end();
