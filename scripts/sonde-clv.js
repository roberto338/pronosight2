// ══════════════════════════════════════════════
// scripts/sonde-clv.js — de quoi dispose-t-on pour mesurer le CLV ?
// ══════════════════════════════════════════════
//
//   node scripts/sonde-clv.js
//
// LECTURE SEULE. Une requête SQL sur ps_pronostics, ~15 fichiers publics.
//
// Le CLV (closing line value) compare la cote publiée par Victor à la cote
// de clôture de Pinnacle. Deux inconnues avant de l'écrire :
//   1. quelles compétitions et quels marchés Victor a-t-il réellement publiés,
//      avec une cote confirmée par le marché ?
//   2. football-data.co.uk couvre-t-il ces compétitions, avec quelles
//      colonnes, et la saison en cours est-elle déjà là ?

import { query } from '../db/database.js';
import pool from '../db/database.js';

console.log('── Pronostics publiés, par compétition ──');
const { rows: parCompet } = await query(`
  SELECT competition, COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE cote_confirmee)::int AS confirmes,
         COUNT(*) FILTER (WHERE cote_confirmee AND pronostic_correct IS NOT NULL)::int AS notes,
         MIN(date)::text AS debut, MAX(date)::text AS fin
  FROM ps_pronostics GROUP BY competition ORDER BY confirmes DESC, n DESC`);
for (const r of parCompet) {
  console.log(`  ${String(r.confirmes).padStart(3)} confirmés / ${String(r.n).padStart(3)} · ${r.debut} → ${r.fin} · ${r.competition}`);
}

console.log('\n── Marchés (pari_code) des pronostics à cote confirmée ──');
const { rows: parMarche } = await query(`
  SELECT COALESCE(pari_code, '(aucun)') AS code, COUNT(*)::int AS n
  FROM ps_pronostics WHERE cote_confirmee GROUP BY 1 ORDER BY n DESC`);
for (const r of parMarche) console.log(`  ${String(r.n).padStart(3)} · ${r.code}`);

console.log('\n── Exemples ──');
const { rows: ex } = await query(`
  SELECT date::text, heure, competition, equipe_a, equipe_b, match, pari_code, cote_estimee
  FROM ps_pronostics WHERE cote_confirmee ORDER BY date DESC LIMIT 12`);
for (const r of ex) console.log(`  ${r.date} ${r.heure ?? '--:--'} [${r.competition}] ${r.equipe_a} | ${r.equipe_b} (« ${r.match} ») · ${r.pari_code} @ ${r.cote_estimee}`);

await pool.end?.();

// ── football-data.co.uk ──
async function lireCsv(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'PronoSight-sonde/1.0' } });
    if (!r.ok) return { statut: r.status, lignes: [] };
    const texte = (await r.text()).replace(/^﻿/, '');
    const lignes = texte.split(/\r?\n/).filter(l => l.trim());
    return { statut: r.status, lignes };
  } catch (err) {
    return { statut: 0, lignes: [], erreur: err.message };
  }
}

console.log('\n── football-data.co.uk : ligues principales ──');
for (const saison of ['2526', '2627']) {
  for (const div of ['E0', 'E1', 'SP1', 'D1', 'I1', 'F1', 'N1', 'P1', 'B1', 'SC0', 'T1']) {
    const r = await lireCsv(`https://www.football-data.co.uk/mmz4281/${saison}/${div}.csv`);
    const entete = r.lignes[0]?.split(',') ?? [];
    const cloture = entete.filter(c => /^(PSC|AvgC|PC|B365C)/.test(c));
    const dernier = r.lignes.at(-1)?.split(',').slice(1, 5).join(' ') ?? '';
    console.log(`  ${saison}/${div.padEnd(4)} HTTP ${r.statut} · ${Math.max(0, r.lignes.length - 1)} match(s) · clôture : ${cloture.join(' ') || '—'} · dernier : ${dernier}`);
  }
}
{
  const r = await lireCsv('https://www.football-data.co.uk/mmz4281/2627/E0.csv');
  if (r.lignes[0]) console.log(`\n  colonnes E0 2026-27 : ${r.lignes[0]}`);
}

console.log('\n── football-data.co.uk : autres ligues (fichier unique) ──');
for (const code of ['BRA', 'ARG', 'USA', 'MEX', 'JPN', 'SWE', 'NOR', 'CHN', 'DNK', 'AUT', 'SWZ', 'POL', 'IRL', 'FIN', 'ROU', 'RUS']) {
  const r = await lireCsv(`https://www.football-data.co.uk/new/${code}.csv`);
  const entete = r.lignes[0]?.split(',') ?? [];
  const recents = r.lignes.slice(1).filter(l => /\/2026,/.test(l)).length;
  const dernier = r.lignes.at(-1)?.split(',').slice(3, 7).join(' ') ?? '';
  console.log(`  ${code.padEnd(4)} HTTP ${r.statut} · ${recents} match(s) en 2026 · dernier : ${dernier}`);
  if (code === 'BRA' && entete.length) console.log(`       colonnes : ${entete.join(',')}`);
}
process.exit(0);
