// ══════════════════════════════════════════════
// scripts/essai-espn.js — le secours ESPN sur les vrais matchs
// ══════════════════════════════════════════════
//
//   node scripts/essai-espn.js [jours=3]
//
// LECTURE SEULE. Aucune écriture en base, aucun appel à l'IA.
//
// Les tests unitaires prouvent la logique sur des réponses simulées. Ce
// script mesure ce qui compte en production : sur les matchs réellement au
// programme (football-data, TheSportsDB, The Odds API si ODDS_API_KEY est
// fournie), combien d'équipes ESPN documente, et lesquelles il refuse de
// rapprocher — pour juger les garde-fous sur pièces.

import { getFixturesOfDay, couvertureContexte } from '../victor/sources.js';
import { getOddsEvents } from '../victor/odds.js';
import { getContexteEspn, ligueEspn, liguesConnues } from '../victor/espn.js';

const jours = Number(process.argv[2] || 3);

// ── 1. Chaque code de ligue de la table existe-t-il chez ESPN ? ──
console.log('── Codes de ligue de la table ──');
const invalides = [];
for (const code of liguesConnues()) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`);
    const j = r.ok ? await r.json() : null;
    const n = (j?.children ?? []).reduce((a, c) => a + (c.standings?.entries?.length ?? 0), 0);
    if (n === 0) invalides.push(`${code} (HTTP ${r.status}, ${n} équipe)`);
  } catch (err) {
    invalides.push(`${code} (${err.message})`);
  }
}
console.log(`  ${liguesConnues().length} code(s), ${invalides.length} sans classement : ${invalides.join(', ') || 'aucun'}`);

// ── 2. Les matchs réels des prochains jours ──
let totalEquipes = 0, totalDocumentees = 0;
const refus = [];
for (let j = 0; j < jours; j++) {
  const dateISO = new Date(Date.now() + j * 864e5).toISOString().slice(0, 10);
  const cotes = await getOddsEvents(dateISO).catch(() => []);
  const tous = await getFixturesOfDay(dateISO, { extra: cotes });
  const foot = tous.filter(f => /^(football|soccer)$/i.test(f.sport));

  const ctx = await getContexteEspn(foot, new Map(), new Map(), { maintenant: new Date(`${dateISO}T00:00:00Z`) });
  const couv = couvertureContexte(foot, ctx.forme, ctx.classement);
  totalEquipes += couv.equipes;
  totalDocumentees += couv.avecDonnees;

  console.log(`\n── ${dateISO} : ${foot.length} match(s) de football, ${couv.avecDonnees}/${couv.equipes} équipe(s) documentée(s) ──`);
  for (const f of foot) {
    const code = ligueEspn(f);
    const etat = (id) => (id && (ctx.classement.get(id) || ctx.forme.get(id)) ? '✅' : '··');
    if (!code) continue;
    console.log(`  [${code}] ${etat(f.homeId)} ${f.home} vs ${f.away} ${etat(f.awayId)}  (${f.source})`);
    for (const [nom, id] of [[f.home, f.homeId], [f.away, f.awayId]]) {
      if (!(id && (ctx.classement.get(id) || ctx.forme.get(id)))) refus.push(`[${code}] ${nom}`);
    }
  }
  const hors = foot.filter(f => !ligueEspn(f));
  if (hors.length) {
    const ligues = [...new Set(hors.map(f => `${f.competition}${f.sportKey ? ` (${f.sportKey})` : ''}`))];
    console.log(`  hors couverture : ${hors.length} match(s) — ${ligues.slice(0, 15).join(' · ')}`);
  }
}

console.log(`\n── Bilan : ${totalDocumentees}/${totalEquipes} équipe(s) documentée(s) sur ${jours} jour(s) ──`);
console.log(`Noms refusés dans une ligue couverte (${refus.length}) :`);
for (const r of [...new Set(refus)].slice(0, 60)) console.log(`  ${r}`);
