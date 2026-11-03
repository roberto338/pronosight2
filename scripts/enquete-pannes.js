// ══════════════════════════════════════════════
// scripts/enquete-pannes.js — quota de cotes épuisé, moteurs IA en panne
// ══════════════════════════════════════════════
//
//   node scripts/enquete-pannes.js            (21 derniers jours)
//
// LECTURE SEULE. Les 30 et 31/10, Victor n'a rien publié : « aucune cote de
// marché obtenue (quota… ». Le 03/11 à 13h, les trois moteurs IA ont échoué
// ensemble. Ce script sort ce que la base en garde : motif complet des jobs,
// erreur complète des échecs, et ce que usage_log (écrit par Nexus, qui
// partage la clé The Odds API) a enregistré.

import { query } from '../db/database.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 21;

console.log(`\n── 1. Jobs en échec (${jours} jours) : erreur complète ──`);
const { rows: echecs } = await query(`
  SELECT id, name, to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS quand, attempts, error
  FROM victor_jobs WHERE status = 'failed' AND created_at >= NOW() - ($1::int || ' days')::interval ORDER BY id`, [jours]);
for (const j of echecs) console.log(`#${j.id} ${j.name} ${j.quand} essais=${j.attempts}\n${String(j.error || '').replace(/\s+/g, ' ').slice(0, 2000)}\n`);
if (!echecs.length) console.log('aucun');

console.log(`\n── 2. Analyses sans cotes ou sans prono : motif complet ──`);
const { rows: vides } = await query(`
  SELECT id, name, to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS quand, result
  FROM victor_jobs
  WHERE name IN ('prematch', 'value') AND created_at >= NOW() - ($1::int || ' days')::interval
    AND (result->>'raison' IS NOT NULL OR COALESCE((result->>'nbPronostics')::int, 0) = 0)
  ORDER BY id`, [jours]);
for (const j of vides) {
  const r = j.result || {};
  console.log(`#${j.id} ${j.name} ${j.quand} · pronos=${r.nbPronostics ?? '?'} · ${r.raison || 'sans motif'}`);
  if (r.couverture) console.log(`    couverture : ${JSON.stringify(r.couverture).slice(0, 300)}`);
}

console.log(`\n── 3. Tout le contenu « result » d'un prematch récent (pour voir ce qui est tracé) ──`);
const { rows: [dernier] } = await query(`
  SELECT id, result FROM victor_jobs WHERE name = 'prematch' AND status = 'done' ORDER BY id DESC LIMIT 1`);
if (dernier) {
  const { rejets, ...reste } = dernier.result || {};
  console.log(`#${dernier.id} ${JSON.stringify(reste).slice(0, 1500)}`);
  if (Array.isArray(rejets)) for (const x of rejets.slice(0, 8)) console.log(`  rejet : ${x.match} — ${(x.motifs || []).join(' ; ').slice(0, 200)}`);
}

console.log(`\n── 4. usage_log : services enregistrés (${jours} jours) ──`);
try {
  const { rows } = await query(`
    SELECT service, COALESCE(endpoint, '') AS endpoint, COUNT(*)::int AS appels, SUM(unites)::int AS unites,
           MIN(jour) AS du, MAX(jour) AS au
    FROM usage_log WHERE jour >= CURRENT_DATE - $1::int
    GROUP BY service, endpoint ORDER BY unites DESC NULLS LAST LIMIT 30`, [jours]);
  for (const r of rows) console.log(`${String(r.service).padEnd(16)} ${String(r.endpoint).slice(0, 50).padEnd(50)} appels=${r.appels} unités=${r.unites}`);
  if (!rows.length) console.log('rien');
  const { rows: odds } = await query(`
    SELECT jour, COUNT(*)::int AS appels, SUM(unites)::int AS unites FROM usage_log
    WHERE jour >= CURRENT_DATE - $1::int AND (service ILIKE '%odds%' OR endpoint ILIKE '%odds%')
    GROUP BY jour ORDER BY jour`, [jours]);
  console.log(odds.length ? '\nThe Odds API dans usage_log, par jour :' : '\nThe Odds API : aucune trace dans usage_log.');
  for (const r of odds) console.log(`  ${r.jour.toISOString().slice(0, 10)} appels=${r.appels} unités=${r.unites}`);
} catch (err) {
  console.log(`usage_log illisible : ${err.message}`);
}

await pool.end();
