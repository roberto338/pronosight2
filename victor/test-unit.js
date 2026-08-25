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
  evalPronostic, evalValueBet, matchFixture, repairTruncatedJSON, extractJSON,
  estNotable, validerEvent, normalizeTeam,
} from './core.js';
import { heureParis, estHoraireProvisoire } from './sources.js';
import { cacheLire, cacheEcrire, cacheVider } from './odds.js';

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
// 4 bis. extractJSON — enveloppe des moteurs + réponses coupées
// ══════════════════════════════════════════════
// Régression du 16/08 : Gemini a épuisé son plafond de tokens en
// réflexion et rendu un JSON coupé AVANT sa première accolade fermante.
// extractJSON levait « Aucun JSON trouvé » sans jamais atteindre sa
// propre réparation — trois tentatives perdues, zéro pronostic du jour.
const enveloppe = (txt) => ({ source: 'gemini', data: { candidates: [{ content: { parts: [{ text: txt }] } }] } });

const e1 = extractJSON(enveloppe('{"date":"2026-08-16","events":[{"match":"A vs B","pari_code":"1X2:HOME"},{"match":"C vs D","contexte":"deux équipes ayant perdu leur pre'));
verifie('coupé avant toute accolade fermante', e1?.events?.length, 1);
verifie('coupé — event exploitable', e1?.events?.[0]?.pari_code, '1X2:HOME');

// Coupé sans la moindre accolade fermante ET sans event complet :
// il n'y a rien à sauver, mais ça doit lever proprement, pas boucler.
let leve = false;
try { extractJSON(enveloppe('{"date":"2026-08-16","events":[{"match":"A vs')); } catch { leve = true; }
verifie('coupé trop tôt → erreur propre', leve, true);

// Réponse complète : le chemin nominal ne doit pas régresser
const e2 = extractJSON(enveloppe('```json\n{"events":[{"match":"A vs B"}],"verdict_journee":"ok"}\n```'));
verifie('markdown + JSON complet', e2?.verdict_journee, 'ok');

// Réponse vraiment vide : toujours refusée
let vide = false;
try { extractJSON(enveloppe('désolé, je ne peux pas répondre')); } catch { vide = true; }
verifie('réponse sans JSON refusée', vide, true);

// ══════════════════════════════════════════════
// 5. Portillon de validation — ce qui entre en base
//
// Régression couverte : le 03/08/2026 la production a inséré 5 lignes
// "NO BET" / vides. Impossibles à noter, elles auraient dilué le taux
// de réussite sans jamais le faire bouger.
// ══════════════════════════════════════════════
// Depuis la migration 011, un event valide porte un pari_code.
const evBase = { match: 'Portugal vs Luxembourg', equipe_a: 'Portugal', equipe_b: 'Luxembourg',
                 cote_estimee: 1.8, pari_code: '1X2:HOME' };
const ev = (extra) => ({ ...evBase, ...extra });

// estNotable — avec un code valide, le libellé n'a plus d'importance
verifie('notable — code valide suffit', estNotable(ev({ pronostic_principal: 'peu importe' })), true);
verifie('notable — code de handicap',   estNotable(ev({ pari_code: 'AH:HOME:-2.5' })),          true);

// Sans code : repli sur l'ancienne analyse du libellé (pronostics d'avant la 011)
const sansCode = (extra) => { const e = ev(extra); delete e.pari_code; return e; };
verifie('legacy notable — victoire',    estNotable(sansCode({ pronostic_principal: 'Victoire Portugal' })), true);
verifie('legacy notable — over',        estNotable(sansCode({ pronostic_principal: 'Over 2.5 buts' })),     true);
verifie('legacy non notable — NO BET',  estNotable(sansCode({ pronostic_principal: 'NO BET' })),            false);
verifie('legacy non notable — vide',    estNotable(sansCode({ pronostic_principal: '' })),                  false);
verifie('legacy non notable — exotique',estNotable(sansCode({ pronostic_principal: 'Score exact 2-1' })),   false);
verifie('code invalide non notable',    estNotable(ev({ pari_code: 'DC:99', pronostic_principal: 'Score exact 2-1' })), false);

