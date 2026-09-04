// ══════════════════════════════════════════════════════════════
// config/proxy-guards.js — Ce que les proxys publics acceptent
//
// Les routes /api/odds, /api/football-data et /api/apifootball sont
// appelées par le navigateur, donc sans authentification possible sans
// compte utilisateur. Elles font pourtant dépenser de l'argent et du
// débit. À défaut de pouvoir fermer la porte, on borne ce qui passe.
//
// Audit du 03/09/2026, findings F-001, F-004 et F-005. Ces valeurs sont
// dérivées de ce que le frontend demande RÉELLEMENT
// (public/js/modules/api.js) : les figer ne lui retire rien.
// ══════════════════════════════════════════════════════════════

// ── The Odds API ─────────────────────────────────────────────
// Facturation au produit regions × markets. Le frontend n'a jamais
// demandé autre chose que eu + h2h (api.js:312) : 1 crédit au lieu des
// 16 qu'un appel forgé pouvait coûter.
export const ODDS_REGIONS = 'eu';
export const ODDS_MARKETS = 'h2h';

/** Forme réelle des clés The Odds API : soccer_epl, soccer_france_ligue_one… */
export function sportKeyValide(k) {
  return /^[a-z0-9_]{3,60}$/.test(String(k || ''));
}

/** Filtre la réponse sans multiplier le coût — donc conservé, mais borné. */
export function bookmakersValides(b) {
  return /^[a-z0-9_,]{1,300}$/.test(String(b || ''));
}

// ── football-data ────────────────────────────────────────────
// Le palier gratuit plafonne à 10 requêtes/minute, PARTAGÉES avec
// victor/sources.js qui en consomme 8 par analyse. Saturer ce débit prive
// Victor de toute sa couche statistique.
export function cheminFootballDataAutorise(p) {
  return /^competitions\/[A-Z0-9]{2,4}\/(matches|standings)$/.test(String(p || ''));
}

// ── api-football ─────────────────────────────────────────────
const AF_AUTORISES = new Set(['fixtures', 'fixtures/headtohead', 'injuries', 'teams']);
export function cheminApiFootballAutorise(p) {
  return AF_AUTORISES.has(String(p || ''));
}

// ── /api/gemini ──────────────────────────────────────────────
// Le frontend demande au plus 6000 tokens et ne choisit jamais de modèle.
export const GEMINI_MAX_TOKENS   = 6000;
export const GEMINI_MAX_MESSAGES = 20;
export const GEMINI_MAX_OCTETS   = 60_000;

/** @returns {string|null} motif de refus, ou null si la requête est acceptable */
export function refusGemini(messages, octets) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages invalide';
  if (messages.length > GEMINI_MAX_MESSAGES) return 'trop de messages';
  if (octets > GEMINI_MAX_OCTETS) return 'requête trop volumineuse';
  return null;
}
