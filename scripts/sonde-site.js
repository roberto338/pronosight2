// ══════════════════════════════════════════════
// scripts/sonde-site.js — tout ce que le site affiche existe-t-il vraiment ?
// ══════════════════════════════════════════════
//
//   node scripts/sonde-site.js [jours=2]
//
// LECTURE SEULE. Aucun crédit The Odds API consommé (/sports et /events sont
// gratuits), aucune écriture, aucun appel à l'IA.
//
// Le site ne propose plus que les compétitions présentes dans /api/matchs.
// Cette sonde mesure, sur les vrais matchs des prochains jours :
//   1. quelles compétitions arrivent, par quelle source ;
//   2. pour chacune, si l'analyse pourra trouver de VRAIES cotes
//      (clé The Odds API connue et match présent chez The Odds API) — sans
//      cotes, l'analyse n'affiche aucun pourcentage ;
//   3. si le site en production répond sur chaque route qu'il appelle.

import { getFixturesOfDay } from '../victor/sources.js';
import { getOddsEvents, sportDe } from '../victor/odds.js';

const jours = Number(process.argv[2] || 2);
const APP = process.env.APP || 'https://pronosight2.onrender.com';
const ODDS_KEY = process.env.ODDS_API_KEY;

const simple = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const memeMatch = (a, b) => {
  const x = [simple(a.home), simple(a.away)], y = [simple(b.home), simple(b.away)];
  const proche = (p, q) => p && q && (p.includes(q) || q.includes(p));
  return proche(x[0], y[0]) && proche(x[1], y[1]);
};

// ── 1 et 2. Compétitions réelles et couverture des cotes ──
for (let j = 0; j < jours; j++) {
  const dateISO = new Date(Date.now() + j * 864e5).toISOString().slice(0, 10);
  const extra = await getOddsEvents(dateISO).catch(() => []);
  const fixtures = await getFixturesOfDay(dateISO, { extra });
  console.log(`\n══ ${dateISO} : ${fixtures.length} match(s) ══`);

  const parCompet = new Map();
  for (const f of fixtures) {
    const c = `${f.sport} — ${f.competition || '?'}`;
    if (!parCompet.has(c)) parCompet.set(c, []);
    parCompet.get(c).push(f);
  }
  const lignes = [];
  let analysables = 0, total = 0;
  for (const [c, liste] of [...parCompet.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sources = [...new Set(liste.map(f => f.source))].join('+');
    const cle = sportDe(liste[0]) || liste.map(sportDe).find(Boolean) || null;
    // Un match a des cotes si sa compétition a une clé ET qu'il figure dans
    // le calendrier The Odds API (même équipes).
    const avecCotes = cle ? liste.filter(f => extra.some(e => (e.sportKey === cle) && memeMatch(e, f))).length : 0;
    const football = /foot|soccer/i.test(liste[0].sport || '');
    if (football) { analysables += avecCotes; total += liste.length; }
    lignes.push(`  ${String(liste.length).padStart(3)}  ${c.padEnd(48).slice(0, 48)} ${sources.padEnd(28).slice(0, 28)} `
      + (cle ? `cotes ${avecCotes}/${liste.length} (${cle})` : (football ? 'AUCUNE CLÉ DE COTES' : '— (hors football)')));
  }
  console.log(lignes.join('\n'));
  console.log(`  → football : ${analysables}/${total} match(s) analysables avec de vraies cotes${ODDS_KEY ? '' : ' (ODDS_API_KEY absente : non mesurable)'}`);
}

// ── 3. Le site en production ──
console.log(`\n══ Routes du site (${APP}) ══`);
const routes = ['/api/status', '/api/matchs', '/api/victor/today', '/api/victor/stats', '/api/victor/patterns',
  '/api/victor/history?days=30', '/api/victor/valeurs', '/api/victor/bilan', '/', '/js/app.js', '/css/theme.css'];
for (const r of routes) {
  const debut = Date.now();
  try {
    let rep;
    for (let i = 0; i < 3; i++) {   // le plan gratuit endort le service
      rep = await fetch(APP + r, { signal: AbortSignal.timeout(90_000) }).catch(() => null);
      if (rep) break;
    }
    if (!rep) { console.log(`  ❌ ${r} : injoignable`); continue; }
    const texte = await rep.text();
    let detail = `${texte.length} o`;
    if (r.startsWith('/api/')) {
      try {
        const j = JSON.parse(texte);
        detail = r === '/api/matchs' ? `${j.total ?? '?'} matchs, ${j.aVenir ?? '?'} à venir, ${j.matchs?.filter(m => m.sport_key).length ?? '?'} avec clé de cotes`
          : r === '/api/victor/valeurs' ? `${j.aujourdhui?.length ?? '?'} value(s) aujourd'hui, ${j.notees?.length ?? '?'} notée(s)`
          : r === '/api/victor/bilan' ? `Victor n=${j.victor?.n ?? '?'}, values n=${j.marche?.total?.n ?? '?'}`
          : r === '/api/victor/today' ? `${j.total ?? '?'} prono(s)`
          : r === '/api/status' ? `commit ${j.commit ?? '?'}`
          : Object.keys(j).slice(0, 5).join(', ');
      } catch { detail = 'réponse non JSON'; }
    }
    console.log(`  ${rep.ok ? '✅' : '❌'} ${r} : HTTP ${rep.status} · ${detail} · ${Date.now() - debut} ms`);
  } catch (err) {
    console.log(`  ❌ ${r} : ${err.message}`);
  }
}
process.exit(0);
