// ══════════════════════════════════════════════
// nexus/routes.js — Express routes /nexus/*
// ══════════════════════════════════════════════

import { Router } from 'express';
import { dispatchTask, nexusQueue } from './orchestrator.js';
import { listTasks, getTask, getOutputs } from './lib/db.js';
import { renderDashboard } from './dashboard.js';
import { query } from '../db/database.js';
import {
  remember, forget, listMemories, consolidate, getMemoryStats,
} from './lib/longTermMemory.js';

const router = Router();

// ── Auth middleware ─────────────────────────────
function requireApiKey(req, res, next) {
  const key      = req.headers['x-api-key'] || req.query.key;
  const expected = process.env.NEXUS_API_KEY || process.env.VICTOR_API_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ error: 'Non autorisé — x-api-key invalide' });
  }
  next();
}

// ── GET /nexus/dashboard ────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [tasks, statsRes, memStats, goalsRes, routinesRes] = await Promise.all([
      listTasks({ limit: 50 }),
      query(`
        SELECT
          COUNT(*)                                               AS total,
          COUNT(*) FILTER (WHERE status = 'done')    AS done,
          COUNT(*) FILTER (WHERE status = 'running') AS running,
          COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending
        FROM nexus_tasks
      `),
      getMemoryStats(),
      query(`SELECT * FROM nexus_goals WHERE status='active' ORDER BY deadline ASC NULLS LAST`).catch(() => ({ rows: [] })),
      query(`SELECT * FROM nexus_routines ORDER BY active DESC, created_at DESC`).catch(() => ({ rows: [] })),
    ]);
    res.send(renderDashboard(tasks, statsRes.rows[0], memStats, goalsRes.rows, routinesRes.rows));
  } catch (err) {
    res.status(500).send(`<pre style="color:red">Erreur dashboard: ${err.message}</pre>`);
  }
});

