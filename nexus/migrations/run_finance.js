// nexus/migrations/run_finance.js
// Usage: node nexus/migrations/run_finance.js

import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Client } = pg;

const SQL = `
CREATE TABLE IF NOT EXISTS nexus_bankroll (
  id              SERIAL        PRIMARY KEY,
  balance         DECIMAL(12,2) NOT NULL,
  initial_balance DECIMAL(12,2) NOT NULL,
  currency        VARCHAR(3)    NOT NULL DEFAULT 'EUR',
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nexus_bets (
  id          SERIAL        PRIMARY KEY,
  match_name  TEXT          NOT NULL,
  market      TEXT          NOT NULL,
  odds        DECIMAL(6,2)  NOT NULL,
  stake       DECIMAL(10,2) NOT NULL,
  confidence  DECIMAL(4,2),
  agent       VARCHAR(32)   DEFAULT 'radar',
  status      VARCHAR(16)   NOT NULL DEFAULT 'pending',
  profit      DECIMAL(10,2),
  notes       TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  settled_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nexus_bets_status     ON nexus_bets(status);
CREATE INDEX IF NOT EXISTS idx_nexus_bets_created_at ON nexus_bets(created_at DESC);
`;

const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Tables nexus_bankroll et nexus_bets créées');
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'nexus_%' ORDER BY table_name
  `);
  rows.forEach(r => console.log('  -', r.table_name));
} catch (err) {
  console.error('❌', err.message);
  process.exit(1);
} finally {
  await client.end();
}
