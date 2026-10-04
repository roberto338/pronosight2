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
import { bilanVictor, bilanValeursMarche } from './valeur-suivi.js';

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
  return { date: dateISO, pronos, valeurs, bilan: { victor, marche } };
}

export default { veilleParis, donneesVeille };
