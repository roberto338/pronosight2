// ══════════════════════════════════════════════
// victor/quota-cotes.js — protéger le quota mensuel de The Odds API
// ══════════════════════════════════════════════
//
// Victor et le site partagent les crédits de The Odds API (500 par mois sur
// le palier gratuit). Victor peut en consommer jusqu'à ~24 par jour, le site
// jusqu'à 8 : un mois chargé épuisait le quota avant son terme, et Victor
// perdait ses cotes — donc ses pronostics — jusqu'au mois suivant.
//
// Chaque réponse de The Odds API, y compris les appels GRATUITS (/sports,
// /events), porte le nombre de crédits restants. On le retient ici, et le
// site cesse d'acheter des cotes quand il reste moins de RESERVE_VICTOR
// crédits : ce stock est réservé aux analyses de Victor.

export const RESERVE_VICTOR = Number(process.env.ODDS_RESERVE_VICTOR || 150);

let _etat = { restants: null, utilises: null, le: null };

/** Lit les en-têtes de quota d'une réponse The Odds API (si présents). */
export function noterQuota(headers) {
  const brut = headers?.get?.('x-requests-remaining');
  if (brut == null || brut === '') return;
  const restants = Number(brut);
  if (!Number.isFinite(restants)) return;
  const u = headers.get('x-requests-used');
  _etat = { restants, utilises: u == null || u === '' ? null : Number(u), le: new Date().toISOString() };
}

/** État connu du quota : { restants, utilises, le, reserve }. restants = null tant qu'inconnu. */
export function etatQuota() { return { ..._etat, reserve: RESERVE_VICTOR }; }

/**
 * Le site peut-il dépenser un crédit ? Oui tant que le quota est inconnu
 * (redémarrage : la première réponse le fera connaître) ou au-dessus de la réserve.
 */
export function sitePeutAcheter() {
  return _etat.restants == null || _etat.restants > RESERVE_VICTOR;
}

/** Réservé aux tests. */
export function reinitialiserQuota() { _etat = { restants: null, utilises: null, le: null }; }

export default { RESERVE_VICTOR, noterQuota, etatQuota, sitePeutAcheter, reinitialiserQuota };
