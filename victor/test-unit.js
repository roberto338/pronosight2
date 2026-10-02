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
import {
  heureParis, estHoraireProvisoire, formatFixturesForPrompt,
  aDesDonnees, couvertureContexte, lireStandingsApiFootball,
  getContexteApiFootball, MAX_LIGUES_SECOURS,
} from './sources.js';
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

// ── Régression du 02/10 : « Pas de match nul » recevait la cote du NUL ──
// libelleCode('DC:12') vaut « Pas de match nul » ; cleMarche y lisait « nul ».
// Sept doubles chances publiées à 3,01–3,80 au lieu d'environ 1,35.
verifie('« Pas de match nul » n\'est pas un nul',  cleMarche('Pas de match nul', 'Palmeiras', 'Santos'), null);
verifie('« Pas de nul » n\'est pas un nul',        cleMarche('Pas de nul', 'Palmeiras', 'Santos'), null);
verifie('« No draw » n\'est pas un nul',           cleMarche('No draw', 'Palmeiras', 'Santos'), null);
verifie('« Match nul » reste un nul',              cleMarche('Match nul', 'Palmeiras', 'Santos'), '1X2:DRAW');
const evDc12 = { pari_code: 'DC:12', pronostic_principal: 'Pas de match nul',
                 equipe_a: 'Palmeiras', equipe_b: 'Santos', probabilite: 0.75 };
verifie('DC:12 non coté → aucune cote (rejet en amont)', evaluerValue(evDc12, cotesMatch), null);
// Le code fait foi même quand le libellé dit autre chose.
const evCodeContreLibelle = { pari_code: 'OU:OVER:2.5', pronostic_principal: 'Victoire Palmeiras',
                              equipe_a: 'Palmeiras', equipe_b: 'Santos', probabilite: 0.60 };
verifie('le code de pari fait foi sur le libellé', evaluerValue(evCodeContreLibelle, cotesMatch)?.cote, 1.90);
verifie('code coté : cote du bon marché', evaluerValue({ ...evBon, pari_code: '1X2:HOME' }, cotesMatch)?.cote, 1.40);
verifie('code non coté par le marché → null', evaluerValue({ ...evBon, pari_code: '1X2:AWAY' }, cotesMatch), null);
// Sans code (anciens formats), le libellé reste lu.
verifie('sans code, le libellé sert encore', evaluerValue(evBon, cotesMatch)?.cote, 1.40);

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
// Un marché disponible doit être utilisé
// ══════════════════════════════════════════════
//
// Le 31/08 : 7 matchs cotés, et pourtant les 4 pronostics étaient des
// « Under 3.5 » et « Over 1.5 ». The Odds API ne publie que la ligne
// principale du bookmaker — 2.5 buts au football. evaluerValue ne
// trouvait donc aucune cote, retournait null, et le pari passait sans
// jamais être arbitré. 53 % de l'historique était dans ce cas : le
// garde-fou censé écarter les paris perdants ne servait à rien.

const marchesReels = { marches: {
  '1X2:HOME': 2.10, '1X2:DRAW': 3.40, '1X2:AWAY': 3.10,
  'OU:OVER:2.5': 1.95, 'OU:UNDER:2.5': 1.85,
} };

// evaluerValue trouve la ligne cotée → le pari est arbitrable
const arbitrable = evaluerValue(
  { pronostic_principal: 'Plus de 2.5 buts', probabilite: 0.60, equipe_a: 'A', equipe_b: 'B' },
  marchesReels);
verifie('seuil coté → value calculée', arbitrable !== null, true);
verifie('cote réelle reprise',         arbitrable?.cote, 1.95);

// Le seuil 3.5 n'est pas au menu : aucune cote, donc aucun arbitrage
const horsMarche = evaluerValue(
  { pronostic_principal: 'Moins de 3.5 buts', probabilite: 0.80, equipe_a: 'A', equipe_b: 'B' },
  marchesReels);
verifie('seuil non coté → non arbitrable', horsMarche, null);

const over15 = evaluerValue(
  { pronostic_principal: 'Plus de 1.5 buts', probabilite: 0.85, equipe_a: 'A', equipe_b: 'B' },
  marchesReels);
verifie('Over 1.5 → non arbitrable', over15, null);

// Les familles sans équivalent dans h2h/totals ne le seront jamais
const doubleChance = evaluerValue(
  { pronostic_principal: 'Double chance 1X', probabilite: 0.75, equipe_a: 'A', equipe_b: 'B' },
  marchesReels);
verifie('double chance → non arbitrable', doubleChance, null);

// Aucune donnée de marché : le pronostic reste publiable, avec mention
verifie('aucun marché → null sans erreur', evaluerValue({ pronostic_principal: 'Plus de 2.5 buts', probabilite: 0.6 }, null), null);

// La value reste calculée, pas déclarée : 0.60 × 1.95 − 1 = 0.17
verifie('value calculée juste', Math.round((arbitrable.value + Number.EPSILON) * 100) / 100, 0.17);

