-- ══════════════════════════════════════════════
-- 014 — Moteur statistique : mémoire des résultats et trace des analyses
--
-- Jusqu'ici, PronoSight ne calculait aucune probabilité. Le prompt envoyé au
-- modèle de langage demande littéralement (public/js/app.js:638) :
--
--     "proba_home": <entier 0-100, probabilité victoire ${t1}>
--
-- et la valeur rendue est reprise telle quelle sous le nom `trueProb`
-- (app.js:761) pour alimenter l'espérance de gain et le critère de Kelly
-- (app.js:388). Rien ne rend ce nombre vrai : un modèle de langage ne compte
-- pas les buts, il produit le token le plus plausible. Une bankroll était
-- dimensionnée sur une intuition.
--
-- Ces trois tables sont le socle du remplacement de ce nombre par un calcul.
--
-- ──────────────────────────────────────────────
-- Pourquoi une table de résultats alors que Victor a déjà accès aux matchs
--
-- victor/sources.js:434 (buildFormIndex) télécharge déjà 20 jours de
-- rencontres terminées, avec les buts et l'identifiant des deux équipes.
-- Puis sources.js:477 écrase tout pour n'en garder qu'une chaîne de cinq
-- caractères ("VVNDV") collée dans le prompt, et le reste est perdu à la fin
-- du run. La matière première d'un modèle de Poisson transite déjà par le
-- code : elle n'est simplement jamais écrite. On la conserve désormais.
--
-- Conséquence : coût API additionnel nul. Aucun appel nouveau n'est créé.
--
-- ──────────────────────────────────────────────
-- Isolation vis-à-vis de l'existant — contrainte posée par Roberto
--
-- Cette migration est strictement additive. Elle ne contient aucun ALTER,
-- aucun DROP, aucun TRUNCATE, et ne référence par clé étrangère AUCUNE table
-- ps_* ou nexus_*. Les 19 tables en production en sortent inchangées.
--
-- En particulier, pa_analyses ne pointe pas vers ps_pronostics : le moteur
-- doit pouvoir analyser une rencontre que Victor n'a pas retenue, et la
-- calibration doit rester mesurable même si un pronostic est supprimé.
-- Le lien se fait par (equipe_dom, equipe_ext, coup_envoi), pas par FK.
--
-- Retour arrière complet : DROP TABLE pa_analysis_markets, pa_analyses,
-- pa_match_results;  — aucune donnée PronoSight n'est concernée.
-- ══════════════════════════════════════════════

