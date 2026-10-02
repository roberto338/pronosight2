// ══════════════════════════════════════════════
// victor/combines.js — les sélections d'un combiné honnête
// ══════════════════════════════════════════════
//
// L'ancien « Combinés auto » faisait écrire par l'IA les cotes et les
// confiances de chaque sélection. Ici, une sélection n'entre que si elle est
// RÉELLE et COTÉE :
//   - une value de marché du jour (ps_valeurs_marche) : meilleure cote et
//     probabilité juste du consensus, déjà calculées ;
//   - un prono de Victor publié à une cote du marché : sa probabilité juste
//     est recalculée sur les cotes que Victor a déjà payées le matin (cache
//     en mémoire, aucun crédit), par la méthode de la puissance.
// Un prono dont le match n'est plus dans le cache garde sa cote, sans
// probabilité : le site l'affiche mais ne le combine pas automatiquement.
//
// Fonctions pures, testées sans réseau ni base.

import { normalizeTeam } from './sources.js';
import { agregerEvenement } from './odds.js';
import { prixJuste } from './valeur.js';

/** L'évènement The Odds API d'un match, ou null. Les deux équipes doivent correspondre. */
export function trouverEvenement(equipeA, equipeB, caches = []) {
  const a = normalizeTeam(equipeA), b = normalizeTeam(equipeB);
  if (!a || !b) return null;
  const proche = (x, y) => x && y && (x.includes(y) || y.includes(x));
  const trouves = [];
  for (const { sport, evenements } of caches) {
    for (const ev of evenements || []) {
      if (proche(normalizeTeam(ev.home_team), a) && proche(normalizeTeam(ev.away_team), b)) trouves.push({ sport, ev });
    }
  }
  // Deux candidats : on ne devine pas.
  return trouves.length === 1 ? trouves[0] : null;
}

/** Décalage de Paris sur l'UTC ce jour-là, en heures (2 l'été, 1 l'hiver). */
function decalageParis(dateISO) {
  const midi = new Date(`${dateISO}T12:00:00Z`);
  const paris = new Date(midi.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const utc = new Date(midi.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((paris - utc) / 36e5);
}

/** Début d'un prono de Victor : date + heure de Paris → instant UTC. */
export function debutVictor(p) {
  const d = String(p.date || '').slice(0, 10), h = String(p.heure || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(h)) return null;
  const t = Date.parse(`${d}T${h.padStart(5, '0')}:00Z`) - decalageParis(d) * 36e5;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Sélections combinables du jour.
 * @param {{valeurs: object[], pronos: object[], caches: object[], maintenant?: Date}} p
 * @returns {object[]} { id, source, match, competition, debut_utc, pari_code, libelle, cote, bookmaker, proba_juste }
 */
export function selectionsDuJour({ valeurs = [], pronos = [], caches = [], maintenant = new Date() } = {}) {
  const pasCommence = (iso) => !iso || Date.parse(iso) > maintenant.getTime();
  const out = [];
  for (const v of valeurs) {
    const cote = Number(v.cote), pj = Number(v.proba_juste);
    if (!(cote > 1) || !pasCommence(v.debut_utc)) continue;
    out.push({
      id: `v-${v.id ?? v.match}-${v.pari_code}`, source: 'value',
      match: String(v.match || '').replace(/\s+vs\s+/i, ' – '), competition: v.competition || '',
      debut_utc: v.debut_utc ? new Date(v.debut_utc).toISOString() : null,
      pari_code: v.pari_code, libelle: v.libelle || v.pari_code, cote, bookmaker: v.bookmaker || null,
      proba_juste: pj > 0 && pj < 1 ? pj : null,
    });
  }
  for (const p of pronos) {
    const cote = Number(p.cote_estimee);
    if (!p.cote_confirmee || !(cote > 1) || !p.pari_code || String(p.pari_code).startsWith('DC:')) continue;
    const debut = debutVictor(p);
    if (!pasCommence(debut)) continue;
    const ev = trouverEvenement(p.equipe_a, p.equipe_b, caches);
    const pj = ev ? prixJuste(agregerEvenement(ev.ev), p.pari_code) : null;
    out.push({
      id: `p-${p.id}`, source: 'victor',
      match: `${p.equipe_a} – ${p.equipe_b}`, competition: p.competition || '', debut_utc: debut,
      pari_code: p.pari_code, libelle: p.pronostic_principal || p.pari_code, cote, bookmaker: null,
      proba_juste: pj ? Number(pj.probaJuste.toFixed(4)) : null,
    });
  }
  // Une value et un prono de Victor sur le même pari du même match : on garde la value (meilleure cote).
  const vus = new Set();
  return out.filter(s => {
    const cle = `${normalizeTeam(s.match)}|${s.pari_code}`;
    if (vus.has(cle)) return false;
    vus.add(cle); return true;
  });
}

export default { trouverEvenement, debutVictor, selectionsDuJour };
