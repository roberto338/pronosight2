// ══════════════════════════════════════════════
// victor/paris.js — Vocabulaire fermé des paris
//
// Trois faux résultats en dix jours, tous dus à la même cause : le pari
// était une PHRASE, interprétée par expressions régulières.
//
//   03/08  « Portugal -2.5 »            lu comme « Under 2.5 buts »
//   05/08  « Double chance : X ou nul » lu comme « Match nul »
//   12/08  « Pas de match nul »         lu comme « Match nul »
//
// Le dernier a fait afficher 100 % de réussite sur un pari perdu.
// Chaque correctif était juste ; chaque fois une nouvelle formulation
// passait au travers. Tant que le pari reste une phrase, ça continue.
//
// Ici, un pari est un CODE. Chaque code correspond à une fonction pure
// de (buts domicile, buts extérieur). Aucune ambiguïté n'est possible,
// et un code inconnu est rejeté au lieu d'être deviné.
//
// Le libellé lisible est DÉRIVÉ du code, jamais l'inverse.
// ══════════════════════════════════════════════

/** Familles reconnues. Toute autre valeur est invalide. */
export const FAMILLES = ['1X2', 'DC', 'OU', 'BTTS', 'AH', 'TT'];

const nombre = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Analyse un code en ses composants.
 * @returns {{famille:string, [k:string]:any}|null} null si le code est invalide
 */
export function parserCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const p = c.split(':');

  switch (p[0]) {
    // 1X2:HOME | 1X2:DRAW | 1X2:AWAY
    case '1X2':
      return ['HOME', 'DRAW', 'AWAY'].includes(p[1]) && p.length === 2
        ? { famille: '1X2', issue: p[1] } : null;

    // DC:1X | DC:X2 | DC:12
    case 'DC':
      return ['1X', 'X2', '12'].includes(p[1]) && p.length === 2
        ? { famille: 'DC', combinaison: p[1] } : null;

    // OU:OVER:2.5 | OU:UNDER:3.5
    case 'OU':
      return ['OVER', 'UNDER'].includes(p[1]) && nombre.test(p[2] || '') && p.length === 3
        ? { famille: 'OU', sens: p[1], seuil: parseFloat(p[2]) } : null;

    // BTTS:YES | BTTS:NO
    case 'BTTS':
      return ['YES', 'NO'].includes(p[1]) && p.length === 2
        ? { famille: 'BTTS', oui: p[1] === 'YES' } : null;

    // AH:HOME:-1.5 | AH:AWAY:+2.5
    case 'AH':
      return ['HOME', 'AWAY'].includes(p[1]) && nombre.test(p[2] || '') && p.length === 3
        ? { famille: 'AH', cote: p[1], handicap: parseFloat(p[2]) } : null;

    // TT:HOME:OVER:0.5 | TT:AWAY:UNDER:1.5
    case 'TT':
      return ['HOME', 'AWAY'].includes(p[1]) && ['OVER', 'UNDER'].includes(p[2])
          && nombre.test(p[3] || '') && p.length === 4
        ? { famille: 'TT', cote: p[1], sens: p[2], seuil: parseFloat(p[3]) } : null;

    default:
      return null;
  }
}

/** @returns {boolean} le code appartient-il au vocabulaire ? */
export function codeValide(code) {
  return parserCode(code) !== null;
}

/**
 * Évalue un pari à partir de son code et du score final.
 * Fonction PURE : mêmes entrées, même sortie, aucune interprétation.
 *
 * @returns {boolean|null} null uniquement si le code est invalide
 */
