// ══════════════════════════════════════════════
// nexus/agents/monitorAgent.js
// Monitors URLs, APIs, DB metrics
// ══════════════════════════════════════════════

import { callAI }           from '../lib/ai.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';
import { query } from '../../db/database.js';

/**
 * @param {Object} ctx
 * @param {string} ctx.input
 * @param {Object} ctx.meta  { type?: 'url'|'db'|'custom', url?, query? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runMonitor({ input, meta = {} }) {
  const type          = meta.type || 'url';
  const memoryContext = meta.memoryContext || '';
  console.log(`[MonitorAgent] Monitor [${type}]: ${input.slice(0, 80)}`);

  // ── URL monitoring ──────────────────────────
  if (type === 'url') {
    const url = meta.url || input;
    try {
      const start = Date.now();
      const resp  = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const ms    = Date.now() - start;
      const status = resp.ok ? 'ok' : 'error';
      const output = `🔍 URL Monitor — ${status.toUpperCase()}\nURL: ${url}\nHTTP: ${resp.status}\nLatence: ${ms}ms`;
      return {
        output,
        meta: { agent: 'monitor', type, status, httpStatus: resp.status, latencyMs: ms },
      };
    } catch (err) {
      return {
        output: `❌ URL Monitor — ERREUR\nURL: ${url}\nErreur: ${err.message}`,
        meta:   { agent: 'monitor', type, status: 'error', error: err.message },
      };
    }
  }

  // ── DB health check ─────────────────────────
  if (type === 'db') {
    try {
      const { rows } = await query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
          COUNT(*) FILTER (WHERE status = 'running') AS running,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending
        FROM nexus_tasks
        WHERE created_at > NOW() - INTERVAL '24h'
      `);
      const r = rows[0];
      const failed  = parseInt(r.failed)  || 0;
      const running = parseInt(r.running) || 0;
      const pending = parseInt(r.pending) || 0;
      const status  = failed > 10 ? 'warning' : 'ok';
      const output  = `🔍 DB Monitor — ${status.toUpperCase()}\nDernières 24h: ${failed} échouées, ${running} en cours, ${pending} en attente`;
      return {
        output,
        meta: { agent: 'monitor', type, status, failed, running, pending },
      };
    } catch (err) {
      return {
        output: `❌ DB Monitor — ERREUR: ${err.message}`,
        meta:   { agent: 'monitor', type, status: 'error', error: err.message },
      };
    }
  }

  // ── Custom monitoring via AI ────────────────
  const monitorInstructions = `Tu es un agent de monitoring. Analyse les données fournies et génère un rapport de statut.
Identifie les anomalies, les alertes et les recommandations. Sois concis et factuel.`;
  const systemPrompt = buildNexusPrompt(monitorInstructions, memoryContext);
  const output = await callAI(systemPrompt, input, { maxTokens: 2048 });
  return {
    output,
    meta: { agent: 'monitor', type: 'custom' },
  };
}
