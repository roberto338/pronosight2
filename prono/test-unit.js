// ══════════════════════════════════════════════
// prono/test-unit.js — contrôle du moteur statistique
// ══════════════════════════════════════════════
//
// Aucune base, aucun réseau, aucune clé API. C'est la raison d'être de
// l'isolement de prono/engine/ : un modèle qu'on ne peut pas vérifier sans
// appeler une API tierce n'est jamais vérifié.
//
// Les valeurs attendues des trois premiers tests sont calculées à la main,
// pas relevées sur une exécution : un test qui recopie la sortie du code
// qu'il contrôle ne contrôle rien.

import { poidsAnciennete, calculerForces, calculerLambdas } from './engine/ratings.js';
import { poissonPmf, matriceScores } from './engine/poisson.js';
import { marchesDepuisMatrice } from './engine/markets.js';
import { simuler, mulberry32, quantile } from './engine/montecarlo.js';
import { devigoriser, edge, kelly, estValue } from './engine/odds.js';
import { scoreConfiance } from './engine/confidence.js';
import { analyserMatch } from './engine/index.js';
import {
  ligneDepuisFixture, versHistorique, moyennesDepuisLignes,
  MOY_DOM_DEFAUT, MOY_EXT_DEFAUT,
  SOURCES_MEMORISEES,
} from './data/normalisation.js';

let ok = 0, ko = 0;
const echecs = [];

function verifie(libelle, obtenu, attendu) {
  if (JSON.stringify(obtenu) === JSON.stringify(attendu)) ok++;
  else { ko++; echecs.push(`${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`); }
}
function presque(libelle, obtenu, attendu, tolerance = 1e-5) {
  if (Number.isFinite(obtenu) && Math.abs(obtenu - attendu) <= tolerance) ok++;
  else { ko++; echecs.push(`${libelle} — attendu ~${attendu} (±${tolerance}), obtenu ${obtenu}`); }
}
function vrai(libelle, condition, detail = '') {
  if (condition) ok++;
  else { ko++; echecs.push(`${libelle}${detail ? ' — ' + detail : ''}`); }
}

// ══════════════════════════════════════════════
// Poisson — valeurs calculées à la main
// ══════════════════════════════════════════════
// P(X=0 ; λ=1,5) = e^-1,5                = 0,2231302
// P(X=2 ; λ=1,5) = e^-1,5 × 1,5²/2       = 0,2231302 × 1,125 = 0,2510214
// P(X=3 ; λ=2,0) = e^-2 × 8/6            = 0,1353353 × 1,333… = 0,1804470
presque('Poisson P(0 ; 1,5)', poissonPmf(0, 1.5), 0.2231302);
presque('Poisson P(2 ; 1,5)', poissonPmf(2, 1.5), 0.2510214);
presque('Poisson P(3 ; 2,0)', poissonPmf(3, 2.0), 0.1804470);
verifie('Poisson refuse un k négatif',     poissonPmf(-1, 1.5), 0);
verifie('Poisson refuse un k non entier',  poissonPmf(1.5, 1.5), 0);

// La masse totale d'une loi de Poisson tronquée à 8 doit rester quasi complète.
let masse8 = 0;
for (let i = 0; i <= 8; i++) masse8 += poissonPmf(i, 1.5);
vrai('Troncature à 8 buts négligeable (λ=1,5)', masse8 > 0.9999, `masse = ${masse8}`);

// ══════════════════════════════════════════════
// Matrice de scores et correction de Dixon-Coles
// ══════════════════════════════════════════════
const M = matriceScores(1.5, 1.2);
let sommeM = 0;
for (const ligne of M) for (const p of ligne) sommeM += p;
presque('Matrice normalisée à 1', sommeM, 1, 1e-12);

const sansDC = matriceScores(1.5, 1.2, { rho: 0 });
vrai('Dixon-Coles rehausse le 0-0', M[0][0] > sansDC[0][0], `${M[0][0]} vs ${sansDC[0][0]}`);
vrai('Dixon-Coles rehausse le 1-1', M[1][1] > sansDC[1][1], `${M[1][1]} vs ${sansDC[1][1]}`);
vrai('Dixon-Coles abaisse le 1-0',  M[1][0] < sansDC[1][0], `${M[1][0]} vs ${sansDC[1][0]}`);
vrai('Dixon-Coles abaisse le 0-1',  M[0][1] < sansDC[0][1], `${M[0][1]} vs ${sansDC[0][1]}`);

