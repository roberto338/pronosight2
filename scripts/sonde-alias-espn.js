// ══════════════════════════════════════════════
// scripts/sonde-alias-espn.js — pourquoi ESPN refuse un nom d'équipe
// ══════════════════════════════════════════════
//
//   node scripts/sonde-alias-espn.js "arg.1:Newells Old Boys" "esp.2:SD Eibar" …
//
// LECTURE SEULE, aucune clé. Pour chaque nom refusé par le secours ESPN
// (« sans correspondance sûre » dans les journaux de Victor), affiche les
// équipes ESPN de la ligue qui partagent un mot avec lui, et le résultat du
// rapprochement. C'est sur cette base, et non de mémoire, qu'on écrit un alias.

import { lireClassementEspn, apparierEquipe } from '../victor/espn.js';
import { normalizeTeam } from '../victor/sources.js';

const BASE = 'https://site.api.espn.com/apis';
const demandes = process.argv.slice(2);
const parLigue = new Map();

for (const d of demandes) {
  const i = d.indexOf(':');
  const code = d.slice(0, i), nom = d.slice(i + 1);
  if (!parLigue.has(code)) {
    try {
      const r = await fetch(`${BASE}/v2/sports/soccer/${code}/standings`, { headers: { 'User-Agent': 'PronoSight-sonde/1.0' } });
      parLigue.set(code, r.ok ? lireClassementEspn(await r.json()).equipes || [] : []);
    } catch { parLigue.set(code, []); }
  }
  const equipes = parLigue.get(code);
  const mots = normalizeTeam(nom).split(' ').filter(m => m.length >= 3);
  const proches = equipes.filter(e => e.noms.some(n => mots.some(m => normalizeTeam(n).includes(m))));
  const choisie = apparierEquipe(nom, equipes);
  console.log(`\n${code} « ${nom} » — ${equipes.length} équipe(s) ESPN · rapprochement : ${choisie ? choisie.noms.join(' / ') : 'AUCUN'}`);
  for (const e of proches) console.log(`   candidat #${e.id} : ${e.noms.join(' / ')}`);
  if (!proches.length) console.log('   aucun candidat partageant un mot');
}
process.exit(0);