// ══════════════════════════════════════════════
// La cote du value bet vient du marché, elle aussi
// ══════════════════════════════════════════════
//
// Le 01/09, les trois pronostics avaient enfin une cote principale
// vérifiée — mais leur value bet portait une cote écrite par le modèle
// (1.87, 1.73, 2.74) que rien ne confirmait. Le défaut n'avait pas
// disparu, il s'était déplacé d'une ligne.
//
// On reproduit ici la résolution appliquée dans runVictor.

const marchesVb = {
  '1X2:HOME': 1.87, '1X2:DRAW': 3.50, '1X2:AWAY': 4.10,
  'OU:OVER:2.5': 1.73, 'OU:UNDER:2.5': 2.05,
};
function resoudreValueBet(valueBet, marches, equipeA, equipeB) {
  const nul = String(valueBet || '').trim().toLowerCase();
  if (!marches || !valueBet || nul === 'aucun' || nul === 'no bet' || nul === 'n/a') return { valueBet, cote: null };
  const cle  = marches[valueBet] != null ? valueBet : cleMarche(valueBet, equipeA, equipeB);
  const cote = cle ? marches[cle] : null;
  return cote ? { valueBet, cote } : { valueBet: 'aucun', cote: null };
}

// Code déjà dans le vocabulaire : la cote du marché est reprise
verifie('code coté → cote du marché', resoudreValueBet('1X2:HOME', marchesVb).cote, 1.87);
verifie('code coté → pari conservé', resoudreValueBet('1X2:HOME', marchesVb).valueBet, '1X2:HOME');
verifie('Over 2.5 coté → cote reprise', resoudreValueBet('OU:OVER:2.5', marchesVb).cote, 1.73);

// Texte libre des anciens formats : cleMarche fait la traduction
verifie('texte libre traduit', resoudreValueBet('Plus de 2.5 buts', marchesVb).cote, 1.73);

// Pari non coté : on le supprime plutôt que d'inventer une cote
verifie('DC non cotée → supprimé', resoudreValueBet('DC:1X', marchesVb).valueBet, 'aucun');
verifie('DC non cotée → cote nulle', resoudreValueBet('DC:1X', marchesVb).cote, null);
verifie('seuil non coté → supprimé', resoudreValueBet('OU:UNDER:3.5', marchesVb).valueBet, 'aucun');

// « aucun » reste « aucun », sans bruit
verifie('aucun préservé', resoudreValueBet('aucun', marchesVb).valueBet, 'aucun');
verifie('sans marché → intact', resoudreValueBet('1X2:HOME', null).cote, null);

// ══════════════════════════════════════════════
// Appariement : refuser plutôt que deviner
// ══════════════════════════════════════════════
//
// Avant le 03/09, teamsMatch acceptait un recouvrement de tokens de 0.5
// pile : deux noms de deux mots partageant le premier passaient. Vérifié
// par exécution : « Manchester United vs Arsenal » était apparié à
// « Manchester City 3-0 Arsenal », « Real Madrid vs Barcelona » à
// « Real Sociedad 1-4 Barcelona ». Le score d'un AUTRE match était écrit
// sur le pronostic, faussant le taux de réussite en silence.
//
// Et matchFixture prenait le PREMIER candidat trouvé, sans arbitrer.

const ft = (home, away) => ({ home, away, homeGoals: 1, awayGoals: 0, status: "FT", source: "test" });

// ── Les faux positifs doivent être refusés ──
verifie('Manchester United ≠ Manchester City',
  matchFixture('Manchester United vs Arsenal', [ft('Manchester City', 'Arsenal')]), null);
verifie('Real Madrid ≠ Real Sociedad',
  matchFixture('Real Madrid vs Barcelona', [ft('Real Sociedad', 'Barcelona')]), null);
verifie('Real Madrid ≠ Real Betis',
  matchFixture('Real Madrid vs Getafe', [ft('Real Betis', 'Getafe')]), null);
verifie('Atletico Madrid ≠ Real Madrid',
  matchFixture('Atletico Madrid vs Sevilla', [ft('Real Madrid', 'Sevilla')]), null);

// ── Les cas légitimes doivent survivre ──
verifie('alias USA conservé',
  matchFixture('USA vs Korea Republic', [ft('United States', 'South Korea')])?.home, 'United States');
verifie('nom court conservé',
  matchFixture('Internacional vs Clube do Remo', [ft('Internacional', 'Remo')])?.home, 'Internacional');
verifie('exact conservé',
  matchFixture('Nottingham Forest vs Everton', [ft('Nottingham Forest', 'Everton')])?.away, 'Everton');
verifie('ordre inversé conservé',
  matchFixture('Everton vs Nottingham Forest', [ft('Nottingham Forest', 'Everton')])?.home, 'Nottingham Forest');

// ── Ambiguïté : refuser ET signaler ──
// Deux rencontres du jour revendiquent le pronostic avec la même force.
// Trancher au hasard écrirait un score faux ; on refuse et on consigne.
let signalee = null;
const ambigu = matchFixture('Manchester vs Arsenal', [
  ft('Manchester United', 'Arsenal'),
  ft('Manchester City', 'Arsenal'),
], { onAmbigu: (d) => { signalee = d; } });
verifie('ambiguïté → aucun appariement', ambigu, null);
verifie('ambiguïté → signalée', signalee !== null, true);
verifie('ambiguïté → 2 candidats listés', signalee?.candidats?.length, 2);

