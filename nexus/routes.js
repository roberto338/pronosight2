// ══════════════════════════════════════════════
// nexus/routes.js — Express routes /nexus/*
// ══════════════════════════════════════════════

import { Router } from 'express';
import { dispatchTask, nexusQueue } from './orchestrator.js';
import { listTasks, getTask, getOutputs } from './lib/db.js';
import { renderDashboard } from './dashboard.js';
import { query } from '../db/database.js';

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
    const tasks = await listTasks({ limit: 50 });
    const { rows } = await query(`
      SELECT
        COUNT(*)                                               AS total,
        COUNT(*) FILTER (WHERE status = 'done')    AS done,
        COUNT(*) FILTER (WHERE status = 'running') AS running,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending
      FROM nexus_tasks
    `);
    res.send(renderDashboard(tasks, rows[0]));
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

// ── POST /nexus/dispatch ────────────────────────
router.post('/dispatch', requireApiKey, async (req, res) => {
  const { agentType, input, meta = {}, priority = 0 } = req.body;

  if (!agentType || !input) {
    return res.status(400).json({ error: 'agentType et input sont requis' });
  }

  const VALID = ['research', 'write', 'code', 'monitor', 'notify', 'custom', 'radar', 'planner', 'exec'];
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

export default router;
