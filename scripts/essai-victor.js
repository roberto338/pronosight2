// ══════════════════════════════════════════════
// scripts/essai-victor.js — Victor aura-t-il de quoi travailler demain ?
// ══════════════════════════════════════════════
//
//   node scripts/essai-victor.js [jours=1]
//
// LECTURE SEULE. Aucun appel à l'IA, aucune écriture, aucun crédit The Odds
// API (seul /events, gratuit, est appelé). Rejoue la première moitié de
// runVictor : calendrier → matchs cotés → forme et classement (football-data,
// puis secours API-Football et ESPN) → couverture. C'est là que Victor
// s'est arrêté du 21/09 au 02/10.

import { getFixturesOfDay, buildFormIndex, getStandings, getContexteApiFootball, couvertureContexte } from '../victor/sources.js';
import { getOddsEvents, sportDe } from '../victor/odds.js';
import { getContexteEspn } from '../victor/espn.js';

const decalage = Number(process.argv[2] || 1);
const dateISO = new Date(Date.now() + decalage * 864e5).toISOString().slice(0, 10);
console.log(`\n── Essai à blanc de Victor pour le ${dateISO} ──\n`);

const extra = await getOddsEvents(dateISO).catch(() => []);
const fixtures = await getFixturesOfDay(dateISO, { extra });
const aVenir = fixtures.filter(f => f.status !== 'FT' && f.status !== 'LIVE' && f.debutUTC && String(f.debutUTC).slice(0, 10) === dateISO);
const cotes = aVenir.filter(f => sportDe(f));
console.log(`Calendrier : ${fixtures.length} match(s), ${aVenir.length} à venir ce jour, ${cotes.length} coté(s) par les bookmakers.`);

const forme = await buildFormIndex(20).catch(() => new Map());
const classement = await getStandings([...new Set(cotes.map(f => f.codeCompet).filter(Boolean))]).catch(() => new Map());
console.log(`football-data : forme ${forme.size} équipe(s), classement ${classement.size}`);
const c0 = couvertureContexte(cotes, forme, classement);
console.log(`Couverture après football-data : ${c0.avecDonnees}/${c0.equipes}`);

if (c0.sansDonnees > 0) {
  const af = await getContexteApiFootball(cotes).catch(err => ({ forme: new Map(), classement: new Map(), rapport: `échec : ${err.message}` }));
  for (const [id, v] of af.forme) if (!forme.has(id)) forme.set(id, v);
  for (const [id, v] of af.classement) if (!classement.has(id)) classement.set(id, v);
  const c1 = couvertureContexte(cotes, forme, classement);
  console.log(`Secours API-Football : ${af.rapport} → couverture ${c1.avecDonnees}/${c1.equipes}`);
}
if (couvertureContexte(cotes, forme, classement).sansDonnees > 0) {
  const es = await getContexteEspn(cotes, forme, classement).catch(err => ({ forme: new Map(), classement: new Map(), rapport: `échec : ${err.message}` }));
  for (const [id, v] of es.forme) if (!forme.has(id)) forme.set(id, v);
  for (const [id, v] of es.classement) if (!classement.has(id)) classement.set(id, v);
  console.log(`Secours ESPN : ${es.rapport}`);
}
const fin = couvertureContexte(cotes, forme, classement);
console.log(`\nCouverture finale : ${fin.avecDonnees}/${fin.equipes} équipe(s) documentée(s) sur ${cotes.length} match(s) coté(s).`);

const parCompet = new Map();
for (const f of cotes) {
  const k = f.competition || '?';
  if (!parCompet.has(k)) parCompet.set(k, { n: 0, doc: 0, cle: sportDe(f) });
  const g = parCompet.get(k); g.n++;
  if (forme.has(f.homeId) || classement.has(f.homeId)) g.doc++;
  if (forme.has(f.awayId) || classement.has(f.awayId)) g.doc++;
}
for (const [k, g] of [...parCompet.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(g.n).padStart(3)}  ${k.padEnd(40).slice(0, 40)}  ${g.doc}/${g.n * 2} équipes documentées  (${g.cle})`);
}
console.log(fin.avecDonnees > 0
  ? '\n✅ Victor aura des données : l\'IA sera appelée.'
  : '\n❌ Aucune donnée : Victor s\'arrêtera avant l\'IA, comme le 02/10.');
process.exit(0);
