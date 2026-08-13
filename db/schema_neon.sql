-- 19 tables en prod

CREATE TABLE IF NOT EXISTS nexus_bankroll (
  id               SERIAL,
  balance          NUMERIC NOT NULL,
  initial_balance  NUMERIC NOT NULL,
  currency         VARCHAR(3) NOT NULL DEFAULT 'EUR',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS nexus_bets (
  id               SERIAL,
  match_name       TEXT NOT NULL,
  market           TEXT NOT NULL,
  odds             NUMERIC NOT NULL,
  stake            NUMERIC NOT NULL,
  confidence       NUMERIC,
  agent            VARCHAR(32) DEFAULT 'radar',
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  profit           NUMERIC,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nexus_bets_created_at ON public.nexus_bets USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_bets_status ON public.nexus_bets USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_content (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  project          VARCHAR(100) NOT NULL,
  format           VARCHAR(50) NOT NULL,
  topic            VARCHAR(200),
  content          TEXT,
  platform         VARCHAR(50),
  scheduled_at     TIMESTAMPTZ,
  published_at     TIMESTAMPTZ,
  buffer_post_id   VARCHAR(100),
  status           VARCHAR(20) NOT NULL DEFAULT 'draft',
  engagement       JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_project ON public.nexus_content USING btree (project);
CREATE INDEX IF NOT EXISTS idx_content_scheduled ON public.nexus_content USING btree (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_content_status ON public.nexus_content USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_decisions (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  type             VARCHAR(50) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT NOT NULL,
  analysis         JSONB DEFAULT '{}',
  action_plan      JSONB DEFAULT '[]',
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  score            INTEGER DEFAULT 0,
  telegram_msg_id  BIGINT,
  decided_at       TIMESTAMPTZ,
  executed_at      TIMESTAMPTZ,
  result           JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON public.nexus_decisions USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_score ON public.nexus_decisions USING btree (score DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON public.nexus_decisions USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_goals (
  id               SERIAL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  deadline         DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'active',
  progress         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_goals_deadline ON public.nexus_goals USING btree (deadline);
CREATE INDEX IF NOT EXISTS idx_nexus_goals_status ON public.nexus_goals USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_ltm (
  id               SERIAL,
  category         VARCHAR(50) NOT NULL,
  key              VARCHAR(200) NOT NULL,
  value            TEXT NOT NULL,
  confidence       DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  source_task_id   INTEGER,
  times_confirmed  INTEGER NOT NULL DEFAULT 1,
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_category ON public.nexus_ltm USING btree (category);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_ranking ON public.nexus_ltm USING btree (confidence DESC, times_confirmed DESC, last_seen DESC);

CREATE TABLE IF NOT EXISTS nexus_ltm_log (
  id               SERIAL,
  memory_id        INTEGER NOT NULL,
  action           VARCHAR(20) NOT NULL,
  old_value        TEXT,
  new_value        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_memory ON public.nexus_ltm_log USING btree (memory_id);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_ts ON public.nexus_ltm_log USING btree (created_at DESC);

CREATE TABLE IF NOT EXISTS nexus_memory (
  id               SERIAL,
  chat_id          VARCHAR(32) NOT NULL,
  role             VARCHAR(16) NOT NULL,
  content          TEXT NOT NULL,
  agent_type       VARCHAR(32),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_memory_chat_created ON public.nexus_memory USING btree (chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nexus_outputs (
  id               SERIAL,
  task_id          INTEGER NOT NULL,
  output           TEXT NOT NULL,
  meta             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_outputs_task_id ON public.nexus_outputs USING btree (task_id);

CREATE TABLE IF NOT EXISTS nexus_outreach (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  campaign         VARCHAR(100),
  email            VARCHAR(200),
  name             VARCHAR(100),
  context          TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'queued',
  brevo_msg_id     VARCHAR(100),
  sent_at          TIMESTAMPTZ,
  follow_up_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON public.nexus_outreach USING btree (campaign);
CREATE INDEX IF NOT EXISTS idx_outreach_followup ON public.nexus_outreach USING btree (follow_up_at);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON public.nexus_outreach USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_revenue (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  project          VARCHAR(100) NOT NULL,
  amount           NUMERIC NOT NULL,
  currency         VARCHAR(3) NOT NULL DEFAULT 'EUR',
  source           VARCHAR(50),
  stripe_charge_id VARCHAR(100),
  stripe_customer  VARCHAR(100),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revenue_project ON public.nexus_revenue USING btree (project);
CREATE INDEX IF NOT EXISTS idx_revenue_recorded ON public.nexus_revenue USING btree (recorded_at DESC);

CREATE TABLE IF NOT EXISTS nexus_routines (
  id               SERIAL,
  name             VARCHAR(100) NOT NULL,
  cron_expression  VARCHAR(50) NOT NULL,
  task_type        VARCHAR(50) NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  active           BOOLEAN NOT NULL DEFAULT true,
  last_run         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_routines_active ON public.nexus_routines USING btree (active);

CREATE TABLE IF NOT EXISTS nexus_saas (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL,
  concept          TEXT,
  spec             JSONB DEFAULT '{}',
  deploy_url       VARCHAR(300),
  landing_url      VARCHAR(300),
  stripe_link      VARCHAR(300),
  github_repo      VARCHAR(300),
  render_svc_id    VARCHAR(100),
  brevo_list_id    INTEGER,
  status           VARCHAR(30) NOT NULL DEFAULT 'building',
  mrr              NUMERIC NOT NULL DEFAULT 0,
  decision_id      UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_decision ON public.nexus_saas USING btree (decision_id);
CREATE INDEX IF NOT EXISTS idx_saas_status ON public.nexus_saas USING btree (status);

CREATE TABLE IF NOT EXISTS nexus_tasks (
  id               SERIAL,
  agent_type       VARCHAR(32) NOT NULL,
  input            TEXT NOT NULL,
  meta             JSONB NOT NULL DEFAULT '{}',
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  error            TEXT,
  scheduled_for    TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_nexus_tasks_agent_type ON public.nexus_tasks USING btree (agent_type);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_claim ON public.nexus_tasks USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_created_at ON public.nexus_tasks USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_status ON public.nexus_tasks USING btree (status);

CREATE TABLE IF NOT EXISTS ps_pronostics (
  id               SERIAL,
  date             DATE NOT NULL,
  sport            VARCHAR(50),
  competition      VARCHAR(100),
  match            VARCHAR(200),
  equipe_a         VARCHAR(100),
  equipe_b         VARCHAR(100),
  heure            VARCHAR(10),
  enjeu            TEXT,
  contexte         TEXT,
  forme_equipe_a   TEXT,
  forme_equipe_b   TEXT,
  infirmerie       TEXT,
  stats_cles       JSONB,
  analyse_tactique TEXT,
  pronostic_principal VARCHAR(200),
  cote_estimee     NUMERIC,
  confiance        VARCHAR(20),
  value_bet        VARCHAR(200),
  cote_value       NUMERIC,
  pari_a_eviter    TEXT,
  score_predit     VARCHAR(50),
  confiance_score  INTEGER,
  analyse_courte   TEXT,
  phrase_signature TEXT,
  resultat_reel    VARCHAR(100),
  score_reel       VARCHAR(50),
  pronostic_correct BOOLEAN,
  value_bet_correct BOOLEAN,
  patterns_appliques JSONB,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  updated_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  pari_code        VARCHAR(40)
);

CREATE INDEX IF NOT EXISTS idx_ps_pronostics_confiance ON public.ps_pronostics USING btree (confiance);
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_date ON public.ps_pronostics USING btree (date DESC);
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_sans_code ON public.ps_pronostics USING btree (date) WHERE (pari_code IS NULL);
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_sport ON public.ps_pronostics USING btree (sport);
CREATE UNIQUE INDEX idx_ps_pronostics_unique_jour ON public.ps_pronostics USING btree (date, lower(regexp_replace((match)::text, '\s+'::text, ' '::text, 'g'::text)));

CREATE TABLE IF NOT EXISTS ps_victor_patterns (
  id               SERIAL,
  nom              VARCHAR(200) NOT NULL,
  type             VARCHAR(50),
  sport            VARCHAR(50),
  equipe_a         VARCHAR(100),
  equipe_b         VARCHAR(100),
  condition_trigger TEXT,
  pattern_observe  TEXT,
  occurrences_total INTEGER DEFAULT 0,
  occurrences_confirmees INTEGER DEFAULT 0,
  taux_confirmation NUMERIC DEFAULT 0,
  pari_suggere     VARCHAR(100),
  fiabilite        VARCHAR(20),
  derniere_confirmation DATE,
  actif            BOOLEAN DEFAULT true,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ps_patterns_actif ON public.ps_victor_patterns USING btree (actif);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_fiabilite ON public.ps_victor_patterns USING btree (fiabilite);
CREATE INDEX IF NOT EXISTS idx_ps_patterns_sport ON public.ps_victor_patterns USING btree (sport);

CREATE TABLE IF NOT EXISTS ps_victor_rules (
  id               SERIAL,
  semaine          VARCHAR(20),
  regles           JSONB,
  biais            JSONB,
  sports_prudence  JSONB,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);


CREATE TABLE IF NOT EXISTS ps_victor_stats (
  id               SERIAL,
  date             DATE NOT NULL,
  taux_global      NUMERIC,
  taux_confiance_eleve NUMERIC,
  taux_confiance_moyen NUMERIC,
  taux_value_bet   NUMERIC,
  roi_mise_fixe    NUMERIC,
  total_pronostics INTEGER DEFAULT 0,
  pronostics_corrects INTEGER DEFAULT 0,
  created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ps_stats_date ON public.ps_victor_stats USING btree (date DESC);

CREATE TABLE IF NOT EXISTS victor_jobs (
  id               SERIAL,
  name             VARCHAR(32) NOT NULL,
  data             JSONB NOT NULL DEFAULT '{}',
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  priority         INTEGER NOT NULL DEFAULT 5,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  progress         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  result           JSONB,
  dedupe_key       VARCHAR(64),
  scheduled_for    TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_victor_jobs_claim ON public.victor_jobs USING btree (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_victor_jobs_created ON public.victor_jobs USING btree (created_at DESC);

