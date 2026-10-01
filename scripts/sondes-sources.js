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
const CLE_AF = process.env.API_FOOTBALL_KEY || process.env.RAPIDAPI_KEY;

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
  // Deuxième passage (01/10) : les six formes ci-dessus renvoient toutes 0,
  // et /competitions/PL/matches ignore les dates pour n'appliquer que
  // season=2026. Reste à distinguer deux causes qui n'appellent pas la même
  // action : un changement de plan (périmètre des compétitions réduit) ou une
  // saison vidée chez football-data (classement à zéro match joué).
  ['Compétitions accessibles avec ce plan',            'competitions'],
  ['/competitions/PL/matches saison précédente',       'competitions/PL/matches?season=2025'],
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
    const table = json.standings[0]?.table ?? [];
    const joues = table.reduce((a, r) => a + (r.playedGames || 0), 0);
    console.log(`  ${table.length} équipe(s) au classement, ${joues} match(s) joué(s) au total`);
    console.log(`  saison : ${json.season?.startDate} → ${json.season?.endDate}, journée ${json.season?.currentMatchday}`);
    for (const r of table.slice(0, 3)) console.log(`    ${r.position}. ${r.team?.shortName} — ${r.playedGames} j, ${r.points} pts`);
  } else if (json?.competitions) {
    console.log(`  ${json.competitions.length} compétition(s) : ${json.competitions.map(c => c.code).join(', ')}`);
    const pl = json.competitions.find(c => c.code === 'PL');
    if (pl) console.log(`  PL saison courante : ${pl.currentSeason?.startDate} → ${pl.currentSeason?.endDate}, journée ${pl.currentSeason?.currentMatchday}`);
  }
}

// ══════════════════════════════════════════════
// API-Football — le secours de la PR #1 peut-il fonctionner ?
// ══════════════════════════════════════════════
// Le correctif complète forme et classement par /standings d'API-Football.
// Deux conditions à vérifier avant de fusionner : la clé est valide, et le
// plan gratuit donne accès au classement de la saison EN COURS — certains
// plans gratuits sont limités aux saisons passées. 2 requêtes sur 100/jour.
console.log('\n── API-Football ──');
if (!CLE_AF) {
  console.log('  Clé absente du dépôt (secret API_FOOTBALL_KEY). Sonde non exécutée.');
} else {
  for (const [nom, chemin] of [
    ['Compte et quota du jour',              'status'],
    ['Classement Premier League 2026',       'standings?league=39&season=2026'],
  ]) {
    try {
      const res = await fetch(`https://v3.football.api-sports.io/${chemin}`, { headers: { 'x-apisports-key': CLE_AF } });
      const json = await res.json();
      console.log(`\n${nom}\n  HTTP ${res.status}`);
      const errs = json?.errors;
      const enErreur = Array.isArray(errs) ? errs.length > 0 : Boolean(errs && Object.keys(errs).length);
      if (enErreur) { console.log(`  REFUS : ${JSON.stringify(errs)}`); continue; }
      if (chemin === 'status') {
        const r = json.response || {};
        console.log(`  plan : ${r.subscription?.plan ?? '?'} · actif : ${r.subscription?.active ?? '?'} · fin : ${r.subscription?.end ?? '?'}`);
        console.log(`  requêtes aujourd'hui : ${r.requests?.current ?? '?'} / ${r.requests?.limit_day ?? '?'}`);
      } else {
        const table = json.response?.[0]?.league?.standings?.[0] ?? [];
        console.log(`  ${table.length} équipe(s) · ${table.slice(0, 2).map(t => `${t.rank}. ${t.team?.name} (${t.all?.played} j, forme ${t.form})`).join(' · ')}`);
        console.log(table.length > 0 ? '  ✅ Le secours de la PR #1 fonctionnera.' : '  ⛔ Aucun classement : le secours ne pourra rien fournir.');
      }
    } catch (err) {
      console.log(`\n${nom}\n  ÉCHEC : ${err.message}`);
    }
  }
}
