// ══════════════════════════════════════════════
// nexus/routes.js — Express routes /nexus/*
// ══════════════════════════════════════════════

import { Router }       from 'express';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dispatchTask, nexusQueue }         from './orchestrator.js';
import { listTasks, getTask, getOutputs }   from './lib/db.js';
import { renderDashboard }                  from './dashboard.js';
import { query }                            from '../db/database.js';
import { parseNaturalCommand, jarvisTaskToDispatch } from './jarvis.js';
import { saveMessage, formatHistoryContext }  from './lib/memory.js';
import {
  remember, forget, listMemories, consolidate, getMemoryStats,
  buildMemoryContext, extractAndSave,
} from './lib/longTermMemory.js';
import { buildNexusPrompt } from './lib/systemPrompt.js';

// ── Per-type streaming instructions ────────────
const STREAM_INSTRUCTIONS = {
  custom:   `Tu peux aider sur n'importe quel sujet. Sois concis, précis, directement actionnable.`,
  research: `Tu es un agent de recherche. Fournis des informations factuelles, structurées, sourcées. Identifie les points clés.`,
  write:    `Tu es un expert en rédaction. Produis un texte fluide, bien structuré, adapté au format demandé.`,
  code:     `Tu es un expert développeur. Fournis du code propre, commenté, directement exécutable. Explique brièvement les choix.`,
  planner:  `Tu es un planificateur. Décompose l'objectif en étapes concrètes, séquencées, avec livrables clairs.`,
  critique: `Tu es un critique business expert. Analyse l'idée selon 8 axes : marché, concurrence, technique, coûts, acquisition, MVP, risques, et donne un score /25.`,
  business: `Tu es un expert business builder. Construis un MVP complet : concept, stack, plan de lancement, pricing, distribution.`,
  exec:     `Tu es un agent d'exécution. Analyse les données fournies, calcule, raisonne, et fournis un résultat précis.`,
  finance:  `Tu es un gestionnaire financier. Analyse les données de bankroll, calcule les statistiques, recommande des actions.`,
  vision:   `Tu es un agent Vision expert. Analyse l'image ou le document avec précision. Identifie éléments clés, texte, métriques, insights.`,
};

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ══════════════════════════════════════════════
// NEXUS CHAT — Web UI
// ══════════════════════════════════════════════

// Basic auth middleware (username: roberto, password: NEXUS_CHAT_PASSWORD)
function requireChatAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Nexus Chat"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);
  const expected = process.env.NEXUS_CHAT_PASSWORD;
  if (!expected) {
    return res.status(503).send('NEXUS_CHAT_PASSWORD non configuré — accès refusé');
  }
  if (user !== 'roberto' || pass !== expected) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Nexus Chat"');
    return res.status(401).send('Identifiants invalides');
  }
  next();
}

// In-memory set to avoid duplicate memory saves on re-poll
const _servedTasks = new Set();

// ── GET /nexus/chat ─────────────────────────────
router.get('/chat', requireChatAuth, (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'chat.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>chat.html introuvable: ${err.message}</pre>`);
  }
});

