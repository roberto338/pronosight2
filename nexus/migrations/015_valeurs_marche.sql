-- ══════════════════════════════════════════════
-- 015 — Values de marché : chaque signal diffusé est enregistré puis noté
-- ══════════════════════════════════════════════
--
-- Strictement additive : une table nouvelle, aucune table existante touchée.
--
-- Une value de marché est une cote d'un bookmaker supérieure au prix juste du
-- consensus (victor/valeur.js). Pour qu'elle soit vendable, elle doit être
-- vérifiable : on enregistre ce qui a été diffusé (jamais retouché ensuite),
-- on note le résultat après le match (victor/valeur-suivi.js), et le bilan
-- est public (/bilan).

CREATE TABLE IF NOT EXISTS ps_valeurs_marche (
  id             SERIAL PRIMARY KEY,
  date           DATE         NOT NULL,
  match          VARCHAR(200) NOT NULL,
  competition    VARCHAR(100),
  equipe_a       VARCHAR(100) NOT NULL,
  equipe_b       VARCHAR(100) NOT NULL,
  debut_utc      TIMESTAMPTZ,
  sport_key      VARCHAR(80),             -- clé The Odds API : désigne la ligue pour la notation
  code_compet    VARCHAR(10),             -- code football-data, quand le match en vient
  pari_code      VARCHAR(40)  NOT NULL,   -- vocabulaire fermé de victor/paris.js
  libelle        VARCHAR(200),
  cote           NUMERIC(7,3) NOT NULL,   -- la meilleure cote diffusée
  bookmaker      VARCHAR(80),
  proba_juste    NUMERIC(6,5) NOT NULL,   -- consensus, marge retirée (méthode de la puissance)
  avantage       NUMERIC(7,4) NOT NULL,   -- cote × proba_juste − 1
  nb_bookmakers  INTEGER,
  score_reel     VARCHAR(20),
  gagne          BOOLEAN,                 -- NULL tant que le match n'est pas noté
  note_le        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_valeurs_marche UNIQUE (date, match, pari_code)
);

CREATE INDEX IF NOT EXISTS idx_valeurs_marche_date     ON ps_valeurs_marche (date DESC);
CREATE INDEX IF NOT EXISTS idx_valeurs_marche_a_noter  ON ps_valeurs_marche (date) WHERE gagne IS NULL;