// Un candidat EXACT bat une simple ressemblance : pas d'ambiguïté ici.
verifie('exact l\'emporte sur le flou',
  matchFixture('Manchester City vs Arsenal', [
    ft('Manchester United', 'Arsenal'),
    ft('Manchester City', 'Arsenal'),
  ])?.home, 'Manchester City');

// Aucun candidat : null, sans bruit.
verifie('aucun candidat → null', matchFixture('Ajax vs Feyenoord', [ft('PSV', 'Utrecht')]), null);
verifie('format invalide → null', matchFixture('Ajax', [ft('Ajax', 'PSV')]), null);


// ══════════════════════════════════════════════
// Incident du 21/09 au 01/10 — Victor muet onze jours
// ══════════════════════════════════════════════
//
// football-data ne renvoyait plus aucun match de la saison 2026-27. Forme et
// classement vides, chaque équipe « aucune donnée disponible », et prompt.js:30
// interdit de parier sur un tel match : gemini, groq et gemma ont tous rendu
// une liste vide. L'alerte disait « aucun pronostic produit par l'IA ».

const fxAf = (home, away, idH, idA, league = 39, season = 2026) => ({
  sport: 'Football', competition: 'Premier League', home, away,
  match: `${home} vs ${away}`, homeId: `af:${idH}`, awayId: `af:${idA}`,
  heure: '21:00', source: 'api-football', afLeagueId: league, afSeason: season,
});

// ── La couverture applique EXACTEMENT la règle du prompt ──
// Si ces deux mesures divergeaient, Victor pourrait annoncer des données
// que l'IA ne voit pas, ou l'inverse.
const fxVide = [fxAf('Arsenal', 'Chelsea', 42, 49)];
const couvVide = couvertureContexte(fxVide, new Map(), new Map());
verifie('couverture : 2 équipes comptées', couvVide.equipes, 2);
verifie('couverture : aucune documentée', couvVide.avecDonnees, 0);
verifie('prompt : la même équipe est bien marquée vide',
  formatFixturesForPrompt(fxVide).includes('Arsenal — aucune donnée disponible'), true);

const classementPartiel = new Map([['af:42', { position: 1, total: 20, points: 15, joues: 6 }]]);
const couvPartielle = couvertureContexte(fxVide, new Map(), classementPartiel);
verifie('couverture : classement seul suffit', couvPartielle.avecDonnees, 1);
verifie('prompt : équipe classée NON marquée vide',
  formatFixturesForPrompt(fxVide, { classement: classementPartiel }).includes('Arsenal — aucune donnée disponible'), false);
verifie('prompt : équipe non classée toujours marquée vide',
  formatFixturesForPrompt(fxVide, { classement: classementPartiel }).includes('Chelsea — aucune donnée disponible'), true);

verifie('aDesDonnees : identifiant absent', aDesDonnees(null, new Map([['x', {}]])), false);
verifie('aDesDonnees : forme seule', aDesDonnees('af:1', new Map([['af:1', { forme: 'WWDLW' }]])), true);

// ── Lecture d'une réponse /standings ──
const standingsOk = {
  errors: [],
  response: [{ league: { id: 39, name: 'Premier League', season: 2026, standings: [[
    { rank: 1, team: { id: 42, name: 'Arsenal' }, points: 16, form: 'WWDWW',
      all: { played: 6, goals: { for: 14, against: 4 } } },
    { rank: 2, team: { id: 49, name: 'Chelsea' }, points: 13, form: 'WDWLW',
      all: { played: 6, goals: { for: 11, against: 6 } } },
  ]] } }],
};
const lu = lireStandingsApiFootball(standingsOk);
verifie('standings : pas d\'erreur', lu.erreur, null);
verifie('standings : identifiant préfixé af:', lu.classement.has('af:42'), true);
verifie('standings : rang', lu.classement.get('af:42').position, 1);
verifie('standings : taille du tableau', lu.classement.get('af:42').total, 2);
verifie('standings : matchs joués', lu.classement.get('af:49').joues, 6);
verifie('standings : forme reprise', lu.forme.get('af:42').forme, 'WWDWW');
verifie('standings : buts marqués', lu.forme.get('af:42').marques, 14);

// Le format attendu par le prompt est respecté : la ligne se construit.
const ligne = formatFixturesForPrompt(fxVide, { classement: lu.classement, forme: lu.forme });
verifie('prompt : rang affiché', ligne.includes('1e/2 · 16pts en 6j'), true);
verifie('prompt : forme affichée', ligne.includes('forme WWDWW · 14 marqués / 4 encaissés sur 6 match(s)'), true);
verifie('prompt : plus aucune équipe marquée vide', ligne.includes('aucune donnée disponible'), false);