// validerEvent : 0 motif = publiable
const cles = new Set(['portugal|luxembourg']);
verifie('valide — cas nominal',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal' }), cles).length, 0);
// Sans code exploitable, le pari est rejeté quel que soit son libellé —
// c'est la garantie qui remplace les correctifs par expressions régulières.
// On vérifie le REJET, pas le nombre de motifs : plusieurs peuvent
// s'appliquer en même temps, et compter les raisons rend le test fragile.
verifie('rejet — NO BET sans code',
  validerEvent(sansCode({ pronostic_principal: 'NO BET' }), cles).length > 0, true);
verifie('rejet — pronostic vide sans code',
  validerEvent(sansCode({ pronostic_principal: '' }), cles).length > 0, true);
verifie('rejet — code invalide',
  validerEvent(ev({ pari_code: 'SCORE:2-1' }), cles).length > 0, true);
verifie('rejet — cote implausible',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal', cote_estimee: 0.4 }), cles).length, 1);
verifie('rejet — cote absurde',
  validerEvent(ev({ pronostic_principal: 'Victoire Portugal', cote_estimee: 120 }), cles).length, 1);
// Match cohérent en lui-même, mais absent des sources → inventé
const evInvente = { match: 'Real Madrid vs Barcelona', equipe_a: 'Real Madrid', equipe_b: 'Barcelona',
                    cote_estimee: 2.1, pronostic_principal: 'Victoire Real Madrid', pari_code: '1X2:HOME' };
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
                 pari_code: '1X2:HOME', cote_estimee: 2.0 }, clesJour).length, 0);

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
// 5 bis. VOCABULAIRE FERMÉ — la fin des regex sur les paris
//
// Trois faux résultats en dix jours, tous dus à l'interprétation d'un
// libellé en texte libre. Un pari est désormais un CODE, évalué par une
// fonction pure. Ces tests rejouent les trois incidents réels.
// ══════════════════════════════════════════════
const { evaluerCode, codeValide, libelleCode, codeDepuisTexte } = await import('./paris.js');

// Les trois bugs historiques, exprimés en codes
verifie('DC:12 sur un nul (bug du 12/08)',    evaluerCode('DC:12', 1, 1), false);
verifie('DC:12 sur une victoire',             evaluerCode('DC:12', 2, 0), true);
verifie('AH:HOME:-2.5 gagne par 4 (03/08)',   evaluerCode('AH:HOME:-2.5', 4, 0), true);
verifie('AH:HOME:-2.5 gagne par 2',           evaluerCode('AH:HOME:-2.5', 2, 0), false);
verifie('DC:X2 sur victoire ext (05/08)',     evaluerCode('DC:X2', 0, 1), true);
verifie('DC:X2 sur victoire dom',             evaluerCode('DC:X2', 2, 0), false);

// Familles restantes
verifie('1X2:HOME',        evaluerCode('1X2:HOME', 2, 0), true);
verifie('1X2:DRAW',        evaluerCode('1X2:DRAW', 1, 1), true);
verifie('OU:UNDER:2.5',    evaluerCode('OU:UNDER:2.5', 1, 1), true);
verifie('BTTS:NO sur 2-0', evaluerCode('BTTS:NO', 2, 0), true);
verifie('TT:AWAY:OVER:0.5 ext marque', evaluerCode('TT:AWAY:OVER:0.5', 0, 1), true);
verifie('TT:AWAY:OVER:0.5 ext muet',   evaluerCode('TT:AWAY:OVER:0.5', 3, 0), false);

// Un code inconnu est REJETÉ, jamais deviné
verifie('code inconnu rejeté',   evaluerCode('DC:99', 1, 1), null);
verifie('famille inconnue',      evaluerCode('SCORE:2-1', 2, 1), null);
verifie('code vide',             evaluerCode('', 1, 1), null);
verifie('codeValide insensible à la casse', codeValide('dc:12'), true);

// Libellé dérivé du code, jamais l'inverse
verifie('libellé DC:12',    libelleCode('DC:12', 'Palmeiras', 'Cerro'), 'Pas de match nul');
verifie('libellé 1X2:AWAY', libelleCode('1X2:AWAY', 'PSV', 'Sittard'), 'Victoire Sittard');

