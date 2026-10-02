// ══════════════════════════════════════════════
// victor/cache-proxy-cotes.js — protéger le quota The Odds API du site web
// ══════════════════════════════════════════════
//
// Le relais /api/odds/:sportKey interrogeait The Odds API à CHAQUE analyse
// lancée sur le site, sans cache. Le palier gratuit (500 crédits par mois)
// est partagé avec Victor, et Victor ne publie plus rien sans cote de marché :
// quelques dizaines de visiteurs pouvaient donc le faire taire.
//
// Deux protections :
//   · un cache par compétition (6 h par défaut, comme victor/odds.js) ;
//   · un budget quotidien d'appels payants pour le site (8 par défaut).
//     Budget épuisé : on sert la dernière réponse connue, même ancienne,
//     sinon on répond « indisponible » — et le site l'affiche comme tel.
//
// Pur et injectable (horloge en paramètre) : testé sans réseau.

export function creerCacheProxyCotes({
  ttlMs = Number(process.env.ODDS_PROXY_CACHE_MS || 6 * 3600_000),
  maxParJour = Number(process.env.ODDS_PROXY_MAX_JOUR || 8),
  maintenant = () => Date.now(),
} = {}) {
  const cache = new Map();          // clé → { ts, data }
  let jour = '', depenses = 0;

  const jourCourant = () => new Date(maintenant()).toISOString().slice(0, 10);
  const recharger = () => { const j = jourCourant(); if (j !== jour) { jour = j; depenses = 0; } };

  return {
    /** Réponse fraîche en cache, ou null. */
    frais(cle) {
      const e = cache.get(cle);
      return e && maintenant() - e.ts < ttlMs ? e.data : null;
    },
    /** Dernière réponse connue, même périmée (budget épuisé). */
    perime(cle) { return cache.get(cle)?.data ?? null; },
    /** Un appel payant est-il encore permis aujourd'hui ? */
    peutPayer() { recharger(); return depenses < maxParJour; },
    /** Enregistre une réponse payée. */
    enregistrer(cle, data) { recharger(); depenses++; cache.set(cle, { ts: maintenant(), data }); },
    etat() { recharger(); return { jour, depenses, maxParJour, entrees: cache.size }; },
  };
}

export default { creerCacheProxyCotes };
