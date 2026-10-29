// ══════════════════════════════════════════════
// victor/recap.js — le bilan des pronos de la veille
// ══════════════════════════════════════════════
//
// Le message du soir (23h30) ne donnait que des pourcentages, et seulement
// pour le jour même : les matchs joués la nuit (Brésil, Argentine…) n'étaient
// pas encore finis. Le lendemain matin, on reprend chaque prono de la veille,
// un par un — gagné, perdu ou toujours en attente, avec le score — puis le
// bilan cumulé. Gains comme pertes : c'est ce qui rend le service crédible.

import { query } from '../db/database.js';
import { coteNette } from './commission.js';
import { bilanVictor, bilanValeursMarche, parisNotesVictor, bilanEntre, bilanParPeriodes, jourParis, decalerJour } from './valeur-suivi.js';

/** Date ISO de la veille, en heure de Paris. */
export function veilleParis(maintenant = new Date()) {
  const jour = maintenant.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });   // AAAA-MM-JJ
  return new Date(Date.parse(`${jour}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
}

/** Tout ce qu'il faut pour le message de la veille. */
export async function donneesVeille(dateISO = veilleParis()) {
  const [{ rows: pronos }, { rows: valeurs }, victor, marche] = await Promise.all([
    query(`SELECT equipe_a, equipe_b, competition, pronostic_principal, pari_code, cote_estimee,
                  cote_confirmee, pronostic_correct, score_reel
           FROM ps_pronostics WHERE date = $1 ORDER BY id`, [dateISO]),
    query(`SELECT match, libelle, pari_code, cote, bookmaker, gagne, score_reel
           FROM ps_valeurs_marche WHERE date = $1 ORDER BY avantage DESC`, [dateISO]).catch(() => ({ rows: [] })),
    bilanVictor().catch(() => null),
    bilanValeursMarche().catch(() => null),
  ]);
  for (const v of valeurs) v.cote_nette = coteNette(v.cote, v.bookmaker);
  return { date: dateISO, pronos, valeurs, bilan: { victor, marche } };
}

// ── Bilan de la semaine et du mois écoulés ──

/** Premier et dernier jour d'un mois « AAAA-MM ». Pur. */
function bornesMois(a, m) {
  if (m === 0) { m = 12; a--; }
  const debut = `${a}-${String(m).padStart(2, '0')}-01`;
  const suivant = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  return { debut, fin: decalerJour(suivant, -1) };
}

/**
 * La dernière période TERMINÉE et celle d'avant, pour comparer. Pur.
 *  - semaine : du lundi au dimanche ;
 *  - mois    : le mois civil.
 */
export function bornesPeriode(type, maintenant = new Date()) {
  const auj = jourParis(maintenant);
  if (type === 'semaine') {
    const jour = new Date(`${auj}T12:00:00Z`).getUTCDay();          // 0 = dimanche
    const fin = decalerJour(auj, -(jour === 0 ? 7 : jour));          // dernier dimanche passé
    const debut = decalerJour(fin, -6);
    return { type, debut, fin, precedent: { debut: decalerJour(debut, -7), fin: decalerJour(debut, -1) } };
  }
  if (type === 'mois') {
    const [a, m] = auj.split('-').map(Number);
    const courant = bornesMois(a, m - 1);
    const [a2, m2] = courant.debut.split('-').map(Number);
    return { type, ...courant, precedent: bornesMois(a2, m2 - 1) };
  }
  throw new Error(`Période inconnue : ${type}`);
}

/** Tout ce qu'il faut pour le bilan de la semaine ou du mois écoulé. */
export async function donneesPeriode(type, maintenant = new Date()) {
  const b = bornesPeriode(type, maintenant);
  const rows = await parisNotesVictor();
  return {
    ...b,
    courant: bilanEntre(rows, b.debut, b.fin),
    avant: bilanEntre(rows, b.precedent.debut, b.precedent.fin),
    periodes: bilanParPeriodes(rows, maintenant),
  };
}

// ── Rattrapage des bilans du matin ──

/**
 * Bilans du matin dont l'heure est passée, en heure de Paris : ce que le
 * rattrapage doit (ré)enfiler. Le 11/10, le bilan de 10h n'a jamais été
 * enfilé alors que le serveur tournait à 8h30 et à 13h. Réenfiler un bilan
 * déjà envoyé ne fait rien (clé du jour) : on peut le faire à chaque heure.
 * Pur. Rend une liste parmi 'recap-veille', 'semaine', 'mois'.
 */
export function rattrapagesDus(maintenant = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(maintenant).map(x => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  // Après 23h, la clé du jour (en UTC) bascule bientôt : on s'arrête.
  if (minutes >= 23 * 60) return [];
  const dus = [];
  if (minutes >= 10 * 60 + 5) dus.push('recap-veille');
  if (p.weekday === 'Mon' && minutes >= 10 * 60 + 25) dus.push('semaine');
  if (Number(p.day) === 1 && minutes >= 10 * 60 + 45) dus.push('mois');
  return dus;
}

export default { veilleParis, donneesVeille, bornesPeriode, donneesPeriode, rattrapagesDus };
