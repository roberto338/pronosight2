-- ══════════════════════════════════════════════════════════════
-- 009 — Reprise des tâches Nexus + isolation des secrets en base
--
-- 1. nexus_tasks gagne attempts/max_attempts : sans ces colonnes, un
--    échec transitoire (429 Anthropic, 503 Gemini) tuait la tâche
--    définitivement, et une tâche 'running' interrompue par un
--    redéploiement restait figée à vie (aucun balayage possible).
--    Aligne nexus_tasks sur victor_jobs (migration 008).
--
-- 2. Index de claim composite : la requête FOR UPDATE SKIP LOCKED de
--    nexus/worker.js filtre sur status puis trie sur created_at.
--    victor_jobs avait déjà son idx_victor_jobs_claim, pas nexus_tasks.
--
-- 3. Les tokens OAuth Google étaient rangés dans nexus_ltm en catégorie
--    'fact'. getRelevantMemories() ne filtrait pas la catégorie : le
--    refresh_token pouvait donc être recopié tel quel dans un system
--    prompt envoyé à Anthropic / Google / Groq. On les bascule en
--    catégorie 'system', désormais exclue de la lecture mémoire.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Tentatives sur les tâches ──────────────────────────────
ALTER TABLE nexus_tasks
  ADD COLUMN IF NOT EXISTS attempts     INTEGER NOT NULL DEFAULT 0;

ALTER TABLE nexus_tasks
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;

-- ── 2. Index de claim du worker ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nexus_tasks_claim
  ON nexus_tasks(status, created_at);

-- ── 3. Isolation des secrets stockés dans nexus_ltm ───────────
UPDATE nexus_ltm
   SET category = 'system'
 WHERE key IN ('google_oauth_tokens', 'google_oauth_state')
   AND category <> 'system';

-- ── 4. Assainissement des tâches déjà figées ──────────────────
-- Les tâches 'running' antérieures à cette migration n'ont jamais eu de
-- filet : elles sont orphelines par construction. On les marque échouées
-- plutôt que de les rejouer — leur contexte est périmé (cf. les 26 jobs
-- Victor qui seraient tous repartis d'un coup au premier déploiement).
UPDATE nexus_tasks
   SET status     = 'failed',
       error      = COALESCE(error, 'Tâche orpheline antérieure à la migration 009'),
       updated_at = NOW()
 WHERE status     = 'running'
   AND started_at < NOW() - INTERVAL '1 hour';