// ── POST /nexus/chat/send ───────────────────────
router.post('/chat/send', requireChatAuth, async (req, res) => {
  const { message, file } = req.body;

  // Require at least a message or an attached file
  if (!message?.trim() && !file) return res.status(400).json({ error: 'message ou fichier requis' });

  const chatId    = 'nexus-web-chat';
  const userText  = message?.trim() || '';

  try {
    // ── Determine agent / prompt from file type ──────
    let agentType      = null;   // null → let Jarvis decide
    let promptText     = userText;
    let fileMeta       = {};

    if (file?.data && file?.type) {
      if (file.type.startsWith('image/') || file.type === 'application/pdf') {
        // Vision agent handles images and PDFs
        agentType = 'vision';
        const defaultInstruction = file.type === 'application/pdf'
          ? 'Analyse ce document PDF en détail.'
          : 'Analyse cette image en détail.';
        fileMeta = {
          imageBase64:    file.data,
          imageMediaType: file.type,
          instruction:    userText || defaultInstruction,
        };
        promptText = fileMeta.instruction;
      } else {
        // Text / code / CSV — decode base64 and append to prompt
        try {
          const decoded = Buffer.from(file.data, 'base64').toString('utf8').slice(0, 8000);
          promptText = (userText ? userText + '\n\n' : '') +
                       `Contenu du fichier "${file.name}":\n\`\`\`\n${decoded}\n\`\`\``;
        } catch {
          promptText = userText || `Fichier reçu: ${file.name}`;
        }
      }
    }

    // ── Save user turn to conversational memory ──────
    const memLabel = file
      ? `[Fichier: ${file.name}] ${userText}`.trim()
      : userText;
    await saveMessage(chatId, 'user', memLabel || promptText.slice(0, 200), 'web');

    // ── Build dispatch: vision bypasses Jarvis ────────
    let dispatch        = {};
    let taskPriority    = 0;
    let taskExplanation = '';

    if (agentType === 'vision') {
      dispatch = { agentType: 'vision', input: promptText, meta: fileMeta };
    } else {
      const task  = await parseNaturalCommand(promptText, chatId);
      dispatch    = jarvisTaskToDispatch(task);
      taskPriority    = task.priority;
      taskExplanation = task.explanation;
    }

    // ── Pre-inject LTM memory context ────────────────
    let memoryContext = '';
    try {
      memoryContext = await buildMemoryContext(dispatch.agentType, promptText);
      console.log('[Chat/send] Memory injected:', memoryContext.length, 'chars');
    } catch (err) {
      console.warn('[Chat/send] Memory fetch error (non-blocking):', err.message);
    }

    const { taskId } = await dispatchTask({
      agentType: dispatch.agentType,
      input:     dispatch.input,
      meta:      { ...dispatch.meta, source: 'web-chat', chatId, memoryContext },
      priority:  taskPriority,
    });

    res.json({
      taskId,
      explanation: taskExplanation,
      agentType:   dispatch.agentType,
    });
  } catch (err) {
    console.error('[Chat/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/chat/stream ─────────────────────
// Bypass queue — stream Claude response directly via SSE.
// First token in <1s. Saves to memory async after completion.
router.post('/chat/stream', requireChatAuth, async (req, res) => {
  const { message, file } = req.body;
  if (!message?.trim() && !file) return res.status(400).json({ error: 'message ou fichier requis' });

  // SSE headers — disable all buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx: disable buffering
  res.flushHeaders();

  const chatId    = 'nexus-web-chat';
  const userText  = message?.trim() || '';
  const send      = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  try {
    // ── File routing ─────────────────────────────
    let imageBlock = null;
    let promptText = userText;
    let forceType  = null; // override Jarvis when file present

    if (file?.data && file?.type) {
      if (file.type.startsWith('image/') || file.type === 'application/pdf') {
        forceType  = 'vision';
        promptText = userText || (file.type === 'application/pdf' ? 'Analyse ce document PDF en détail.' : 'Analyse cette image en détail.');
        imageBlock = file.type === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
          : { type: 'image',    source: { type: 'base64', media_type: file.type,          data: file.data } };
      } else {
        try {
          const decoded = Buffer.from(file.data, 'base64').toString('utf8').slice(0, 8000);
          promptText = (userText ? userText + '\n\n' : '') + `Contenu de "${file.name}":\n\`\`\`\n${decoded}\n\`\`\``;
        } catch { promptText = userText || `Fichier: ${file.name}`; }
      }
    }

    // ── Memory + Jarvis in parallel ───────────────
    const [memoryContext, task, historyContext] = await Promise.all([
      buildMemoryContext(forceType || 'custom', promptText).catch(() => ''),
      forceType === 'vision'
        ? Promise.resolve({ type: 'vision', payload: {}, priority: 2, explanation: 'Analyse visuelle' })
        : parseNaturalCommand(promptText, chatId).catch(() => ({ type: 'custom', payload: { prompt: promptText }, priority: 2, explanation: '' })),
      formatHistoryContext(chatId).catch(() => ''),
    ]);

    // ── Save user turn ────────────────────────────
    const memLabel = file ? `[Fichier: ${file.name}] ${userText}`.trim() : userText;
    saveMessage(chatId, 'user', memLabel || promptText.slice(0, 200), 'web').catch(() => {});

    // ── Build system prompt ───────────────────────
    const resolvedType = forceType || task.type || 'custom';
    const agentInstr   = STREAM_INSTRUCTIONS[resolvedType] || STREAM_INSTRUCTIONS.custom;
    const systemPrompt = buildNexusPrompt(agentInstr, memoryContext);

    // ── Build user message content ────────────────
    const contextualPrompt = historyContext
      ? historyContext + '\nMessage actuel: ' + promptText
      : promptText;

    const userContent = imageBlock
      ? [imageBlock, { type: 'text', text: contextualPrompt }]
      : contextualPrompt;

    const model  = resolvedType === 'vision'
      ? (process.env.VISION_MODEL || 'claude-sonnet-5')
      : (process.env.CHAT_MODEL   || 'claude-haiku-4-5');

    // ── Stream from Claude API ────────────────────
    const apiKey     = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { send({ error: 'ANTHROPIC_API_KEY manquant' }); res.end(); return; }

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system:     systemPrompt,
        stream:     true,
        messages:   [{ role: 'user', content: userContent }],
      }),
      // Plafond sur l'établissement du flux. Une fois le stream ouvert, c'est la
      // boucle reader.read() ci-dessous qui gouverne — undici applique son
      // bodyTimeout d'inactivité (5 min) sur un flux qui se tairait.
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS || 90_000)),
    });

    if (!claudeResp.ok) {
      const errData = await claudeResp.json().catch(() => ({}));
      send({ error: `Claude ${claudeResp.status}: ${errData.error?.message || claudeResp.statusText}` });
      res.end();
      return;
    }

    // ── Forward SSE tokens to client ──────────────
    const reader  = claudeResp.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = '';
    let buf       = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const token = evt.delta.text;
            fullText   += token;
            send({ token });
          }
        } catch { /* ignore malformed SSE lines */ }
      }
    }

    send({ done: true, agentType: resolvedType });
    res.end();

    // ── Async post-save (non-blocking) ────────────
    setImmediate(async () => {
      try {
        await saveMessage(chatId, 'assistant', fullText, resolvedType);
        // Signature : (taskId, agentType, input, output). La voie streaming n'a
        // pas de nexus_tasks associée → taskId null (source_task_id est nullable).
        await extractAndSave(null, resolvedType, promptText, fullText);
      } catch (err) {
        console.error('[Chat/stream] Post-save error:', err.message);
      }
    });

  } catch (err) {
    console.error('[Chat/stream]', err.message);
    send({ error: err.message });
    try { res.end(); } catch {}
  }
});

