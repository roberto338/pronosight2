-- ══════════════════════════════════════════════
-- nexus/migrations/006_seed_memory.sql
-- Initial long-term memory seed for Nexus.
--
-- NOTE: The factual memory table is nexus_ltm, NOT nexus_memory.
-- nexus_memory stores conversation history (chat_id, role, content).
-- nexus_ltm stores persistent key-value facts (category, key, value).
--
-- Run directly in your Neon PostgreSQL console.
-- Safe to re-run: ON CONFLICT (key) DO UPDATE keeps the latest value.
-- ══════════════════════════════════════════════

INSERT INTO nexus_ltm (category, key, value, confidence, times_confirmed)
VALUES
  -- ── Who Roberto is ─────────────────────────
  ('person',     'owner',             'Roberto, entrepreneur basé à Châtillon, France',                                                       1.0, 1),

  -- ── Active projects ─────────────────────────
  ('project',    'pronosight',        'PronoSight v5 — plateforme paris sportifs, Node.js, PostgreSQL Neon, Render, en production',           1.0, 1),
  ('project',    'metafiction',       'MÉTAFICTION — app fitness React Native Expo, coach IA META, en développement',                         1.0, 1),
  ('project',    'nutriplan',         'NutriPlan AI — meal planner IA, live sur Polsia, 18 prospects contactés',                              1.0, 1),
  ('project',    'nexus',             'Nexus — assistant IA autonome 24/7, Node.js PostgreSQL Claude, en production sur Render',              1.0, 1),
  ('project',    'fruity_arena',      'Fruity Arena — série animée 3D fruits, ElevenLabs Kling AI Remotion, en production',                  1.0, 1),

  -- ── Tech preferences ────────────────────────
  ('preference', 'stack',             'Node.js Express, PostgreSQL, Render, Claude API, React Native',                                        1.0, 1),
  ('preference', 'langue',            'Français, réponses concises et directes',                                                              1.0, 1),
  ('preference', 'style',             'Teste immédiatement, préfère commandes concrètes aux longues explications',                            1.0, 1)

ON CONFLICT (key) DO UPDATE
  SET value           = EXCLUDED.value,
      times_confirmed = nexus_ltm.times_confirmed + 1,
      last_seen       = NOW()
;
