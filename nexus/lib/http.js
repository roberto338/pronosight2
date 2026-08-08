// ══════════════════════════════════════════════
// nexus/lib/http.js — fetch avec plafond de durée
//
// Tout appel réseau de Nexus part d'un agent exécuté par le worker
// (nexus/worker.js), qui n'a que 4 slots de concurrence. Un appel sans
// plafond immobilise un slot pendant les 5 minutes de timeout undici par
// défaut ; quatre suffisent à figer la file sans le moindre log.
//
// Ce module existe pour qu'aucun `fetch` de Nexus ne parte nu.
// ══════════════════════════════════════════════

// Les API métier (Stripe, Brevo, GitHub, Render…) répondent en quelques
// secondes. 30s laisse de la marge sans jamais bloquer un slot longtemps.
export const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30_000);

/**
 * fetch() identique à l'original, mais abandonné au bout de `timeoutMs`.
 * Traduit l'AbortError en message lisible : sans ça, l'erreur remonte en
 * « This operation was aborted », impossible à diagnostiquer dans les logs.
 *
 * @param {string} url
 * @param {RequestInit} options   options fetch habituelles
 * @param {number} timeoutMs      défaut : API_TIMEOUT_MS
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  try {
    return await fetch(url, {
      ...options,
      // Un signal explicitement fourni par l'appelant a priorité.
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      throw new Error(`Timeout après ${timeoutMs}ms sur ${host}`);
    }
    throw err;
  }
}

export default fetchWithTimeout;
