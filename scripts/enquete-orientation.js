// ══════════════════════════════════════════════
// scripts/enquete-orientation.js — domicile et extérieur inversés ?
// ══════════════════════════════════════════════
//
//   node scripts/enquete-orientation.js            (45 derniers jours)
//   node scripts/enquete-orientation.js --jours=60
//
// LECTURE SEULE. N'écrit rien.
//
// Le 15/10, Victor a publié « Juventus vs Celta Vigo » (victoire Celta) et
// « Celta Vigo vs Juventus » (victoire Juventus) : le même match dans les
// deux sens. Or checkResults accepte un match retrouvé dans l'autre sens,
// puis lit le code du pari (1X2:HOME…) sur le score du VRAI domicile. Un
// prono enregistré à l'envers était donc noté sur la mauvaise équipe.
//
// 1. Les pronos du même jour publiés deux fois (paire d'équipes identique).
// 2. Le sens réel des matchs Juventus/Celta du 15/10 selon ESPN.
// 3. Les pronos notés dont le code dépend du sens : ESPN les retrouve-t-il
//    dans le même sens ou à l'envers, et le verdict changerait-il ?

import { query } from '../db/database.js';
import pool from '../db/database.js';
import { normalizeTeam, fetchWithTimeout } from '../victor/sources.js';
import { scoreEspnProno, lecteurScoresEspn } from '../victor/valeur-suivi.js';
import { evaluerCode } from '../victor/paris.js';

const args = process.argv.slice(2);
const jours = Number((args.find(a => a.startsWith('--jours=')) || '').split('=')[1]) || 45;
const paire = (a, b) => [normalizeTeam(a || ''), normalizeTeam(b || '')].sort().join('|');

// ── 1. Doublons dans les deux sens ──
console.log(`\n── 1. Même match publié deux fois le même jour (${jours} jours) ──`);
const { rows: tous } = await query(`
  SELECT id, to_char(date, 'YYYY-MM-DD') AS date_iso,
         to_char(created_at AT TIME ZONE 'Europe/Paris', 'HH24:MI') AS cree,
         match, equipe_a, equipe_b, competition, heure, pronostic_principal, pari_code,
         cote_estimee, cote_confirmee, moteur, pronostic_correct, score_reel
  FROM ps_pronostics WHERE date >= CURRENT_DATE - $1::int ORDER BY date, id`, [jours]);
const groupes = new Map();
for (const p of tous) {
  const cle = `${p.date_iso}|${paire(p.equipe_a, p.equipe_b)}`;
  if (!groupes.has(cle)) groupes.set(cle, []);
  groupes.get(cle).push(p);
}
let doublons = 0;
for (const [, g] of groupes) {
  if (g.length < 2) continue;
  doublons++;
  for (const p of g) {
    console.log(`${p.date_iso} #${p.id} créé ${p.cree} · ${p.match} (${p.competition}, ${p.heure || '?'})`
      + ` · ${p.pronostic_principal} [${p.pari_code}] @ ${p.cote_estimee}${p.cote_confirmee ? '' : ' (est.)'}`
      + ` · ${p.moteur || '?'} · ${p.pronostic_correct === true ? 'GAGNÉ' : p.pronostic_correct === false ? 'PERDU' : 'attente'} ${p.score_reel || ''}`);
  }
  console.log('');
}
console.log(`→ ${doublons} match(s) publié(s) deux fois.`);

// ── 2. Le sens réel selon ESPN (programme du jour, matchs non joués compris) ──
console.log('\n── 2. ESPN : Juventus / Celta, 15/10 ──');
for (const ligue of ['uefa.europa', 'uefa.champions']) {
  try {
    const r = await fetchWithTimeout(`https://site.api.espn.com/apis/site/v2/sports/soccer/${ligue}/scoreboard?dates=20261015`,
      { headers: { 'User-Agent': 'PronoSight/1.0' } }, 10_000);
    const j = await r.json();
    for (const ev of j.events || []) {
      const c = ev.competitions?.[0];
      const dom = c?.competitors?.find(k => k.homeAway === 'home');
      const ext = c?.competitors?.find(k => k.homeAway === 'away');
      const noms = `${dom?.team?.displayName} (domicile) vs ${ext?.team?.displayName} (extérieur)`;
      if (/juvent|celta/i.test(noms)) {
        console.log(`${ligue} : ${noms} · ${c?.status?.type?.description || '?'} · ${dom?.score ?? ''}-${ext?.score ?? ''} · ${ev.date}`);
      }
    }
  } catch (err) {
    console.log(`${ligue} : illisible (${err.message})`);
  }
}

// ── 3. Pronos notés dont le code dépend du sens ──
console.log(`\n── 3. Pronos notés à code dépendant du sens (${jours} jours) ──`);
const lire = lecteurScoresEspn();
const positionnels = tous.filter(p => p.pronostic_correct != null && p.pari_code
  && /^(1X2:(HOME|AWAY)|DC:|AH:|TT:)/.test(p.pari_code));
let memeSens = 0, introuvables = 0;
const inverses = [];
for (const p of positionnels) {
  const base = { equipe_a: p.equipe_a, equipe_b: p.equipe_b, competition: p.competition, date_iso: p.date_iso };
  const droit = await scoreEspnProno(base, lire).catch(() => null);
  if (droit) { memeSens++; continue; }
  const envers = await scoreEspnProno({ ...base, equipe_a: p.equipe_b, equipe_b: p.equipe_a }, lire).catch(() => null);
  if (!envers) { introuvables++; continue; }
  // Score dans le sens du prono : buts de equipe_a, puis de equipe_b.
  const butsA = envers.butsExt, butsB = envers.butsDom;
  const juste = evaluerCode(p.pari_code, butsA, butsB);
  inverses.push(p);
  console.log(`${p.date_iso} #${p.id} ${p.match} · ${p.pronostic_principal} [${p.pari_code}]`
    + ` · ESPN : ${p.equipe_b} reçoit ${p.equipe_a} (${butsB}-${butsA})`
    + ` · noté ${p.pronostic_correct ? 'GAGNÉ' : 'PERDU'} (${p.score_reel}) · verdict juste : ${juste === true ? 'GAGNÉ' : juste === false ? 'PERDU' : '?'}`
    + `${juste !== null && juste !== p.pronostic_correct ? '  ← MAL NOTÉ' : ''}`);
}
console.log(`→ ${positionnels.length} pronos vérifiés : ${memeSens} dans le bon sens, ${inverses.length} à l'envers, ${introuvables} introuvables sur ESPN.`);

await pool.end();
