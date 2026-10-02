// ══════════════════════════════════════════════
// prono/data/audit-lecture.js — lecture seule de ps_pronostics
// ══════════════════════════════════════════════
//
// Ce fichier est le SEUL du dossier prono/ autorisé à lire une table ps_*,
// et il ne fait que lire. Aucun INSERT, aucun UPDATE, aucun DELETE : la
// règle posée au début du chantier — ne jamais écrire dans les tables de
// PronoSight — tient toujours. Auditer, c'est regarder.

import { query } from '../../db/database.js';

/**
 * Pronostics déjà notés par checkResults.
 * `pronostic_correct IS NOT NULL` suffit à écarter ceux dont le match n'a
 * pas encore eu lieu ou dont l'appariement a été refusé (migration 013).
 */
export async function chargerPronosticsNotes(options = {}) {
  const { depuis = null } = options;
  const { rows } = await query(`
    SELECT date, sport, competition, match, pronostic_principal,
           cote_estimee, cote_confirmee, confiance, confiance_score,
           pronostic_correct, value_bet, value_bet_correct, moteur, modele
    FROM ps_pronostics
    WHERE pronostic_correct IS NOT NULL
      ${depuis ? 'AND date >= $1' : ''}
    ORDER BY date ASC`, depuis ? [depuis] : []);
  return rows;
}

/** Vue d'ensemble, y compris ce qui n'est pas encore noté. */
export async function etatPronostics() {
  const { rows } = await query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE pronostic_correct IS NOT NULL)::int AS notes,
           COUNT(*) FILTER (WHERE cote_confirmee = true)::int AS cotes_reelles,
           MIN(date) AS plus_ancien,
           MAX(date) AS plus_recent
    FROM ps_pronostics`);
  return rows[0];
}

export default { chargerPronosticsNotes, etatPronostics };
