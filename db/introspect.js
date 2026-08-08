// ══════════════════════════════════════════════════════════════
// db/introspect.js — Introspection de la base Neon de prod
//
// Outil de la règle CLAUDE.md : « Régénérer db/schema_neon.sql par
// introspection de la prod, jamais à la main. » Ce script est la source
// mécanique de cette régénération.
//
// Usage:
//   node db/introspect.js              → dump complet (toutes les tables)
//   node db/introspect.js nexus_tasks  → une table précise
// ══════════════════════════════════════════════════════════════
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;

const only = process.argv[2] || null;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Rend un type SQL lisible tel qu'on l'écrit dans schema_neon.sql */
function renderType(c) {
  const t = c.data_type;
  if (c.column_default?.startsWith('nextval(')) {
    return t === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
  }
  if (t === 'character varying') return `VARCHAR(${c.character_maximum_length})`;
  if (t === 'timestamp with time zone') return 'TIMESTAMPTZ';
  if (t === 'double precision') return 'DOUBLE PRECISION';
  if (t === 'integer') return 'INTEGER';
  return t.toUpperCase();
}

try {
  await client.connect();

  const { rows: tables } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND ($1::text IS NULL OR table_name = $1)
    ORDER BY table_name
  `, [only]);

  if (!only) console.log(`-- ${tables.length} tables en prod\n`);

  for (const { table_name } of tables) {
    const { rows: cols } = await client.query(`
      SELECT column_name, data_type, character_maximum_length,
             is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table_name]);

    console.log(`CREATE TABLE IF NOT EXISTS ${table_name} (`);
    const lines = cols.map((c) => {
      let line = `  ${c.column_name.padEnd(16)} ${renderType(c)}`;
      if (c.is_nullable === 'NO' && !c.column_default?.startsWith('nextval(')) {
        line += ' NOT NULL';
      }
      if (c.column_default && !c.column_default.startsWith('nextval(')) {
        line += ` DEFAULT ${c.column_default.replace(/::[a-z ]+$/i, '')}`;
      }
      return line;
    });
    console.log(lines.join(',\n'));
    console.log(');\n');

    const { rows: idx } = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1
       ORDER BY indexname`,
      [table_name]
    );
    for (const { indexdef } of idx) {
      // Les index de contrainte (PK/UNIQUE) sont déjà portés par la table
      if (indexdef.includes('_pkey') || indexdef.includes('_key ')) continue;
      console.log(indexdef.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS') + ';');
    }
    console.log('');
  }
} catch (err) {
  console.error('❌ Introspection échouée:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