// La conséquence qui compte : sans la correction, le nul est sous-estimé,
// et toute value détectée sur le X est un artefact du modèle.
const nulAvec  = marchesDepuisMatrice(M).parCle['1X2:X'];
const nulSans  = marchesDepuisMatrice(sansDC).parCle['1X2:X'];
vrai('Sans Dixon-Coles, le nul est sous-estimé', nulAvec > nulSans, `${nulAvec} vs ${nulSans}`);

// ══════════════════════════════════════════════
// Marchés — cohérence interne
// ══════════════════════════════════════════════
const { parCle, scoresProbables } = marchesDepuisMatrice(M);
presque('1 + X + 2 = 1', parCle['1X2:1'] + parCle['1X2:X'] + parCle['1X2:2'], 1, 1e-12);
presque('Over + Under = 1 (2,5)', parCle['OU_2.5:over'] + parCle['OU_2.5:under'], 1, 1e-12);
presque('BTTS oui + non = 1', parCle['BTTS:oui'] + parCle['BTTS:non'], 1, 1e-12);
vrai('Over 1,5 plus probable qu\'Over 3,5', parCle['OU_1.5:over'] > parCle['OU_3.5:over']);
vrai('Scores probables triés', scoresProbables[0].proba >= scoresProbables[1].proba);

// Symétrie : deux équipes identiques et aucun avantage du terrain → 1 et 2 égaux.
const sym = marchesDepuisMatrice(matriceScores(1.4, 1.4)).parCle;
presque('Sans avantage du terrain, P(1) = P(2)', sym['1X2:1'] - sym['1X2:2'], 0, 1e-12);
// Avec avantage du terrain, P(1) > P(2) — sinon le modèle ne modélise rien.
const avecTerrain = marchesDepuisMatrice(matriceScores(1.55, 1.20)).parCle;
vrai('Avec avantage du terrain, P(1) > P(2)', avecTerrain['1X2:1'] > avecTerrain['1X2:2']);

// ══════════════════════════════════════════════
// Pondération et rétrécissement
// ══════════════════════════════════════════════
presque('Poids d\'un match du jour', poidsAnciennete(0), 1);
presque('Poids à la demi-vie', poidsAnciennete(90), 0.5);
presque('Poids à deux demi-vies', poidsAnciennete(180), 0.25);

const REF = new Date('2026-09-16T00:00:00Z');
const ctx = { moyLigue: 1.4, aujourdhui: REF };

const sansDonnees = calculerForces([], ctx);
presque('Sans historique, attaque = 1', sansDonnees.attaque, 1);
presque('Sans historique, défense = 1', sansDonnees.defense, 1);
verifie('Sans historique, 0 match compté', sansDonnees.nMatchs, 0);

// Une équipe pile dans la moyenne doit ressortir à 1, quel que soit le shrinkage.
const moyenne = calculerForces(
  Array.from({ length: 10 }, (_, i) => ({
    date: new Date(REF.getTime() - (i + 1) * 864e5).toISOString().slice(0, 10),
    butsMarques: 1.4, butsEncaisses: 1.4,
  })), ctx);
presque('Équipe moyenne : attaque = 1', moyenne.attaque, 1, 1e-9);

// Le test qui protège des chiffres absurdes : un seul 5-0 ne fait pas une
// attaque à 3,6. Le rétrécissement doit ramener la force près de 1.
const unSeulCarton = calculerForces(
  [{ date: '2026-09-15', butsMarques: 5, butsEncaisses: 0 }], ctx);
vrai('Un seul 5-0 ne produit pas une attaque délirante',
  unSeulCarton.attaque < 1.6, `attaque = ${unSeulCarton.attaque}`);
vrai('Un seul 5-0 rehausse tout de même l\'attaque',
  unSeulCarton.attaque > 1.0, `attaque = ${unSeulCarton.attaque}`);

