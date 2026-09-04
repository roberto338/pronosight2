#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// scripts/quota-model.mjs — Combien d'analyses par jour ?
//
// Toutes les constantes ci-dessous sont MESURÉES, sauf celles marquées
// HYPOTHÈSE. Change un palier, relance : le calcul est reproductible.
//
//   node scripts/quota-model.mjs
//   node scripts/quota-model.mjs --competitions 6
// ══════════════════════════════════════════════════════════════

// ── Unité de travail ─────────────────────────────────────────
// ATTENTION : « une analyse » n'est PAS un match. Le pipeline traite
// TOUS les matchs du jour en UN SEUL appel IA (victor/core.js:589,
// « Analyse IA de 26 match(s) réel(s) » le 03/09). Le coût ne suit donc
// pas le nombre de matchs — il suit le nombre de COMPÉTITIONS, qui
// détermine les appels de cotes et de statistiques.
const COMPETITIONS_PAR_RUN = Number(
  process.argv.includes('--competitions')
    ? process.argv[process.argv.indexOf('--competitions') + 1]
    : 2                                   // mesuré le 03/09 (et le 01/09)
);

// ── The Odds API ─────────────────────────────────────────────
// MESURÉ : en-têtes x-requests-remaining / x-requests-used.
//   31/08 : 472 utilisés / 500 → 28 restants
//   01/09 : 4 utilisés → cycle CALENDAIRE confirmé
//   03/09 : 484 restants après l'analyse du matin
const ODDS_CREDITS_MOIS      = 500;
const ODDS_CREDITS_PAR_COMPET = 2;        // regions=eu (1) × markets=h2h,totals (2)
const ODDS_RUNS_FACTURES_JOUR = 1;        // cache 6 h : le run de 13h réutilise celui de 7h

// ── football-data ────────────────────────────────────────────
// MESURÉ : limiteur à 9/min (victor/sources.js), plafond réel 10/min.
// Requêtes par run le 03/09 : forme 2 + classement 2 + H2H 2 + buteurs 2 = 8
const FD_REQ_PAR_MIN   = 10;
const FD_REQ_PAR_RUN   = 2 + 3 * COMPETITIONS_PAR_RUN;
const FD_FENETRE_MIN   = 2;               // durée observée de la collecte

// ── Cascade IA ───────────────────────────────────────────────
// MESURÉ : 1 appel abouti par run. Mais Gemini échoue un matin sur deux
// (30/08, 01/09, 03/09) → compter les tentatives, pas les succès.
const IA_APPELS_PAR_RUN = 2;              // 1 Gemini + 1 repli, cas défavorable observé
// HYPOTHÈSE — à confirmer dans la console Google AI Studio et Groq.
const GEMINI_RPD = 200;                   // HYPOTHÈSE palier gratuit
const GROQ_RPD   = 1000;                  // HYPOTHÈSE palier gratuit

// ── Runs quotidiens réels ────────────────────────────────────
const RUNS_JOUR = 2;                      // prematch 07:00 + value 13:00

// ══════════════════════════════════════════════════════════════

const joursRestants = (() => {
  const d = new Date();
  const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return fin - d.getDate() + 1;
})();

function modele({ creditsRestants = ODDS_CREDITS_MOIS, jours = joursRestants } = {}) {
  const creditsParRun = ODDS_CREDITS_PAR_COMPET * COMPETITIONS_PAR_RUN;
  const creditsParJour = creditsParRun * ODDS_RUNS_FACTURES_JOUR;

  const contraintes = [
    {
      ressource: 'The Odds API (crédits/mois)',
      limite: `${ODDS_CREDITS_MOIS}/mois — ${creditsRestants} restants`,
      coutParRun: `${creditsParRun} crédits`,
      runsMax: Math.floor(creditsRestants / (jours * creditsParRun * ODDS_RUNS_FACTURES_JOUR)),
    },
    {
      ressource: 'football-data (débit)',
      limite: `${FD_REQ_PAR_MIN} req/min`,
      coutParRun: `${FD_REQ_PAR_RUN} req sur ~${FD_FENETRE_MIN} min`,
      runsMax: Math.floor((FD_REQ_PAR_MIN * FD_FENETRE_MIN) / FD_REQ_PAR_RUN),
    },
    {
      ressource: 'Gemini (RPD) [HYPOTHÈSE]',
      limite: `${GEMINI_RPD}/jour`,
      coutParRun: `${IA_APPELS_PAR_RUN} appels`,
      runsMax: Math.floor(GEMINI_RPD / IA_APPELS_PAR_RUN),
    },
    {
      ressource: 'Groq (RPD, filet) [HYPOTHÈSE]',
      limite: `${GROQ_RPD}/jour`,
      coutParRun: '1 appel',
      runsMax: GROQ_RPD,
    },
  ];

  const plancher = Math.min(...contraintes.map(c => c.runsMax));
  const limitant = contraintes.find(c => c.runsMax === plancher);

  return { contraintes, plancher, limitant, creditsParJour, jours };
}

const r = modele({ creditsRestants: Number(process.env.ODDS_RESTANTS || 484) });

console.log('\n═══ COMBIEN D\'ANALYSES PAR JOUR ? ═══');
console.log(`Unité : un RUN du pipeline (tous les matchs du jour en un appel IA).`);
console.log(`Hypothèse de volume : ${COMPETITIONS_PAR_RUN} compétition(s) cotée(s) par run.`);
console.log(`Jours restants dans le mois : ${r.jours}\n`);

const L = (s, n) => String(s).padEnd(n);
console.log(L('Ressource', 32) + L('Limite', 26) + L('Coût / run', 20) + L('Runs/jour max', 14) + 'Limitant ?');
console.log('─'.repeat(104));
for (const c of r.contraintes) {
  console.log(L(c.ressource, 32) + L(c.limite, 26) + L(c.coutParRun, 20)
    + L(c.runsMax, 14) + (c === r.limitant ? '◄── OUI' : ''));
}

console.log(`\nPlancher : ${r.plancher} runs/jour. Recommandé avec 30 % de marge : ${Math.floor(r.plancher * 0.7)}.`);
console.log(`Rythme actuel : ${RUNS_JOUR} runs/jour, soit ${r.creditsParJour} crédits — ${Math.round(r.creditsParJour * 30)} crédits/mois sur 500.`);
console.log(`\nRéponse binaire : The Odds API plafonne-t-elle AVANT les fournisseurs IA ?`);
console.log(`  → ${r.limitant.ressource.startsWith('The Odds') ? 'OUI' : 'NON — ' + r.limitant.ressource + ' mord en premier'}\n`);
