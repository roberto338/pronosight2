// ══════════════════════════════════════════════
// prono/engine/audit.js — noter Victor sur ses propres promesses
// ══════════════════════════════════════════════
//
// Le moteur statistique a été mesuré et jugé insuffisant avant d'être
// montré à quiconque. Victor, lui, publie depuis des mois sans que personne
// n'ait jamais vérifié ses chiffres. Ce module répare cette asymétrie.
//
// Pur : reçoit des pronostics notés, rend des agrégats. Aucune base.
//
// ── Ce que Victor promet, et qui est donc vérifiable ──
//
// victor/prompt.js:176-178 impose une correspondance explicite entre le
// libellé de confiance et une PROBABILITÉ :
//
//     confiance_score 5  →  probabilité ≥ 0,75
//     confiance_score 4  →  0,65 à 0,75
//     confiance_score 3  →  0,55 à 0,65
//
// Ce ne sont pas des étiquettes décoratives : ce sont des engagements
// chiffrés. Si les pronostics marqués 5 ne passent pas au moins 75 % du
// temps, l'échelle ment — et un abonné qui mise davantage sur « Très
// élevée » est trompé par une graduation qui ne correspond à rien.

export const BANDES = {
  5: { libelle: 'Très élevée', min: 0.75, max: 1.00 },
  4: { libelle: 'Élevée',      min: 0.65, max: 0.75 },
  3: { libelle: 'Moyenne',     min: 0.55, max: 0.65 },
};

/**
 * Gain d'une mise d'une unité.
 * Gagné → on récupère (cote − 1) net. Perdu → on perd la mise.
 */
export function gainPari(correct, cote) {
  const c = Number(cote);
  if (!Number.isFinite(c) || c < 1.01) return null;
  return correct ? c - 1 : -1;
}

/**
 * Agrégats sur un ensemble de paris notés.
 *
 * Le taux de réussite seul ne dit rien : 70 % de réussite à la cote 1,20
 * fait perdre de l'argent, 40 % à la cote 3,00 en fait gagner. C'est le
 * RENDEMENT qui tranche, et le seuil de rentabilité varie avec les cotes
 * jouées — d'où `tauxRentabilite`, le taux qu'il aurait fallu atteindre
 * pour simplement rentrer dans ses frais.
 */
export function resumerParis(paris) {
  const valides = paris.filter(p => Number.isFinite(gainPari(p.correct, p.cote)));
  const n = valides.length;
  if (n === 0) {
    return { n: 0, tauxReussite: null, roi: null, gainTotal: null,
             coteMoyenne: null, tauxRentabilite: null };
  }

  let gains = 0, reussis = 0, sommeCotes = 0;
  for (const p of valides) {
    gains += gainPari(p.correct, p.cote);
    if (p.correct) reussis++;
    sommeCotes += Number(p.cote);
  }
  const coteMoyenne = sommeCotes / n;

  return {
    n,
    tauxReussite: reussis / n,
    roi: gains / n,
    gainTotal: gains,
    coteMoyenne,
    // À cote moyenne c, il faut gagner 1/c des paris pour être à l'équilibre.
    tauxRentabilite: 1 / coteMoyenne,
  };
}

/**
 * Le rendement est-il distinguable de zéro ?
 *
 * Sur 69 paris, un rendement de +8 % ne veut rien dire : quelques cotes
 * élevées qui passent suffisent à le produire. Le bootstrap rééchantillonne
 * les paris avec remise et rend l'intervalle dans lequel le vrai rendement
 * se situe. Tant que zéro est dedans, « rentable » n'est pas démontré.
 */
export function bootstrapRoi(paris, options = {}) {
  const { iterations = 2000, rnd } = options;
  const gains = paris
    .map(p => gainPari(p.correct, p.cote))
    .filter(g => Number.isFinite(g));
  if (gains.length < 20 || typeof rnd !== 'function') return null;

  const tirages = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let somme = 0;
    for (let j = 0; j < gains.length; j++) somme += gains[Math.floor(rnd() * gains.length)];
    tirages[i] = somme / gains.length;
  }
  tirages.sort((a, b) => a - b);
  const q = (p) => tirages[Math.min(iterations - 1, Math.max(0, Math.round(p * (iterations - 1))))];

  const basse = q(0.025), haute = q(0.975);
  return {
    n: gains.length,
    roi: gains.reduce((a, b) => a + b, 0) / gains.length,
    basse,
    haute,
    rentable: basse > 0,
    perdant: haute < 0,
  };
}

/**
 * Les bandes de confiance tiennent-elles leur promesse ?
 * @returns Array<{score, libelle, promesse, n, realise, tientPromesse}>
 */
export function verifierBandes(paris) {
  const out = [];
  for (const score of [5, 4, 3]) {
    const bande = BANDES[score];
    const lot = paris.filter(p => Number(p.confianceScore) === score);
    if (lot.length === 0) continue;
    const reussis = lot.filter(p => p.correct).length;
    const realise = reussis / lot.length;
    out.push({
      score,
      libelle: bande.libelle,
      promesse: score === 5 ? `≥ ${Math.round(bande.min * 100)} %`
                            : `${Math.round(bande.min * 100)}–${Math.round(bande.max * 100)} %`,
      min: bande.min,
      n: lot.length,
      realise,
      // La promesse est tenue si le réalisé atteint AU MOINS la borne basse
      // annoncée. On ne reproche pas de faire mieux que promis.
      tientPromesse: realise >= bande.min,
      ecart: realise - bande.min,
    });
  }
  return out;
}

/** L'échelle est-elle au moins ordonnée ? 5 doit passer plus souvent que 3. */
export function echelleOrdonnee(bandes) {
  const avecDonnees = bandes.filter(b => b.n >= 10).sort((a, b) => b.score - a.score);
  if (avecDonnees.length < 2) return null;
  for (let i = 1; i < avecDonnees.length; i++) {
    if (avecDonnees[i - 1].realise < avecDonnees[i].realise) return false;
  }
  return true;
}

export default { gainPari, resumerParis, bootstrapRoi, verifierBandes, echelleOrdonnee, BANDES };
