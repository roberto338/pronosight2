-- ══════════════════════════════════════════════════════════════
-- PronoSight v4.1 — Schéma PostgreSQL complet (SOURCE DE VÉRITÉ)
-- Généré depuis l'introspection de la base Neon de prod le 07/08/2026
-- (mis à jour après migration 009 — attempts/max_attempts + index de claim)
-- Régénérer avec : node db/introspect.js
-- Compatible Neon.tech / tout PostgreSQL ≥ 13 (gen_random_uuid)
-- Idempotent : exécutable sur une base vide ou existante
-- 19 tables : 4 ps_* (Victor) + 14 nexus_* (Nexus) + victor_jobs (file)
-- Les migrations nexus/migrations/001→009 restent l'historique ;
-- ce fichier est l'état de référence pour recréer une base neuve.
-- ══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- PARTIE 1 — VICTOR (pronostics sportifs), préfixe ps_
-- ────────────────────────────────────────────────────────────────

-- ── 1.1 Pronostics générés par Victor ──────────────────────────
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

-- ── 1.2 Patterns statistiques appris par Victor ────────────────
CREATE TABLE IF NOT EXISTS ps_victor_patterns (
  id                     SERIAL PRIMARY KEY,
  nom                    VARCHAR(200) UNIQUE NOT NULL,
  type                   VARCHAR(50),           -- H2H | situationnel | psychologique
  sport                  VARCHAR(50),
  equipe_a               VARCHAR(100),          -- nullable (patterns situationnels)
  equipe_b               VARCHAR(100),          -- nullable
  condition_trigger      TEXT,
  pattern_observe        TEXT,
  occurrences_total      INTEGER DEFAULT 0,
  occurrences_confirmees INTEGER DEFAULT 0,
  taux_confirmation      DECIMAL(5,2) DEFAULT 0,
  pari_suggere           VARCHAR(100),
  fiabilite              VARCHAR(20),           -- Fort | Moyen | Émergent
  derniere_confirmation  DATE,
  actif                  BOOLEAN DEFAULT true,
  created_at             TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_patterns_sport     ON ps_victor_patterns(sport);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_actif     ON ps_victor_patterns(actif);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_fiabilite ON ps_victor_patterns(fiabilite);

-- ── 1.3 Règles hebdomadaires de Victor ─────────────────────────
CREATE TABLE IF NOT EXISTS ps_victor_rules (
  id              SERIAL PRIMARY KEY,
  semaine         VARCHAR(20),           -- ex: "2024-W12"
  regles          JSONB,                 -- array de règles texte
  biais           JSONB,                 -- biais détectés par sport
  sports_prudence JSONB,                 -- sports à éviter cette semaine
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── 1.4 Statistiques journalières de Victor ────────────────────
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

-- ────────────────────────────────────────────────────────────────
-- PARTIE 2 — NEXUS (assistant multi-agents), préfixe nexus_
-- Ordre respectant les dépendances FK :
-- tasks → outputs/ltm → ltm_log ; decisions → saas
-- ────────────────────────────────────────────────────────────────

-- ── 2.1 Tâches des agents (migration 001) ──────────────────────
CREATE TABLE IF NOT EXISTS nexus_tasks (
  id            SERIAL PRIMARY KEY,
  agent_type    VARCHAR(32) NOT NULL,
  input         TEXT NOT NULL,
  meta          JSONB NOT NULL DEFAULT '{}',
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  error         TEXT,
  scheduled_for TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- migration 009 : reprise des tâches orphelines et retry avec backoff
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_nexus_tasks_agent_type ON nexus_tasks(agent_type);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_created_at ON nexus_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_status     ON nexus_tasks(status);
-- Index de claim du worker (FOR UPDATE SKIP LOCKED) — pendant de idx_victor_jobs_claim
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_claim      ON nexus_tasks(status, created_at);

-- ── 2.2 Résultats produits par les tâches ──────────────────────
CREATE TABLE IF NOT EXISTS nexus_outputs (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES nexus_tasks(id) ON DELETE CASCADE,
  output     TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_outputs_task_id ON nexus_outputs(task_id);

-- ── 2.3 Mémoire de conversation (chat) ─────────────────────────
CREATE TABLE IF NOT EXISTS nexus_memory (
  id         SERIAL PRIMARY KEY,
  chat_id    VARCHAR(32) NOT NULL,
  role       VARCHAR(16) NOT NULL,
  content    TEXT NOT NULL,
  agent_type VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_memory_chat_created ON nexus_memory(chat_id, created_at DESC);

-- ── 2.4 Objectifs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_goals (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  description TEXT,
  deadline    DATE,
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  progress    INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_goals_deadline ON nexus_goals(deadline);
CREATE INDEX IF NOT EXISTS idx_nexus_goals_status   ON nexus_goals(status);

-- ── 2.5 Routines planifiées ────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_routines (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  cron_expression VARCHAR(50) NOT NULL,
  task_type       VARCHAR(50) NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT true,
  last_run        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_routines_active ON nexus_routines(active);

-- ── 2.6 Bankroll (migration 002 — finance) ─────────────────────
CREATE TABLE IF NOT EXISTS nexus_bankroll (
  id              SERIAL PRIMARY KEY,
  balance         NUMERIC(12,2) NOT NULL,
  initial_balance NUMERIC(12,2) NOT NULL,
  currency        VARCHAR(3) NOT NULL DEFAULT 'EUR',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2.7 Paris suivis ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_bets (
  id         SERIAL PRIMARY KEY,
  match_name TEXT NOT NULL,
  market     TEXT NOT NULL,
  odds       NUMERIC(6,2) NOT NULL,
  stake      NUMERIC(10,2) NOT NULL,
  confidence NUMERIC(4,2),
  agent      VARCHAR(32) DEFAULT 'radar',
  status     VARCHAR(16) NOT NULL DEFAULT 'pending',
  profit     NUMERIC(10,2),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nexus_bets_created_at ON nexus_bets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_bets_status     ON nexus_bets(status);

-- ── 2.8 Mémoire long terme (migration 004) ─────────────────────
CREATE TABLE IF NOT EXISTS nexus_ltm (
  id              SERIAL PRIMARY KEY,
  category        VARCHAR(50) NOT NULL,
  key             VARCHAR(200) NOT NULL UNIQUE,
  value           TEXT NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  source_task_id  INTEGER REFERENCES nexus_tasks(id) ON DELETE SET NULL,
  times_confirmed INTEGER NOT NULL DEFAULT 1,
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_category ON nexus_ltm(category);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_key      ON nexus_ltm(key);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_ranking  ON nexus_ltm(confidence DESC, times_confirmed DESC, last_seen DESC);

-- ── 2.9 Journal des modifications de la mémoire ────────────────
CREATE TABLE IF NOT EXISTS nexus_ltm_log (
  id         SERIAL PRIMARY KEY,
  memory_id  INTEGER NOT NULL REFERENCES nexus_ltm(id) ON DELETE CASCADE,
  action     VARCHAR(20) NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_memory ON nexus_ltm_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_ts     ON nexus_ltm_log(created_at DESC);

-- ── 2.10 Décisions autonomes (migration 007) ───────────────────
CREATE TABLE IF NOT EXISTS nexus_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            VARCHAR(50) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  analysis        JSONB DEFAULT '{}',
  action_plan     JSONB DEFAULT '[]',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  score           INTEGER DEFAULT 0,
  telegram_msg_id BIGINT,
  decided_at      TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  result          JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON nexus_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_score   ON nexus_decisions(score DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_status  ON nexus_decisions(status);

-- ── 2.11 Revenus ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_revenue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project          VARCHAR(100) NOT NULL,
  amount           NUMERIC(10,2) NOT NULL,
  currency         VARCHAR(3) NOT NULL DEFAULT 'EUR',
  source           VARCHAR(50),
  stripe_charge_id VARCHAR(100),
  stripe_customer  VARCHAR(100),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_project  ON nexus_revenue(project);
CREATE INDEX IF NOT EXISTS idx_revenue_recorded ON nexus_revenue(recorded_at DESC);

-- ── 2.12 Micro-SaaS générés ────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_saas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  concept       TEXT,
  spec          JSONB DEFAULT '{}',
  deploy_url    VARCHAR(300),
  landing_url   VARCHAR(300),
  stripe_link   VARCHAR(300),
  github_repo   VARCHAR(300),
  render_svc_id VARCHAR(100),
  brevo_list_id INTEGER,
  status        VARCHAR(30) NOT NULL DEFAULT 'building',
  mrr           NUMERIC(10,2) NOT NULL DEFAULT 0,
  decision_id   UUID REFERENCES nexus_decisions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saas_decision ON nexus_saas(decision_id);
CREATE INDEX IF NOT EXISTS idx_saas_status   ON nexus_saas(status);

-- ── 2.13 Contenus (posts, articles) ────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_content (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project        VARCHAR(100) NOT NULL,
  format         VARCHAR(50) NOT NULL,
  topic          VARCHAR(200),
  content        TEXT,
  platform       VARCHAR(50),
  scheduled_at   TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  buffer_post_id VARCHAR(100),
  status         VARCHAR(20) NOT NULL DEFAULT 'draft',
  engagement     JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_project   ON nexus_content(project);
CREATE INDEX IF NOT EXISTS idx_content_scheduled ON nexus_content(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_content_status    ON nexus_content(status);

-- ── 2.14 Prospection (outreach email) ──────────────────────────
CREATE TABLE IF NOT EXISTS nexus_outreach (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign     VARCHAR(100),
  email        VARCHAR(200),
  name         VARCHAR(100),
  context      TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'queued',
  brevo_msg_id VARCHAR(100),
  sent_at      TIMESTAMPTZ,
  follow_up_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON nexus_outreach(campaign);
CREATE INDEX IF NOT EXISTS idx_outreach_followup ON nexus_outreach(follow_up_at);
CREATE INDEX IF NOT EXISTS idx_outreach_status   ON nexus_outreach(status);

-- ────────────────────────────────────────────────────────────────
-- PARTIE 3 — FILE DE JOBS VICTOR (migration 008)
-- Remplace BullMQ/Redis : claim atomique FOR UPDATE SKIP LOCKED
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS victor_jobs (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(32) NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 5,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  progress      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  result        JSONB,
  dedupe_key    VARCHAR(64) UNIQUE,
  scheduled_for TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_victor_jobs_claim   ON victor_jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_victor_jobs_created ON victor_jobs(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- Vérification : doit retourner 19 tables
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND (table_name LIKE 'ps_%' OR table_name LIKE 'nexus_%'
--        OR table_name = 'victor_jobs');
-- ══════════════════════════════════════════════════════════════