// Les matchs anciens pèsent moins : même score, 300 jours plus tôt.
const recent = calculerForces([{ date: '2026-09-15', butsMarques: 4, butsEncaisses: 0 }], ctx);
const vieux  = calculerForces([{ date: '2025-11-20', butsMarques: 4, butsEncaisses: 0 }], ctx);
vrai('Un vieux match pèse moins qu\'un récent', vieux.attaque < recent.attaque,
  `${vieux.attaque} vs ${recent.attaque}`);

// Données aberrantes ignorées sans faire tomber le calcul.
const sale = calculerForces([
  { date: '2026-09-15', butsMarques: 2, butsEncaisses: 1 },
  { date: '2026-09-10', butsMarques: null, butsEncaisses: 1 },
  { date: '2026-09-05', butsMarques: -3, butsEncaisses: 2 },
], ctx);
verifie('Lignes invalides écartées', sale.nMatchs, 1);

// ══════════════════════════════════════════════
// Buts attendus
// ══════════════════════════════════════════════
const neutre = { attaque: 1, defense: 1, nMatchs: 0, poidsTotal: 0 };
const L = { moyButsDom: 1.55, moyButsExt: 1.20, moyLigue: 1.375 };
const lam = calculerLambdas(neutre, neutre, L);
presque('Deux équipes moyennes : λ domicile = moyenne de ligue', lam.lambdaDom, 1.55);
presque('Deux équipes moyennes : λ extérieur = moyenne de ligue', lam.lambdaExt, 1.20);

const fort = { attaque: 1.5, defense: 0.7, nMatchs: 10, poidsTotal: 10 };
const duel = calculerLambdas(fort, neutre, L);
presque('Attaque forte contre défense moyenne', duel.lambdaDom, 1.55 * 1.5);
presque('Attaque moyenne contre défense forte', duel.lambdaExt, 1.20 * 0.7);

// ══════════════════════════════════════════════
// Cotes : marge, espérance, Kelly
// ══════════════════════════════════════════════
// Marché sans marge : 2,0 / 4,0 / 4,0 → 0,50 + 0,25 + 0,25 = 1,00 exactement.
const sansMarge = devigoriser({ '1X2:1': 2.0, '1X2:X': 4.0, '1X2:2': 4.0 });
presque('Marché équitable : marge nulle', sansMarge.overround['1X2'], 0, 1e-12);
presque('Marché équitable : P(1) = 0,50', sansMarge.probaMarche['1X2:1'], 0.5, 1e-12);

// Marché réel : 1,90 / 3,50 / 4,20
// 1/1,90 + 1/3,50 + 1/4,20 = 0,5263158 + 0,2857143 + 0,2380952 = 1,0501253
const reel = devigoriser({ '1X2:1': 1.90, '1X2:X': 3.50, '1X2:2': 4.20 });
presque('Marge du bookmaker détectée', reel.overround['1X2'], 0.0501253, 1e-6);
const sommeDevig = reel.probaMarche['1X2:1'] + reel.probaMarche['1X2:X'] + reel.probaMarche['1X2:2'];
presque('Après dévigorisation, somme = 1', sommeDevig, 1, 1e-12);
vrai('La dévigorisation abaisse la probabilité implicite brute',
  reel.probaMarche['1X2:1'] < 1 / 1.90, `${reel.probaMarche['1X2:1']} vs ${1 / 1.90}`);

// Un 1X2 incomplet ne permet pas de mesurer la marge : on refuse de deviner.
const partiel = devigoriser({ '1X2:1': 1.90 });
verifie('1X2 incomplet : pas de dévigorisation', partiel.probaMarche['1X2:1'], null);
verifie('1X2 incomplet : pas de marge annoncée', partiel.overround['1X2'], null);
// Un marché binaire à deux cotes, lui, est complet.
const binaire = devigoriser({ 'BTTS:oui': 1.80, 'BTTS:non': 1.95 });
vrai('Marché binaire dévigorisé', binaire.probaMarche['BTTS:oui'] > 0);

