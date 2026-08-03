// ══════════════════════════════════════════════
// victor/test-unit.js — Tests de la logique de scoring
//
// Usage : npm test              (rapide, hors ligne)
//         npm run test:live     (+ vérifie les sources de données)
//
// Pourquoi ce fichier existe : evalPronostic() décide seule si un
// pronostic est gagné ou perdu. C'est elle qui produit le taux de
// réussite dont dépend la décision de monétiser. Une régression ici
// est invisible en production et fausse deux mois de tracking.
//
// Bug historique couvert : "Portugal -2.5" (handicap) était évalué
// comme "Under 2.5 buts" — tous les handicaps étaient inversés.
// ══════════════════════════════════════════════

import 'dotenv/config'; // doit précéder tout import qui lit process.env
import {
  evalPronostic, evalValueBet, matchFixture, repairTruncatedJSON,
  estNotable, validerEvent, normalizeTeam,
} from './core.js';

let ok = 0, ko = 0;
const echecs = [];

function verifie(libelle, obtenu, attendu) {
  if (obtenu === attendu) {
    ok++;
  } else {
    ko++;
    echecs.push(`${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`);
  }
}

// ══════════════════════════════════════════════
// 1. evalPronostic — [pronostic, butsDom, butsExt, attendu]
// ══════════════════════════════════════════════
const DOM = 'Portugal', EXT = 'Luxembourg';

const casEval = [
  // ── Handicap : le bug historique ──
  ['Portugal -2.5',             4, 0, true ],  // gagne par 4 > 2.5
  ['Portugal -2.5',             3, 0, true ],  // gagne par 3 > 2.5
  ['Portugal -2.5',             2, 0, false],  // gagne par 2 < 2.5
  ['Portugal -2.5',             0, 1, false],  // perd
  ['Handicap -1',               2, 0, true ],
  ['Handicap -1',               1, 0, false],  // 1-1=0, non gagnant
  ['Luxembourg +2.5',           2, 0, true ],  // perd par 2 < 2.5 → couvert
  ['Luxembourg +2.5',           4, 0, false],  // perd par 4 > 2.5
  ['Luxembourg +1',             1, 1, true ],

  // ── Over / Under ──
  ['Over 2.5 buts',             2, 1, true ],
  ['Over 2.5 buts',             1, 1, false],
  ['Under 2.5 buts',            1, 0, true ],
  ['Under 2.5 buts',            2, 2, false],
  ['Plus de 1.5 buts',          1, 1, true ],
  ['Moins de 3.5 buts',         2, 1, true ],
  ['Over 0.5 buts',             0, 0, false],

  // ── 1N2 ──
  ['Victoire Portugal',         1, 0, true ],
  ['Victoire Portugal',         0, 1, false],
  ['Victoire Portugal',         1, 1, false],
  ['Victoire Luxembourg',       0, 1, true ],
  ['Victoire domicile',         2, 1, true ],
  ['Victoire extérieur',        1, 2, true ],
  ['Match nul',                 1, 1, true ],
  ['Match nul',                 2, 1, false],

  // ── BTTS ──
  ['BTTS',                      1, 1, true ],
  ['BTTS',                      2, 0, false],
  ['Les deux équipes marquent', 1, 2, true ],

  // ── Non géré → null (part en arbitrage IA, jamais deviné) ──
  ['Mi-temps/fin de match 1/X', 1, 1, null ],
  ['Score exact 2-1',           2, 1, null ],
  ['',                          1, 1, null ],
];

for (const [prono, hg, ag, attendu] of casEval) {
  verifie(`evalPronostic("${prono}", ${hg}-${ag})`, evalPronostic(prono, hg, ag, DOM, EXT), attendu);
}

