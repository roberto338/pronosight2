// ══════════════════════════════════════════════
// nexus/routes/planning.js — Objectifs et routines planifiées
// Monté sous /nexus par routes/index.js
// ══════════════════════════════════════════════

import { Router }        from 'express';
import { query }         from '../../db/database.js';
import { requireApiKey } from './middleware.js';

const router = Router();

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
    const { scheduleRoutine } = await import('../nexusCron.js');
    scheduleRoutine(rows[0]);
    res.json({ status: 'created', routine: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/routines/:id/stop', requireApiKey, async (req, res) => {
  try {
    await query(`UPDATE nexus_routines SET active=false WHERE id=$1`, [req.params.id]);
    const { unscheduleRoutine } = await import('../nexusCron.js');
    unscheduleRoutine(parseInt(req.params.id));
    res.json({ status: 'stopped' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
