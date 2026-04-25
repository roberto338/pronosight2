// nexus/migrations/run_memory.js
// Usage: node nexus/migrations/run_memory.js
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;

const SQL = `
CREATE TABLE IF NOT EXISTS nexus_memory (
  id SERIAL PRIMARY KEY, chat_id VARCHAR(32) NOT NULL,
  role VARCHAR(16) NOT NULL, content TEXT NOT NULL,
  agent_type VARCHAR(32), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nexus_memory_chat_created ON nexus_memory(chat_id, created_at DESC);
`;

const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Table nexus_memory créée');
} catch (err) { console.error('❌', err.message); process.exit(1); }
finally { await client.end(); }