presque('Espérance : p=0,50 à la cote 2,50', edge(0.5, 2.5), 0.25);
presque('Espérance nulle à la cote juste', edge(0.4, 2.5), 0, 1e-12);
verifie('Espérance refuse une cote absurde', edge(0.5, 0.9), null);
presque('Kelly : p=0,50 à la cote 2,50', kelly(0.5, 2.5), 0.1666667, 1e-6);
presque('Kelly nul sans avantage', kelly(0.4, 2.5), 0, 1e-12);

// Le double critère : un edge élevé sur données minces n'est pas une value.
verifie('Value : edge 10 % et confiance 70', estValue(0.10, 70), true);
verifie('Value refusée si confiance faible', estValue(0.10, 40), false);
verifie('Value refusée si edge insuffisant', estValue(0.01, 90), false);

// ══════════════════════════════════════════════
// Score de confiance
// ══════════════════════════════════════════════
const confPleine = scoreConfiance({
  nMatchsDom: 12, nMatchsExt: 15, largeurIC: 0.05, ecartMarche: 0.01,
  champsAttendus: 3, champsManquants: 0,
});
vrai('Données complètes et modèle stable : confiance élevée', confPleine.score >= 85, `score = ${confPleine.score}`);
verifie('Aucune alerte quand tout va bien', confPleine.alertes.length, 0);

const confPauvre = scoreConfiance({
  nMatchsDom: 2, nMatchsExt: 3, largeurIC: 0.28, ecartMarche: 0.22,
  champsAttendus: 3, champsManquants: 1,
});
vrai('Données minces : confiance basse', confPauvre.score < 40, `score = ${confPauvre.score}`);
vrai('Données minces : alertes levées', confPauvre.alertes.length >= 2);
vrai('Value impossible avec une confiance basse', estValue(0.20, confPauvre.score) === false);

// Sans cote, la cohérence n'est pas inventée : elle est déclarée indisponible.
const confSansCote = scoreConfiance({
  nMatchsDom: 12, nMatchsExt: 12, largeurIC: 0.05, ecartMarche: null,
  champsAttendus: 3, champsManquants: 1,
});
verifie('Sans cote, cohérence non mesurée', confSansCote.composantes.coherence, null);
vrai('Sans cote, une alerte le signale',
  confSansCote.alertes.some(a => a.includes('cote')));

// ══════════════════════════════════════════════
// Monte Carlo
// ══════════════════════════════════════════════
const r1 = mulberry32(7), r2 = mulberry32(7);
verifie('Générateur déterministe', [r1(), r1(), r1()], [r2(), r2(), r2()]);
vrai('Générateur dans [0,1[', Array.from({ length: 200 }, () => mulberry32(3)())
  .every(v => v >= 0 && v < 1));
verifie('Quantile médian', quantile([1, 2, 3, 4, 5], 0.5), 3);
verifie('Quantile sur tableau vide', quantile([], 0.5), null);

const histo = (n, bp, bc, depuis = REF) => Array.from({ length: n }, (_, i) => ({
  date: new Date(depuis.getTime() - (i + 1) * 5 * 864e5).toISOString().slice(0, 10),
  butsMarques: bp, butsEncaisses: bc,
}));

const ligue = { moyButsDom: 1.55, moyButsExt: 1.20, moyLigue: 1.375 };
const simA = simuler({ matchsDom: histo(12, 2, 1), matchsExt: histo(12, 1, 1), ligue, ctxForces: ctx }, { iterations: 200, graine: 42 });
const simB = simuler({ matchsDom: histo(12, 2, 1), matchsExt: histo(12, 1, 1), ligue, ctxForces: ctx }, { iterations: 200, graine: 42 });
verifie('Même graine, même intervalle',
  simA.intervalles['1X2:1'], simB.intervalles['1X2:1']);
vrai('Intervalle borné dans [0,1]',
  simA.intervalles['1X2:1'].basse >= 0 && simA.intervalles['1X2:1'].haute <= 1);

