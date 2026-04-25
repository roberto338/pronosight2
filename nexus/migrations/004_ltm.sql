-- ══════════════════════════════════════════════
-- nexus/migrations/004_ltm.sql
-- Nexus long-term memory (persistent knowledge layer)
-- Run: node nexus/migrations/run_ltm.js
-- ══════════════════════════════════════════════

-- ── nexus_ltm — persistent facts/preferences ───
CREATE TABLE IF NOT EXISTS nexus_ltm (
  id              SERIAL        PRIMARY KEY,
  category        VARCHAR(50)   NOT NULL,
  key             VARCHAR(200)  NOT NULL UNIQUE,
  value           TEXT          NOT NULL,
  confidence      FLOAT         NOT NULL DEFAULT 1.0,
  source_task_id  INTEGER       REFERENCES nexus_tasks(id) ON DELETE SET NULL,
  times_confirmed INTEGER       NOT NULL DEFAULT 1,
  last_seen       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  nexus_ltm              IS 'Long-term memory: facts, preferences, patterns about the user';
COMMENT ON COLUMN nexus_ltm.category     IS 'project | preference | pattern | person | fact | feedback';
COMMENT ON COLUMN nexus_ltm.key          IS 'snake_case unique identifier (e.g. pronosight_deploy_url)';
COMMENT ON COLUMN nexus_ltm.confidence   IS '0 = forgotten, 1.0 = fully confirmed';
COMMENT ON COLUMN nexus_ltm.times_confirmed IS 'Incremented each time the same fact is seen again';

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_category ON nexus_ltm(category);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_key      ON nexus_ltm(key);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_ranking  ON nexus_ltm(confidence DESC, times_confirmed DESC, last_seen DESC);

-- ── nexus_ltm_log — audit trail ─────────────────
CREATE TABLE IF NOT EXISTS nexus_ltm_log (
  id          SERIAL        PRIMARY KEY,
  memory_id   INTEGER       NOT NULL REFERENCES nexus_ltm(id) ON DELETE CASCADE,
  action      VARCHAR(20)   NOT NULL,  -- insert | update | forget
  old_value   TEXT,
  new_value   TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_memory ON nexus_ltm_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_nexus_ltm_log_ts     ON nexus_ltm_log(created_at DESC);
