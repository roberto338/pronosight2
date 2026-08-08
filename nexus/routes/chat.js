// ══════════════════════════════════════════════
// nexus/routes/chat.js — Chat web Nexus (UI + SSE)
//
// Deux voies coexistent :
//   /chat/send   → passe par la file nexus_tasks, réponse via /chat/poll
//   /chat/stream → court-circuite la file et streame Claude en SSE
// ══════════════════════════════════════════════

import { Router }           from 'express';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import { dispatchTask }     from '../orchestrator.js';
import { getTask, getOutputs } from '../lib/db.js';
import { parseNaturalCommand, jarvisTaskToDispatch } from '../jarvis.js';
import { saveMessage, formatHistoryContext } from '../lib/memory.js';
import { buildMemoryContext, extractAndSave } from '../lib/longTermMemory.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';
import { requireChatAuth }  from './middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── Consignes de style par type d'agent (voie streaming) ────────
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

// In-memory set to avoid duplicate memory saves on re-poll
const _servedTasks = new Set();

// ── GET /nexus/chat ─────────────────────────────
router.get('/chat', requireChatAuth, (req, res) => {
  try {
    // chat.html vit dans nexus/, pas dans nexus/routes/
    const html = readFileSync(join(__dirname, '..', 'chat.html'), 'utf8');
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

export default router;
