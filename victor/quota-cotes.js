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

// ── Budget du jour (03/11) ──────────────────────────────────────────
// La réserve ne protégeait Victor QUE du site : rien ne limitait Victor
// lui-même. Ses cotes, achetées vers 7h01, expiraient vers 13h01, pile quand
// le job de 13h les relisait : il les rachetait. Le 15/10, 225 crédits
// étaient partis en 15 jours ; le quota d'octobre s'est épuisé le 30, et
// Victor n'a rien publié les 30 et 31.
// Désormais, chaque jour a droit au solde restant divisé par les jours qui
// restent dans le mois. Ce qui est dépensé se lit dans l'en-tête de The Odds
// API (site, Victor ou tout autre usage de la clé, tout compte).
export const MARGE_QUOTA = 10;                    // jamais dépensés : imprévus
export const BESOIN_MATIN_VICTOR = 12;            // 6 compétitions × 2 crédits

let _etat = { restants: null, utilises: null, le: null };
let _jour = { date: null, restantsDebut: null, achatVictor: false };

const jourParis = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const heureParis = (d) => Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }));

function nouveauJour(maintenant) {
  const j = jourParis(maintenant);
  if (_jour.date !== j) _jour = { date: j, restantsDebut: _etat.restants, achatVictor: false };
}

/** Lit les en-têtes de quota d'une réponse The Odds API (si présents). */
export function noterQuota(headers, maintenant = new Date()) {
  const brut = headers?.get?.('x-requests-remaining');
  if (brut == null || brut === '') return;
  const restants = Number(brut);
  if (!Number.isFinite(restants)) return;
  const u = headers.get('x-requests-used');
  nouveauJour(maintenant);
  // Premier solde connu du jour, ou quota rechargé (nouveau mois) : nouveau départ.
  if (_jour.restantsDebut == null || restants > _jour.restantsDebut) _jour.restantsDebut = restants;
  _etat = { restants, utilises: u == null || u === '' ? null : Number(u), le: maintenant.toISOString() };
}

/** Jours restants dans le mois, aujourd'hui compris (heure de Paris). Pur. */
export function joursRestantsDuMois(maintenant = new Date()) {
  const [a, m, j] = jourParis(maintenant).split('-').map(Number);
  const dernier = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return dernier - j + 1;
}

/** Budget du jour : { allocation, depense, reste }, ou null tant que le solde est inconnu. */
export function budgetDuJour(maintenant = new Date()) {
  nouveauJour(maintenant);
  if (_etat.restants == null || _jour.restantsDebut == null) return null;
  const allocation = Math.floor(Math.max(0, _jour.restantsDebut - MARGE_QUOTA) / joursRestantsDuMois(maintenant));
  const depense = Math.max(0, _jour.restantsDebut - _etat.restants);
  return { allocation, depense, reste: allocation - depense };
}

/**
 * Victor peut-il acheter `credits` crédits ? Son premier achat du jour (le
 * matin, celui sans lequel il ne publie rien) passe tant que le mois n'est pas
 * à sec ; les suivants (13h) seulement dans le budget du jour. Au-delà, il
 * relit les cotes du matin.
 */
export function victorPeutAcheter(credits, maintenant = new Date()) {
  nouveauJour(maintenant);
  if (_etat.restants == null) return true;
  if (_etat.restants - MARGE_QUOTA < credits) return false;
  if (!_jour.achatVictor) return true;
  const b = budgetDuJour(maintenant);
  return !b || b.reste >= credits;
}

/** À appeler après chaque achat de Victor. */
export function noterAchatVictor(maintenant = new Date()) { nouveauJour(maintenant); _jour.achatVictor = true; }

/**
 * Le site peut-il dépenser un crédit ? Oui tant que le quota est inconnu
 * (redémarrage : la première réponse le fera connaître). Sinon : au-dessus de
 * la réserve du mois, et dans le budget du jour — moins ce dont Victor aura
 * besoin à 7h s'il n'a pas encore acheté.
 */
export function sitePeutAcheter(maintenant = new Date()) {
  if (_etat.restants == null) return true;
  if (_etat.restants <= RESERVE_VICTOR) return false;
  const b = budgetDuJour(maintenant);
  if (!b) return true;
  const besoinVictor = !_jour.achatVictor && heureParis(maintenant) < 13 ? BESOIN_MATIN_VICTOR : 0;
  return b.reste - besoinVictor > 0;
}

/** État connu du quota : { restants, utilises, le, reserve, budget }. restants = null tant qu'inconnu. */
export function etatQuota(maintenant = new Date()) {
  return { ..._etat, reserve: RESERVE_VICTOR, budget: budgetDuJour(maintenant) };
}

/** Réservé aux tests. */
export function reinitialiserQuota() {
  _etat = { restants: null, utilises: null, le: null };
  _jour = { date: null, restantsDebut: null, achatVictor: false };
}

export default {
  RESERVE_VICTOR, MARGE_QUOTA, BESOIN_MATIN_VICTOR, noterQuota, joursRestantsDuMois, budgetDuJour,
  victorPeutAcheter, noterAchatVictor, sitePeutAcheter, etatQuota, reinitialiserQuota,
};
