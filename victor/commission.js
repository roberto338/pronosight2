// ══════════════════════════════════════════════
// victor/commission.js — la cote qu'on touche vraiment
// ══════════════════════════════════════════════
//
// Sur une bourse de paris (Betfair Exchange, Matchbook, Smarkets, Betdaq),
// la cote affichée n'est pas celle qu'on touche : une commission est prélevée
// sur le GAIN net. Une cote de 3,00 chez Betfair à 5 % rapporte en réalité
// 1 + 2 × 0,95 = 2,90.
//
// L'analyse du 29/10 l'a montré : 50 des 72 values de marché venaient de
// Betfair ou Matchbook, et ni leur détection ni leur bilan ne retiraient la
// commission. Le rendement affiché était donc trop beau.
//
// Taux de base, volontairement prudents (les remises de fidélité ne sont pas
// supposées). Un bookmaker classique, ou le « Betfair Sportsbook », n'en a pas.
//
// Pur.

export const COMMISSIONS = [
  { motif: /betfair(?!.*sportsbook)/i, taux: 0.05 },
  { motif: /matchbook/i, taux: 0.02 },
  { motif: /smarkets/i, taux: 0.02 },
  { motif: /betdaq/i, taux: 0.02 },
];

/** Taux de commission d'un bookmaker (0 pour un bookmaker classique). */
export function commissionDe(bookmaker = '') {
  return COMMISSIONS.find(c => c.motif.test(String(bookmaker || '')))?.taux ?? 0;
}

/** Cote réellement touchée : 1 + (cote − 1) × (1 − commission). */
export function coteNette(cote, bookmaker = '') {
  const c = Number(cote);
  if (!(c > 1)) return c;
  const t = commissionDe(bookmaker);
  return t ? 1 + (c - 1) * (1 - t) : c;
}

export default { COMMISSIONS, commissionDe, coteNette };
