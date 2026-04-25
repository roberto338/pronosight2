// ══════════════════════════════════════════════
// nexus/lib/longTermMemory.js
// Persistent knowledge layer for Nexus.
// Learns from every task. Enriches every prompt.
// ══════════════════════════════════════════════

import { query } from '../../db/database.js';
import { callAI } from './ai.js';

const VALID_CATEGORIES = ['project', 'preference', 'pattern', 'person', 'fact', 'feedback'];

// Category priority per agent type (for relevance ranking)
const CATEGORY_PRIORITY = {
  custom:   ['person', 'project', 'preference', 'pattern', 'fact', 'feedback'],
  planner:  ['project', 'preference', 'pattern', 'person', 'fact', 'feedback'],
  research: ['fact', 'project', 'person', 'preference', 'pattern', 'feedback'],
  write:    ['preference', 'person', 'project', 'pattern', 'fact', 'feedback'],
  exec:     ['fact', 'project', 'preference', 'person', 'pattern', 'feedback'],
  radar:    ['fact', 'project', 'preference', 'person', 'pattern', 'feedback'],
  finance:  ['fact', 'preference', 'project', 'person', 'pattern', 'feedback'],
};

const EXTRACT_SYSTEM = `Tu es un système d'extraction de mémoire à long terme.
Analyse cette tâche Nexus et extrais les informations utiles à retenir pour de futures interactions : infos sur l'utilisateur, ses projets actifs, ses préférences de travail, ses habitudes détectées.

Réponds UNIQUEMENT en JSON valide. Tableau de 0 à 5 objets. Aucun texte autour:
[{"category": "...", "key": "...", "value": "..."}]

Catégories disponibles:
- project    : état d'un projet (nom, stack, statut, URL, avancement)
- preference : préférences de travail, outils favoris, style de réponse souhaité
- pattern    : habitudes détectées (types de tâches fréquentes, façon de travailler)
- person     : infos sur l'utilisateur (background, objectifs, contexte général)
- fact       : faits techniques (URLs, configs, stacks, noms de services)
- feedback   : ce qui a bien ou mal marché dans les tâches passées

Règles:
- Keys: snake_case, courtes et descriptives (ex: pronosight_deploy_url, prefer_concise_answers)
- Values: phrases concises et factuelles, maximum 200 caractères
- NE JAMAIS stocker: mots de passe, clés API, données financières personnelles sensibles
- Extraire seulement ce qui est réellement utile pour personnaliser les futures réponses
- Si rien d'utile à retenir: retourne []`;

// ── Internal: upsert a memory row ──────────────
async function upsertMemory(category, key, value, sourceTaskId = null) {
  const { rows: existing } = await query(
    'SELECT id, value FROM nexus_ltm WHERE key = $1',
    [key]
  );

  if (existing.length > 0) {
    const mem = existing[0];
    await query(
      `UPDATE nexus_ltm
         SET value           = $1,
             times_confirmed = times_confirmed + 1,
             last_seen       = NOW(),
             confidence      = LEAST(confidence + 0.1, 1.0)
         WHERE key = $2`,
      [value.slice(0, 1000), key]
    );
    await query(
      `INSERT INTO nexus_ltm_log (memory_id, action, old_value, new_value)
       VALUES ($1, 'update', $2, $3)`,
      [mem.id, mem.value, value.slice(0, 1000)]
    );
  } else {
    const { rows } = await query(
      `INSERT INTO nexus_ltm (category, key, value, source_task_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [category, key, value.slice(0, 1000), sourceTaskId || null]
    );
    await query(
      `INSERT INTO nexus_ltm_log (memory_id, action, new_value)
       VALUES ($1, 'insert', $2)`,
      [rows[0].id, value.slice(0, 1000)]
    );
  }
}

/**
 * Extract insights from a completed task and persist them.
 * Called async after task completion — errors are caught silently, never blocks.
 *
 * @param {number} taskId
 * @param {string} agentType
 * @param {string} input
 * @param {string} output
 */
export async function extractAndSave(taskId, agentType, input, output) {
  try {
    const prompt =
      `Type de tâche: ${agentType}\n` +
      `Input: ${input.slice(0, 600)}\n` +
      `Output: ${output.slice(0, 1000)}`;

    const raw = await callAI(EXTRACT_SYSTEM, prompt, {
      maxTokens:   400,
      temperature: 0.1,
      provider:    'claude',  // Fast + structured. Falls back to Gemini if unavailable.
    });

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;

    const cleaned = match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    const items = JSON.parse(cleaned);
    if (!Array.isArray(items) || items.length === 0) return;

    let saved = 0;
    for (const item of items) {
      if (!item.category || !item.key || !item.value) continue;
      if (!VALID_CATEGORIES.includes(item.category)) continue;
      await upsertMemory(item.category, String(item.key), String(item.value), taskId);
      saved++;
    }

    if (saved > 0) {
      console.log(`[LTM] ✅ ${saved} mémoire(s) extraite(s) — tâche #${taskId}`);
    }
  } catch (err) {
    // Silent: memory extraction must never crash the worker
    console.error(`[LTM] Erreur extraction tâche #${taskId}:`, err.message);
  }
}

/**
 * Retrieve relevant memories to enrich an agent's context.
 * Pure DB query — no AI call. Target: < 200ms.
 *
 * @param {string} agentType
 * @param {string} input      (unused for now — reserved for keyword matching)
 * @param {number} limit
 * @returns {Promise<Array<{category, key, value, times_confirmed, last_seen}>>}
 */
