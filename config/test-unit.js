// ══════════════════════════════════════════════
// config/test-unit.js — Bornes des proxys publics
// ══════════════════════════════════════════════
//
// Ces trois routes sont appelées par le navigateur, donc sans
// authentification possible tant qu'il n'y a pas de comptes. Elles font
// pourtant dépenser des crédits The Odds API et du débit football-data.
// Les bornes ci-dessous sont la seule chose qui les sépare d'un abus.
//
// Audit du 03/09/2026, findings F-001, F-004, F-005.

import {
  ODDS_REGIONS, ODDS_MARKETS, sportKeyValide, bookmakersValides,
  cheminFootballDataAutorise, cheminApiFootballAutorise,
  GEMINI_MAX_TOKENS, refusGemini,
} from './proxy-guards.js';

let ok = 0, ko = 0;
const echecs = [];
function verifie(libelle, obtenu, attendu) {
  if (JSON.stringify(obtenu) === JSON.stringify(attendu)) ok++;
  else { ko++; echecs.push(`${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`); }
}

// ══════════════════════════════════════════════
// The Odds API — le multiplicateur de crédits
// ══════════════════════════════════════════════
// La facturation est au produit regions × markets. Ces deux valeurs ne
// doivent JAMAIS venir de la requête : un appel forgé avec 4 régions et
// 4 marchés coûtait 16 crédits, soit tout le quota mensuel en 2 minutes.
verifie('regions figée à eu',   ODDS_REGIONS, 'eu');
verifie('markets figé à h2h',   ODDS_MARKETS, 'h2h');

verifie('sportKey normal accepté',      sportKeyValide('soccer_epl'), true);
verifie('sportKey long accepté',        sportKeyValide('soccer_france_ligue_one'), true);
verifie('sportKey majuscules refusé',   sportKeyValide('Soccer_EPL'), false);
verifie('sportKey avec / refusé',       sportKeyValide('soccer/../admin'), false);
verifie('sportKey avec ? refusé',       sportKeyValide('soccer?apiKey=x'), false);
verifie('sportKey vide refusé',         sportKeyValide(''), false);
verifie('sportKey trop long refusé',    sportKeyValide('a'.repeat(61)), false);

verifie('bookmakers liste acceptée',    bookmakersValides('unibet,betclic,winamax'), true);
verifie('bookmakers avec & refusé',     bookmakersValides('x&markets=totals'), false);

// ══════════════════════════════════════════════
// football-data — 10 req/min partagées avec Victor
// ══════════════════════════════════════════════
// Saturer ce débit prive Victor de TOUTE sa couche statistique.
verifie('matches autorisé',      cheminFootballDataAutorise('competitions/PL/matches'), true);
verifie('standings autorisé',    cheminFootballDataAutorise('competitions/FL1/standings'), true);
verifie('code 4 lettres OK',     cheminFootballDataAutorise('competitions/WC22/matches'), true);
verifie('endpoint libre refusé', cheminFootballDataAutorise('teams/57'), false);
verifie('scorers refusé',        cheminFootballDataAutorise('competitions/PL/scorers'), false);
verifie('remontée de chemin refusée', cheminFootballDataAutorise('competitions/../../v4/teams'), false);
verifie('code minuscule refusé', cheminFootballDataAutorise('competitions/pl/matches'), false);
verifie('vide refusé',           cheminFootballDataAutorise(''), false);

// ══════════════════════════════════════════════
// api-football — compte suspendu depuis le 21/08
// ══════════════════════════════════════════════
verifie('fixtures autorisé',      cheminApiFootballAutorise('fixtures'), true);
verifie('headtohead autorisé',    cheminApiFootballAutorise('fixtures/headtohead'), true);
verifie('injuries autorisé',      cheminApiFootballAutorise('injuries'), true);
verifie('odds refusé',            cheminApiFootballAutorise('odds'), false);
verifie('status refusé',          cheminApiFootballAutorise('status'), false);

// ══════════════════════════════════════════════
// /api/gemini — proxy LLM sur la clé de production
// ══════════════════════════════════════════════
// C'est la clé dont dépend la production quotidienne de pronostics, et
// que Gemma partage. Un tiers ne doit pas pouvoir la faire travailler.
const msg = (n) => Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));

verifie('requête normale acceptée',  refusGemini(msg(3), 500), null);
verifie('messages vide refusé',      refusGemini([], 10), 'messages invalide');
verifie('non-tableau refusé',        refusGemini('coucou', 10), 'messages invalide');
verifie('null refusé',               refusGemini(null, 10), 'messages invalide');
verifie('21 messages refusés',       refusGemini(msg(21), 500), 'trop de messages');
verifie('20 messages acceptés',      refusGemini(msg(20), 500), null);
verifie('corps trop gros refusé',    refusGemini(msg(2), 60_001), 'requête trop volumineuse');
verifie('corps à la limite accepté', refusGemini(msg(2), 60_000), null);

verifie('plafond de tokens', GEMINI_MAX_TOKENS, 6000);

console.log(`\n${ko === 0 ? '✅' : '❌'} Bornes des proxys — ${ok} test(s) OK, ${ko} échec(s)`);
if (ko > 0) { echecs.forEach(e => console.log(`   • ${e}`)); process.exit(1); }