// Refus du plan gratuit : HTTP 200, mais `errors` renseigné.
const refus = lireStandingsApiFootball({ errors: { plan: 'Free plans do not have access to this season.' }, response: [] });
verifie('standings : refus du plan détecté', refus.erreur, 'Free plans do not have access to this season.');
verifie('standings : refus = aucune donnée', refus.classement.size, 0);

// Coupe : pas de classement, sans faire planter.
verifie('standings : coupe sans tableau', lireStandingsApiFootball({ errors: [], response: [] }).erreur !== null, true);
verifie('standings : réponse nulle', lireStandingsApiFootball(null).erreur !== null, true);

// Une équipe listée dans deux tableaux : le premier fait foi.
const doublon = lireStandingsApiFootball({ errors: [], response: [{ league: { name: 'L', standings: [
  [{ rank: 3, team: { id: 7 }, points: 9, all: { played: 4 } }],
  [{ rank: 1, team: { id: 7 }, points: 9, all: { played: 4 } }],
] } }] });
verifie('standings : premier tableau prioritaire', doublon.classement.get('af:7').position, 3);

// ── Sans clé, le secours le dit au lieu d'échouer en silence ──
// AF_KEY est lue au chargement du module : en test, elle est absente.
if (!process.env.API_FOOTBALL_KEY && !process.env.RAPIDAPI_KEY) {
  const sansCle = await getContexteApiFootball(fxVide);
  verifie('secours : clé absente annoncée', sansCle.rapport, 'clé API-Football absente');
  verifie('secours : aucune donnée inventée', sansCle.classement.size, 0);
}

// Le plafond reste sous la limite de 10 requêtes par minute du plan gratuit,
// une requête étant déjà consommée par fetchApiFootball.
verifie('secours : plafond compatible avec 10 req/min', MAX_LIGUES_SECOURS <= 9, true);

