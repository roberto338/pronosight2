// nexus/migrations/run_autonomous.js
// Creates Nexus v3.0 autonomous tables.
// Usage: node nexus/migrations/run_autonomous.js
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, '007_autonomous.sql'), 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Tables Nexus v3.0 créées:');
  console.log('   • nexus_decisions  — file de décisions 1-tap');
  console.log('   • nexus_saas       — projets SaaS buildés');
  console.log('   • nexus_content    — calendrier éditorial');
  console.log('   • nexus_revenue    — tracking revenus');
  console.log('   • nexus_outreach   — tracking prospects');
} catch (err) {
  console.error('❌ Migration 007 échouée:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
