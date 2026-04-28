-- ══════════════════════════════════════════════
-- nexus/migrations/007_autonomous.sql
-- Nexus Autonomous Entrepreneur v3.0
-- Run: node nexus/migrations/run_autonomous.js
-- ══════════════════════════════════════════════

-- ── nexus_decisions — 1-tap decision queue ──────
CREATE TABLE IF NOT EXISTS nexus_decisions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type              VARCHAR(50) NOT NULL,          -- saas | content | outreach | feature | revenue
  title             VARCHAR(200) NOT NULL,
  description       TEXT        NOT NULL,
  analysis          JSONB       DEFAULT '{}',
  action_plan       JSONB       DEFAULT '[]',
  status            VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | approved | ignored | executing | done | failed
  score             INTEGER     DEFAULT 0,
  telegram_msg_id   BIGINT,                        -- message id for button update
  decided_at        TIMESTAMPTZ,
  executed_at       TIMESTAMPTZ,
  result            JSONB       DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decisions_status    ON nexus_decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_created   ON nexus_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_score     ON nexus_decisions(score DESC);

-- ── nexus_saas — SaaS projects built by factory ─
CREATE TABLE IF NOT EXISTS nexus_saas (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  concept       TEXT,
  spec          JSONB       DEFAULT '{}',
  deploy_url    VARCHAR(300),
  landing_url   VARCHAR(300),
  stripe_link   VARCHAR(300),
  github_repo   VARCHAR(300),
  render_svc_id VARCHAR(100),
  brevo_list_id INTEGER,
  status        VARCHAR(30) NOT NULL DEFAULT 'building',  -- building | live | failed | paused
  mrr           DECIMAL(10,2) NOT NULL DEFAULT 0,
  decision_id   UUID        REFERENCES nexus_decisions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saas_status     ON nexus_saas(status);
CREATE INDEX IF NOT EXISTS idx_saas_decision   ON nexus_saas(decision_id);

-- ── nexus_content — content calendar ────────────
CREATE TABLE IF NOT EXISTS nexus_content (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project         VARCHAR(100) NOT NULL,
  format          VARCHAR(50) NOT NULL,   -- linkedin | twitter | tiktok | blog | instagram
  topic           VARCHAR(200),
  content         TEXT,
  platform        VARCHAR(50),
  scheduled_at    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  buffer_post_id  VARCHAR(100),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | approved | scheduled | published | failed
  engagement      JSONB       DEFAULT '{}',              -- { likes, comments, shares, views }
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_project   ON nexus_content(project);
CREATE INDEX IF NOT EXISTS idx_content_status    ON nexus_content(status);
CREATE INDEX IF NOT EXISTS idx_content_scheduled ON nexus_content(scheduled_at);

-- ── nexus_revenue — revenue tracking ────────────
CREATE TABLE IF NOT EXISTS nexus_revenue (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project          VARCHAR(100) NOT NULL,
  amount           DECIMAL(10,2) NOT NULL,
  currency         VARCHAR(3)   NOT NULL DEFAULT 'EUR',
  source           VARCHAR(50),                          -- stripe | gumroad | manual
  stripe_charge_id VARCHAR(100),
  stripe_customer  VARCHAR(100),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_project    ON nexus_revenue(project);
CREATE INDEX IF NOT EXISTS idx_revenue_recorded   ON nexus_revenue(recorded_at DESC);

-- ── nexus_outreach — prospect tracking ──────────
CREATE TABLE IF NOT EXISTS nexus_outreach (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign        VARCHAR(100),
  email           VARCHAR(200),
  name            VARCHAR(100),
  context         TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued | sent | replied | cold | converted
  brevo_msg_id    VARCHAR(100),
  sent_at         TIMESTAMPTZ,
  follow_up_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaign  ON nexus_outreach(campaign);
CREATE INDEX IF NOT EXISTS idx_outreach_status    ON nexus_outreach(status);
CREATE INDEX IF NOT EXISTS idx_outreach_followup  ON nexus_outreach(follow_up_at);
