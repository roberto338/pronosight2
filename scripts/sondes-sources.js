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

// Premier passage (01/10) : la clé est valide, le classement répond, mais
// `matches?dateFrom&dateTo&status=FINISHED` renvoie ZÉRO match sur cinq
// jours en pleine saison — la même requête en rendait 1 449 le 18/09. On
// teste donc chaque forme d'appel qu'utilise victor/sources.js, pour
// trouver laquelle a cessé de répondre. 6 requêtes : le throttle maison
// n'est pas chargé ici, elles restent sous le plafond de 10 par minute.
const hier = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const sondes = [
  ['/matches terminés, fenêtre 5 j (buildFormIndex)', `matches?dateFrom=${ilYa5j}&dateTo=${aujourdhui}&status=FINISHED`],
  ['/matches fenêtre 5 j, SANS filtre de statut',      `matches?dateFrom=${ilYa5j}&dateTo=${aujourdhui}`],
  ['/matches du jour (getFixturesOfDay)',              `matches?date=${aujourdhui}`],
  ['/matches d\'hier, terminés (getResultsOfDay)',     `matches?date=${hier}&status=FINISHED`],
  ['/matches sans paramètre',                          'matches'],
  ['/competitions/PL/matches fenêtre 5 j',             `competitions/PL/matches?dateFrom=${ilYa5j}&dateTo=${aujourdhui}`],
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
    // Ce que l'API dit d'elle-même : filtres effectivement appliqués et
    // compétitions couvertes. C'est là qu'un changement de comportement se voit.
    if (json.filters) console.log(`  filtres appliqués : ${JSON.stringify(json.filters)}`);
    if (json.resultSet) console.log(`  resultSet : ${JSON.stringify(json.resultSet)}`);
    const competitions = [...new Set(json.matches.map(m => m.competition?.code))].filter(Boolean);
    if (competitions.length) console.log(`  compétitions : ${competitions.join(', ')}`);
    const statuts = [...new Set(json.matches.map(m => m.status))];
    if (statuts.length) console.log(`  statuts : ${statuts.join(', ')}`);
  } else if (json?.standings) {
    console.log(`  ${json.standings[0]?.table?.length ?? 0} équipe(s) au classement`);
  }
}
