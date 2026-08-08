// ══════════════════════════════════════════════
// nexus/routes/autonomous.js — Autonomous Entrepreneur v3.0
// Les moteurs sont importés à la demande : ils tirent des SDK lourds
// (Stripe, Netlify, GitHub) qu'on ne charge pas au démarrage.
// ══════════════════════════════════════════════

import { Router }        from 'express';
import { query }         from '../../db/database.js';
import { requireApiKey } from './middleware.js';

const router = Router();

// ══════════════════════════════════════════════
// AUTONOMOUS ENTREPRENEUR v3.0
// ══════════════════════════════════════════════

// ── POST /nexus/autonomous/decisions/generate ──
router.post('/autonomous/decisions/generate', requireApiKey, async (req, res) => {
  try {
    const { generateDailyDecisions } = await import('../autonomous/decisionEngine.js');
    const decisions = await generateDailyDecisions();
    res.json({ status: 'done', generated: decisions.length, decisions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/decisions ────────────
router.get('/autonomous/decisions', requireApiKey, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { rows } = await query(
      `SELECT * FROM nexus_decisions WHERE status=$1 ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 20`,
      [status]
    );
    res.json({ total: rows.length, decisions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/decisions/:id/execute ──
router.post('/autonomous/decisions/:id/execute', requireApiKey, async (req, res) => {
  try {
    const { executeDecision } = await import('../autonomous/decisionEngine.js');
    const result = await executeDecision(req.params.id);
    res.json({ status: 'executed', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/decisions/:id/ignore ──
router.post('/autonomous/decisions/:id/ignore', requireApiKey, async (req, res) => {
  try {
    const { markIgnored } = await import('../autonomous/decisionEngine.js');
    await markIgnored(req.params.id);
    res.json({ status: 'ignored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/opportunity/scan ─────
router.post('/autonomous/opportunity/scan', requireApiKey, async (req, res) => {
  try {
    const { runDetectionCycle } = await import('../autonomous/opportunityEngine.js');
    const decisions = await runDetectionCycle();
    res.json({ status: 'done', decisionsCreated: decisions.length, decisions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/revenue ───────────────
router.get('/autonomous/revenue', requireApiKey, async (req, res) => {
  try {
    const { buildRevenueReport, getRevenueByProject } = await import('../autonomous/revenueTracker.js');
    const [report, byProject] = await Promise.all([
      buildRevenueReport(),
      getRevenueByProject(30),
    ]);
    res.json({ report, byProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/saas ──────────────────
router.get('/autonomous/saas', requireApiKey, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, status, deploy_url, stripe_link, github_repo, created_at
       FROM nexus_saas ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ total: rows.length, saas: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/content ───────────────
router.get('/autonomous/content', requireApiKey, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, project, platform, status, scheduled_at, buffer_post_id, created_at
       FROM nexus_content ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ total: rows.length, content: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/outreach ───────────────
router.get('/autonomous/outreach', requireApiKey, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, campaign, name, email, status, sent_at, follow_up_at, created_at
       FROM nexus_outreach ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ total: rows.length, outreach: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/outreach/followups ───
router.post('/autonomous/outreach/followups', requireApiKey, async (req, res) => {
  try {
    const { runFollowUps } = await import('../autonomous/outreachEngine.js');
    const result = await runFollowUps();
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/health ───────────────
router.post('/autonomous/health', requireApiKey, async (req, res) => {
  try {
    const { runProblemSolver } = await import('../autonomous/problemSolver.js');
    const result = await runProblemSolver();
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
