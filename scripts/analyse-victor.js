// ══════════════════════════════════════════════
// scripts/analyse-victor.js — où Victor gagne, où il perd
// ══════════════════════════════════════════════
//
//   node scripts/analyse-victor.js
//
// LECTURE SEULE. Découpe tout l'historique noté de Victor (et des values de
// marché) par type de pari, tranche de cote, confiance, moteur IA,
// compétition, heure de publication… Pour chaque segment : nombre de paris,
// réussite, ce que les cotes prévoyaient, rendement à mise fixe, et un
// écart en écarts-types (z). |z| < 2 : rien ne distingue le segment de la
// chance. C'est ce garde-fou qui empêche de « corriger » Victor sur du bruit.

import { query } from '../db/database.js';
import pool from '../db/database.js';

const pct = (x) => (x == null ? '    —' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).padStart(5)} %`);
const rond = (x) => (x == null ? '  —' : `${String(Math.round(x * 100)).padStart(3)} %`);

/** Bilan d'un segment : paris {gagne, cote}. z = (gagnés − attendus) / σ. */
function segment(rows) {
  const r = rows.filter(x => (x.gagne === true || x.gagne === false) && Number(x.cote) > 1);
  const n = r.length;
  if (!n) return { n: 0 };
  const g = r.filter(x => x.gagne).length;
  const p = r.map(x => 1 / Number(x.cote));
  const attendus = p.reduce((a, b) => a + b, 0);
  const variance = p.reduce((a, b) => a + b * (1 - b), 0);
  const profit = r.reduce((a, x) => a + (x.gagne ? Number(x.cote) - 1 : -1), 0);
  return {
    n, g, taux: g / n, attendu: attendus / n, rendement: profit / n, profit,
    coteMoy: r.reduce((a, x) => a + Number(x.cote), 0) / n,
    z: variance > 0 ? (g - attendus) / Math.sqrt(variance) : null,
  };
}

function tableau(titre, groupes, { min = 1 } = {}) {
  console.log(`\n┌─ ${titre}`);
  console.log('│ segment                              paris  gagnés  cotes  cote moy.  rendement   profit     z');
  const lignes = [...groupes.entries()].map(([k, rows]) => [k, segment(rows)]).filter(([, s]) => s.n >= min)
    .sort((a, b) => b[1].n - a[1].n);
  for (const [k, s] of lignes) {
    const alerte = s.z != null && Math.abs(s.z) >= 2 ? (s.z > 0 ? '  ← au-dessus des cotes' : '  ← sous les cotes') : '';
    console.log(`│ ${String(k).slice(0, 36).padEnd(36)} ${String(s.n).padStart(5)}  ${rond(s.taux)}  ${rond(s.attendu)}    ${s.coteMoy.toFixed(2)}   ${pct(s.rendement)}  ${(s.profit >= 0 ? '+' : '') + s.profit.toFixed(1).padStart(5)} u  ${s.z == null ? '  —' : s.z.toFixed(1).padStart(5)}${alerte}`);
  }
  console.log('└──────────────────────────────────────────────────────');
}

const grouper = (rows, cle) => {
  const m = new Map();
  for (const r of rows) {
    const k = cle(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

const famille = (code = '') => {
  const c = String(code || '');
  if (c === '1X2:HOME') return 'Victoire domicile';
  if (c === '1X2:AWAY') return 'Victoire extérieur';
  if (c === '1X2:DRAW') return 'Match nul';
  if (c.startsWith('OU:OVER:')) return `Plus de ${c.split(':')[2]} buts`;
  if (c.startsWith('OU:UNDER:')) return `Moins de ${c.split(':')[2]} buts`;
  if (c === 'BTTS:YES') return 'Les deux marquent';
  if (c === 'BTTS:NO') return 'Les deux ne marquent pas';
  if (c.startsWith('DC:')) return 'Double chance';
  if (c.startsWith('AH:')) return 'Handicap';
  if (c.startsWith('TT:')) return 'Total d\'une équipe';
  return c ? `Autre (${c})` : 'Sans code';
};
const grandeFamille = (code = '') => {
  const f = famille(code);
  if (f.startsWith('Victoire')) return 'Victoire (1X2)';
  if (f.startsWith('Plus de')) return 'Plus de X buts';
  if (f.startsWith('Moins de')) return 'Moins de X buts';
  return f;
};
const tranche = (cote) => {
  const c = Number(cote);
  if (!(c > 1)) return null;
  if (c < 1.30) return '1 · moins de 1,30';
  if (c < 1.45) return '2 · 1,30 à 1,44';
  if (c < 1.60) return '3 · 1,45 à 1,59';
  if (c < 1.80) return '4 · 1,60 à 1,79';
  if (c < 2.10) return '5 · 1,80 à 2,09';
  if (c < 2.60) return '6 · 2,10 à 2,59';
  return '7 · 2,60 et plus';
};
const TOP = /premier league|^epl$|la liga|primera division$|serie a( - italy)?$|bundesliga( - germany)?$|ligue 1/i;
const niveau = (comp = '') => {
  const c = String(comp || '');
  if (/champions league|europa|conference/i.test(c)) return 'Coupes d\'Europe';
  if (TOP.test(c) && !/brazil|brasileiro/i.test(c)) return '5 grands championnats';
  if (/brazil|brasileiro|argentin|libertadores|sudamericana/i.test(c)) return 'Amérique du Sud';
  if (/championship|league 1|league 2|league one|league two|ligue 2|liga 2|segunda|serie b|2\. bundesliga/i.test(c)) return 'Deuxièmes divisions et moins';
  return 'Autres championnats';
};

// ── Population ──
const { rows: tous } = await query(`
  SELECT to_char(date, 'YYYY-MM-DD') AS date, competition, pari_code, cote_estimee AS cote, cote_confirmee,
         confiance, moteur, pronostic_correct AS gagne, value_bet, value_bet_correct, resultat_reel,
         EXTRACT(HOUR FROM created_at)::int AS heure_utc, EXTRACT(ISODOW FROM date)::int AS jour
  FROM ps_pronostics ORDER BY date`);
const notes = tous.filter(r => r.gagne === true || r.gagne === false);
const comptes = notes.filter(r => r.cote_confirmee === true && Number(r.cote) > 1 && !String(r.pari_code || '').startsWith('DC:'));
console.log(`\n── Analyse de Victor — du ${tous[0]?.date} au ${tous.at(-1)?.date} ──`);
console.log(`${tous.length} pronos publiés · ${notes.length} notés · ${tous.filter(r => r.gagne == null && r.resultat_reel == null).length} jamais notés`
  + ` · ${tous.filter(r => r.gagne == null && r.resultat_reel != null).length} notés « non-pari »`);
console.log(`Cote confirmée par le marché : ${tous.filter(r => r.cote_confirmee === true).length} · estimée par l'IA : ${tous.filter(r => r.cote_confirmee === false).length} · inconnue : ${tous.filter(r => r.cote_confirmee == null).length}`);
console.log(`Comptés au bilan (cote de marché, hors double chance) : ${comptes.length}`);
const parJour = grouper(tous, r => r.date);
const tailles = [...parJour.values()].map(v => v.length);
console.log(`Pronos par jour : moyenne ${(tailles.reduce((a, b) => a + b, 0) / tailles.length).toFixed(1)}, max ${Math.max(...tailles)}, ${parJour.size} jours avec au moins un prono`);

