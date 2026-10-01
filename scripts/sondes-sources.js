// ══════════════════════════════════════════════
// scripts/sondes-sources.js — football-data répond-il encore ?
// ══════════════════════════════════════════════
//
//   node scripts/sondes-sources.js
//
// LECTURE SEULE. Deux requêtes football-data, aucune écriture, aucun crédit
// The Odds API.
//
// Depuis le 21/09, chaque run prematch se conclut en 14 s par « aucun
// pronostic produit par l'IA », quel que soit le moteur (gemini, groq,
// gemma). formatFixturesForPrompt écrit « aucune donnée disponible » pour
// toute équipe sans classement ni forme — deux données qui viennent toutes
// deux de football-data — et prompt.js:30 interdit tout pari sur un tel
// match. Si football-data ne répond plus, les trois IA se taisent ensemble,
// sans erreur. Cette sonde vérifie l'hypothèse au lieu de la supposer.

const CLE = process.env.FOOTBALL_DATA_KEY;
if (!CLE) { console.error('FOOTBALL_DATA_KEY absente.'); process.exit(1); }

const aujourdhui = new Date().toISOString().slice(0, 10);
const ilYa5j = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);

const sondes = [
  ['Matchs terminés (indice de forme)', `matches?dateFrom=${ilYa5j}&dateTo=${aujourdhui}&status=FINISHED`],
  ['Classement Premier League',          'competitions/PL/standings'],
];

for (const [nom, chemin] of sondes) {
  const t = Date.now();
  let res, corps = '';
  try {
    res = await fetch(`https://api.football-data.org/v4/${chemin}`, { headers: { 'X-Auth-Token': CLE } });
    corps = await res.text();
  } catch (err) {
    console.log(`\n${nom}\n  ÉCHEC RÉSEAU : ${err.message}`);
    continue;
  }
  let json = null;
  try { json = JSON.parse(corps); } catch { /* corps non JSON */ }

  console.log(`\n${nom}`);
  console.log(`  HTTP ${res.status} en ${Date.now() - t} ms`);
  for (const h of ['x-requests-available-minute', 'x-requestcounter-reset', 'x-api-version', 'x-authenticated-client']) {
    const v = res.headers.get(h);
    if (v != null) console.log(`  ${h}: ${v}`);
  }
  if (!res.ok) {
    console.log(`  message : ${json?.message ?? corps.slice(0, 300)}`);
    if (json?.errorCode) console.log(`  errorCode : ${json.errorCode}`);
  } else if (json?.matches) {
    console.log(`  ${json.matches.length} match(s) renvoyé(s)`);
  } else if (json?.standings) {
    console.log(`  ${json.standings[0]?.table?.length ?? 0} équipe(s) au classement`);
  }
}
