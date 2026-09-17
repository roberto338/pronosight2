// ══════════════════════════════════════════════
// prono/data/repository.js — seul point de contact avec PostgreSQL
// ══════════════════════════════════════════════
//
// prono/engine/ ne doit jamais savoir qu'une base existe. Tout le SQL du
// moteur statistique est ici, et nulle part ailleurs.
//
// Les fonctions de transformation (ligneDepuisFixture, versHistorique,
// moyennesDepuisLignes) sont PURES et exportées séparément : ce sont elles
// qui portent les règles métier, donc ce sont elles qu'il faut pouvoir
// tester sans base. Les fonctions qui ouvrent une connexion, en dessous, ne
// font plus que du transport.

import { query } from '../../db/database.js';
import {
  ligneDepuisFixture, versHistorique, moyennesDepuisLignes, FENETRE_JOURS,
} from './normalisation.js';

// Réexportées pour que l'appelant n'ait qu'un seul module à connaître.
export { ligneDepuisFixture, versHistorique, moyennesDepuisLignes, FENETRE_JOURS };

// ══════════════════════════════════════════════
// Accès base — transport uniquement
// ══════════════════════════════════════════════

/**
 * Enregistre des rencontres terminées. Idempotent : une rencontre déjà
 * connue est ignorée sans erreur, ce qui est le cas courant puisque
 * buildFormIndex balaie une fenêtre glissante et revoit chaque match une
 * vingtaine de fois.
 *
 * @returns {Promise<{recus:number, retenus:number, inseres:number}>}
 */
export async function enregistrerResultats(fixtures = []) {
  const lignes = [];
  for (const f of fixtures) {
    const l = ligneDepuisFixture(f);
    if (l) lignes.push(l);
  }
  if (lignes.length === 0) return { recus: fixtures.length, retenus: 0, inseres: 0 };

  // Insertion groupée : une requête plutôt que N. Au-delà de quelques
  // centaines de lignes on découpe, pour ne pas dépasser la limite de
  // paramètres de PostgreSQL (65535) ni tenir le pool trop longtemps.
  const TAILLE_LOT = 200;
  let inseres = 0;

  for (let debut = 0; debut < lignes.length; debut += TAILLE_LOT) {
    const lot = lignes.slice(debut, debut + TAILLE_LOT);
    const valeurs = [];
    const params = [];
    lot.forEach((l, i) => {
      const b = i * 11;
      valeurs.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`);
      params.push(l.source, l.source_match_id, l.competition, l.competition_code, l.joue_le,
                  l.equipe_dom_id, l.equipe_ext_id, l.equipe_dom, l.equipe_ext, l.buts_dom, l.buts_ext);
    });

    const { rowCount } = await query(`
      INSERT INTO pa_match_results
        (source, source_match_id, competition, competition_code, joue_le,
         equipe_dom_id, equipe_ext_id, equipe_dom, equipe_ext, buts_dom, buts_ext)
      VALUES ${valeurs.join(',')}
      ON CONFLICT DO NOTHING`, params);
    inseres += rowCount ?? 0;
  }

  return { recus: fixtures.length, retenus: lignes.length, inseres };
}

/** Rencontres d'une équipe sur la fenêtre utile, la plus récente d'abord. */
export async function historiqueEquipe(equipeId, options = {}) {
  const { fenetreJours = FENETRE_JOURS, limite = 40 } = options;
  const { rows } = await query(`
    SELECT joue_le, equipe_dom_id, equipe_ext_id, equipe_dom, equipe_ext, buts_dom, buts_ext
    FROM pa_match_results
    WHERE (equipe_dom_id = $1 OR equipe_ext_id = $1)
      AND joue_le >= CURRENT_DATE - $2::int
    ORDER BY joue_le DESC
    LIMIT $3`, [equipeId, fenetreJours, limite]);
  return versHistorique(rows, equipeId);
}

/** Moyennes de buts d'une compétition sur la saison en cours. */
export async function moyennesLigue(competitionCode, options = {}) {
  const { fenetreJours = FENETRE_JOURS } = options;
  if (!competitionCode) return moyennesDepuisLignes([]);
  const { rows } = await query(`
    SELECT buts_dom, buts_ext
    FROM pa_match_results
    WHERE competition_code = $1 AND joue_le >= CURRENT_DATE - $2::int`,
    [competitionCode, fenetreJours]);
  return moyennesDepuisLignes(rows);
}

/**
 * Rassemble tout ce dont le moteur a besoin pour une rencontre à venir.
 * C'est la seule fonction que l'appelant a normalement à connaître.
 */
export async function contexteMatch(fixture, options = {}) {
  const [matchsDom, matchsExt, ligue] = await Promise.all([
    historiqueEquipe(fixture.homeId, options),
    historiqueEquipe(fixture.awayId, options),
    moyennesLigue(fixture.codeCompet, options),
  ]);

  return {
    equipeDom: { nom: fixture.home, id: fixture.homeId, matchs: matchsDom },
    equipeExt: { nom: fixture.away, id: fixture.awayId, matchs: matchsExt },
    ligue: { nom: fixture.competition, moyButsDom: ligue.moyButsDom, moyButsExt: ligue.moyButsExt },
    ligueMesuree: ligue.mesuree,
    competition: fixture.competition,
    coupEnvoi: fixture.debutUTC,
  };
}

/**
 * Fige une analyse et son détail par marché.
 * Écrite AVANT le coup d'envoi : une probabilité enregistrée après coup a vu
 * le résultat et ne mesure plus rien.
 */
export async function enregistrerAnalyse(analyse) {
  const { rows } = await query(`
    INSERT INTO pa_analyses
      (equipe_dom, equipe_ext, competition, coup_envoi, model_version,
       lambda_dom, lambda_ext, rho, att_dom, def_dom, att_ext, def_ext,
       n_matchs_dom, n_matchs_ext, score_confiance, iterations)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id`, [
    analyse.equipeDom, analyse.equipeExt, analyse.competition, analyse.coupEnvoi,
    analyse.modelVersion, analyse.lambdaDom, analyse.lambdaExt, analyse.parametres.rho,
    analyse.forces.dom.attaque, analyse.forces.dom.defense,
    analyse.forces.ext.attaque, analyse.forces.ext.defense,
    analyse.forces.dom.nMatchs, analyse.forces.ext.nMatchs,
    analyse.confiance.score, analyse.parametres.iterations,
  ]);

  const analyseId = rows[0].id;
  const valeurs = [], params = [];
  analyse.marches.forEach((m, i) => {
    const b = i * 11;
    valeurs.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`);
    params.push(analyseId, m.marche, m.selection, m.proba, m.probaBasse, m.probaHaute,
                m.coteJuste, m.coteOfferte, m.bookmaker ?? null, m.edge, m.estValue);
  });

  await query(`
    INSERT INTO pa_analysis_markets
      (analyse_id, marche, selection, proba, proba_basse, proba_haute,
       cote_juste, cote_offerte, bookmaker, edge, est_value)
    VALUES ${valeurs.join(',')}
    ON CONFLICT DO NOTHING`, params);

  return analyseId;
}

