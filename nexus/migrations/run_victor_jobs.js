// nexus/migrations/run_victor_jobs.js
// Crée la table victor_jobs (file de jobs Victor en PostgreSQL).
// Usage: node nexus/migrations/run_victor_jobs.js
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, '008_victor_jobs.sql'), 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Migration 008 appliquée : table victor_jobs (file Victor sans Redis)');
} catch (err) {
  console.error('❌ Migration 008 échouée:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