tableau('Tout (bilan officiel)', new Map([['Tous les paris comptés', comptes]]));
tableau('Par grande famille de pari', grouper(comptes, r => grandeFamille(r.pari_code)));
tableau('Par type de pari précis', grouper(comptes, r => famille(r.pari_code)));
tableau('Par tranche de cote', grouper(comptes, r => tranche(r.cote)));
tableau('« Plus de X buts » par tranche de cote', grouper(comptes.filter(r => grandeFamille(r.pari_code) === 'Plus de X buts'), r => tranche(r.cote)));
tableau('« Victoire » par tranche de cote', grouper(comptes.filter(r => grandeFamille(r.pari_code) === 'Victoire (1X2)'), r => tranche(r.cote)));
tableau('Par niveau de compétition', grouper(comptes, r => niveau(r.competition)));
tableau('Par compétition (5 paris ou plus)', grouper(comptes, r => r.competition || '?'), { min: 5 });
tableau('Par confiance annoncée', grouper(comptes, r => r.confiance || '?'));
tableau('Par moteur IA', grouper(comptes, r => r.moteur || 'inconnu (avant le suivi)'));
// created_at est en heure du serveur (UTC) : 7h Paris ≈ 5-6h UTC, 13h ≈ 11-12h UTC.
tableau('Par job de publication', grouper(comptes, r => (r.heure_utc < 9 ? 'Matin (7h)' : r.heure_utc < 17 ? 'Après-midi (13h)' : `Autre (${r.heure_utc}h UTC)`)));
tableau('Semaine ou week-end (date du match)', grouper(comptes, r => (r.jour >= 6 ? 'Week-end' : 'Semaine')));
tableau('Par mois', grouper(comptes, r => r.date.slice(0, 7)));
tableau('Pronos à cote ESTIMÉE par l\'IA (réussite seulement, rendement fictif)', new Map([['Cote estimée', notes.filter(r => r.cote_confirmee === false)]]));

// Le « value bet » secondaire que Victor écrit dans chaque prono
const vb = tous.filter(r => r.value_bet_correct === true || r.value_bet_correct === false);
console.log(`\nValue bet secondaire noté : ${vb.length} · gagnés ${vb.filter(r => r.value_bet_correct).length} (${vb.length ? Math.round(100 * vb.filter(r => r.value_bet_correct).length / vb.length) : '—'} %) — sans cote de marché, réussite seulement.`);

// ── Values de marché ──
try {
  const { rows: vm } = await query(`
    SELECT pari_code, cote, avantage, nb_bookmakers, gagne, bookmaker FROM ps_valeurs_marche WHERE gagne IS NOT NULL`);
  const av = (a) => { const x = Number(a); return x < 0.03 ? '1 · avantage < 3 %' : x < 0.05 ? '2 · 3 à 5 %' : x < 0.08 ? '3 · 5 à 8 %' : '4 · 8 % et plus'; };
  tableau('Values de marché — toutes', new Map([['Toutes les values notées', vm]]));
  tableau('Values de marché — par avantage', grouper(vm, r => av(r.avantage)));
  tableau('Values de marché — par tranche de cote', grouper(vm, r => tranche(r.cote)));
  tableau('Values de marché — par type de pari', grouper(vm, r => grandeFamille(r.pari_code)));
  tableau('Values de marché — par nombre de bookmakers', grouper(vm, r => (Number(r.nb_bookmakers) >= 15 ? '15 et plus' : Number(r.nb_bookmakers) >= 10 ? '10 à 14' : 'moins de 10')));
  tableau('Values de marché — bookmaker (5 values ou plus)', grouper(vm, r => r.bookmaker || '?'), { min: 5 });
} catch (err) {
  console.log(`\nValues de marché illisibles : ${err.message}`);
}

await pool.end();