// ── GET /nexus/status ───────────────────────────
router.get('/status', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*)                                                           AS total,
        COUNT(*) FILTER (WHERE status = 'done')                AS done,
        COUNT(*) FILTER (WHERE status = 'running')             AS running,
        COUNT(*) FILTER (WHERE status = 'failed')              AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')             AS pending,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h') AS last24h
      FROM nexus_tasks
    `);
    res.json({
      status: 'ok',
      queue:  nexusQueue ? 'active' : 'disabled',
      tasks:  rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/task (alias for /dispatch) ─────
router.post('/task', requireApiKey, async (req, res) => {
  const { type, agentType, payload, input, meta = {}, priority = 0 } = req.body;
  const resolvedType  = type || agentType;
  const resolvedInput = input || payload?.prompt || payload?.query || payload?.idea || JSON.stringify(payload || {});

  if (!resolvedType || !resolvedInput) {
    return res.status(400).json({ error: 'type/agentType et input/payload sont requis' });
  }
  const VALID = ['research', 'write', 'code', 'monitor', 'notify', 'custom', 'radar', 'planner', 'exec', 'api', 'browser', 'finance', 'business', 'vision'];
  if (!VALID.includes(resolvedType)) {
    return res.status(400).json({ error: `type invalide. Valides: ${VALID.join(', ')}` });
  }
  try {
    const result = await dispatchTask({
      agentType: resolvedType,
      input:     resolvedInput,
      meta:      { ...(payload || {}), ...meta },
      priority,
    });
    res.json({ status: 'queued', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/dispatch ────────────────────────
router.post('/dispatch', requireApiKey, async (req, res) => {
  const { agentType, input, meta = {}, priority = 0 } = req.body;

  if (!agentType || !input) {
    return res.status(400).json({ error: 'agentType et input sont requis' });
  }

  const VALID = ['research', 'write', 'code', 'monitor', 'notify', 'custom', 'radar', 'planner', 'exec', 'api', 'browser', 'finance', 'business', 'vision'];
  if (!VALID.includes(agentType)) {
    return res.status(400).json({ error: `agentType invalide. Valides: ${VALID.join(', ')}` });
  }

  try {
    const result = await dispatchTask({ agentType, input, meta, priority });
    res.json({ status: 'queued', ...result });
  } catch (err) {
    console.error('[Nexus/dispatch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/tasks ────────────────────────────
router.get('/tasks', requireApiKey, async (req, res) => {
  try {
    const tasks = await listTasks({
      limit:     Math.min(parseInt(req.query.limit) || 50, 200),
      status:    req.query.status    || null,
      agentType: req.query.agentType || null,
    });
    res.json({ total: tasks.length, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/tasks/:id ────────────────────────
router.get('/tasks/:id', requireApiKey, async (req, res) => {
  try {
    const task = await getTask(parseInt(req.params.id));
    if (!task) return res.status(404).json({ error: 'Tâche non trouvée' });
    const outputs = await getOutputs(task.id);
    res.json({ task, outputs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// GOALS
// ══════════════════════════════════════════════

router.get('/goals', requireApiKey, async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM nexus_goals WHERE status='active' ORDER BY deadline ASC NULLS LAST`);
    res.json({ total: rows.length, goals: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/goals', requireApiKey, async (req, res) => {
  const { title, description, deadline } = req.body;
  if (!title) return res.status(400).json({ error: 'title requis' });
  try {
    const { rows } = await query(
      `INSERT INTO nexus_goals (title, description, deadline) VALUES ($1, $2, $3) RETURNING *`,
      [title, description || null, deadline || null]
    );
    res.json({ status: 'created', goal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/goals/:id', requireApiKey, async (req, res) => {
  const { progress, status } = req.body;
  try {
    const { rows } = await query(
      `UPDATE nexus_goals SET progress=COALESCE($1, progress), status=COALESCE($2, status), updated_at=NOW() WHERE id=$3 RETURNING *`,
      [progress ?? null, status || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Objectif non trouvé' });
    res.json({ status: 'updated', goal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// ROUTINES
// ══════════════════════════════════════════════

router.get('/routines', requireApiKey, async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM nexus_routines ORDER BY created_at DESC`);
    res.json({ total: rows.length, routines: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/routines', requireApiKey, async (req, res) => {
  const { name, cron_expression, task_type, payload = {} } = req.body;
  if (!name || !cron_expression || !task_type) {
    return res.status(400).json({ error: 'name, cron_expression et task_type requis' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO nexus_routines (name, cron_expression, task_type, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, cron_expression, task_type, JSON.stringify(payload)]
    );
    const { scheduleRoutine } = await import('./nexusCron.js');
    scheduleRoutine(rows[0]);
    res.json({ status: 'created', routine: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/routines/:id/stop', requireApiKey, async (req, res) => {
  try {
    await query(`UPDATE nexus_routines SET active=false WHERE id=$1`, [req.params.id]);
    const { unscheduleRoutine } = await import('./nexusCron.js');
    unscheduleRoutine(parseInt(req.params.id));
    res.json({ status: 'stopped' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// LONG-TERM MEMORY ROUTES
// ══════════════════════════════════════════════

// ── POST /nexus/memory/consolidate ─────────────  (must be before /:category)
router.post('/memory/consolidate', requireApiKey, async (req, res) => {
  try {
    const result = await consolidate();
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/memory ──────────────────────────
router.get('/memory', requireApiKey, async (req, res) => {
  try {
    const memories = await listMemories();
    const grouped  = {};
    for (const m of memories) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(m);
    }
    res.json({ total: memories.length, grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/memory/:category ────────────────
router.get('/memory/:category', requireApiKey, async (req, res) => {
  try {
    const memories = await listMemories(req.params.category);
    res.json({ category: req.params.category, count: memories.length, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/memory ─────────────────────────
router.post('/memory', requireApiKey, async (req, res) => {
  const { category, key, value } = req.body;
  if (!category || !key || !value) {
    return res.status(400).json({ error: 'category, key et value sont requis' });
  }
  const VALID = ['project', 'preference', 'pattern', 'person', 'fact', 'feedback'];
  if (!VALID.includes(category)) {
    return res.status(400).json({ error: `Catégorie invalide. Valides: ${VALID.join(', ')}` });
  }
  try {
    await remember(category, key, value);
    res.json({ status: 'saved', category, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /nexus/memory/:key ──────────────────
router.delete('/memory/:key', requireApiKey, async (req, res) => {
  try {
    const found = await forget(req.params.key);
    if (!found) return res.status(404).json({ error: 'Mémoire non trouvée' });
    res.json({ status: 'forgotten', key: req.params.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
