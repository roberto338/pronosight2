// ══════════════════════════════════════════════
// scripts/bilan-victor.js — ce que Victor a publié, et ce que ça a donné
// ══════════════════════════════════════════════
//
//   node scripts/bilan-victor.js            (12 derniers jours)
//   node scripts/bilan-victor.js --jours=30
//
// LECTURE SEULE. N'écrit rien, n'appelle aucune API, ne relance aucun job.
// Mêmes calculs que /bilan et l'écran « Bilan Victor » (valeur-suivi.js),
// plus chaque prono un par un et les jobs de bilan Telegram (envoyés ou non).

import { query } from '../db/database.js';
import pool from '../db/database.js';
import { bilanVictor, bilanValeursMarche } from '../victor/valeur-suivi.js';

const args = process.argv.slice(2);
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 12;
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)} %`);
const rond = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const ligne = (b) => (b?.n ? `${String(b.n).padStart(4)} paris · ${rond(b.taux).padStart(5)} gagnés · cotes ${rond(b.attendu).padStart(5)} · rendement ${pct(b.rendement)}` : '   aucun pari noté');

console.log(`\n── Bilan Victor — ${jours} derniers jours ──\n`);

// ── 1. Chaque prono, avec son résultat ──
const { rows: pronos } = await query(`
  SELECT to_char(date, 'YYYY-MM-DD') AS date, equipe_a, equipe_b, competition, pronostic_principal,
         pari_code, cote_estimee, cote_confirmee, confiance, pronostic_correct, score_reel, moteur
  FROM ps_pronostics WHERE date >= CURRENT_DATE - $1::int ORDER BY date, id`, [jours]);
console.log(`┌─ Pronos publiés : ${pronos.length} ───────────────────────────`);
for (const p of pronos) {
  const res = p.pronostic_correct === true ? 'GAGNÉ ' : p.pronostic_correct === false ? 'PERDU ' : 'attente';
  const cote = p.cote_estimee ? `@ ${Number(p.cote_estimee).toFixed(2)}${p.cote_confirmee ? '' : ' (est.)'}` : '';
  console.log(`│ ${p.date} ${res} ${p.equipe_a} – ${p.equipe_b} (${p.competition || '?'}) · ${p.pronostic_principal} ${cote}`
    + `${p.score_reel ? ` · ${p.score_reel}` : ''}${p.moteur ? ` · ${p.moteur}` : ''}`);
}
const notes = pronos.filter(p => p.pronostic_correct != null);
console.log(`│ → ${notes.filter(p => p.pronostic_correct).length} gagnés / ${notes.length} notés, ${pronos.length - notes.length} en attente`);
console.log('└───────────────────────────────────────────────────────');

// ── 2. Fiabilité par période (paris à cote de marché, hors DC, mise fixe) ──
const bv = await bilanVictor();
console.log('\n┌─ Fiabilité de Victor (cote de marché, mise fixe) ─────');
for (const c of ['semaine', 'mois', 'sixMois', 'annee', 'total']) console.log(`│ ${bv.periodes[c].libelle.padEnd(17)} ${ligne(bv.periodes[c])}`);
console.log(`│ premier pari compté : ${bv.premier || '—'}`);
console.log('│ Mois par mois :');
for (const m of bv.mois.filter(m => m.n)) console.log(`│   ${m.mois}  ${ligne(m)}`);
console.log('└───────────────────────────────────────────────────────');

// ── 3. Values de marché ──
try {
  const bm = await bilanValeursMarche();
  const { rows: vj } = await query(`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE gagne)::int AS g, COUNT(*) FILTER (WHERE gagne IS NOT NULL)::int AS notes
    FROM ps_valeurs_marche WHERE date >= CURRENT_DATE - $1::int GROUP BY date ORDER BY date`, [jours]);
  console.log('\n┌─ Values de marché ────────────────────────────────────');
  for (const r of vj) console.log(`│ ${r.date}  ${String(r.n).padStart(3)} values · ${r.g}/${r.notes} gagnées`);
  console.log(`│ Depuis le début : ${bm.total.n} notées · ${bm.total.gagnes} gagnées · rendement ${pct(bm.total.rendement)}`);
  console.log(`│ 30 derniers jours : ${bm.trenteJours.n} notées · rendement ${pct(bm.trenteJours.rendement)}`);
  console.log('└───────────────────────────────────────────────────────');
} catch (err) {
  console.log(`\nValues de marché : illisibles (${err.message})`);
}

// ── 4. Jobs : Victor a-t-il tourné, les bilans Telegram sont-ils partis ? ──
const { rows: jobs } = await query(`
  SELECT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS quand, id, name, status, attempts, error, result
  FROM victor_jobs
  WHERE created_at >= NOW() - ($1::int || ' days')::interval AND name <> 'heartbeat'
  ORDER BY created_at`, [jours]);
console.log(`\n┌─ Jobs (hors heartbeat) : ${jobs.length} ─────────────────────────`);
for (const j of jobs) {
  const r = j.result || {};
  const detail = j.name === 'recap-veille' || j.name === 'bilan-periode'
    ? `envoyé=${r.envoye ?? '?'} ${r.date || `${r.debut || ''}→${r.fin || ''}`} pronos=${r.pronos ?? r.paris ?? '?'}`
    : j.name === 'prematch' || j.name === 'value'
      ? `pronos=${r.nbPronostics ?? '?'} rejets=${r.nbRejets ?? '?'} values=${r.nbValeursMarche ?? '?'} telegram=${r.telegramSent ?? '?'}${r.moteur ? ` moteur=${r.moteur}` : ''}${r.raison ? ` raison=${String(r.raison).slice(0, 80)}` : ''}`
      : '';
  console.log(`│ ${j.quand} #${j.id} ${j.name.padEnd(13)} ${j.status.padEnd(9)} ${detail}${j.error ? ` ERREUR ${String(j.error).slice(0, 120)}` : ''}`);
}
console.log('└───────────────────────────────────────────────────────');

await pool.end();
