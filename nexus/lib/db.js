// ══════════════════════════════════════════════
// nexus/lib/db.js — Nexus DB helpers
// Tables: nexus_tasks, nexus_outputs
// ══════════════════════════════════════════════

import { query } from '../../db/database.js';

/**
 * Insert a new task and return its id
 * @param {Object} opts
 * @param {string} opts.agentType
 * @param {string} opts.input
 * @param {Object} opts.meta
 * @param {string|null} opts.scheduledFor
 * @returns {Promise<number>} task id
 */
export async function insertTask({ agentType, input, meta = {}, scheduledFor = null }) {
  const { rows } = await query(
    `INSERT INTO nexus_tasks (agent_type, input, meta, scheduled_for, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [agentType, input, JSON.stringify(meta), scheduledFor]
  );
  return rows[0].id;
}

/**
 * Update task status
 * @param {number} id
 * @param {string} status  'running' | 'done' | 'failed'
 * @param {string|null} errorMsg
 */
export async function updateTaskStatus(id, status, errorMsg = null) {
  await query(
    `UPDATE nexus_tasks
     SET status       = $2::varchar,
         error        = $3,
         updated_at   = NOW(),
         started_at   = CASE WHEN $2::varchar = 'running'           THEN NOW() ELSE started_at   END,
         completed_at = CASE WHEN $2::varchar IN ('done', 'failed') THEN NOW() ELSE completed_at END
     WHERE id = $1`,
    [id, status, errorMsg]
  );
}

/**
 * Save agent output for a task
 * @param {Object} opts
 * @param {number} opts.taskId
 * @param {string} opts.output
 * @param {Object} opts.meta
 * @returns {Promise<number>} output id
 */
export async function saveOutput({ taskId, output, meta = {} }) {
  const { rows } = await query(
    `INSERT INTO nexus_outputs (task_id, output, meta)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [taskId, output, JSON.stringify(meta)]
  );
  return rows[0].id;
}

/**
 * Get single task by id
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
export async function getTask(id) {
  const { rows } = await query('SELECT * FROM nexus_tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * List recent tasks with optional filters
 * @param {Object} opts
 * @param {number} opts.limit
 * @param {string|null} opts.status
 * @param {string|null} opts.agentType
 * @returns {Promise<Array>}
 */
export async function listTasks({ limit = 50, status = null, agentType = null } = {}) {
  const params = [];
  let sql = 'SELECT * FROM nexus_tasks WHERE 1=1';

  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (agentType) {
    params.push(agentType);
    sql += ` AND agent_type = $${params.length}`;
  }

  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Get all outputs for a task
 * @param {number} taskId
 * @returns {Promise<Array>}
 */
export async function getOutputs(taskId) {
  const { rows } = await query(
    'SELECT * FROM nexus_outputs WHERE task_id = $1 ORDER BY created_at ASC',
    [taskId]
  );
  return rows;
}
