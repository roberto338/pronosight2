// nexus/migrations/run.js
// Exécute la migration Nexus directement via DATABASE_URL
// Usage: node nexus/migrations/run.js

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Client } = pg;

const SQL = `
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

CREATE TABLE IF NOT EXISTS nexus_outputs (
  id         SERIAL      PRIMARY KEY,
  task_id    INTEGER     NOT NULL REFERENCES nexus_tasks(id) ON DELETE CASCADE,
  output     TEXT        NOT NULL,
  meta       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_tasks_status      ON nexus_tasks(status);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_agent_type  ON nexus_tasks(agent_type);
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_created_at  ON nexus_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nexus_outputs_task_id   ON nexus_outputs(task_id);
`;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log('✅ Connecté à PostgreSQL');

  await client.query(SQL);
  console.log('✅ Tables nexus_tasks et nexus_outputs créées');

  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'nexus_%'
    ORDER BY table_name
  `);
  console.log('📋 Tables Nexus présentes:');
  rows.forEach(r => console.log('   -', r.table_name));

} catch (err) {
  console.error('❌ Erreur migration:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