// Traduction de secours — pièges relevés sur l'historique réel
verifie('texte « Sunderland ou Nul »',  codeDepuisTexte('Sunderland ou Nul', 'Sunderland', 'Forest'), 'DC:1X');
verifie('texte « Pas de match nul »',   codeDepuisTexte('Pas de match nul', 'A', 'B'), 'DC:12');
verifie('texte « Portugal -2.5 »',      codeDepuisTexte('Portugal -2.5', 'Portugal', 'Luxembourg'), 'AH:HOME:-2.5');
verifie('texte team total',             codeDepuisTexte('Braga marque (Team Total Over 0.5)', 'Braga', 'Fribourg'), 'TT:HOME:OVER:0.5');
verifie('pari combiné refusé',          codeDepuisTexte('Lille gagne et Over 1.5 buts', 'Lille', 'Le Havre'), null);
verifie('libellé inconnu refusé',       codeDepuisTexte('Score exact 2-1', 'A', 'B'), null);

// ══════════════════════════════════════════════
// 6 bis. NÉGATION — la classe de bug la plus coûteuse
//
// Régression réelle du 12/08/2026 : Victor publie « Pas de match nul
// (Double chance 12) » sur Palmeiras – Cerro Porteño. Le match finit 1-1,
// donc NUL, donc le pari est PERDU. evalPronostic voyait le mot « nul »,
// déclenchait la branche du match nul et répondait GAGNÉ.
// Un taux de réussite affiché à 100% sur un pari perdu.
// ══════════════════════════════════════════════
const PAL = 'Palmeiras', CER = 'Cerro Porteño';

verifie('négation — pas de nul, match nul',       evalPronostic('Pas de match nul (Double chance 12)', 1, 1, PAL, CER), false);
verifie('négation — pas de nul, victoire dom',    evalPronostic('Pas de match nul (Double chance 12)', 2, 0, PAL, CER), true);
verifie('négation — pas de nul, victoire ext',    evalPronostic('Pas de match nul (Double chance 12)', 0, 3, PAL, CER), true);
verifie('négation — formulation courte',          evalPronostic('Pas de match nul', 1, 1, PAL, CER),                    false);
verifie('négation — double chance : pas de nul',  evalPronostic('Double chance : pas de nul', 1, 1, PAL, CER),          false);
verifie('sans négation — match nul reste correct',evalPronostic('Match nul', 1, 1, PAL, CER),                           true);
verifie('sans négation — match nul, non nul',     evalPronostic('Match nul', 2, 1, PAL, CER),                           false);
verifie('négation — BTTS Non sur 1-1',            evalPronostic('BTTS Non', 1, 1, PAL, CER),                            false);
verifie('négation — BTTS Non sur 1-0',            evalPronostic('BTTS Non', 1, 0, PAL, CER),                            true);

// Codes de double chance
verifie('double chance 1X — victoire dom',  evalPronostic('Double chance 1X', 2, 0, PAL, CER), true);
verifie('double chance 1X — nul',           evalPronostic('Double chance 1X', 1, 1, PAL, CER), true);
verifie('double chance 1X — défaite dom',   evalPronostic('Double chance 1X', 0, 2, PAL, CER), false);
verifie('double chance X2 — nul',           evalPronostic('Double chance X2', 1, 1, PAL, CER), true);
verifie('double chance X2 — victoire dom',  evalPronostic('Double chance X2', 2, 0, PAL, CER), false);
verifie('double chance 12 — nul',           evalPronostic('Double chance 12', 1, 1, PAL, CER), false);
verifie('double chance 12 — victoire',      evalPronostic('Double chance 12', 2, 1, PAL, CER), true);
// Par nom d'équipe
verifie('double chance équipe dom — nul',   evalPronostic('Double chance : Palmeiras ou nul', 1, 1, PAL, CER), true);
verifie('double chance équipe dom — perdu', evalPronostic('Double chance : Palmeiras ou nul', 0, 2, PAL, CER), false);

// ══════════════════════════════════════════════
// 7. Fenêtre de rattrapage — décalage de date
//
// Régression couverte : le 03/08/2026, 4 pronostics sur 5 n'ont jamais été
// notés parce que checkResults ne regardait que CURRENT_DATE à 23h30, alors
// que les matchs WNBA/MLB commençaient à 01h00 heure de Paris.
// ══════════════════════════════════════════════
const { decalerJour } = await import('./core.js');