export function evaluerCode(code, butsDom, butsExt) {
  const p = parserCode(code);
  if (!p) return null;
  const h = Number(butsDom), a = Number(butsExt);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;

  const ecart = h - a;
  const total = h + a;

  switch (p.famille) {
    case '1X2':
      return p.issue === 'HOME' ? ecart > 0
           : p.issue === 'AWAY' ? ecart < 0
           : ecart === 0;

    case 'DC':
      return p.combinaison === '1X' ? ecart >= 0
           : p.combinaison === 'X2' ? ecart <= 0
           : ecart !== 0;                       // 12 : pas de nul

    case 'OU':
      return p.sens === 'OVER' ? total > p.seuil : total < p.seuil;

    case 'BTTS': {
      const lesDeux = h > 0 && a > 0;
      return p.oui ? lesDeux : !lesDeux;
    }

    case 'AH': {
      // Handicap appliqué à l'équipe visée : son écart + handicap > 0.
      // « HOME:-1.5 » = le domicile doit gagner par 2 buts ou plus.
      const ecartVise = p.cote === 'HOME' ? ecart : -ecart;
      return ecartVise + p.handicap > 0;
    }

    case 'TT': {
      const butsVise = p.cote === 'HOME' ? h : a;
      return p.sens === 'OVER' ? butsVise > p.seuil : butsVise < p.seuil;
    }

    default:
      return null;
  }
}

/**
 * Libellé lisible, DÉRIVÉ du code. C'est le code qui fait foi ;
 * le texte n'est qu'un affichage, il n'est jamais réinterprété.
 */
export function libelleCode(code, equipeDom = 'Domicile', equipeExt = 'Extérieur') {
  const p = parserCode(code);
  if (!p) return String(code || '');
  const signe = n => (n > 0 ? `+${n}` : `${n}`);

  switch (p.famille) {
    case '1X2':
      return p.issue === 'HOME' ? `Victoire ${equipeDom}`
           : p.issue === 'AWAY' ? `Victoire ${equipeExt}`
           : 'Match nul';

    case 'DC':
      return p.combinaison === '1X' ? `${equipeDom} ou match nul`
           : p.combinaison === 'X2' ? `Match nul ou ${equipeExt}`
           : 'Pas de match nul';

    case 'OU':
      return p.sens === 'OVER' ? `Plus de ${p.seuil} buts` : `Moins de ${p.seuil} buts`;

    case 'BTTS':
      return p.oui ? 'Les deux équipes marquent' : 'Une équipe au moins ne marque pas';

    case 'AH':
      return `${p.cote === 'HOME' ? equipeDom : equipeExt} handicap ${signe(p.handicap)}`;

    case 'TT': {
      const eq = p.cote === 'HOME' ? equipeDom : equipeExt;
      return `${eq} — ${p.sens === 'OVER' ? 'plus' : 'moins'} de ${p.seuil} but${p.seuil >= 2 ? 's' : ''}`;
    }

    default:
      return String(code);
  }
}

/**
 * Traduit un ancien libellé en texte libre vers un code, au mieux.
 *
 * Sert à deux choses : reprendre l'historique, et rattraper le cas où le
 * modèle renverrait une phrase malgré la consigne. En cas de doute on
 * renvoie null — mieux vaut un pari non noté qu'un pari noté à l'envers.
 */
