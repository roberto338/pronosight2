// ══════════════════════════════════════════════
// nexus/routes/memory.js — Mémoire long terme
//
// L'ordre de déclaration compte : /memory/consolidate doit précéder
// /memory/:category, sinon Express route « consolidate » comme une catégorie.
// ══════════════════════════════════════════════

import { Router }        from 'express';
import { remember, forget, listMemories, consolidate } from '../lib/longTermMemory.js';
import { requireApiKey } from './middleware.js';

const router = Router();

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