verifie('lendemain simple',        decalerJour('2026-08-03', 1),  '2026-08-04');
verifie('veille simple',           decalerJour('2026-08-03', -1), '2026-08-02');
verifie('passage de mois',         decalerJour('2026-08-31', 1),  '2026-09-01');
verifie('passage d\'année',        decalerJour('2026-12-31', 1),  '2027-01-01');
verifie('fin de mois court',       decalerJour('2026-03-01', -1), '2026-02-28');
verifie('recul de 3 jours',        decalerJour('2026-08-03', -3), '2026-07-31');
// Midi UTC en pivot : garantit qu'aucun fuseau ne fait basculer le jour
verifie('stable, aller-retour',    decalerJour(decalerJour('2026-08-03', 1), -1), '2026-08-03');

// ══════════════════════════════════════════════
// 8. Sources de données (uniquement avec --live)
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
// Fenêtre jouable — un pronostic sur un match commencé n'en est pas un
// ══════════════════════════════════════════════
//
// Régression des 21 et 23/08 : 4 pronostics sur 16 ont été publiés APRÈS
// le coup d'envoi. Le filtre ne testait que le statut déclaré par le
// fournisseur, toujours en retard. Corinthians vs Rosario, débuté à
// 02:30, est parti à 07:02 ; Go Ahead vs Den Haag, débuté à 12:15, à
// 13:01. Pour un abonné, recevoir un pari sur un match déjà joué est
// indéfendable — c'est le défaut le plus coûteux qu'on ait eu.

// ── estHoraireProvisoire : minuit UTC pile = match non programmé ──
verifie('minuit UTC = provisoire',      estHoraireProvisoire('2026-08-22T00:00:00Z'), true);
verifie('heure réelle = définitive',    estHoraireProvisoire('2026-08-22T18:00:00Z'), false);
verifie('horodatage absent = provisoire', estHoraireProvisoire(null), true);
verifie('horodatage illisible = provisoire', estHoraireProvisoire('pas une date'), true);
// Un match à 02:00 Paris (00:00 UTC en hiver) reste suspect, mais un
// match à 00:30 UTC est un vrai coup d'envoi : seul minuit PILE compte.
verifie('00:30 UTC = définitive',       estHoraireProvisoire('2026-08-22T00:30:00Z'), false);

// ── heureParis : l'affichage dérive de l'horodatage, jamais saisi à part ──
verifie('18:00 UTC → 20:00 Paris (été)', heureParis('2026-08-22T18:00:00Z'), '20:00');
verifie('00:00 UTC → 02:00 Paris (été)', heureParis('2026-08-22T00:00:00Z'), '02:00');
verifie('horodatage absent → vide',      heureParis(null), '');
verifie('horodatage illisible → vide',   heureParis('n importe quoi'), '');

// ── Le filtre lui-même, reproduit à l'identique ──
// Trois conditions : coup d'envoi futur (marge 15 min), bon jour,
// non terminé. On rejoue la logique de runVictor sur des cas construits.
const MARGE = 15 * 60 * 1000;
function estJouable(f, maintenant, dateISO) {
  if (f.status === 'FT' || f.status === 'LIVE') return false;
  const debut = f.debutUTC ? new Date(f.debutUTC).getTime() : NaN;
  if (Number.isNaN(debut)) return false;
  if (debut - maintenant < MARGE) return false;
  if (String(f.debutUTC).slice(0, 10) !== dateISO) return false;
  return true;
}
const T = new Date('2026-08-21T05:00:00Z').getTime();   // 07:00 Paris, l'heure du cron
const J = '2026-08-21';

verifie('match du soir → jouable',
  estJouable({ status: 'NS', debutUTC: '2026-08-21T19:00:00Z' }, T, J), true);
// Le cas Corinthians vs Rosario : coup d'envoi 00:30 UTC, analyse à 05:00
verifie('match déjà commencé → écarté',
  estJouable({ status: 'NS', debutUTC: '2026-08-21T00:30:00Z' }, T, J), false);
// Le cas Go Ahead vs Den Haag vu par le job de 13h
verifie('commencé il y a 46 min → écarté',
  estJouable({ status: 'NS', debutUTC: '2026-08-23T10:15:00Z' },
             new Date('2026-08-23T11:01:00Z').getTime(), '2026-08-23'), false);
// Le cas NEC vs Excelsior : bon statut, mais programmé le lendemain
verifie('match du lendemain → écarté',
  estJouable({ status: 'NS', debutUTC: '2026-08-22T18:00:00Z' }, T, J), false);
