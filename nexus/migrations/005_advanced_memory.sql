-- ══════════════════════════════════════════════
-- nexus/migrations/005_advanced_memory.sql
-- Goals tracking + Dynamic routines
-- Run: node nexus/migrations/run_advanced_memory.js
-- ══════════════════════════════════════════════

-- ── nexus_goals ─────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_goals (
  id          SERIAL        PRIMARY KEY,
  title       VARCHAR(200)  NOT NULL,
  description TEXT,
  deadline    DATE,
  status      VARCHAR(20)   NOT NULL DEFAULT 'active', -- active | done | abandoned
  progress    INTEGER       NOT NULL DEFAULT 0
                            CHECK (progress >= 0 AND progress <= 100),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_goals_status   ON nexus_goals(status);
CREATE INDEX IF NOT EXISTS idx_nexus_goals_deadline ON nexus_goals(deadline ASC NULLS LAST);

-- ── nexus_routines ───────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_routines (
  id              SERIAL        PRIMARY KEY,
  name            VARCHAR(100)  NOT NULL,
  cron_expression VARCHAR(50)   NOT NULL,
  task_type       VARCHAR(50)   NOT NULL,
  payload         JSONB         NOT NULL DEFAULT '{}',
  active          BOOLEAN       NOT NULL DEFAULT true,
  last_run        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_routines_active ON nexus_routines(active);
