// ══════════════════════════════════════════════
// public/js/modules/prevention.js — mentions valables dans tous les pays
// ══════════════════════════════════════════════
//
// PronoSight s'adresse à tous les pays, pas seulement à la France : la
// mention ne peut plus se limiter à « 18 ans » et au numéro français. Une
// seule source, partagée par le site et le bot Telegram.
//
// Numéros d'aide gratuits et officiels, par pays. Ailleurs, on renvoie au
// service local plutôt que d'en inventer un.

export const AIDE_PAR_PAYS = [
  ['France', '09 74 75 13 13'],
  ['Belgique', '0800 35 777'],
  ['Québec', '1 800 461-0140'],
  ['Royaume-Uni', '0808 8020 133'],
  ['États-Unis', '1-800-GAMBLER'],
];

export const MENTION_PREVENTION = 'Jeu réservé aux adultes : 18 ans, 21 dans certains pays. '
  + 'Jouer comporte des risques : endettement, isolement, dépendance. Pour être aidé : '
  + AIDE_PAR_PAYS.map(([pays, numero]) => `${pays} ${numero}`).join(' · ')
  + ' — ailleurs, le service d\'aide de ton pays.';

/** Pour les petits espaces (image de partage). */
export const MENTION_COURTE = '18+ · Jouer comporte des risques · Aide : 09 74 75 13 13 (FR) · 1-800-GAMBLER (US)';

/**
 * Le juste prix vaut partout ; le bookmaker de la meilleure cote, non : il
 * peut être interdit dans le pays du lecteur. On ne l'y envoie donc pas.
 */
export const CONSEIL_BOOKMAKER = 'chez un bookmaker autorisé dans ton pays';

export default { AIDE_PAR_PAYS, MENTION_PREVENTION, MENTION_COURTE, CONSEIL_BOOKMAKER };
