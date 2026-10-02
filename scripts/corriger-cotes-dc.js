// ══════════════════════════════════════════════
// scripts/corriger-cotes-dc.js — retirer les cotes fausses des doubles chances
// ══════════════════════════════════════════════
//
//   node scripts/corriger-cotes-dc.js              aperçu, aucune écriture
//   node scripts/corriger-cotes-dc.js --appliquer  correction
//
// Du 06 au 20/09, sept doubles chances DC:12 (« Pas de match nul ») ont été
// enregistrées avec la cote du MATCH NUL (3,01 à 3,80 au lieu d'environ 1,35)
// et marquées « cote confirmée ». Bug corrigé dans victor/odds.js (PR #4).
//
// The Odds API ne cote aucune double chance : TOUTE double chance marquée
// « cote confirmée » vient donc de ce bug. La correction retire la cote et
// le marquage — cote_estimee = NULL, cote_confirmee = false — pour que plus
// rien (statistiques du soir, /best, audits) ne la compte comme un prix.
// Le pronostic et sa notation (pronostic_correct) restent intacts.
//
// Les valeurs d'origine sont affichées avant toute écriture : elles restent
// dans le journal du run GitHub Actions.

import { query } from '../db/database.js';
import pool from '../db/database.js';

const appliquer = process.argv.includes('--appliquer');
const PLAFOND = 20;   // au-delà, ce n'est plus le bug connu : on s'arrête

const { rows } = await query(`
  SELECT id, to_char(date, 'YYYY-MM-DD') AS date, match, pari_code, pronostic_principal,
         cote_estimee, cote_confirmee, pronostic_correct
  FROM ps_pronostics
  WHERE cote_confirmee = true AND pari_code LIKE 'DC:%'
  ORDER BY date, id`);

console.log(`\n── Doubles chances marquées « cote confirmée » : ${rows.length} ──`);
for (const r of rows) {
  console.log(`  #${r.id} ${r.date} ${r.match} · ${r.pari_code} « ${r.pronostic_principal} » · cote ${r.cote_estimee}`
    + ` · ${r.pronostic_correct == null ? 'non noté' : r.pronostic_correct ? 'gagné' : 'perdu'}`);
}

if (rows.length === 0) {
  console.log('Rien à corriger.');
} else if (rows.length > PLAFOND) {
  console.log(`⛔ ${rows.length} lignes : plus que le bug connu (7). Aucune écriture — à examiner d'abord.`);
  process.exitCode = 1;
} else if (!appliquer) {
  console.log('\nAperçu seulement. Pour corriger : « corriger-dc appliquer » dans prono/DECLENCHEUR.txt.');
} else {
  const ids = rows.map(r => r.id);
  const { rowCount } = await query(`
    UPDATE ps_pronostics
    SET cote_estimee = NULL, cote_confirmee = false, updated_at = NOW()
    WHERE id = ANY($1) AND cote_confirmee = true AND pari_code LIKE 'DC:%'`, [ids]);
  console.log(`\n✅ ${rowCount} ligne(s) corrigée(s) : cote retirée, plus marquée « confirmée ».`);
}

await pool.end();
