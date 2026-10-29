// ══════════════════════════════════════════════
// prono/clv-valeurs.js — les values de marché battent-elles la clôture ?
// ══════════════════════════════════════════════
//
//   node prono/clv-valeurs.js
//
// LECTURE SEULE sur ps_valeurs_marche. Même méthode que prono/clv.js pour
// Victor : cote publiée comparée au prix juste de clôture (Betfair Exchange,
// sinon Pinnacle, sinon moyenne du marché, marge retirée), fichiers publics
// de football-data.co.uk, aucun crédit The Odds API.
//
// La cote comparée est la cote RÉELLEMENT touchée : commission des bourses
// de paris retirée (victor/commission.js). La cote brute est donnée à côté,
// pour voir ce que la commission coûte.
//
// C'est la mesure qui dira, en quelques semaines, si l'avantage des values
// est réel : le rendement, lui, dépend surtout de la chance avant des
// centaines de paris.

import { clvPari, resumerClv, familleMarche, N_MIN_VERDICT } from './engine/clv.js';
import { mulberry32 } from './engine/montecarlo.js';
import { fichierPour, chargerFichier, apparier } from './data/football-data-uk.js';
import { coteNette, commissionDe } from '../victor/commission.js';
import { query } from '../db/database.js';
import pool from '../db/database.js';

const pct = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1).padStart(4)} %`);
const ic = (i) => (i ? `[${pct(i.basse)} ; ${pct(i.haute)}]` : '');

const { rows } = await query(`
  SELECT id, to_char(date, 'YYYY-MM-DD') AS date, competition, sport_key, equipe_a, equipe_b,
         pari_code, cote, bookmaker, avantage, gagne
  FROM ps_valeurs_marche ORDER BY date, id`);
await pool.end();

console.log('\n── CLV des values de marché ──');
console.log(`${rows.length} value(s) enregistrée(s).\n`);

const mesures = [];
const ecartes = new Map();
const ecarter = (motif, v) => {
  if (!ecartes.has(motif)) ecartes.set(motif, []);
  ecartes.get(motif).push(`${v.date} [${v.competition}] ${v.equipe_a} vs ${v.equipe_b} · ${v.pari_code}`);
};

for (const v of rows) {
  if (!familleMarche(v.pari_code)) { ecarter('marché non couvert par les fichiers', v); continue; }
  const fichier = fichierPour(v.competition, v.date, v.sport_key);
  if (!fichier) { ecarter('compétition non couverte', v); continue; }
  let rencontres;
  try { rencontres = await chargerFichier(fichier.url); }
  catch (err) { ecarter(`fichier ${fichier.cle} indisponible (${err.message})`, v); continue; }
  const r = apparier(v, rencontres);
  if (!r) { ecarter('match introuvable dans le fichier (ou pas encore publié)', v); continue; }
  const nette = coteNette(v.cote, v.bookmaker);
  const c = clvPari(nette, r.ligne, v.pari_code);
  if (c.erreur) { ecarter(c.erreur, v); continue; }
  const brut = clvPari(Number(v.cote), r.ligne, v.pari_code);
  mesures.push({ ...c, valeurBrute: brut.erreur ? null : brut.valeur, v, nette });
}

const rnd = mulberry32(20261029);
const total = resumerClv(mesures, { rnd });
console.log(`Mesurées : ${total.n} / ${rows.length}`);
console.log('── Valeur à la cote réellement touchée (commission retirée) ──');
console.log(`  moyenne ${pct(total.valeurMoyenne)}  IC 95 % ${ic(total.ic)}  · ${total.partPositive == null ? '—' : `${(total.partPositive * 100).toFixed(0)} %`} au-dessus du prix juste de clôture`);
const bruts = mesures.map(m => m.valeurBrute).filter(x => x != null);
if (bruts.length) console.log(`  (à la cote affichée, sans retirer la commission : ${pct(bruts.reduce((a, b) => a + b, 0) / bruts.length)})`);

const VERDICTS = {
  'insuffisant': `⏳ Échantillon insuffisant (moins de ${N_MIN_VERDICT} values mesurées) : aucun verdict.`,
  'bat le marché': '✅ Les values battent la cote de clôture : l\'intervalle est entièrement au-dessus de zéro.',
  'ne bat pas le marché': '❌ Les values ne battent pas la cote de clôture : l\'intervalle est entièrement sous zéro.',
  'non concluant': '➖ Non concluant : l\'intervalle contient zéro.',
};
console.log(`\n${VERDICTS[total.verdict]}`);

const parGroupe = (cle) => {
  const g = new Map();
  for (const m of mesures) { const k = cle(m); if (!g.has(k)) g.set(k, []); g.get(k).push(m); }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
};
for (const [titre, cle] of [
  ['Par marché', m => familleMarche(m.v.pari_code)],
  ['Par bookmaker', m => `${m.v.bookmaker || '?'}${commissionDe(m.v.bookmaker) ? ' (bourse)' : ''}`],
  ['Par avantage annoncé', m => (Number(m.v.avantage) < 0.03 ? 'moins de 3 %' : Number(m.v.avantage) < 0.05 ? '3 à 5 %' : '5 % et plus')],
]) {
  console.log(`\n── ${titre} ──`);
  for (const [k, liste] of parGroupe(cle)) {
    const s = resumerClv(liste, { rnd });
    console.log(`  ${String(k).slice(0, 26).padEnd(26)} n=${String(s.n).padStart(3)}  valeur ${pct(s.valeurMoyenne)}`);
  }
}

console.log('\n── Détail (du meilleur au pire) ──');
for (const m of [...mesures].sort((a, b) => b.valeur - a.valeur)) {
  const v = m.v;
  console.log(`  ${pct(m.valeur)}  ${v.date} ${v.equipe_a} vs ${v.equipe_b} · ${v.pari_code} @ ${Number(v.cote).toFixed(2)} ${v.bookmaker}`
    + `${m.nette !== Number(v.cote) ? ` (nette ${m.nette.toFixed(2)})` : ''} · juste ${(1 / m.probaJuste).toFixed(2)} (${m.reference})`);
}

if (ecartes.size) {
  console.log('\n── Non mesurées ──');
  for (const [motif, liste] of ecartes) {
    console.log(`  ${motif} : ${liste.length}`);
    for (const l of liste.slice(0, 6)) console.log(`    · ${l}`);
    if (liste.length > 6) console.log(`    · … et ${liste.length - 6} autre(s)`);
  }
}
process.exit(0);