// ══════════════════════════════════════════════
// SECOURS ESPN — rapprochement par le nom, sans jamais deviner
// ══════════════════════════════════════════════
{
  const { ligueEspn, liguesConnues, lireClassementEspn, lireCalendrierEspn, apparierEquipe,
          getContexteEspn, viderCacheEspn } = await import('./espn.js');

  // ── Ligue d'un match ──
  verifie('espn : clé The Odds API', ligueEspn({ sportKey: 'soccer_epl', competition: 'EPL' }), 'eng.1');
  verifie('espn : code football-data', ligueEspn({ codeCompet: 'BSA', competition: 'Campeonato Brasileiro Série A' }), 'bra.1');
  verifie('espn : nom TheSportsDB', ligueEspn({ competition: 'German Bundesliga' }), 'ger.1');
  verifie('espn : nom avec accents et ponctuation', ligueEspn({ competition: 'German 2. Bundesliga' }), 'ger.2');
  // « Premier League » seul : Angleterre, Russie, Ukraine, Égypte… on ne devine pas.
  verifie('espn : nom ambigu refusé', ligueEspn({ competition: 'Premier League' }), null);
  verifie('espn : ligue inconnue', ligueEspn({ competition: 'UEFA European Under-21 Championship' }), null);
  verifie('espn : table de ligues non vide', liguesConnues().length > 20, true);

  // ── Classement ──
  const st = (rank, gp, pts, pf, pa) => [
    { name: 'rank', value: rank }, { name: 'gamesPlayed', value: gp }, { name: 'points', value: pts },
    { name: 'pointsFor', value: pf }, { name: 'pointsAgainst', value: pa },
  ];
  const equipe = (id, displayName, shortDisplayName, extra = {}) =>
    ({ team: { id, displayName, shortDisplayName, name: displayName, location: displayName, ...extra } });
  const classementPL = {
    name: 'English Premier League',
    children: [{ standings: { entries: [
      { ...equipe('382', 'Manchester City', 'Man City'), stats: st(1, 5, 15, 13, 5) },
      { ...equipe('360', 'Manchester United', 'Man United'), stats: st(7, 5, 8, 7, 6) },
      { ...equipe('331', 'Brighton & Hove Albion', 'Brighton'), stats: st(4, 5, 10, 9, 5) },
      { ...equipe('359', 'Arsenal', 'Arsenal'), stats: st(2, 5, 13, 11, 3) },
    ] } }],
  };
  const lu = lireClassementEspn(classementPL);
  verifie('espn classement : 4 équipes lues', lu.equipes.length, 4);
  verifie('espn classement : rang et points', [lu.equipes[0].position, lu.equipes[0].points, lu.equipes[0].joues].join(), '1,15,5');
  verifie('espn classement : buts pour / contre', [lu.equipes[0].bp, lu.equipes[0].bc].join(), '13,5');
  verifie('espn classement : taille du tableau', lu.equipes[0].total, 4);
  verifie('espn classement : nom de compétition', lu.equipes[0].compet, 'English Premier League');
  verifie('espn classement : vide = erreur', lireClassementEspn({ children: [] }).erreur !== null, true);
  verifie('espn classement : réponse absente = erreur', lireClassementEspn(null).erreur !== null, true);
  const mls = lireClassementEspn({ children: [
    { standings: { entries: [{ ...equipe('1', 'Inter Miami', 'Miami'), stats: st(1, 30, 60, 50, 30) }] } },
    { standings: { entries: [{ ...equipe('2', 'LA Galaxy', 'Galaxy'), stats: st(1, 30, 58, 55, 35) }] } },
  ] });
  verifie('espn classement : deux conférences lues', mls.equipes.map(e => e.id).join(), '1,2');

  // ── Rapprochement par le nom ──
  const eq = lu.equipes;
  verifie('apparier : nom identique', apparierEquipe('Manchester City', eq)?.id, '382');
  verifie('apparier : nom court ESPN', apparierEquipe('Man United', eq)?.id, '360');
  verifie('apparier : « and » au lieu de « & »', apparierEquipe('Brighton and Hove Albion', eq)?.id, '331');
  verifie('apparier : nom partiel unique', apparierEquipe('Brighton', eq)?.id, '331');
  verifie('apparier : alias d\'usage', apparierEquipe('Man Utd', eq)?.id, '360');
  verifie('apparier : « Manchester » seul est ambigu', apparierEquipe('Manchester', eq), null);
  verifie('apparier : équipe absente de la ligue', apparierEquipe('Vitória', eq), null);
  verifie('apparier : nom vide', apparierEquipe('', eq), null);
  const italie = [
    { id: '103', noms: ['AC Milan', 'Milan'] },
    { id: '110', noms: ['Internazionale', 'Inter'] },
  ];
  verifie('apparier : Inter Milan n\'est pas l\'AC Milan', apparierEquipe('Inter Milan', italie)?.id, '110');
  verifie('apparier : AC Milan', apparierEquipe('AC Milan', italie)?.id, '103');

  // ── Forme depuis le calendrier ──
  const match = (date, idA, nomA, sA, idB, nomB, sB, fini = true) => ({
    date, competitions: [{ date, status: { type: { completed: fini } }, competitors: [
      { team: { id: idA, displayName: nomA }, score: sA },
      { team: { id: idB, displayName: nomB }, score: sB },
    ] }],
  });
  const calendrier = { events: [
    match('2026-09-27T14:00Z', '359', 'Arsenal', { value: 3, displayValue: '3' }, '388', 'Coventry City', { value: 0, displayValue: '0' }),
    match('2026-08-22T14:00Z', '359', 'Arsenal', { value: 1 }, '382', 'Manchester City', { value: 1 }),
    match('2026-09-13T14:00Z', '360', 'Manchester United', '2', '359', 'Arsenal', '1'),
    match('2026-10-04T14:00Z', '359', 'Arsenal', null, '331', 'Brighton', null, false),
    match('2026-10-02T19:00Z', '359', 'Arsenal', { value: 9 }, '331', 'Brighton', { value: 0 }),
  ] };
  const fo = lireCalendrierEspn(calendrier, '359', '2026-10-02T05:00:00.000Z');
  verifie('espn forme : ordre chronologique, futur exclu', fo?.forme, 'NDV');
  verifie('espn forme : buts marqués / encaissés', [fo?.marques, fo?.encaisses].join(), '5,3');
  verifie('espn forme : matchs comptés', fo?.matchs, 3);
  verifie('espn forme : bilan lisible', fo?.bilan.split(' | ')[2], 'V 3-0 vs Coventry City');
  verifie('espn forme : aucun match joué = null', lireCalendrierEspn({ events: [] }, '359'), null);
  const six = { events: [1, 2, 3, 4, 5, 6].map(j =>
    match(`2026-09-0${j}T12:00Z`, '9', 'X', { value: j === 1 ? 0 : 2 }, '8', 'Y', { value: 1 })) };
  verifie('espn forme : cinq derniers seulement', lireCalendrierEspn(six, '9', '2026-10-01T00:00Z')?.forme, 'VVVVV');

  // ── Bout en bout, réseau simulé ──
  const fetchReel = globalThis.fetch;
  const appels = [];
  globalThis.fetch = async (url) => {
    appels.push(String(url));
    const corps = String(url).includes('/standings') ? classementPL
      : String(url).includes('/teams/359/') ? calendrier
      : { events: [] };
    return { ok: true, status: 200, json: async () => corps };
  };
  try {
    viderCacheEspn();
    const fx = [
      { home: 'Arsenal', away: 'Brighton', homeId: null, awayId: null, sportKey: 'soccer_epl', competition: 'EPL', source: 'odds-api' },
      { home: 'Man City', away: 'Manchester City', homeId: null, awayId: null, sportKey: 'soccer_epl', competition: 'EPL', source: 'odds-api' },
      { home: 'France U21', away: 'Luxembourg U21', homeId: 'tsdb:1', awayId: 'tsdb:2', competition: 'UEFA European Under-21 Championship' },
      { home: 'Manchester United', away: 'Arsenal', homeId: 'fd:66', awayId: 'tsdb:9', sportKey: 'soccer_epl' },
    ];
    const dejaConnu = new Map([['fd:66', { position: 3 }]]);
    const ctx = await getContexteEspn(fx, new Map(), dejaConnu, { maintenant: new Date('2026-10-02T05:00:00Z') });

    verifie('espn bout en bout : identifiant attribué au match sans id', fx[0].homeId, 'espn:359');
    verifie('espn bout en bout : classement rangé sous cet id', ctx.classement.get('espn:359')?.position, 2);
    verifie('espn bout en bout : forme calculée', ctx.forme.get('espn:359')?.forme, 'NDV');
    verifie('espn bout en bout : extérieur rapproché', ctx.classement.get(fx[0].awayId)?.position, 4);
    // Deux noms, une seule équipe : l'un des deux est faux, on ne garde rien.
    verifie('espn bout en bout : paire identique écartée', fx[1].homeId === null && fx[1].awayId === null, true);
    verifie('espn bout en bout : ligue non couverte intacte', fx[2].homeId, 'tsdb:1');
    verifie('espn bout en bout : id existant conservé', fx[3].awayId, 'tsdb:9');
    verifie('espn bout en bout : donnée rangée sous l\'id existant', ctx.classement.get('tsdb:9')?.position, 2);
    verifie('espn bout en bout : donnée déjà connue jamais écrasée', ctx.classement.has('fd:66'), false);
    verifie('espn bout en bout : rapport explicite', /hors couverture/.test(ctx.rapport) && /sans correspondance/.test(ctx.rapport), true);
    verifie('espn bout en bout : un seul classement demandé', appels.filter(u => u.includes('/standings')).length, 1);

    // Le second job de la journée réutilise le cache.
    const avant = appels.length;
    const fx2 = [{ home: 'Arsenal', away: 'Brighton', homeId: null, awayId: null, sportKey: 'soccer_epl' }];
    await getContexteEspn(fx2, new Map(), new Map(), { maintenant: new Date('2026-10-02T11:00:00Z') });
    verifie('espn cache : aucune nouvelle requête', appels.length, avant);

    // Une panne réseau est rapportée, jamais levée.
    viderCacheEspn();
    globalThis.fetch = async () => { throw new Error('réseau coupé'); };
    const enPanne = await getContexteEspn(
      [{ home: 'Arsenal', away: 'Brighton', homeId: null, awayId: null, sportKey: 'soccer_epl' }], new Map(), new Map());
    verifie('espn panne : rapportée', /réseau coupé/.test(enPanne.rapport), true);
    verifie('espn panne : aucune donnée inventée', enPanne.classement.size + enPanne.forme.size, 0);

    const rien = await getContexteEspn([{ home: 'A', away: 'B', competition: 'Inconnue' }]);
    verifie('espn : aucune ligue couverte annoncée', /aucune ligue couverte/.test(rien.rapport), true);
  } finally {
    globalThis.fetch = fetchReel;
    viderCacheEspn();
  }
}