// Le test qui justifie l'existence du Monte Carlo : moins de données, plus
// d'incertitude. Si cette relation ne tenait pas, l'intervalle ne mesurerait rien.
const varie = (n) => {
  const m = [];
  for (let i = 0; i < n; i++) m.push({
    date: new Date(REF.getTime() - (i + 1) * 5 * 864e5).toISOString().slice(0, 10),
    butsMarques: i % 4, butsEncaisses: (i + 1) % 3,
  });
  return m;
};
const peu     = simuler({ matchsDom: varie(4),  matchsExt: varie(4),  ligue, ctxForces: ctx }, { iterations: 300, graine: 1 });
const beaucoup = simuler({ matchsDom: varie(20), matchsExt: varie(20), ligue, ctxForces: ctx }, { iterations: 300, graine: 1 });
vrai('Moins de données → intervalle plus large',
  peu.intervalles['1X2:1'].largeur > beaucoup.intervalles['1X2:1'].largeur,
  `${peu.intervalles['1X2:1'].largeur} vs ${beaucoup.intervalles['1X2:1'].largeur}`);

// ══════════════════════════════════════════════
// Analyse complète
// ══════════════════════════════════════════════
const entree = {
  equipeDom: { nom: 'Équipe A', matchs: histo(12, 2, 1) },
  equipeExt: { nom: 'Équipe B', matchs: histo(12, 1, 2) },
  ligue: { nom: 'Ligue test', moyButsDom: 1.55, moyButsExt: 1.20 },
  cotes: { '1X2:1': 1.75, '1X2:X': 3.80, '1X2:2': 4.50, 'BTTS:oui': 1.80, 'BTTS:non': 1.95 },
  competition: 'Ligue test',
  options: { iterations: 200, graine: 42, aujourdhui: REF },
};

const a = analyserMatch(entree);
verifie('Version du modèle renseignée', a.modelVersion, '1.0.0');
vrai('Avertissement présent', a.avertissement.includes('Aucune garantie de gain'));

const un   = a.marches.find(m => m.marche === '1X2' && m.selection === '1');
const nul  = a.marches.find(m => m.marche === '1X2' && m.selection === 'X');
const deux = a.marches.find(m => m.marche === '1X2' && m.selection === '2');
presque('Analyse : 1 + X + 2 = 1', un.proba + nul.proba + deux.proba, 1, 1e-12);
vrai('Équipe dominante favorite', un.proba > deux.proba, `${un.proba} vs ${deux.proba}`);
vrai('Confiance dans [0,100]', a.confiance.score >= 0 && a.confiance.score <= 100);

// L'intervalle doit encadrer l'estimation ponctuelle, sans quoi l'un des deux ment.
for (const m of a.marches) {
  vrai(`Intervalle encadre l'estimation (${m.marche}:${m.selection})`,
    m.probaBasse <= m.proba + 1e-9 && m.proba <= m.probaHaute + 1e-9,
    `${m.probaBasse} ≤ ${m.proba} ≤ ${m.probaHaute}`);
}

vrai('Cote juste cohérente avec la probabilité', Math.abs(un.coteJuste - 1 / un.proba) < 1e-9);
vrai('Marché dévigorisé rattaché au 1X2', un.probaMarche > 0 && un.probaMarche < 1);
vrai('Espérance calculée quand la cote existe', Number.isFinite(un.edge));
const sansCoteOU = a.marches.find(m => m.marche === 'OU_2.5');
verifie('Sans cote, pas d\'espérance', sansCoteOU.edge, null);
verifie('Sans cote, pas de value', sansCoteOU.estValue, false);

// Déterminisme de bout en bout : deux analyses identiques, au chiffre près.
verifie('Analyse reproductible', JSON.stringify(analyserMatch(entree)), JSON.stringify(a));

// Aucune donnée : le modèle doit répondre « je ne sais rien », pas inventer.
const vide = analyserMatch({
  equipeDom: { nom: 'A', matchs: [] },
  equipeExt: { nom: 'B', matchs: [] },
  ligue: { moyButsDom: 1.55, moyButsExt: 1.20 },
  options: { iterations: 50, graine: 42, aujourdhui: REF },
});
presque('Sans données, λ domicile = moyenne de ligue', vide.lambdaDom, 1.55);
presque('Sans données, λ extérieur = moyenne de ligue', vide.lambdaExt, 1.20);
vrai('Sans données, confiance nulle', vide.confiance.score === 0, `score = ${vide.confiance.score}`);
verifie('Sans données, aucun intervalle publié', vide.marches[0].probaBasse, null);
verifie('Sans données, intervalle déclaré non fiable', vide.intervalleFiable, false);
vrai('Sans données, alertes explicites', vide.confiance.alertes.length >= 2);
vrai('Sans données, aucune value déclarée', vide.marches.every(m => m.estValue === false));