/**
 * Combien d'équipes ont assez d'historique pour que le modèle ait un sens ?
 *
 * C'est la seule mesure qui dit si le moteur est prêt. Un total de
 * rencontres élevé ne garantit rien : il peut être réparti sur trop
 * d'équipes pour qu'aucune atteigne le seuil.
 */
export async function couvertureEquipes(minMatchs = 10) {
  const { rows } = await query(`
    WITH apparitions AS (
      SELECT equipe_dom_id AS equipe, equipe_dom AS nom FROM pa_match_results
      UNION ALL
      SELECT equipe_ext_id, equipe_ext FROM pa_match_results
    )
    SELECT COUNT(*)::int AS equipes,
           COUNT(*) FILTER (WHERE n >= $1)::int AS suffisantes,
           COALESCE(ROUND(AVG(n)::numeric, 1), 0) AS moyenne
    FROM (SELECT equipe, COUNT(*)::int AS n FROM apparitions GROUP BY equipe) t`,
    [minMatchs]);
  return rows[0];
}

/** Combien de rencontres le moteur a-t-il en mémoire ? */
export async function etatMemoire() {
  const { rows } = await query(`
    SELECT COUNT(*)::int AS total,
           COUNT(DISTINCT competition_code)::int AS competitions,
           MIN(joue_le) AS plus_ancien,
           MAX(joue_le) AS plus_recent
    FROM pa_match_results`);
  return rows[0];
}

export default {
  ligneDepuisFixture, versHistorique, moyennesDepuisLignes,
  enregistrerResultats, historiqueEquipe, moyennesLigue,
  contexteMatch, enregistrerAnalyse, etatMemoire, couvertureEquipes,
};