// ══════════════════════════════════════════════
// 2. evalValueBet — "aucun" et null ne sont pas des paris
// ══════════════════════════════════════════════
verifie('evalValueBet("aucun")',  evalValueBet('aucun', 1, 0, DOM, EXT), null);
verifie('evalValueBet("Aucun")',  evalValueBet('Aucun', 1, 0, DOM, EXT), null);
verifie('evalValueBet(null)',     evalValueBet(null,    1, 0, DOM, EXT), null);
verifie('evalValueBet("BTTS")',   evalValueBet('BTTS',  1, 1, DOM, EXT), true);

// ══════════════════════════════════════════════
// 3. matchFixture — appariement flou pronostic ↔ source
// ══════════════════════════════════════════════
const fixtures = [
  { home: 'Portugal',      away: 'Luxembourg',  status: 'FT', homeGoals: 4, awayGoals: 0, source: 'football-data' },
  { home: 'United States', away: 'South Korea', status: 'FT', homeGoals: 1, awayGoals: 1, source: 'thesportsdb' },
  { home: 'Manchester City', away: 'Arsenal',   status: 'FT', homeGoals: 2, awayGoals: 2, source: 'football-data' },
];

verifie('matchFixture exact',           matchFixture('Portugal vs Luxembourg', fixtures)?.home, 'Portugal');
verifie('matchFixture inversé',         matchFixture('Luxembourg vs Portugal', fixtures)?.home, 'Portugal');
verifie('matchFixture alias USA',       matchFixture('USA vs Korea Republic', fixtures)?.home, 'United States');
verifie('matchFixture introuvable',     matchFixture('Real Madrid vs Barcelona', fixtures), null);
verifie('matchFixture format invalide', matchFixture('Portugal', fixtures), null);
// England ≠ Manchester : ne doit PAS matcher par sous-chaîne
verifie('matchFixture faux positif',    matchFixture('England vs Arsenal', fixtures), null);

// ══════════════════════════════════════════════
// 4. repairTruncatedJSON — réponses IA coupées en plein vol
// ══════════════════════════════════════════════
function repare(txt) {
  try { return JSON.parse(repairTruncatedJSON(txt)); } catch { return null; }
}

// Coupé au milieu d'une chaîne : le dernier event est sacrifié
const t1 = repare('{"date":"2026-08-03","events":[{"match":"A vs B","pronostic_principal":"Victoire A"},{"match":"C vs D","analyse":"le match sera dispu');
verifie('tronqué en pleine chaîne', t1?.events?.length, 1);
verifie('tronqué — 1er event intact', t1?.events?.[0]?.match, 'A vs B');

// Coupé juste après un objet complet
const t2 = repare('{"events":[{"match":"A vs B"},{"match":"C vs D"}');
verifie('tronqué après objet', t2?.events?.length, 2);

// Coupé sur une clé sans valeur
const t3 = repare('{"events":[{"match":"A vs B"}],"verdict_journee":');
verifie('tronqué sur clé nue', t3?.events?.length, 1);

// JSON déjà valide : doit rester intact
const t4 = repare('{"events":[{"match":"A vs B"}],"verdict_journee":"ok"}');
verifie('JSON complet préservé', t4?.verdict_journee, 'ok');

// ══════════════════════════════════════════════
// 5. Portillon de validation — ce qui entre en base
//
// Régression couverte : le 03/08/2026 la production a inséré 5 lignes
// "NO BET" / vides. Impossibles à noter, elles auraient dilué le taux
// de réussite sans jamais le faire bouger.
// ══════════════════════════════════════════════
const evBase = { match: 'Portugal vs Luxembourg', equipe_a: 'Portugal', equipe_b: 'Luxembourg', cote_estimee: 1.8 };
const ev = (extra) => ({ ...evBase, ...extra });

