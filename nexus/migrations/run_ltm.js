// nexus/migrations/run_ltm.js
// Usage: node nexus/migrations/run_ltm.js
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, '004_ltm.sql'), 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Tables nexus_ltm + nexus_ltm_log créées');
} catch (err) {
  console.error('❌', err.message);
  process.exit(1);
} finally {
  await client.end();
}
