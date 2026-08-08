// nexus/migrations/run_task_retry.js
// Applique 009 : attempts/max_attempts + index de claim sur nexus_tasks,
// et bascule les secrets OAuth de nexus_ltm en catégorie 'system'.
// Usage: node nexus/migrations/run_task_retry.js
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, '009_task_retry_and_secrets.sql'), 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Migration 009 appliquée : retry des tâches Nexus + secrets isolés');

  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM nexus_tasks WHERE status = 'failed')            AS echouees,
      (SELECT COUNT(*) FROM nexus_ltm   WHERE category = 'system')          AS secrets,
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'nexus_tasks' AND column_name = 'attempts')      AS col_attempts
  `);
  console.log('   Vérification:', rows[0]);
} catch (err) {
  console.error('❌ Migration 009 échouée:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
