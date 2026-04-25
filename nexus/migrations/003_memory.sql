-- nexus/migrations/003_memory.sql
-- Table de mémoire conversationnelle Nexus

CREATE TABLE IF NOT EXISTS nexus_memory (
  id         SERIAL        PRIMARY KEY,
  chat_id    VARCHAR(32)   NOT NULL,
  role       VARCHAR(16)   NOT NULL,   -- 'user' | 'assistant'
  content    TEXT          NOT NULL,
  agent_type VARCHAR(32),
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_memory_chat_created
  ON nexus_memory(chat_id, created_at DESC);

COMMENT ON TABLE  nexus_memory      IS 'Historique conversations Telegram par chat_id';
COMMENT ON COLUMN nexus_memory.role IS 'user | assistant';