// ══════════════════════════════════════════════
// AMÉLIORATIONS DU 02/10 — meilleure cote, cotes The Odds API, confiance, couverture
// ══════════════════════════════════════════════
{
  const { agregerEvenement, sportsAInterroger } = await import('./odds.js');
  const { validerEvent, PROBA_MIN } = await import('./core.js');
  const { alerteCouverture } = await import('./healthcheck.js');

  const evOdds = {
    home_team: 'Lens', away_team: 'Lille', bookmakers: [
      { title: 'Unibet', markets: [{ key: 'h2h', outcomes: [
        { name: 'Lens', price: 2.10 }, { name: 'Lille', price: 3.40 }, { name: 'Draw', price: 3.30 }] },
        { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: 1.95 }, { name: 'Under', point: 2.5, price: 1.85 }] }] },
      { title: 'Betclic', markets: [{ key: 'h2h', outcomes: [
        { name: 'Lens', price: 2.20 }, { name: 'Lille', price: 3.20 }, { name: 'Draw', price: 3.25 }] }] },
    ],
  };
  const agr = agregerEvenement(evOdds);
  verifie('meilleure cote : domicile', agr.meilleures['1X2:HOME'].cote, 2.20);
  verifie('meilleure cote : bookmaker', agr.meilleures['1X2:HOME'].bookmaker, 'Betclic');
  verifie('meilleure cote : extérieur chez l\'autre bookmaker', agr.meilleures['1X2:AWAY'].bookmaker, 'Unibet');
  verifie('meilleure cote : over 2.5', agr.meilleures['OU:OVER:2.5'].cote, 1.95);
  verifie('la moyenne reste la cote de référence', agr.marches['1X2:HOME'], 2.15);
  const vbMeilleure = evaluerValue({ pari_code: '1X2:HOME', probabilite: 0.6 }, { marches: agr.marches, meilleures: agr.meilleures });
  verifie('value calculée sur la moyenne', vbMeilleure.cote, 2.15);
  verifie('meilleure cote transmise', vbMeilleure.meilleure.cote, 2.20);

  // Les matchs de The Odds API sont désormais cotés, sous le même plafond.
  const fxOdds = [
    { codeCompet: 'PL' }, { codeCompet: '', sportKey: 'soccer_usa_mls' }, { codeCompet: '', sportKey: 'soccer_usa_mls' },
    { codeCompet: '', sportKey: null, source: 'thesportsdb' },
  ];
  verifie('cotes : clés The Odds API interrogées', sportsAInterroger(fxOdds, 6).join(','), 'soccer_usa_mls,soccer_epl');
  verifie('cotes : plafond respecté', sportsAInterroger(fxOdds, 1).join(','), 'soccer_usa_mls');
  verifie('cotes : rien à interroger', sportsAInterroger([{ codeCompet: '' }]).length, 0);

  // Bande « Moyenne » retirée : sous 0.65, plus de publication.
  const evBase65 = { match: 'Lens vs Lille', equipe_a: 'Lens', equipe_b: 'Lille', pari_code: '1X2:HOME',
                     pronostic_principal: 'Victoire Lens' };
  verifie('confiance : seuil par défaut', PROBA_MIN, 0.65);
  verifie('confiance : 0.60 rejeté', validerEvent({ ...evBase65, probabilite: 0.60 }).some(m => /confiance insuffisante/.test(m)), true);
  verifie('confiance : score 3 rejeté', validerEvent({ ...evBase65, confiance_score: 3 }).some(m => /confiance insuffisante/.test(m)), true);
  verifie('confiance : 0.70 accepté', validerEvent({ ...evBase65, probabilite: 0.70, confiance_score: 4 }).some(m => /confiance insuffisante/.test(m)), false);

  // Couverture des données : alerte sous un tiers d'équipes documentées.
  verifie('couverture : 0/68 alerte', /0\/68/.test(alerteCouverture({ equipes: 68, avecDonnees: 0 }) || ''), true);
  verifie('couverture : 30/40 sans alerte', alerteCouverture({ equipes: 40, avecDonnees: 30 }), null);
  verifie('couverture : absente sans alerte', alerteCouverture(null), null);
}