// Entrées invalides refusées franchement.
let leve = false;
try { analyserMatch({ equipeDom: { nom: 'A' }, equipeExt: { nom: 'B' }, ligue: {} }); }
catch { leve = true; }
verifie('Moyennes de ligue manquantes refusées', leve, true);


// ══════════════════════════════════════════════
// Normalisation des données entrantes
// ══════════════════════════════════════════════
// Ce qui entre en base décide de ce que le modèle croira. Chaque règle de
// rejet ci-dessous protège d'une corruption qui serait ensuite invisible.

const fixtureOK = {
  sport: 'Football', competition: 'Ligue 1', codeCompet: 'FL1', fixtureId: 12345,
  homeId: 'fd:521', awayId: 'fd:548', home: 'Lille', away: 'Nantes',
  dateISO: '2026-09-12', debutUTC: '2026-09-12T19:00:00Z',
  status: 'FT', homeGoals: 2, awayGoals: 1, source: 'football-data',
};

const ligne = ligneDepuisFixture(fixtureOK);
verifie('Rencontre valide retenue', ligne?.equipe_dom_id, 'fd:521');
verifie('Score conservé', [ligne?.buts_dom, ligne?.buts_ext], [2, 1]);
verifie('Identifiant de source conservé', ligne?.source_match_id, '12345');
verifie('Code compétition conservé', ligne?.competition_code, 'FL1');

// Un match non terminé n'a pas de score définitif : le retenir figerait un
// score de mi-temps comme résultat final.
verifie('Match non terminé écarté', ligneDepuisFixture({ ...fixtureOK, status: 'NS' }), null);
verifie('Match en cours écarté',    ligneDepuisFixture({ ...fixtureOK, status: 'LIVE' }), null);
verifie('Score absent écarté',      ligneDepuisFixture({ ...fixtureOK, homeGoals: null }), null);

// Sans identifiant, l'équipe serait indexée par nom — le piège documenté
// dans sources.js:449, qui confondait Vitória SC et Vitória.
verifie('Sans identifiant domicile, écarté', ligneDepuisFixture({ ...fixtureOK, homeId: null }), null);
verifie('Sans identifiant extérieur, écarté', ligneDepuisFixture({ ...fixtureOK, awayId: null }), null);
verifie('Équipe contre elle-même écartée', ligneDepuisFixture({ ...fixtureOK, awayId: 'fd:521' }), null);

// Le modèle est calibré sur le football. Un score de basket ferait exploser
// les moyennes de la « ligue » sans que rien ne le signale.
verifie('Basket écarté', ligneDepuisFixture({ ...fixtureOK, sport: 'Basketball' }), null);

// Une seule source mémorisée. Les identifiants sont cloisonnés par source
// (fd: / af: / tsdb:) : mémoriser plusieurs sources ferait exister la même
// équipe sous deux identités, chacune avec la moitié de son historique.
// dedupe() ne protège que dans la journée, pas d'un jour à l'autre.
verifie('Une seule source mémorisée', [...SOURCES_MEMORISEES], ['football-data']);
verifie('TheSportsDB écarté',  ligneDepuisFixture({ ...fixtureOK, source: 'thesportsdb', homeId: 'tsdb:1', awayId: 'tsdb:2' }), null);
verifie('API-Football écarté', ligneDepuisFixture({ ...fixtureOK, source: 'api-football', homeId: 'af:1', awayId: 'af:2' }), null);
verifie('The Odds API écarté', ligneDepuisFixture({ ...fixtureOK, source: 'odds-api' }), null);
verifie('Source absente écartée', ligneDepuisFixture({ ...fixtureOK, source: undefined }), null);

