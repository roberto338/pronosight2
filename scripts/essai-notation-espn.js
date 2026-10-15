// ══════════════════════════════════════════════
// scripts/essai-notation-espn.js — ESPN noterait-il les pronos en attente ?
// ══════════════════════════════════════════════
//
//   node scripts/essai-notation-espn.js            (14 derniers jours)
//   node scripts/essai-notation-espn.js --jours=20
//
// LECTURE SEULE. N'écrit rien en base : pour chaque prono de Victor sans
// résultat, cherche le score sur ESPN (secours de checkResults) et affiche
// le verdict qui SERAIT enregistré. Puis deux contrôles : les jobs du
// dimanche 11/10 (bilan de la veille absent) et l'erreur complète du job
// value du 14/10.

import { query } from '../db/database.js';
import pool from '../db/database.js';
import { liguesCandidates } from '../victor/espn.js';
import { scoreEspnProno, lecteurScoresEspn } from '../victor/valeur-suivi.js';
import { evaluerCode } from '../victor/paris.js';

const args = process.argv.slice(2);
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 14;

console.log(`\n── Notation ESPN des pronos en attente — ${jours} derniers jours (aucune écriture) ──\n`);
const { rows } = await query(`
  SELECT id, to_char(date, 'YYYY-MM-DD') AS date_iso, equipe_a, equipe_b, competition, pronostic_principal, pari_code
  FROM ps_pronostics
  WHERE date >= CURRENT_DATE - $1::int AND resultat_reel IS NULL AND date < CURRENT_DATE
  ORDER BY date, id`, [jours]);

const lire = lecteurScoresEspn();
let trouves = 0;
for (const p of rows) {
  const ligues = liguesCandidates(p.competition);
  const sc = ligues.length ? await scoreEspnProno(p, lire) : null;
  const verdict = sc ? evaluerCode(p.pari_code, sc.butsDom, sc.butsExt) : null;
  if (sc) trouves++;
  console.log(`${p.date_iso} #${p.id} ${p.equipe_a} – ${p.equipe_b} (${p.competition} → ${ligues.join(',') || 'aucune ligue'})`
    + ` · ${p.pronostic_principal} [${p.pari_code || 'sans code'}]`
    + ` → ${sc ? `${sc.butsDom}-${sc.butsExt} ${verdict === true ? 'GAGNÉ' : verdict === false ? 'PERDU' : 'non tranché'}` : 'introuvable'}`);
}
console.log(`\n→ ${trouves}/${rows.length} pronos en attente seraient notés par ESPN.`);

console.log('\n── Jobs du samedi 10/10 au lundi 12/10 (heure de Paris) ──');
const { rows: jobs } = await query(`
  SELECT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS cree,
         to_char(completed_at AT TIME ZONE 'Europe/Paris', 'HH24:MI') AS fini,
         id, name, status, attempts, dedupe_key, left(coalesce(error, ''), 200) AS error
  FROM victor_jobs
  WHERE created_at >= '2026-10-10 00:00+02' AND created_at < '2026-10-13 00:00+02'
  ORDER BY created_at`);
for (const j of jobs) console.log(`${j.cree} → ${j.fini || '—'} #${j.id} ${j.name.padEnd(13)} ${j.status.padEnd(8)} essais=${j.attempts} clé=${j.dedupe_key || '—'}${j.error ? ` ERREUR ${j.error}` : ''}`);
const { rows: cle } = await query(`SELECT id, name, status, created_at FROM victor_jobs WHERE dedupe_key LIKE 'recap-veille-2026-10-1%' ORDER BY id`);
console.log(`Clés recap-veille du 10 au 19/10 : ${cle.map(c => `#${c.id} ${c.status}`).join(', ') || 'aucune'}`);

console.log('\n── Jobs en échec des 14 derniers jours : erreur complète ──');
const { rows: echecs } = await query(`
  SELECT id, name, to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS cree, attempts, error
  FROM victor_jobs WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '14 days' ORDER BY id`);
for (const j of echecs) console.log(`#${j.id} ${j.name} ${j.cree} essais=${j.attempts}\n${String(j.error || '').replace(/\s+/g, ' ').slice(0, 1500)}\n`);
if (!echecs.length) console.log('aucun');

await pool.end();