// ══════════════════════════════════════════════
// VALUE DE MARCHÉ — le bon prix, sans IA (victor/valeur.js)
// ══════════════════════════════════════════════
{
  const { probasPuissance, probasJustesMatch, prixJuste, detecterValeursMarche, MIN_BOOKMAKERS } = await import('./valeur.js');
  const { confianceDepuisProba, EXIGER_COTE_MARCHE } = await import('./core.js');
  const { MENTION_PREVENTION } = await import('../bot/telegram.js');

  // Méthode de la puissance : somme à 1, plus de poids au favori qu'au prorata.
  const pp = probasPuissance([1.50, 4.00, 7.00]);
  const proche = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
  verifie('puissance : somme à 1', proche(pp[0] + pp[1] + pp[2], 1), true);
  const somme = 1 / 1.5 + 1 / 4 + 1 / 7;
  verifie('puissance : outsider moins probable qu\'au prorata', pp[2] < (1 / 7) / somme, true);
  verifie('puissance : favori plus probable qu\'au prorata', pp[0] > (1 / 1.5) / somme, true);
  verifie('puissance : cote invalide refusée', probasPuissance([1.0, 2.0]), null);
  verifie('puissance : marché sans marge inchangé', proche(probasPuissance([2, 2])[0], 0.5), true);

  const marches = { '1X2:HOME': 2.00, '1X2:DRAW': 3.50, '1X2:AWAY': 4.00, 'OU:OVER:2.5': 1.90, 'OU:UNDER:2.5': 2.00 };
  const pj = probasJustesMatch(marches);
  verifie('justes : 1X2 complet', proche(pj['1X2:HOME'] + pj['1X2:DRAW'] + pj['1X2:AWAY'], 1), true);
  verifie('justes : over/under complet', proche(pj['OU:OVER:2.5'] + pj['OU:UNDER:2.5'], 1), true);
  verifie('justes : marché incomplet ignoré', probasJustesMatch({ '1X2:HOME': 2, '1X2:DRAW': 3.5 })['1X2:HOME'], undefined);

  const cotesMatchV = { marches, bookmakers: 9, meilleures: {
    '1X2:HOME': { cote: 2.30, bookmaker: 'Betclic' }, '1X2:DRAW': { cote: 3.55, bookmaker: 'Unibet' },
    '1X2:AWAY': { cote: 4.05, bookmaker: 'Unibet' }, 'OU:OVER:2.5': { cote: 1.92, bookmaker: 'Winamax' },
    'OU:UNDER:2.5': { cote: 2.02, bookmaker: 'Winamax' } } };
  const prix = prixJuste(cotesMatchV, '1X2:HOME');
  verifie('prix juste : cote = 1 / probabilité', proche(prix.coteJuste * prix.probaJuste, 1), true);
  verifie('prix juste : trop peu de bookmakers, pas de consensus', prixJuste({ ...cotesMatchV, bookmakers: MIN_BOOKMAKERS - 1 }, '1X2:HOME'), null);

  const fxV = [{ fixtureId: 'e1', home: 'Lens', away: 'Lille', heure: '21:00', competition: 'Ligue 1' },
               { fixtureId: 'e2', home: 'A', away: 'B' }];
  const sig = detecterValeursMarche(fxV, new Map([['e1', cotesMatchV]]), { seuil: 0.02 });
  verifie('value de marché : un signal sur le match coté', sig.length, 1);
  verifie('value de marché : la ligne la plus avantageuse', sig[0]?.pari_code, '1X2:HOME');
  verifie('value de marché : bookmaker indiqué', sig[0]?.bookmaker, 'Betclic');
  verifie('value de marché : libellé lisible', sig[0]?.libelle, 'Victoire Lens');
  verifie('value de marché : avantage = cote × proba juste − 1', proche(sig[0].avantage, 2.30 * sig[0].probaJuste - 1), true);
  verifie('value de marché : au prix juste, rien', detecterValeursMarche(fxV, new Map([['e1', { ...cotesMatchV,
    meilleures: { '1X2:HOME': { cote: 1.95, bookmaker: 'X' } } }]])).length, 0);
  verifie('value de marché : cote extrême ignorée', detecterValeursMarche(fxV, new Map([['e1', { ...cotesMatchV,
    meilleures: { '1X2:AWAY': { cote: 15, bookmaker: 'X' } } }]])).length, 0);
  verifie('value de marché : pas de consensus sous 5 bookmakers', detecterValeursMarche(fxV,
    new Map([['e1', { ...cotesMatchV, bookmakers: 3 }]])).length, 0);

  // La confiance découle de la probabilité, jamais de l'IA.
  verifie('confiance : 0,80 → Très élevée', confianceDepuisProba(0.80)?.confiance_score, 5);
  verifie('confiance : 0,70 → Élevée', confianceDepuisProba(0.70)?.confiance, 'Élevée');
  verifie('confiance : sous le seuil, aucune', confianceDepuisProba(0.60), null);
  verifie('confiance : probabilité absente', confianceDepuisProba(undefined), null);
  verifie('cote de marché exigée par défaut', EXIGER_COTE_MARCHE, true);
  verifie('mention de prévention présente', /09 74 75 13 13/.test(MENTION_PREVENTION) && /18 ans/.test(MENTION_PREVENTION), true);
}

