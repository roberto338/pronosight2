// Applique la migration 010. Sans argument : APERÇU seulement.
// Avec --appliquer : exécute réellement.
//
//   node nexus/migrations/run_010_pronostics_unicite.js
//   node nexus/migrations/run_010_pronostics_unicite.js --appliquer

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool, { query } from '../../db/database.js';

const ici = dirname(fileURLToPath(import.meta.url));
const appliquer = process.argv.includes('--appliquer');

const doublons = `
  SELECT a.id AS id_supprime, b.id AS id_conserve, a.date,
         a.match, a.pronostic_principal, a.cote_estimee AS cote_supprimee,
         b.cote_estimee AS cote_conservee
  FROM ps_pronostics a
  JOIN ps_pronostics b
    ON a.date = b.date
   AND lower(regexp_replace(a.match, '\\s+', ' ', 'g')) =
       lower(regexp_replace(b.match, '\\s+', ' ', 'g'))
   AND a.id < b.id
  ORDER BY a.date, a.id`;

const { rows } = await query(doublons);
console.log(`\nDoublons détectés : ${rows.length}`);
if (rows.length) console.table(rows.map(r => ({
  supprime: r.id_supprime, conserve: r.id_conserve,
  match: r.match, pari: r.pronostic_principal,
  cotes: `${r.cote_supprimee} -> ${r.cote_conservee}`,
})));

if (!appliquer) {
  console.log('\nAPERÇU — rien n\'a été modifié. Relancer avec --appliquer.');
  await pool.end();
  process.exit(0);
}

const sql = await readFile(join(ici, '010_pronostics_unicite.sql'), 'utf8');
await query(sql);
console.log('\n✅ Migration 010 appliquée');

const { rows: [v] } = await query(`
  SELECT COUNT(*)::int AS index_present FROM pg_indexes
  WHERE tablename = 'ps_pronostics' AND indexname = 'idx_ps_pronostics_unique_jour'`);
console.log(`   index d'unicité : ${v.index_present ? 'présent ✅' : 'ABSENT ❌'}`);

const { rows: reste } = await query(doublons);
console.log(`   doublons restants : ${reste.length}`);
await pool.end();
