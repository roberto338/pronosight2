// ══════════════════════════════════════════════
// nexus/routes/tasks.js — Dispatch et suivi des tâches
// Monté sous /nexus par routes/index.js
// ══════════════════════════════════════════════

import { Router }                            from 'express';
import { dispatchTask, nexusQueue }          from '../orchestrator.js';
import { listTasks, getTask, getOutputs }    from '../lib/db.js';
import { renderDashboard }                   from '../dashboard.js';
import { query }                             from '../../db/database.js';
import { getMemoryStats }                    from '../lib/longTermMemory.js';
import { requireApiKey, requireChatAuth }    from './middleware.js';

const router = Router();

// ── GET /nexus/dashboard ────────────────────────
router.get('/dashboard', requireChatAuth, async (req, res) => {
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
  // Sans API key : simple ping (monitoring uptime), pas de détails internes
  const key = req.headers['x-api-key'] || req.query.key;
  const expected = process.env.NEXUS_API_KEY || process.env.VICTOR_API_KEY;
  if (!expected || key !== expected) {
    return res.json({ status: 'ok' });
  }
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
  const VALID = ['research', 'write', 'code', 'monitor', 'notify', 'custom', 'radar', 'planner', 'exec', 'api', 'browser', 'finance', 'business', 'vision', 'critique', 'google'];
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

  const VALID = ['research', 'write', 'code', 'monitor', 'notify', 'custom', 'radar', 'planner', 'exec', 'api', 'browser', 'finance', 'business', 'vision', 'critique', 'google'];
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