-- ──────────────────────────────────────────────
-- 1. La mémoire : les rencontres terminées, buts compris
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pa_match_results (
  id               SERIAL PRIMARY KEY,
  source           VARCHAR(30)  NOT NULL,
  source_match_id  VARCHAR(40),
  competition      VARCHAR(100),
  competition_code VARCHAR(10),
  joue_le          DATE         NOT NULL,
  equipe_dom_id    VARCHAR(40)  NOT NULL,
  equipe_ext_id    VARCHAR(40)  NOT NULL,
  equipe_dom       VARCHAR(100) NOT NULL,
  equipe_ext       VARCHAR(100) NOT NULL,
  buts_dom         SMALLINT     NOT NULL CHECK (buts_dom >= 0),
  buts_ext         SMALLINT     NOT NULL CHECK (buts_ext >= 0),
  collecte_le      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE pa_match_results IS
  'Rencontres terminées conservées pour le calcul des forces d''attaque et de défense. Alimentée par buildFormIndex, qui téléchargeait déjà ces données sans les écrire.';
COMMENT ON COLUMN pa_match_results.equipe_dom_id IS
  'Identifiant de source, JAMAIS le nom. sources.js:449 documente pourquoi : indexer par nom faisait fusionner Vitória SC et Vitória, et injectait une forme fausse sans aucun signal.';

-- Le même match revu à chaque run ne doit pas créer de doublon : buildFormIndex
-- balaie une fenêtre glissante, une rencontre y réapparaît une vingtaine de fois.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_results_source
  ON pa_match_results (source, source_match_id)
  WHERE source_match_id IS NOT NULL;

-- Filet pour les sources sans identifiant stable (TheSportsDB) : une rencontre
-- est unique par jour et par paire d'équipes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_results_rencontre
  ON pa_match_results (joue_le, equipe_dom_id, equipe_ext_id);

-- Les deux accès du moteur : l'historique d'une équipe, à domicile puis à
-- l'extérieur. Le tri décroissant sert la pondération par ancienneté.
CREATE INDEX IF NOT EXISTS idx_pa_results_dom ON pa_match_results (equipe_dom_id, joue_le DESC);
CREATE INDEX IF NOT EXISTS idx_pa_results_ext ON pa_match_results (equipe_ext_id, joue_le DESC);

-- ──────────────────────────────────────────────
-- 2. La trace : une analyse figée AVANT le coup d'envoi
-- ──────────────────────────────────────────────
-- Une probabilité recalculée après le match ne vaut rien : elle a vu le
-- résultat. La calibration n'est mesurable que sur des estimations écrites
-- avant, et rattachées à la version du modèle qui les a produites.
CREATE TABLE IF NOT EXISTS pa_analyses (
  id              SERIAL PRIMARY KEY,
  equipe_dom      VARCHAR(100) NOT NULL,
  equipe_ext      VARCHAR(100) NOT NULL,
  competition     VARCHAR(100),
  coup_envoi      TIMESTAMPTZ,
  model_version   VARCHAR(20)  NOT NULL,
  lambda_dom      NUMERIC(6,3) NOT NULL,
  lambda_ext      NUMERIC(6,3) NOT NULL,
  rho             NUMERIC(6,3) NOT NULL,
  att_dom         NUMERIC(6,3),
  def_dom         NUMERIC(6,3),
  att_ext         NUMERIC(6,3),
  def_ext         NUMERIC(6,3),
  n_matchs_dom    SMALLINT,
  n_matchs_ext    SMALLINT,
  score_confiance SMALLINT CHECK (score_confiance BETWEEN 0 AND 100),
  iterations      INTEGER,
  calcule_le      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Vérité terrain, renseignée après le coup de sifflet final.
  buts_dom_reels  SMALLINT,
  buts_ext_reels  SMALLINT,
  verifie_le      TIMESTAMPTZ
);

COMMENT ON COLUMN pa_analyses.model_version IS
  'Sans cette colonne, la calibration mélange des modèles différents et ne mesure plus rien. Toute modification des paramètres (demi-vie, rho, shrinkage) impose de l''incrémenter.';
COMMENT ON COLUMN pa_analyses.score_confiance IS
  'Fiabilité de l''ESTIMATION, jamais une probabilité de gain. Ce libellé est contractuel côté interface.';

CREATE INDEX IF NOT EXISTS idx_pa_analyses_coup_envoi ON pa_analyses (coup_envoi DESC);
CREATE INDEX IF NOT EXISTS idx_pa_analyses_version    ON pa_analyses (model_version, calcule_le DESC);
-- La file de vérification : ce qui a été analysé et pas encore noté.
CREATE INDEX IF NOT EXISTS idx_pa_analyses_a_verifier
  ON pa_analyses (coup_envoi)
  WHERE verifie_le IS NULL;

-- ──────────────────────────────────────────────
-- 3. Le détail par marché — la table sur laquelle se mesure la calibration
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pa_analysis_markets (
  id           SERIAL PRIMARY KEY,
  analyse_id   INTEGER      NOT NULL REFERENCES pa_analyses(id) ON DELETE CASCADE,
  marche       VARCHAR(20)  NOT NULL,
  selection    VARCHAR(20)  NOT NULL,
  proba        NUMERIC(6,5) NOT NULL CHECK (proba >= 0 AND proba <= 1),
  proba_basse  NUMERIC(6,5),
  proba_haute  NUMERIC(6,5),
  cote_juste   NUMERIC(7,3),
  cote_offerte NUMERIC(7,3),
  bookmaker    VARCHAR(40),
  edge         NUMERIC(7,4),
  est_value    BOOLEAN      NOT NULL DEFAULT false,
  gagnant      BOOLEAN
);

COMMENT ON COLUMN pa_analysis_markets.proba_basse IS
  'Borne à 5 % de l''intervalle issu du rééchantillonnage. Un intervalle large est le signal honnête d''un manque de données : il doit être affiché, pas masqué.';
COMMENT ON COLUMN pa_analysis_markets.cote_offerte IS
  'Cote du bookmaker au moment du calcul. La comparaison n''a de sens qu''avec la probabilité de marché DÉVIGORISÉE — victor/odds.js:98 ne retire pas la marge, ce que la phase de branchement corrige.';
COMMENT ON COLUMN pa_analysis_markets.gagnant IS
  'Issue réelle de la sélection. C''est la colonne qui rend calculables le score de Brier et la courbe de fiabilité.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_markets_unique
  ON pa_analysis_markets (analyse_id, marche, selection);
CREATE INDEX IF NOT EXISTS idx_pa_markets_value
  ON pa_analysis_markets (est_value, edge DESC)
  WHERE est_value = true;
-- Accès de la calibration : toutes les estimations notées d'un marché donné.
CREATE INDEX IF NOT EXISTS idx_pa_markets_calibration
  ON pa_analysis_markets (marche, proba)
  WHERE gagnant IS NOT NULL;
