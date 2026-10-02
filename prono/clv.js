// ══════════════════════════════════════════════
// prono/clv.js — Victor bat-il la cote de clôture ?
// ══════════════════════════════════════════════
//
//   node prono/clv.js
//   node prono/clv.js --depuis=2026-08-01
//
// LECTURE SEULE sur ps_pronostics. Télécharge les fichiers publics de
// football-data.co.uk ; ne consomme aucun crédit The Odds API.
//
// Pour chaque pronostic publié à une cote confirmée par le marché :
//   1. retrouver le match dans le fichier du championnat (même jour, les
//      deux équipes reconnues, candidat unique) ;
//   2. lire la cote de clôture la plus juste disponible (Betfair Exchange,
//      sinon Pinnacle, sinon la moyenne du marché) et en retirer la marge ;
//   3. comparer à la cote publiée. Voir prono/engine/clv.js.
//
// Ce qui n'est pas apparié est COMPTÉ et listé, jamais ignoré en silence :
// un CLV calculé sur les seuls matchs faciles à retrouver serait biaisé.

import { clvPari, resumerClv, familleMarche, N_MIN_VERDICT } from './engine/clv.js';
import { gainPari } from './engine/audit.js';
import { mulberry32 } from './engine/montecarlo.js';
import { fichierPour, chargerFichier, apparier } from './data/football-data-uk.js';
import { chargerPronosticsACote } from './data/audit-lecture.js';
import pool from '../db/database.js';

const args = process.argv.slice(2);
const depuis = (args.find(a => a.startsWith('--depuis=')) || '').split('=')[1] || null;

const pct = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1).padStart(4)} %`);
const ic = (i) => (i ? `[${pct(i.basse)} ; ${pct(i.haute)}]` : '');

const pronos = await chargerPronosticsACote({ depuis });
await pool.end();

console.log(`\n── CLV de Victor${depuis ? ` depuis le ${depuis}` : ''} ──`);
console.log(`${pronos.length} pronostic(s) publiés à une cote confirmée par le marché.\n`);

const mesures = [];
const ecartes = new Map();       // motif → [libellés]
const ecarter = (motif, p) => {
  if (!ecartes.has(motif)) ecartes.set(motif, []);
  ecartes.get(motif).push(`${p.date} [${p.competition}] ${p.equipe_a} vs ${p.equipe_b} · ${p.pari_code}`);
};

for (const p of pronos) {
  if (!familleMarche(p.pari_code)) { ecarter('marché non couvert par les fichiers', p); continue; }
  const fichier = fichierPour(p.competition, p.date);
  if (!fichier) { ecarter('compétition non couverte', p); continue; }

  let rencontres;
  try { rencontres = await chargerFichier(fichier.url); }
  catch (err) { ecarter(`fichier ${fichier.cle} indisponible (${err.message})`, p); continue; }

  const r = apparier(p, rencontres);
  if (!r) { ecarter('match introuvable dans le fichier', p); continue; }

  const c = clvPari(p.cote_estimee, r.ligne, p.pari_code);
  if (c.erreur) { ecarter(c.erreur, p); continue; }
  mesures.push({ ...c, prono: p, rencontre: r });
}

const rnd = mulberry32(20261002);
const total = resumerClv(mesures, { rnd });

console.log(`Mesurés : ${total.n} / ${pronos.length}`);
console.log(`Référence de clôture : ${[...new Set(mesures.map(m => m.reference))].map(ref =>
  `${ref} (${mesures.filter(m => m.reference === ref).length})`).join(', ') || '—'}\n`);

console.log('── Valeur à la cote publiée (cote × probabilité juste de clôture − 1) ──');
console.log(`  moyenne ${pct(total.valeurMoyenne)}  IC 95 % ${ic(total.ic)}  · ${total.partPositive == null ? '—' : `${(total.partPositive * 100).toFixed(0)} %`} des paris au-dessus du prix juste`);
console.log('── Mouvement du marché après publication (cote publiée / cote moyenne de clôture − 1) ──');
console.log(`  moyenne ${pct(total.mouvementMoyen)}  IC 95 % ${ic(total.icMouvement)}  · sur ${total.nMouvement} pari(s)`);

const VERDICTS = {
  'insuffisant': `⏳ Échantillon insuffisant (moins de ${N_MIN_VERDICT} paris mesurés) : aucun verdict.`,
  'bat le marché': '✅ Victor bat la cote de clôture : l\'intervalle est entièrement au-dessus de zéro.',
  'ne bat pas le marché': '❌ Victor ne bat pas la cote de clôture : l\'intervalle est entièrement sous zéro.',
  'non concluant': '➖ Non concluant : l\'intervalle contient zéro.',
};
console.log(`\n${VERDICTS[total.verdict]}`);

// ── Par marché et par compétition ──
const parGroupe = (cle) => {
  const g = new Map();
  for (const m of mesures) {
    const k = cle(m);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(m);
  }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
};
console.log('\n── Par marché ──');
for (const [k, liste] of parGroupe(m => familleMarche(m.prono.pari_code))) {
  const s = resumerClv(liste, { rnd });
  console.log(`  ${k.padEnd(6)} n=${String(s.n).padStart(3)}  valeur ${pct(s.valeurMoyenne)}  mouvement ${pct(s.mouvementMoyen)}`);
}
console.log('\n── Par compétition ──');
for (const [k, liste] of parGroupe(m => m.prono.competition)) {
  const s = resumerClv(liste, { rnd });
  console.log(`  ${k.padEnd(20)} n=${String(s.n).padStart(3)}  valeur ${pct(s.valeurMoyenne)}  mouvement ${pct(s.mouvementMoyen)}`);
}

// ── Rendement réel sur les mêmes paris, pour mettre en regard ──
const notes = mesures.filter(m => m.prono.pronostic_correct != null);
if (notes.length) {
  const gains = notes.map(m => gainPari(m.prono.pronostic_correct, m.prono.cote_estimee)).filter(Number.isFinite);
  const roi = gains.reduce((a, b) => a + b, 0) / gains.length;
  console.log(`\nRendement réel sur ces mêmes paris : ${pct(roi)} sur ${gains.length} pari(s) notés — bien plus bruité que le CLV.`);
}

// ── Détail ──
console.log('\n── Détail (du meilleur au pire) ──');
for (const m of [...mesures].sort((a, b) => b.valeur - a.valeur)) {
  const p = m.prono;
  console.log(`  ${pct(m.valeur)}  ${p.date} ${p.equipe_a} vs ${p.equipe_b} · ${p.pari_code} @ ${Number(p.cote_estimee).toFixed(2)}`
    + ` · juste ${(1 / m.probaJuste).toFixed(2)} (${m.reference})${m.mouvement == null ? '' : ` · mouvement ${pct(m.mouvement)}`}`);
}

if (ecartes.size) {
  console.log('\n── Non mesurés ──');
  for (const [motif, liste] of ecartes) {
    console.log(`  ${motif} : ${liste.length}`);
    for (const l of liste.slice(0, 8)) console.log(`    · ${l}`);
    if (liste.length > 8) console.log(`    · … et ${liste.length - 8} autre(s)`);
  }
}
process.exit(0);