export async function getRelevantMemories(agentType, input = '', limit = 10) {
  try {
    const cats = CATEGORY_PRIORITY[agentType] || CATEGORY_PRIORITY.custom;

    // Build CASE WHEN ordering by category priority
    const caseWhen = cats
      .map((c, i) => `WHEN category = '${c}' THEN ${i}`)
      .join(' ');

    const { rows } = await query(
      `SELECT category, key, value, times_confirmed, last_seen
       FROM nexus_ltm
       WHERE confidence > 0
       ORDER BY
         CASE ${caseWhen} ELSE ${cats.length} END,
         times_confirmed DESC,
         last_seen DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    console.error('[LTM] Erreur getRelevantMemories:', err.message);
    return [];
  }
}

/**
 * Build a formatted memory context string ready to inject into a system prompt.
 * Returns '' if no memories.
 */
export async function buildMemoryContext(agentType, input = '', limit = 10) {
  const memories = await getRelevantMemories(agentType, input, limit);
  if (memories.length === 0) return '';
  const lines = memories.map(m => `- [${m.category}] ${m.key}: ${m.value}`).join('\n');
  return `\n\n## Ce que tu sais sur l'utilisateur et ses projets:\n${lines}`;
}

/**
 * Manually add or update a memory.
 *
 * @param {string} category
 * @param {string} key
 * @param {string} value
 * @param {number|null} sourceTaskId
 * @returns {Promise<boolean>}
 */
export async function remember(category, key, value, sourceTaskId = null) {
  try {
    if (!VALID_CATEGORIES.includes(category)) return false;
    await upsertMemory(category, key, value, sourceTaskId);
    return true;
  } catch (err) {
    console.error('[LTM] Erreur remember:', err.message);
    return false;
  }
}

/**
 * Soft-delete a memory (confidence → 0).
 *
 * @param {string} key
 * @returns {Promise<boolean>}  true if found and forgotten
 */
export async function forget(key) {
  try {
    const { rows } = await query(
      `UPDATE nexus_ltm SET confidence = 0 WHERE key = $1 RETURNING id`,
      [key]
    );
    if (rows.length > 0) {
      await query(
        `INSERT INTO nexus_ltm_log (memory_id, action) VALUES ($1, 'forget')`,
        [rows[0].id]
      );
      return true;
    }
    return false;
  } catch (err) {
    console.error('[LTM] Erreur forget:', err.message);
    return false;
  }
}

/**
 * List active memories, optionally filtered by category.
 *
 * @param {string|null} category
 * @returns {Promise<Array>}
 */
export async function listMemories(category = null) {
  try {
    const { rows } = category
      ? await query(
          `SELECT id, category, key, value, times_confirmed, last_seen
           FROM nexus_ltm
           WHERE category = $1 AND confidence > 0
           ORDER BY times_confirmed DESC, last_seen DESC`,
          [category]
        )
      : await query(
          `SELECT id, category, key, value, times_confirmed, last_seen
           FROM nexus_ltm
           WHERE confidence > 0
           ORDER BY category, times_confirmed DESC, last_seen DESC`
        );
    return rows;
  } catch (err) {
    console.error('[LTM] Erreur listMemories:', err.message);
    return [];
  }
}

/**
 * Memory stats for dashboard.
 * Returns: countByCategory, recentMemories, topConfirmed
 */
export async function getMemoryStats() {
  try {
    const [catRows, recentRows, topRows, totalRow] = await Promise.all([
      query(`SELECT category, COUNT(*)::int AS count
             FROM nexus_ltm WHERE confidence > 0
             GROUP BY category ORDER BY count DESC`),
      query(`SELECT category, key, value, times_confirmed, last_seen
             FROM nexus_ltm WHERE confidence > 0
             ORDER BY created_at DESC LIMIT 10`),
      query(`SELECT category, key, value, times_confirmed
             FROM nexus_ltm WHERE confidence > 0 AND times_confirmed > 1
             ORDER BY times_confirmed DESC LIMIT 5`),
      query(`SELECT COUNT(*)::int AS total FROM nexus_ltm WHERE confidence > 0`),
    ]);
    return {
      total:          totalRow.rows[0]?.total || 0,
      countByCategory: catRows.rows,
      recentMemories:  recentRows.rows,
      topConfirmed:    topRows.rows,
    };
  } catch (err) {
    console.error('[LTM] Erreur getMemoryStats:', err.message);
    return { total: 0, countByCategory: [], recentMemories: [], topConfirmed: [] };
  }
}

/**
 * Consolidate: purge forgotten + stale-and-unconfirmed memories.
 * Called weekly by cron.
 *
 * @returns {Promise<{forgotten: number, stale: number, total: number}>}
 */
export async function consolidate() {
  try {
    const { rowCount: forgotten } = await query(
      `DELETE FROM nexus_ltm WHERE confidence = 0`
    );
    const { rowCount: stale } = await query(
      `DELETE FROM nexus_ltm
       WHERE last_seen < NOW() - INTERVAL '90 days'
         AND times_confirmed = 1`
    );
    const total = (forgotten || 0) + (stale || 0);
    console.log(`[LTM] Consolidation: ${forgotten} oubliées + ${stale} obsolètes = ${total} supprimées`);
    return { forgotten: forgotten || 0, stale: stale || 0, total };
  } catch (err) {
    console.error('[LTM] Erreur consolidate:', err.message);
    return { forgotten: 0, stale: 0, total: 0 };
  }
}
