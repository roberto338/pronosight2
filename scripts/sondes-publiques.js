// ══════════════════════════════════════════════
// scripts/sondes-publiques.js — quelles sources gratuites couvrent 2026-27 ?
// ══════════════════════════════════════════════
//
//   node scripts/sondes-publiques.js
//
// LECTURE SEULE, aucune clé, aucun quota payant. ~10 requêtes publiques.
//
// Depuis le 21/09, football-data ne renvoie plus aucun match de la saison
// 2026-27. Avant de choisir un remplaçant, on mesure ce que chaque source
// gratuite rend AUJOURD'HUI pour la saison en cours, plutôt que de se fier à
// sa réputation. Deux critères comptent pour Victor :
//
//   1. la saison 2026-27 est-elle là (matchs joués, classement non vide) ?
//   2. la source fournit-elle À LA FOIS les matchs et le classement ?
//      Victor relie le contexte aux matchs par identifiant d'équipe : une
//      source qui donne le classement sans les matchs (ou l'inverse) oblige à
//      rapprocher les équipes par leur NOM — le piège déjà documenté dans
//      victor/sources.js (Vitória SC confondu avec Vitória).

const DELAI_MS = 15_000;

async function lire(url, { texte = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DELAI_MS);
  const debut = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PronoSight-sonde/1.0' } });
    const corps = await res.text();
    let json = null;
    if (!texte) { try { json = JSON.parse(corps); } catch { /* non JSON */ } }
    return { ok: res.ok, statut: res.status, ms: Date.now() - debut, json, corps };
  } catch (err) {
    return { ok: false, statut: 0, ms: Date.now() - debut, erreur: err.name === 'AbortError' ? 'délai dépassé' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const verdicts = [];
function rapporter(source, nom, r, analyse) {
  console.log(`\n${source} — ${nom}`);
  if (!r.ok) {
    console.log(`  ⛔ ${r.statut ? `HTTP ${r.statut}` : r.erreur} (${r.ms} ms)`);
    verdicts.push({ source, nom, ok: false });
    return;
  }
  let ligne;
  try { ligne = analyse(r); } catch (err) { ligne = { texte: `réponse illisible : ${err.message}`, saison: false }; }
  console.log(`  HTTP ${r.statut} (${r.ms} ms) · ${ligne.texte}`);
  console.log(`  saison 2026-27 présente : ${ligne.saison ? '✅ oui' : '⛔ non'}`);
  verdicts.push({ source, nom, ok: true, saison: ligne.saison });
}

const ajd = new Date();
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const il_y_a = (j) => new Date(ajd.getTime() - j * 864e5);

// ── ESPN (officieux, non documenté, sans clé) ──
for (const [code, nom] of [['eng.1', 'Premier League'], ['fra.1', 'Ligue 1']]) {
  rapporter('ESPN', `matchs ${nom}, 7 derniers jours`,
    await lire(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${ymd(il_y_a(7))}-${ymd(ajd)}`),
    (r) => {
      const ev = r.json?.events ?? [];
      const finis = ev.filter(e => e.status?.type?.completed).length;
      const ex = ev[0]?.name ?? '—';
      return { texte: `${ev.length} match(s), ${finis} terminé(s) · ex. ${ex}`, saison: finis > 0 };
    });
  rapporter('ESPN', `classement ${nom}`,
    await lire(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`),
    (r) => {
      const entrees = r.json?.children?.[0]?.standings?.entries ?? r.json?.standings?.entries ?? [];
      const stat = (e, n) => e?.stats?.find(s => s.name === n)?.value;
      const joues = entrees.reduce((a, e) => a + (stat(e, 'gamesPlayed') || 0), 0);
      const tete = entrees[0] ? `${entrees[0].team?.displayName} ${stat(entrees[0], 'points')} pts` : '—';
      const saisonEspn = r.json?.children?.[0]?.standings?.seasonDisplayName ?? r.json?.seasonDisplayName ?? '?';
      return { texte: `${entrees.length} équipe(s), ${joues} matchs joués au total · saison ${saisonEspn} · tête : ${tete}`, saison: joues > 0 };
    });
}

// ── OpenLigaDB (ouvert, sans clé, communautaire) ──
rapporter('OpenLigaDB', 'matchs Bundesliga 2026',
  await lire('https://api.openligadb.de/getmatchdata/bl1/2026'),
  (r) => {
    const m = Array.isArray(r.json) ? r.json : [];
    const finis = m.filter(x => x.matchIsFinished).length;
    return { texte: `${m.length} match(s) au calendrier, ${finis} terminé(s)`, saison: finis > 0 };
  });
rapporter('OpenLigaDB', 'matchs Premier League 2026 (saisie communautaire)',
  await lire('https://api.openligadb.de/getmatchdata/pl/2026'),
  (r) => {
    const m = Array.isArray(r.json) ? r.json : [];
    const finis = m.filter(x => x.matchIsFinished).length;
    return { texte: `${m.length} match(s) au calendrier, ${finis} terminé(s)`, saison: finis > 0 };
  });

// ── football-data.co.uk (fichiers CSV gratuits : résultats ET cotes) ──
for (const [fichier, nom] of [['E0', 'Premier League'], ['F1', 'Ligue 1']]) {
  rapporter('football-data.co.uk', `résultats + cotes ${nom} 2026-27`,
    await lire(`https://www.football-data.co.uk/mmz4281/2627/${fichier}.csv`, { texte: true }),
    (r) => {
      const lignes = r.corps.trim().split(/\r?\n/).filter(Boolean);
      const n = Math.max(0, lignes.length - 1);
      const derniere = n ? lignes[lignes.length - 1].split(',').slice(1, 6).join(' ') : '—';
      return { texte: `${n} match(s) · dernier : ${derniere}`, saison: n > 0 };
    });
}
rapporter('football-data.co.uk', 'matchs à venir (fixtures.csv, toutes ligues)',
  await lire('https://www.football-data.co.uk/fixtures.csv', { texte: true }),
  (r) => {
    const lignes = r.corps.trim().split(/\r?\n/).filter(Boolean);
    return { texte: `${Math.max(0, lignes.length - 1)} match(s) à venir`, saison: lignes.length > 1 };
  });

// ── TheSportsDB, clé de test publique (déjà utilisée par Victor) ──
rapporter('TheSportsDB', 'classement Premier League 2026-2027 (clé de test)',
  await lire('https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=4328&s=2026-2027'),
  (r) => {
    const t = r.json?.table ?? [];
    const joues = t.reduce((a, e) => a + Number(e.intPlayed || 0), 0);
    return { texte: `${t.length} équipe(s), ${joues} matchs joués au total`, saison: joues > 0 };
  });
rapporter('TheSportsDB', 'derniers résultats Premier League (clé de test)',
  await lire('https://www.thesportsdb.com/api/v1/json/3/eventspastleague.php?id=4328'),
  (r) => {
    const e = r.json?.events ?? [];
    const recent = e.find(x => (x.strSeason || '').startsWith('2026'));
    return { texte: `${e.length} résultat(s) · saison du plus récent : ${e[0]?.strSeason ?? '—'}`, saison: Boolean(recent) };
  });

// ── Synthèse ──
console.log('\n── Synthèse : sources qui couvrent la saison 2026-27 aujourd\'hui ──');
const parSource = new Map();
for (const v of verdicts) {
  if (!parSource.has(v.source)) parSource.set(v.source, []);
  parSource.get(v.source).push(v);
}
for (const [source, lots] of parSource) {
  const bons = lots.filter(v => v.ok && v.saison).length;
  console.log(`  ${bons === lots.length ? '✅' : bons > 0 ? '⚠️ ' : '⛔'} ${source.padEnd(20)} ${bons}/${lots.length} sonde(s) avec la saison en cours`);
}