// ══════════════════════════════════════════════
// SUIVI DES VALUES DE MARCHÉ — notation et bilan (victor/valeur-suivi.js)
// ══════════════════════════════════════════════
{
  const { lireScoresEspn, trouverScore, resumerBilan } = await import('./valeur-suivi.js');
  const { texteBilan } = await import('../bot/telegram.js');

  const evE = (idD, nomD, sd, idE, nomE, se, fini = true) => ({ competitions: [{ status: { type: { completed: fini } },
    competitors: [
      { homeAway: 'home', team: { id: idD, displayName: nomD, shortDisplayName: nomD }, score: sd },
      { homeAway: 'away', team: { id: idE, displayName: nomE, shortDisplayName: nomE }, score: se },
    ] }] });
  const scores = lireScoresEspn({ events: [
    evE('1', 'RC Lens', '2', '2', 'Lille OSC', '1'),
    evE('3', 'Paris Saint-Germain', { value: 3 }, '4', 'Marseille', { value: 0 }),
    evE('5', 'Nice', '0', '6', 'Monaco', '0', false),
  ] });
  verifie('scores ESPN : matchs terminés seulement', scores.length, 2);
  verifie('scores ESPN : score objet ou chaîne', [scores[0].butsDom, scores[1].butsDom].join(','), '2,3');

  const trouve = trouverScore({ equipe_a: 'Lens', equipe_b: 'Lille' }, scores);
  verifie('notation : match retrouvé par le nom', trouve ? `${trouve.butsDom}-${trouve.butsExt}` : null, '2-1');
  verifie('notation : domicile et extérieur non inversés', trouverScore({ equipe_a: 'Lille', equipe_b: 'Lens' }, scores), null);
  verifie('notation : match absent', trouverScore({ equipe_a: 'Nice', equipe_b: 'Monaco' }, scores), null);

  const bil = resumerBilan([
    { gagne: true, cote: 2.20, avantage: 0.05 }, { gagne: false, cote: 1.90, avantage: 0.03 },
    { gagne: true, cote: 1.80, avantage: 0.04 }, { gagne: null, cote: 3.0, avantage: 0.1 },
  ]);
  verifie('bilan : seuls les signaux notés comptent', bil.n, 3);
  verifie('bilan : profit en unités', Number(bil.profit.toFixed(4)), 1.0);
  verifie('bilan : rendement', Number(bil.rendement.toFixed(4)), 0.3333);
  verifie('bilan : vide', resumerBilan([]).rendement, null);

  const txt = texteBilan({ victor: [{ gagne: true, cote: 2 }, { gagne: false, cote: 1.8 }], marche: { total: bil, trenteJours: bil } });
  verifie('texte du bilan : rendement Victor', /2 paris à cote de marché · 1 gagnés · rendement \+0\.0 %/.test(txt), true);
  verifie('texte du bilan : values de marché', /3 signaux · 2 gagnés/.test(txt), true);
  verifie('texte du bilan : mise en garde', /aucune garantie de gain/.test(txt) && /09 74 75 13 13/.test(txt), true);
  verifie('texte du bilan : suivi vide annoncé', /en cours de constitution/.test(texteBilan({ victor: [] })), true);
}

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