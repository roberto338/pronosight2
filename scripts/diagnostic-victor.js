// ══════════════════════════════════════════════
// scripts/diagnostic-victor.js — pourquoi Victor ne publie plus rien
// ══════════════════════════════════════════════
//
//   node scripts/diagnostic-victor.js            (16 derniers jours)
//   node scripts/diagnostic-victor.js --jours=30
//
// LECTURE SEULE. N'écrit rien, n'appelle aucune API, ne relance aucun job.
//
// Le 01/10, le heartbeat signale « Aucun pronostic depuis 11 jours » tout en
// comptant 0 job échoué. Les deux sont compatibles : runVictor peut se
// terminer proprement avec zéro pronostic. Il renvoie alors une `raison` et
// la liste de ses `rejets`, que prematchWorker stocke dans
// victor_jobs.result. La réponse est donc déjà en base — ce script la lit.

import { query } from '../db/database.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 16;

const jour = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';
const heure = (d) => d ? new Date(d).toISOString().slice(11, 16) : '—';

console.log(`\n── Diagnostic Victor — ${jours} derniers jours ──\n`);

// ── 1. Pronostics réellement écrits, jour par jour ──
const { rows: parJour } = await query(`
  SELECT date, COUNT(*)::int AS n
  FROM ps_pronostics
  WHERE date >= CURRENT_DATE - $1::int
  GROUP BY date ORDER BY date`, [jours]);
console.log('┌─ Pronostics en base par jour ─────────────────────────');
if (parJour.length === 0) console.log('│ aucun');
for (const r of parJour) console.log(`│ ${jour(r.date)}  ${String(r.n).padStart(3)}`);
console.log('└───────────────────────────────────────────────────────');

// ── 2. Chaque job, avec sa raison ──
const { rows: jobs } = await query(`
  SELECT id, name, status, attempts, created_at, started_at, completed_at, error,
         result->>'raison' AS raison,
         result->>'moteur' AS moteur,
         COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(result->'rejets') = 'array'
                                          THEN result->'rejets' END), 0) AS nb_rejets,
         result->'rejets' AS rejets,
         result
  FROM victor_jobs
  WHERE created_at >= NOW() - ($1 || ' days')::interval
    AND name <> 'heartbeat'
  ORDER BY created_at ASC`, [jours]);

console.log(`\n┌─ Jobs Victor (hors heartbeat) : ${jobs.length} ─────────────────────`);
for (const j of jobs) {
  const nb = j.result?.nbPronostics ?? j.result?.nouveaux ?? j.result?.events?.length;
  console.log(`│ ${jour(j.created_at)} ${heure(j.created_at)}  #${j.id} ${j.name.padEnd(9)} ${j.status.padEnd(8)}`
    + `${nb != null ? ` ${String(nb).padStart(2)} prono` : '         '}`
    + ` rejets=${String(j.nb_rejets).padStart(2)}`
    + `  ${j.moteur ? `[${j.moteur}] ` : ''}${j.raison || ''}`
    + `${j.error ? `  ERREUR: ${String(j.error).slice(0, 160)}` : ''}`);
}
console.log('└───────────────────────────────────────────────────────');

// ── 3. Les motifs de rejet, agrégés ──
// On réduit chaque motif à sa forme générique (sans le nom du match ni le
// détail entre parenthèses) pour voir lequel domine sur la période.
const motifs = new Map();
const exemples = new Map();
for (const j of jobs) {
  if (!Array.isArray(j.rejets)) continue;
  for (const r of j.rejets) {
    for (const m of (r.motifs || [])) {
      const generique = String(m)
        .replace(/"[^"]*"/g, '"…"')
        .replace(/\([^)]*\)/g, '(…)')
        .replace(/\d+([.,]\d+)?/g, 'N')
        .trim();
      motifs.set(generique, (motifs.get(generique) || 0) + 1);
      if (!exemples.has(generique)) exemples.set(generique, `${r.match} — ${m}`);
    }
  }
}
console.log('\n┌─ Motifs de rejet, du plus fréquent au moins fréquent ─');
if (motifs.size === 0) console.log('│ aucun rejet enregistré');
for (const [m, n] of [...motifs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`│ ${String(n).padStart(4)} × ${m.slice(0, 110)}`);
  console.log(`│        ex. ${String(exemples.get(m)).slice(0, 140)}`);
}
console.log('└───────────────────────────────────────────────────────');

// ── 4. Le dernier run prematch, en entier ──
// Pour voir ce que le résumé ci-dessus aplatit : clés présentes, compteurs.
const dernier = [...jobs].reverse().find(j => j.name === 'prematch');
if (dernier) {
  const r = dernier.result || {};
  console.log(`\n── Dernier prematch #${dernier.id} (${jour(dernier.created_at)}) ──`);
  console.log(`statut ${dernier.status}, ${dernier.attempts} tentative(s), `
    + `durée ${dernier.started_at && dernier.completed_at
      ? Math.round((new Date(dernier.completed_at) - new Date(dernier.started_at)) / 1000) + ' s' : '?'}`);
  const resume = Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, Array.isArray(v) ? `[${v.length} élément(s)]` : (typeof v === 'object' && v ? '{…}' : v)]));
  console.log(JSON.stringify(resume, null, 2));
  if (Array.isArray(r.rejets) && r.rejets.length) {
    console.log('\nRejets de ce run :');
    for (const x of r.rejets.slice(0, 15)) console.log(`  • ${x.match} — ${(x.motifs || []).join(' ; ').slice(0, 220)}`);
  }
}

await pool.end();
