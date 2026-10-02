// ══════════════════════════════════════════════
// scripts/sonde-espn.js — format réel des réponses ESPN
// ══════════════════════════════════════════════
//
//   node scripts/sonde-espn.js
//
// LECTURE SEULE, aucune clé. ~30 requêtes publiques.
//
// L'API ESPN n'est pas documentée. Avant d'en faire le secours de Victor, on
// relève sur la prod ce qu'elle rend vraiment : quelles variantes de dates
// le scoreboard accepte (la plage AAAAMMJJ-AAAAMMJJ a renvoyé HTTP 400 le
// 01/10), quels champs porte une équipe, quelles statistiques le classement
// expose, et quels codes de ligue existent. On liste aussi les matchs du jour
// de TheSportsDB pour vérifier que les noms d'équipes se rapprochent.

const DELAI_MS = 15_000;
const BASE = 'https://site.api.espn.com/apis';

async function lire(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DELAI_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PronoSight-sonde/1.0' } });
    const corps = await res.text();
    let json = null;
    try { json = JSON.parse(corps); } catch { /* non JSON */ }
    return { statut: res.status, json, corps };
  } catch (err) {
    return { statut: 0, json: null, corps: err.name === 'AbortError' ? 'délai dépassé' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const ajd = new Date();
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const il_y_a = (j) => new Date(ajd.getTime() - j * 864e5);

// ── 1. Scoreboard : quelles variantes de dates passent ? ──
console.log('── Scoreboard Premier League : variantes de dates ──');
const variantes = [
  ['sans paramètre', ''],
  ['un jour (il y a 5 j)', `?dates=${ymd(il_y_a(5))}`],
  ['plage 7 j', `?dates=${ymd(il_y_a(7))}-${ymd(ajd)}`],
  ['plage 7 j + limit=200', `?dates=${ymd(il_y_a(7))}-${ymd(ajd)}&limit=200`],
  ['plage 30 j + limit=500', `?dates=${ymd(il_y_a(30))}-${ymd(ajd)}&limit=500`],
  ['plage 30 j, fin = hier', `?dates=${ymd(il_y_a(30))}-${ymd(il_y_a(1))}&limit=500`],
];
let exempleEvenement = null;
for (const [nom, qs] of variantes) {
  const r = await lire(`${BASE}/site/v2/sports/soccer/eng.1/scoreboard${qs}`);
  const ev = r.json?.events ?? [];
  const finis = ev.filter(e => e.status?.type?.completed);
  console.log(`  ${nom.padEnd(26)} HTTP ${r.statut} · ${ev.length} match(s), ${finis.length} terminé(s)`
    + (r.statut !== 200 ? ` · ${String(r.corps).slice(0, 160)}` : ''));
  if (!exempleEvenement && finis.length) exempleEvenement = finis[0];
}

if (exempleEvenement) {
  const c = exempleEvenement.competitions?.[0];
  console.log('\n── Un match terminé, champs utiles ──');
  console.log(`  date ${exempleEvenement.date} · statut ${exempleEvenement.status?.type?.name}`);
  for (const k of c?.competitors ?? []) {
    console.log(`  ${k.homeAway} · id ${k.team?.id} · displayName « ${k.team?.displayName} » · shortDisplayName « ${k.team?.shortDisplayName} »`
      + ` · name « ${k.team?.name} » · location « ${k.team?.location} » · abbr ${k.team?.abbreviation} · score ${JSON.stringify(k.score)} · winner ${k.winner}`);
  }
}

// ── 2. Classement : structure et statistiques ──
console.log('\n── Classement Premier League : structure ──');
{
  const r = await lire(`${BASE}/v2/sports/soccer/eng.1/standings`);
  const groupes = r.json?.children ?? [];
  console.log(`  HTTP ${r.statut} · ${groupes.length} groupe(s) · saison ${groupes[0]?.standings?.seasonDisplayName ?? r.json?.seasons?.[0]?.displayName ?? '?'}`);
  const e = groupes[0]?.standings?.entries?.[0];
  if (e) {
    console.log(`  équipe : id ${e.team?.id} · displayName « ${e.team?.displayName} » · shortDisplayName « ${e.team?.shortDisplayName} » · name « ${e.team?.name} » · location « ${e.team?.location} »`);
    console.log(`  stats : ${(e.stats ?? []).map(s => `${s.name}=${s.displayValue ?? s.value}`).join(' · ')}`);
    console.log(`  note : ${JSON.stringify(e.note ?? null)}`);
  }
}

// ── 3. Codes de ligue : lesquels existent et ont un classement 2026-27 ? ──
console.log('\n── Codes de ligue ──');
const codes = ['eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'ned.1', 'por.1', 'bel.1', 'sco.1',
  'tur.1', 'gre.1', 'aut.1', 'sui.1', 'den.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'bra.1', 'arg.1', 'usa.1', 'mex.1', 'conmebol.libertadores', 'ksa.1'];
for (const code of codes) {
  const r = await lire(`${BASE}/v2/sports/soccer/${code}/standings`);
  const groupes = r.json?.children ?? [];
  const entrees = groupes.flatMap(g => g.standings?.entries ?? []);
  const joues = entrees.reduce((a, e) => a + (e.stats?.find(s => s.name === 'gamesPlayed')?.value || 0), 0);
  console.log(`  ${code.padEnd(24)} HTTP ${r.statut} · ${groupes.length} groupe(s) · ${entrees.length} équipe(s) · ${joues} matchs joués · ${r.json?.name ?? ''}`);
}

// ── 4. Calendrier d'une équipe (secours pour la forme) ──
console.log('\n── Calendrier d\'une équipe (Arsenal, id 359) ──');
{
  const r = await lire(`${BASE}/site/v2/sports/soccer/eng.1/teams/359/schedule`);
  const ev = r.json?.events ?? [];
  const finis = ev.filter(e => e.competitions?.[0]?.status?.type?.completed);
  console.log(`  HTTP ${r.statut} · ${ev.length} match(s), ${finis.length} terminé(s)`);
  const d = finis.at(-1)?.competitions?.[0];
  if (d) console.log(`  dernier : ${d.competitors?.map(k => `${k.team?.displayName} ${JSON.stringify(k.score)}`).join(' vs ')}`);
}

// ── 5. Matchs du jour selon TheSportsDB : noms de ligue et d'équipe ──
console.log('\n── TheSportsDB, football du jour ──');
{
  const r = await lire(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${ajd.toISOString().slice(0, 10)}&s=Soccer`);
  const ev = r.json?.events ?? [];
  console.log(`  HTTP ${r.statut} · ${ev.length} match(s)`);
  for (const e of ev.slice(0, 40)) console.log(`  [${e.strLeague}] ${e.strHomeTeam} vs ${e.strAwayTeam}`);
}

// ── 6. Matchs du jour selon ESPN, pour comparer les noms ──
console.log('\n── ESPN, matchs du jour par ligue ──');
for (const code of ['eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'ned.1', 'por.1', 'bra.1']) {
  const r = await lire(`${BASE}/site/v2/sports/soccer/${code}/scoreboard?dates=${ymd(ajd)}`);
  const ev = r.json?.events ?? [];
  if (ev.length) console.log(`  ${code} : ${ev.map(e => e.name).join(' | ')}`);
}
