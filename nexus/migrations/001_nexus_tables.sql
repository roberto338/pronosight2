-- ══════════════════════════════════════════════
-- nexus/migrations/001_nexus_tables.sql
-- Nexus multi-agent system — DB tables
-- Run once on your PostgreSQL (Neon) database
-- ══════════════════════════════════════════════

-- ── nexus_tasks ────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_tasks (
  id             SERIAL        PRIMARY KEY,
  agent_type     VARCHAR(32)   NOT NULL,
  input          TEXT          NOT NULL,
  meta           JSONB         NOT NULL DEFAULT '{}',
  status         VARCHAR(16)   NOT NULL DEFAULT 'pending',
  error          TEXT,
  scheduled_for  TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  nexus_tasks           IS 'Nexus autonomous agent tasks';
COMMENT ON COLUMN nexus_tasks.agent_type IS 'research | write | code | monitor | notify | custom';
COMMENT ON COLUMN nexus_tasks.status     IS 'pending | running | done | failed';

-- ── nexus_outputs ───────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_outputs (
  id         SERIAL      PRIMARY KEY,
  task_id    INTEGER     NOT NULL REFERENCES nexus_tasks(id) ON DELETE CASCADE,
  output     TEXT        NOT NULL,
  meta       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE nexus_outputs IS 'Outputs produced by Nexus agents';

-- ── Indexes ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_status      ON nexus_tasks(status);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_agent_type  ON nexus_tasks(agent_type);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_created_at  ON nexus_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_outputs_task_id   ON nexus_outputs(task_id);
