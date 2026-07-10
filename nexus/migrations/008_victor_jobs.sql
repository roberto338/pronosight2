-- 008_victor_jobs.sql
-- File de jobs Victor en PostgreSQL — remplace BullMQ/Redis (Upstash)
-- Même pattern que nexus_tasks : claim atomique FOR UPDATE SKIP LOCKED

CREATE TABLE IF NOT EXISTS victor_jobs (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(32) NOT NULL,                    -- prematch | value | live | check-results | weekly-review
  data          JSONB NOT NULL DEFAULT '{}',
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  priority      INTEGER NOT NULL DEFAULT 5,              -- plus petit = plus prioritaire (sémantique BullMQ conservée)
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  progress      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  result        JSONB,
  dedupe_key    VARCHAR(64) UNIQUE,                      -- ex: prematch-2026-07-10 (1 job quotidien max)
  scheduled_for TIMESTAMPTZ,                             -- backoff des retries
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_victor_jobs_claim   ON victor_jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_victor_jobs_created ON victor_jobs(created_at DESC);
