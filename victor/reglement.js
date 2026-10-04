// ══════════════════════════════════════════════
// victor/reglement.js — régler les paris de « Mes paris » sur les vrais scores
// ══════════════════════════════════════════════
//
// « Mes paris » restait en attente pour toujours : le match et le pari y
// étaient du texte libre, sans lien avec un résultat. Ici, chaque pari est
// rapproché d'un match TERMINÉ des sources réelles (football-data,
// API-Football, TheSportsDB — getResultsOfDay), puis noté par evaluerCode,
// le même juge que les pronostics de Victor.
//
// Prudence avant tout : un pari n'est réglé que si le match est trouvé SANS
// ambiguïté (les deux équipes, un seul candidat) et si le pari se traduit en
// un code notable. Sinon il reste en attente, au choix de l'utilisateur —
// jamais deviné.
//
// regler() est pure : les résultats sont fournis par l'appelant.

import { normalizeTeam } from './sources.js';
import { evaluerCode, codeDepuisTexte } from './paris.js';

/** « Lens – Lille », « Lens - Lille », « Lens vs Lille » → ['Lens', 'Lille']. */
export function equipesDuMatch(match = '') {
  const m = String(match).split(/\s+(?:–|-|vs\.?|v)\s+/i);
  return m.length === 2 && m[0].trim() && m[1].trim() ? [m[0].trim(), m[1].trim()] : null;
}

const proche = (x, y) => x && y && (x === y || x.includes(y) || y.includes(x));

/**
 * Le score d'un match vu depuis l'équipe A (A–B), parmi des matchs terminés.
 * Gère un match enregistré dans l'autre sens. Null si absent ou ambigu.
 */
export function trouverScore(equipeA, equipeB, finis = []) {
  const a = normalizeTeam(equipeA), b = normalizeTeam(equipeB);
  if (!a || !b) return null;
  const trouves = [];
  for (const f of finis) {
    const h = normalizeTeam(f.home), w = normalizeTeam(f.away);
    if (proche(h, a) && proche(w, b)) trouves.push({ butsA: f.homeGoals, butsB: f.awayGoals, f });
    else if (proche(h, b) && proche(w, a)) trouves.push({ butsA: f.awayGoals, butsB: f.homeGoals, f });
  }
  return trouves.length === 1 ? trouves[0] : null;
}

/** Une sélection (A, B, pari) → 'gagne' | 'perdu' | statut d'attente. */
function regleSelection({ equipe_a, equipe_b, match, pari, pari_code }, finis) {
  const eq = equipe_a && equipe_b ? [equipe_a, equipe_b] : equipesDuMatch(match);
  if (!eq) return { statut: 'match_illisible' };
  const code = pari_code || codeDepuisTexte(pari, eq[0], eq[1]);
  if (!code) return { statut: 'pari_illisible' };
  const s = trouverScore(eq[0], eq[1], finis);
  if (!s) return { statut: 'non_trouve' };
  const g = evaluerCode(code, s.butsA, s.butsB);
  if (g === null) return { statut: 'pari_illisible' };
  return { resultat: g ? 'gagne' : 'perdu', score: `${s.butsA}-${s.butsB}` };
}

/**
 * Règle un pari (simple ou combiné) sur une liste de matchs terminés.
 * Combiné : perdu dès qu'une sélection est perdue, gagné quand toutes le sont.
 * @returns {{id, resultat?, score?, statut?}}
 */
export function regler(p, finis = []) {
  const legs = Array.isArray(p.legs) && p.legs.length
    ? p.legs
    : String(p.match || '').includes(' + ')
      ? (() => {
          const ms = String(p.match).split(' + '), ps = String(p.pari || '').split(' + ');
          return ms.length === ps.length ? ms.map((m, i) => ({ match: m, pari: ps[i] })) : null;
        })()
      : null;

  if (legs === null && String(p.match || '').includes(' + ')) return { id: p.id, statut: 'pari_illisible' };
  if (!legs) return { id: p.id, ...regleSelection(p, finis) };

  const r = legs.map(l => regleSelection(l, finis));
  if (r.some(x => x.resultat === 'perdu')) return { id: p.id, resultat: 'perdu', score: r.map(x => x.score || '?').join(' · ') };
  if (r.every(x => x.resultat === 'gagne')) return { id: p.id, resultat: 'gagne', score: r.map(x => x.score).join(' · ') };
  return { id: p.id, statut: r.find(x => x.statut)?.statut || 'non_trouve' };
}

export default { equipesDuMatch, trouverScore, regler };