// estNotable
verifie('notable — victoire',   estNotable(ev({ pronostic_principal: 'Victoire Portugal' })), true);
verifie('notable — handicap',   estNotable(ev({ pronostic_principal: 'Portugal -2.5' })),     true);
verifie('notable — over',       estNotable(ev({ pronostic_principal: 'Over 2.5 buts' })),     true);
verifie('non notable — NO BET', estNotable(ev({ pronostic_principal: 'NO BET' })),            false);
verifie('non notable — vide',   estNotable(ev({ pronostic_principal: '' })),                  false);
verifie('non notable — absent', estNotable(ev({})),                                           false);
verifie('non notable — exotique', estNotable(ev({ pronostic_principal: 'Score exact 2-1' })), false);

// validerEvent : 0 motif = publiable
const cles = new Set(['portugal|luxembourg']);
verifie('valide — cas nominal',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal' }), cles).length, 0);
verifie('rejet — NO BET',
  validerEvent(ev({ pronostic_principal: 'NO BET' }), cles).length, 1);
verifie('rejet — pronostic vide',
  validerEvent(ev({ pronostic_principal: '' }), cles).length, 1);
verifie('rejet — cote implausible',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal', cote_estimee: 0.4 }), cles).length, 1);
verifie('rejet — cote absurde',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal', cote_estimee: 120 }), cles).length, 1);
// Match cohérent en lui-même, mais absent des sources → inventé
const evInvente = { match: 'Real Madrid vs Barcelona', equipe_a: 'Real Madrid', equipe_b: 'Barcelona',
                    cote_estimee: 2.1, pronostic_principal: 'Victoire Real Madrid' };
verifie('rejet — match inventé', validerEvent(evInvente, cles).length, 1);
verifie('rejet — équipes manquantes',
  validerEvent({ pronostic_principal: 'Victoire Portugal' }, cles).length > 0, true);
// Sans liste de référence, on ne contrôle pas l'existence du match
verifie('sans sources — pas de contrôle d\'existence',
  validerEvent(evInvente, null).length, 0);

// Rejeu de la sortie de production du 03/08/2026 : les 5 lignes réellement
// insérées (4 "NO BET" + 1 vide) doivent toutes être rejetées.
const matchsDuJour = [
  ['Philadelphia Phillies', 'Washington Nationals'],
  ['Platense', 'Talleres de Córdoba'],
  ['Atlanta Dream', 'Las Vegas Aces'],
];
// ⚠️ Les clés DOIVENT être construites avec le normalizeTeam de core.js —
// celui de sources.js retire « de » et produirait un faux « match inventé ».
const clesJour = new Set(matchsDuJour.map(([a, b]) => `${normalizeTeam(a)}|${normalizeTeam(b)}`));

verifie('prod 03/08 — pronostic vide rejeté',
  validerEvent({ match: 'Philadelphia Phillies vs Washington Nationals', equipe_a: 'Philadelphia Phillies',
                 equipe_b: 'Washington Nationals', pronostic_principal: '' }, clesJour).length > 0, true);
verifie('prod 03/08 — NO BET rejeté',
  validerEvent({ match: 'Atlanta Dream vs Las Vegas Aces', equipe_a: 'Atlanta Dream',
                 equipe_b: 'Las Vegas Aces', pronostic_principal: 'NO BET' }, clesJour).length > 0, true);
// Accents + particule : ne doit PAS être pris pour un match inventé
verifie('accents et particules — pas de faux positif',
  validerEvent({ match: 'Platense vs Talleres de Córdoba', equipe_a: 'Platense',
                 equipe_b: 'Talleres de Córdoba', pronostic_principal: 'Victoire Platense',
                 cote_estimee: 2.0 }, clesJour).length, 0);

// ══════════════════════════════════════════════
// 6. Value bet — calculée, plus déclarée par le LLM
// ══════════════════════════════════════════════
const { calculerValue, probaImplicite, cleMarche, evaluerValue } = await import('./odds.js');

// value = p × cote − 1
verifie('value positive',        calculerValue(0.60, 2.00), 0.20);
verifie('value nulle',           calculerValue(0.50, 2.00), 0);
verifie('value négative',        calculerValue(0.40, 2.00), -0.20);
verifie('value proba invalide',  calculerValue(1.5, 2.00),  null);
verifie('value cote invalide',   calculerValue(0.60, 0.5),  null);
verifie('value non numérique',   calculerValue('abc', 2),   null);

verifie('proba implicite 2.00',  probaImplicite(2.00), 0.5);
verifie('proba implicite 1.25',  probaImplicite(1.25), 0.8);

// Association pronostic -> marché coté
verifie('marché victoire dom.',  cleMarche('Victoire Palmeiras', 'Palmeiras', 'Santos'), '1X2:HOME');
verifie('marché victoire ext.',  cleMarche('Victoire Santos', 'Palmeiras', 'Santos'),    '1X2:AWAY');
verifie('marché nul',            cleMarche('Match nul', 'Palmeiras', 'Santos'),          '1X2:DRAW');
verifie('marché over 2.5',       cleMarche('Over 2.5 buts', 'Palmeiras', 'Santos'),      'OU:OVER:2.5');
verifie('marché under 3.5',      cleMarche('Under 3.5 buts', 'Palmeiras', 'Santos'),     'OU:UNDER:3.5');
// Prudence assumée : pas de cote h2h pour ces marchés -> null plutôt qu'un mauvais rapprochement
verifie('marché double chance non associé', cleMarche('Double chance : Santos ou nul', 'Palmeiras', 'Santos'), null);
verifie('marché handicap non associé',      cleMarche('Palmeiras -1.5', 'Palmeiras', 'Santos'),                null);

// Bout en bout : un pari sous-coté doit ressortir avec une value négative
const cotesMatch = { marches: { '1X2:HOME': 1.40, '1X2:DRAW': 4.20, 'OU:OVER:2.5': 1.90 }, bookmakers: 7 };
const evBon = { pronostic_principal: 'Victoire Palmeiras', equipe_a: 'Palmeiras', equipe_b: 'Santos', probabilite: 0.80 };
const evMauvais = { ...evBon, probabilite: 0.60 };
verifie('value bet retenu',   evaluerValue(evBon, cotesMatch).value > 0, true);
verifie('cote réelle reprise', evaluerValue(evBon, cotesMatch).cote, 1.40);
verifie('value bet rejeté',   evaluerValue(evMauvais, cotesMatch).value < 0, true);
verifie('sans cote -> null',  evaluerValue({ ...evBon, pronostic_principal: 'BTTS' }, cotesMatch), null);

// ══════════════════════════════════════════════
// 7. Sources de données (uniquement avec --live)
// ══════════════════════════════════════════════
if (process.argv.includes('--live')) {
  console.log('\n🌐 Vérification des sources de données...\n');
  const { getFixturesOfDay, getResultsOfDay, normalizeTeam } = await import('./sources.js');

  verifie('normalizeTeam accents',  normalizeTeam('Grêmio'), 'gremio');
  verifie('normalizeTeam suffixes', normalizeTeam('Manchester United FC'), 'manchester united');

  const hier  = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const duJour = await getFixturesOfDay(today);
  console.log(`   Matchs du jour        : ${duJour.length}`);
  const resultats = await getResultsOfDay(hier);
  console.log(`   Résultats d'hier      : ${resultats.length}`);

  // Un résultat doit toujours porter un score exploitable
  const incoherents = resultats.filter(f => f.homeGoals === null || f.awayGoals === null);
  verifie('résultats tous scorés', incoherents.length, 0);
}

// ══════════════════════════════════════════════
// Verdict
// ══════════════════════════════════════════════
console.log(`\n${'═'.repeat(46)}`);
if (ko === 0) {
  console.log(`✅ ${ok} test(s) passé(s), 0 échec`);
} else {
  console.log(`❌ ${ok} passé(s), ${ko} ÉCHEC(S) :\n`);
  echecs.forEach(e => console.log(`   • ${e}`));
}
console.log('═'.repeat(46));

process.exit(ko > 0 ? 1 : 0);
