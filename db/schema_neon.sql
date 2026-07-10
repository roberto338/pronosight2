-- ══════════════════════════════════════════════════════════════
-- PronoSight v4.1 — Schéma PostgreSQL complet
-- Compatible Neon.tech / Supabase / tout PostgreSQL ≥ 13
-- Coller en une seule fois dans l'éditeur SQL de Neon
-- ══════════════════════════════════════════════════════════════

-- ── 1. Pronostics générés par Victor ───────────────────────────
CREATE TABLE IF NOT EXISTS ps_pronostics (
  id                  SERIAL PRIMARY KEY,
  date                DATE NOT NULL,
  sport               VARCHAR(50),
  competition         VARCHAR(100),
  match               VARCHAR(200),
  equipe_a            VARCHAR(100),
  equipe_b            VARCHAR(100),
  heure               VARCHAR(10),
  enjeu               TEXT,
  contexte            TEXT,
  forme_equipe_a      TEXT,
  forme_equipe_b      TEXT,
  infirmerie          TEXT,
  stats_cles          JSONB,
  analyse_tactique    TEXT,
  pronostic_principal VARCHAR(200),
  cote_estimee        DECIMAL(5,2),
  confiance           VARCHAR(20),
  value_bet           VARCHAR(200),
  cote_value          DECIMAL(5,2),
  pari_a_eviter       TEXT,
  score_predit        VARCHAR(50),
  confiance_score     INTEGER,
  analyse_courte      TEXT,
  phrase_signature    TEXT,
  -- Résultats vérifiés post-match
  resultat_reel       VARCHAR(100),
  score_reel          VARCHAR(50),
  pronostic_correct   BOOLEAN,
  value_bet_correct   BOOLEAN,
  patterns_appliques  JSONB,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_pronostics_date      ON ps_pronostics(date DESC);
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_sport     ON ps_pronostics(sport);
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_confiance ON ps_pronostics(confiance);

-- ── 2. Patterns statistiques appris par Victor ─────────────────
CREATE TABLE IF NOT EXISTS ps_victor_patterns (
  id                     SERIAL PRIMARY KEY,
  nom                    VARCHAR(200) UNIQUE NOT NULL,
  type                   VARCHAR(50),
  sport                  VARCHAR(50),
  equipe_a               VARCHAR(100),
  equipe_b               VARCHAR(100),
  condition_trigger      TEXT,
  pattern_observe        TEXT,
  occurrences_total      INTEGER DEFAULT 0,
  occurrences_confirmees INTEGER DEFAULT 0,
  taux_confirmation      DECIMAL(5,2) DEFAULT 0,
  pari_suggere           VARCHAR(100),
  fiabilite              VARCHAR(20),
  derniere_confirmation  DATE,
  actif                  BOOLEAN DEFAULT true,
  created_at             TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_patterns_sport     ON ps_victor_patterns(sport);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_actif     ON ps_victor_patterns(actif);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_fiabilite ON ps_victor_patterns(fiabilite);

-- ── 3. Règles hebdomadaires de Victor ──────────────────────────
CREATE TABLE IF NOT EXISTS ps_victor_rules (
  id              SERIAL PRIMARY KEY,
  semaine         VARCHAR(20),
  regles          JSONB,
  biais           JSONB,
  sports_prudence JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── 4. Statistiques journalières de Victor ─────────────────────
CREATE TABLE IF NOT EXISTS ps_victor_stats (
  id                   SERIAL PRIMARY KEY,
  date                 DATE UNIQUE NOT NULL,
  taux_global          DECIMAL(5,2),
  taux_confiance_eleve DECIMAL(5,2),
  taux_confiance_moyen DECIMAL(5,2),
  taux_value_bet       DECIMAL(5,2),
  roi_mise_fixe        DECIMAL(8,2),
  total_pronostics     INTEGER DEFAULT 0,
  pronostics_corrects  INTEGER DEFAULT 0,
  created_at           TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_stats_date ON ps_victor_stats(date DESC);

-- ══════════════════════════════════════════════════════════════
-- Vérification : doit retourner 4 tables
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE 'ps_%';
-- ══════════════════════════════════════════════════════════════