// ── GET /nexus/chat/poll/:taskId ────────────────
router.get('/chat/poll/:taskId', requireChatAuth, async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  if (!taskId || isNaN(taskId)) return res.status(400).json({ error: 'taskId invalide' });

  try {
    const task = await getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });

    if (task.status === 'done') {
      const outputs = await getOutputs(taskId);
      const output  = outputs[0]?.output || '(pas de résultat)';

      // Save assistant reply to memory once only.
      // Skip if the task had chatId set (worker already saved it on completion).
      if (!_servedTasks.has(taskId)) {
        _servedTasks.add(taskId);
        const taskMeta = typeof task.meta === 'string'
          ? JSON.parse(task.meta || '{}') : (task.meta || {});
        if (!taskMeta.chatId) {
          // Worker skipped memory save (no chatId in meta) — save here
          await saveMessage('nexus-web-chat', 'assistant', output, task.agent_type);
        }
        if (_servedTasks.size > 500) _servedTasks.clear(); // prevent leak
      }

      return res.json({ status: 'done', output, agentType: task.agent_type });
    }

    if (task.status === 'failed') {
      return res.json({ status: 'failed', error: task.error || 'Erreur inconnue' });
    }

    // pending or running
    res.json({ status: task.status });
  } catch (err) {
    console.error('[Chat/poll]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// AUTONOMOUS ENTREPRENEUR v3.0
// ══════════════════════════════════════════════

// ── POST /nexus/autonomous/decisions/generate ──
router.post('/autonomous/decisions/generate', requireApiKey, async (req, res) => {
  try {
    const { generateDailyDecisions } = await import('./autonomous/decisionEngine.js');
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
    const { executeDecision } = await import('./autonomous/decisionEngine.js');
    const result = await executeDecision(req.params.id);
    res.json({ status: 'executed', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/decisions/:id/ignore ──
router.post('/autonomous/decisions/:id/ignore', requireApiKey, async (req, res) => {
  try {
    const { markIgnored } = await import('./autonomous/decisionEngine.js');
    await markIgnored(req.params.id);
    res.json({ status: 'ignored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/opportunity/scan ─────
router.post('/autonomous/opportunity/scan', requireApiKey, async (req, res) => {
  try {
    const { runDetectionCycle } = await import('./autonomous/opportunityEngine.js');
    const decisions = await runDetectionCycle();
    res.json({ status: 'done', decisionsCreated: decisions.length, decisions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nexus/autonomous/revenue ───────────────
router.get('/autonomous/revenue', requireApiKey, async (req, res) => {
  try {
    const { buildRevenueReport, getRevenueByProject } = await import('./autonomous/revenueTracker.js');
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
    const { runFollowUps } = await import('./autonomous/outreachEngine.js');
    const result = await runFollowUps();
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nexus/autonomous/health ───────────────
router.post('/autonomous/health', requireApiKey, async (req, res) => {
  try {
    const { runProblemSolver } = await import('./autonomous/problemSolver.js');
    const result = await runProblemSolver();
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// GOOGLE OAUTH
// ══════════════════════════════════════════════

// ── GET /nexus/google/status ────────────────────
router.get('/google/status', requireChatAuth, async (req, res) => {
  try {
    const { isGoogleConnected } = await import('./lib/googleAuth.js');
    const connected = await isGoogleConnected();
    res.json({ connected });
  } catch (err) {
    res.json({ connected: false });
  }
});

// ── GET /nexus/google/auth ──────────────────────
// Redirects to Google OAuth consent screen
router.get('/google/auth', requireChatAuth, async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).send(`
        <div style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#f5f5f5;min-height:100vh">
          <h2 style="color:#ef4444">⚠️ Google OAuth non configuré</h2>
          <p>Ajoute ces variables dans <code>.env</code> et sur Render:</p>
          <pre style="background:#1a1a1a;padding:16px;border-radius:8px;color:#a78bfa">
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=https://pronosight2.onrender.com/nexus/google/callback</pre>
          <p><a href="https://console.cloud.google.com" style="color:#7c3aed">→ console.cloud.google.com</a></p>
          <a href="/nexus/chat" style="color:#888">← Retour au chat</a>
        </div>
      `);
    }
    const { getAuthUrl } = await import('./lib/googleAuth.js');
    res.redirect(await getAuthUrl());
  } catch (err) {
    res.status(500).send(`Erreur: ${err.message}`);
  }
});

// ── GET /nexus/google/callback ──────────────────
// Receives the code from Google, saves tokens, redirects to chat
// Route nécessairement publique : c'est Google qui l'appelle, pas un navigateur
// authentifié. La protection est le `state` émis par /google/auth (lui, derrière
// requireChatAuth) — sans cette vérification, n'importe qui peut lier son propre
// compte Google à cette instance.
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    return res.redirect(`/nexus/chat?google=error&reason=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect('/nexus/chat?google=error&reason=no_code');
  }
  try {
    const { exchangeCode, consumeState } = await import('./lib/googleAuth.js');
    await consumeState(state);   // lève avant tout échange si le state ne colle pas
    await exchangeCode(code);
    console.log('[Google OAuth] Tokens saved successfully');
    res.redirect('/nexus/chat?google=connected');
  } catch (err) {
    console.error('[Google OAuth] Callback error:', err.message);
    res.redirect(`/nexus/chat?google=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /nexus/google/disconnect ───────────────
router.post('/google/disconnect', requireChatAuth, async (req, res) => {
  try {
    await query(`DELETE FROM nexus_ltm WHERE key = 'google_oauth_tokens'`);
    res.json({ status: 'disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
