// Applique la migration 011 puis reprend l'historique : chaque pronostic
// existant reçoit son code, déduit de son libellé.
//
//   node nexus/migrations/run_011_pari_code.js              (aperçu)
//   node nexus/migrations/run_011_pari_code.js --appliquer

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool, { query } from '../../db/database.js';
import { codeDepuisTexte, evaluerCode, libelleCode } from '../../victor/paris.js';

const ici = dirname(fileURLToPath(import.meta.url));
const appliquer = process.argv.includes('--appliquer');

const { rows } = await query(`
  SELECT id, to_char(date,'DD/MM') j, match, equipe_a, equipe_b,
         pronostic_principal, score_reel, pronostic_correct
  FROM ps_pronostics ORDER BY date, id`);

console.log(`\nReprise de ${rows.length} pronostic(s) :\n`);
const table = [];
let divergences = 0;

for (const r of rows) {
  const code = codeDepuisTexte(r.pronostic_principal, r.equipe_a, r.equipe_b);
  let recalcul = null;
  if (code && /^\d+-\d+$/.test(r.score_reel || '')) {
    const [h, a] = r.score_reel.split('-').map(Number);
    recalcul = evaluerCode(code, h, a);
  }
  const diverge = recalcul !== null && r.pronostic_correct !== null && recalcul !== r.pronostic_correct;
  if (diverge) divergences++;

  table.push({
    id: r.id, j: r.j,
    pari: (r.pronostic_principal || '').slice(0, 30),
    code: code || '— NON CODABLE',
    score: r.score_reel || '—',
    base: r.pronostic_correct === null ? '—' : String(r.pronostic_correct),
    recalcul: recalcul === null ? '—' : String(recalcul),
    ecart: diverge ? '🔴' : '',
  });
}
console.table(table);

const sansCode = table.filter(t => t.code.startsWith('—')).length;
console.log(`Codés : ${rows.length - sansCode}/${rows.length}   ·   divergences avec la notation actuelle : ${divergences}`);

if (!appliquer) { console.log('\nAPERÇU — rien modifié. Relancer avec --appliquer.'); await pool.end(); process.exit(0); }

await query(await readFile(join(ici, '011_pari_code.sql'), 'utf8'));
console.log('\n✅ Colonne pari_code ajoutée');

let ecrits = 0;
for (const r of rows) {
  const code = codeDepuisTexte(r.pronostic_principal, r.equipe_a, r.equipe_b);
  if (!code) continue;
  // Le libellé est réécrit depuis le code : une seule source de vérité.
  const libelle = libelleCode(code, r.equipe_a || 'Domicile', r.equipe_b || 'Extérieur');
  let correct = r.pronostic_correct;
  if (/^\d+-\d+$/.test(r.score_reel || '')) {
    const [h, a] = r.score_reel.split('-').map(Number);
    correct = evaluerCode(code, h, a);
  }
  await query(
    `UPDATE ps_pronostics SET pari_code = $1, pronostic_principal = $2,
            pronostic_correct = $3, updated_at = NOW() WHERE id = $4`,
    [code, libelle, correct, r.id]);
  ecrits++;
}
console.log(`✅ ${ecrits} pronostic(s) codé(s) et renotés`);

const { rows: [v] } = await query(`
  SELECT COUNT(*)::int total, COUNT(pari_code)::int codes,
         COUNT(*) FILTER (WHERE pronostic_correct)::int gagnes,
         COUNT(pronostic_correct)::int notes
  FROM ps_pronostics`);
console.log(`\nÉtat : ${v.codes}/${v.total} codés · ${v.gagnes}/${v.notes} gagnants`);
await pool.end();