export function codeDepuisTexte(texte, equipeDom = '', equipeExt = '') {
  const t = String(texte || '').toLowerCase().replace(',', '.').trim();
  if (!t) return null;

  const sansAccent = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norme = s => sansAccent(String(s || '').toLowerCase()).replace(/[^a-z0-9]/g, '');
  const tn = norme(t);
  const dom = norme(equipeDom), ext = norme(equipeExt);
  const viseDom = dom.length >= 3 && tn.includes(dom);
  const viseExt = ext.length >= 3 && tn.includes(ext);

  const nie = /\b(pas de|pas d'|sans|aucun|aucune)\b/.test(t) || /\bnon\s*$/.test(t) || /\bne\b.*\bpas\b/.test(t);

  // ── Pari COMBINÉ : deux conditions en une ────────────────────
  // « Lille gagne ET Over 1.5 buts » n'est pas réductible à l'une des
  // deux. Le coder sur une moitié fausserait la notation dans les cas
  // où l'autre moitié échoue. On refuse.
  // « & » n'est pas un caractère de mot : \b ne s'y applique pas.
  if ((/\bet\b/.test(t) || t.includes('&') || t.includes('+'))
      && /(over|under|plus de|moins de|buts?)/.test(t)
      && /(gagne|victoire|win)/.test(t)) return null;

  // ── Total d'UNE équipe ───────────────────────────────────────
  // « Braga marque (Team Total Over 0.5) » ou « Angleterre — Total de
  // buts : Plus de 1.5 » portent sur une seule équipe. Les traiter comme
  // un total de match inverserait le résultat dès que l'adversaire marque.
  const estTT = /team total|total (?:de )?buts?\s*[:\-]|marque\s*\(/.test(t)
             || ((viseDom || viseExt) && /total/.test(t));
  if (estTT) {
    const m = t.match(/(over|under|plus de|moins de)\s*(\d+(?:\.\d+)?)/);
    if (m && (viseDom || viseExt)) {
      const sens = /under|moins/.test(m[1]) ? 'UNDER' : 'OVER';
      return `TT:${viseExt && !viseDom ? 'AWAY' : 'HOME'}:${sens}:${parseFloat(m[2])}`;
    }
    return null; // total d'équipe sans équipe identifiable
  }

  // ── Double chance ────────────────────────────────────────────
  // Doit passer avant le nul simple. « Sunderland ou nul » est un double
  // chance même sans le mot « double chance » : la conjonction suffit.
  if (/\b1x\b/.test(t)) return 'DC:1X';
  if (/\bx2\b/.test(t)) return 'DC:X2';
  if (/\b12\b/.test(t)) return 'DC:12';
  const ouNul = /\bou\b/.test(t) && /\bnul\b|\bdraw\b/.test(t);
  if (/double chance/.test(t) || ouNul || (nie && /\bnul\b|\bdraw\b/.test(t))) {
    if (nie && /\bnul\b|\bdraw\b/.test(t)) return 'DC:12';
    if (viseDom && !viseExt) return 'DC:1X';
    if (viseExt && !viseDom) return 'DC:X2';
    return null;
  }

  // Handicap — avant Over/Under : « Portugal -2.5 » n'est pas un total
  const mh = t.match(/([+-]\s*\d+(?:\.\d+)?)/);
  if (mh && (/handicap|hcp/.test(t) || ((viseDom || viseExt) && !/(over|under|plus de|moins de|buts?|goals?)/.test(t)))) {
    const v = parseFloat(mh[1].replace(/\s+/g, ''));
    return `AH:${viseExt && !viseDom ? 'AWAY' : 'HOME'}:${v > 0 ? '+' : ''}${v}`;
  }

  // Total d'une équipe
  const mtt = t.match(/(?:team total|total equipe|equipe marque).*?(over|under|plus de|moins de)?\s*(\d+(?:\.\d+)?)/);
  if (mtt && (viseDom || viseExt)) {
    const sens = /under|moins/.test(mtt[1] || '') ? 'UNDER' : 'OVER';
    return `TT:${viseExt && !viseDom ? 'AWAY' : 'HOME'}:${sens}:${parseFloat(mtt[2])}`;
  }

  // Over / Under
  const mou = t.match(/(over|under|plus de|moins de)\s*(\d+(?:\.\d+)?)/);
  if (mou) return `OU:${/under|moins/.test(mou[1]) ? 'UNDER' : 'OVER'}:${parseFloat(mou[2])}`;

  // Les deux marquent
  if (/btts|les deux.*marquent|both.*score/.test(t)) return nie ? 'BTTS:NO' : 'BTTS:YES';

  // Nul simple
  if (/\bnul\b|\bdraw\b/.test(t) || /^[xn]$/.test(t)) return nie ? 'DC:12' : '1X2:DRAW';

  // 1N2
  if (/victoire|win|gagne|vainqueur/.test(t)) {
    if (viseDom && !viseExt) return nie ? 'DC:X2' : '1X2:HOME';
    if (viseExt && !viseDom) return nie ? 'DC:1X' : '1X2:AWAY';
    if (/\b(dom|home|equipe a|team a|1)\b/.test(sansAccent(t))) return '1X2:HOME';
    if (/\b(ext|away|equipe b|team b|2)\b/.test(sansAccent(t))) return '1X2:AWAY';
  }

  return null; // inconnu → non noté, jamais deviné
}

export default { FAMILLES, parserCode, codeValide, evaluerCode, libelleCode, codeDepuisTexte };