verifie('coup d envoi dans 10 min → écarté (sous la marge)',
  estJouable({ status: 'NS', debutUTC: '2026-08-21T05:10:00Z' }, T, J), false);
verifie('coup d envoi dans 20 min → jouable',
  estJouable({ status: 'NS', debutUTC: '2026-08-21T05:20:00Z' }, T, J), true);
verifie('statut FT → écarté',
  estJouable({ status: 'FT', debutUTC: '2026-08-21T19:00:00Z' }, T, J), false);
verifie('statut LIVE → écarté',
  estJouable({ status: 'LIVE', debutUTC: '2026-08-21T19:00:00Z' }, T, J), false);
// Sans horodatage on ne peut rien affirmer : on refuse plutôt que de parier
verifie('horodatage inconnu → écarté',
  estJouable({ status: 'NS', debutUTC: null }, T, J), false);


// ══════════════════════════════════════════════
// Cache des cotes — chaque compétition interrogée coûte 2 crédits
// ══════════════════════════════════════════════
//
// Le palier gratuit de The Odds API donne 500 crédits par mois. Au 25/08,
// 380 étaient consommés — dont une part pure perte : une reprise de job
// repayait l'intégralité des cotes (arrivé les 24 et 25/08), et un
// déclenchement manuel juste après un cron aussi. Sans cotes, Victor ne
// calcule aucune value et ne publie rien : tomber à court arrête tout.

cacheVider();
verifie('cache vide → rien à lire',       cacheLire('soccer_epl'), null);

cacheEcrire('soccer_epl', [{ id: 'x' }]);
verifie('après écriture → relu',          cacheLire('soccer_epl')?.length, 1);
verifie('autre compétition non affectée', cacheLire('soccer_spain_la_liga'), null);

// L'expiration doit vraiment expirer, sinon une analyse de 13h servirait
// les cotes de 7h — le marché a bougé entre-temps.
cacheEcrire('soccer_serie_a', [{ id: 'y' }]);
const entree = cacheLire('soccer_serie_a');
verifie('entrée fraîche lisible',         entree?.length, 1);

cacheVider();
verifie('vidage effectif',                cacheLire('soccer_epl'), null);


// ══════════════════════════════════════════════
// Origine de la cote — publier sans marché, mais le dire
// ══════════════════════════════════════════════
//
// Décision du 25/08 : plutôt que de refuser un pronostic quand The Odds
// API ne couvre pas la compétition, on le publie en indiquant que la
// cote est estimée. Deux invariants en découlent, et ils doivent tenir :
//
//   1. validerEvent() ne doit JAMAIS rejeter un pronostic au seul motif
//      qu'il n'a pas de cote — sinon on aurait choisi l'option stricte
//      sans le vouloir, et les jours creux ne produiraient plus rien.
//   2. false ne doit pas se confondre avec « inconnu ». La colonne
//      distingue trois états : marché confirmé, estimation, et NULL pour
//      les pronostics antérieurs. Écrire `ev.cote_confirmee || null`
//      transformerait false en NULL et perdrait toute la mesure.

const evSansCote = {
  match: 'A vs B', equipe_a: 'A', equipe_b: 'B',
  pari_code: 'OU:OVER:2.5', pronostic_principal: 'Plus de 2.5 buts',
};
verifie('pronostic sans cote accepté', validerEvent(evSansCote).length, 0);

const evCoteVide = { ...evSansCote, cote_estimee: '' };
verifie('cote vide acceptée', validerEvent(evCoteVide).length, 0);

// La plausibilité reste contrôlée : une cote inventée reste bornée.
verifie('cote absurde refusée', validerEvent({ ...evSansCote, cote_estimee: 900 }).length, 1);
verifie('cote sous 1.01 refusée', validerEvent({ ...evSansCote, cote_estimee: 0.5 }).length, 1);
verifie('cote plausible acceptée', validerEvent({ ...evSansCote, cote_estimee: 1.85 }).length, 0);

// Le piège du booléen : `false || null` vaut null, `false ?? null` vaut false.
const enBase = (v) => (v ?? null);
verifie('marché confirmé → true',  enBase(true),  true);
verifie('estimation → false',      enBase(false), false);
verifie('inconnu → null',          enBase(undefined), null);

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