verifie('Date absente écartée', ligneDepuisFixture({ ...fixtureOK, dateISO: '', debutUTC: null }), null);
verifie('Date malformée écartée', ligneDepuisFixture({ ...fixtureOK, dateISO: '12/09/2026', debutUTC: null }), null);
verifie('Score négatif écarté', ligneDepuisFixture({ ...fixtureOK, homeGoals: -1 }), null);
verifie('Score non entier écarté', ligneDepuisFixture({ ...fixtureOK, homeGoals: 1.5 }), null);
verifie('Entrée nulle écartée', ligneDepuisFixture(null), null);

// Sans identifiant de rencontre, la ligne reste valide : l'index unique
// (jour, équipe dom, équipe ext) prend alors le relais contre les doublons.
verifie('Sans fixtureId, rencontre conservée',
  ligneDepuisFixture({ ...fixtureOK, fixtureId: null })?.source_match_id, null);

// Date reprise du coup d'envoi quand dateISO manque.
verifie('Date déduite du coup d\'envoi',
  ligneDepuisFixture({ ...fixtureOK, dateISO: '' })?.joue_le, '2026-09-12');

// ── Lecture des buts selon le camp ──
// Inverser marqués et encaissés inverserait attaque et défense : une
// équipe solide deviendrait une passoire, sans la moindre erreur visible.
const lignesBase = [
  { joue_le: '2026-09-12', equipe_dom_id: 'A', equipe_ext_id: 'B', equipe_dom: 'Alpha', equipe_ext: 'Beta', buts_dom: 3, buts_ext: 1 },
  { joue_le: '2026-09-05', equipe_dom_id: 'C', equipe_ext_id: 'A', equipe_dom: 'Gamma', equipe_ext: 'Alpha', buts_dom: 0, buts_ext: 2 },
];
const histA = versHistorique(lignesBase, 'A');
verifie('Deux rencontres pour Alpha', histA.length, 2);
verifie('À domicile : 3 marqués, 1 encaissé', [histA[0].butsMarques, histA[0].butsEncaisses], [3, 1]);
verifie('À l\'extérieur : 2 marqués, 0 encaissé', [histA[1].butsMarques, histA[1].butsEncaisses], [2, 0]);
verifie('Camp identifié', [histA[0].domicile, histA[1].domicile], [true, false]);
verifie('Adversaire identifié', [histA[0].adversaire, histA[1].adversaire], ['Beta', 'Gamma']);
verifie('Équipe absente : historique vide', versHistorique(lignesBase, 'Z').length, 0);

// La date peut arriver en objet Date depuis pg : elle doit ressortir en ISO
// court, faute de quoi la pondération par ancienneté échoue silencieusement.
const histDate = versHistorique(
  [{ joue_le: new Date('2026-09-12T00:00:00Z'), equipe_dom_id: 'A', equipe_ext_id: 'B', buts_dom: 1, buts_ext: 0 }], 'A');
verifie('Date pg convertie en ISO', histDate[0].date, '2026-09-12');

// ── Moyennes de ligue ──
const peuDeMatchs = moyennesDepuisLignes([{ buts_dom: 3, buts_ext: 0 }]);
verifie('Trop peu de matchs : repli sur la valeur par défaut',
  [peuDeMatchs.moyButsDom, peuDeMatchs.mesuree], [MOY_DOM_DEFAUT, false]);
vrai('Le repli ne se déguise pas en mesure', peuDeMatchs.mesuree === false);

const assez = moyennesDepuisLignes(Array.from({ length: 40 }, () => ({ buts_dom: 2, buts_ext: 1 })));
verifie('Moyennes mesurées sur 40 matchs',
  [assez.moyButsDom, assez.moyButsExt, assez.mesuree], [2, 1, true]);
verifie('Aucune donnée : repli', moyennesDepuisLignes([]).moyButsExt, MOY_EXT_DEFAUT);

// ══════════════════════════════════════════════
console.log(`\nprono/test-unit.js — ${ok} contrôle(s) passé(s), ${ko} en échec`);
if (ko) {
  console.error('\nÉchecs :');
  for (const e of echecs) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('✅ Moteur statistique conforme.');
