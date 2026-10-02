// ══════════════════════════════════════════════
// public/js/modules/securite.js — aucun texte externe n'entre brut dans le HTML
// ══════════════════════════════════════════════
//
// Les écrans construisent leur HTML par gabarits (innerHTML). Les textes qui
// y entraient venaient de l'IA, des API sportives et de la saisie de
// l'utilisateur, sans aucun échappement : un nom d'équipe ou une analyse
// contenant du HTML s'exécutait dans la page de chaque visiteur (XSS).
// On échappe donc toute chaîne AVANT le rendu.

const ENTITES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function echapperHtml(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur).replace(/[&<>"']/g, c => ENTITES[c]);
}

/** Copie profonde dont toutes les chaînes sont échappées. Nombres et booléens intacts. */
export function assainir(valeur) {
  if (typeof valeur === 'string') return echapperHtml(valeur);
  if (Array.isArray(valeur)) return valeur.map(assainir);
  if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(valeur)) out[k] = assainir(v);
    return out;
  }
  return valeur;
}

export default { echapperHtml, assainir };
