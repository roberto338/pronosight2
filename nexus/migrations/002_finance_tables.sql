-- ══════════════════════════════════════════════
-- nexus/migrations/002_finance_tables.sql
-- Tables de gestion financière Nexus
-- Run: node nexus/migrations/run_finance.js
-- ══════════════════════════════════════════════

-- ── Bankroll (état courant) ───────────────────
CREATE TABLE IF NOT EXISTS nexus_bankroll (
  id              SERIAL        PRIMARY KEY,
  balance         DECIMAL(12,2) NOT NULL,
  initial_balance DECIMAL(12,2) NOT NULL,
  currency        VARCHAR(3)    NOT NULL DEFAULT 'EUR',
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Paris enregistrés ────────────────────────
CREATE TABLE IF NOT EXISTS nexus_bets (
  id          SERIAL        PRIMARY KEY,
  match_name  TEXT          NOT NULL,
  market      TEXT          NOT NULL,
  odds        DECIMAL(6,2)  NOT NULL,
  stake       DECIMAL(10,2) NOT NULL,
  confidence  DECIMAL(4,2),              -- 0.0 à 1.0
  agent       VARCHAR(32)   DEFAULT 'radar',
  status      VARCHAR(16)   NOT NULL DEFAULT 'pending',
  profit      DECIMAL(10,2),             -- positif si gagné, négatif si perdu
  notes       TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  settled_at  TIMESTAMPTZ
);

COMMENT ON COLUMN nexus_bets.status IS 'pending | won | lost | void';

-- ── Indexes ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nexus_bets_status     ON nexus_bets(status);
CREATE INDEX IF NOT EXISTS idx_nexus_bets_created_at ON nexus_bets(created_at DESC);
