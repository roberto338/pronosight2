// ══════════════════════════════════════════════
// nexus/agents/execAgent.js
// Écrit du code, l'exécute, voit le résultat,
// corrige et relance si besoin (max 3 tentatives)
// ══════════════════════════════════════════════

import { callAI }           from '../lib/ai.js';
import { buildNexusPrompt } from '../lib/systemPrompt.js';
import { exec }   from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { join } from 'path';

const execAsync = promisify(exec);
const TMP_DIR   = '/tmp';
const TIMEOUT   = 30000; // 30s max par exécution

const EXEC_SYSTEM = `Tu es un développeur Node.js expert.
Tu écris du code JavaScript (ES Modules) qui s'exécute sur Node.js 20+.

RÈGLES ABSOLUES :
- Utilise uniquement les modules Node.js natifs (fs, path, https, crypto, etc.) ou des modules déjà installés dans le projet
- Modules projet disponibles : node-fetch, pg, ioredis, bullmq, node-telegram-bot-api, axios
- Toujours terminer par console.log() du résultat final
- Gérer les erreurs avec try/catch
- Pas d'interactions utilisateur (pas de readline, pas de prompt)
- Timeout max 25 secondes
- Ne jamais modifier les fichiers du projet
- Ne jamais exécuter de commandes système dangereuses

MODULES INTERDITS dans le code généré :
- child_process (spawn, exec, execSync)
- Suppression de fichiers en dehors de /tmp
- Accès réseau vers des IPs privées

Retourne UNIQUEMENT le code JavaScript, sans markdown, sans explication.
Le code doit être prêt à exécuter tel quel.`;

const FIX_SYSTEM = `Tu es un développeur Node.js expert.
Tu reçois du code qui a échoué avec une erreur.
Corrige le code pour que l'erreur disparaisse.
Retourne UNIQUEMENT le code corrigé, sans markdown, sans explication.`;

/**
 * Exécute du code JS dans /tmp avec timeout
 */
async function runCode(code, fileId) {
  const filePath = join(TMP_DIR, `nexus_exec_${fileId}.mjs`);
  try {
    await writeFile(filePath, code, 'utf8');
    const { stdout, stderr } = await execAsync(`node "${filePath}"`, {
      timeout: TIMEOUT,
      env: { ...process.env, NODE_ENV: 'nexus-exec' },
    });
    return { success: true, output: stdout || stderr || '(pas de sortie)', filePath };
  } catch (err) {
    const errMsg = err.stderr || err.stdout || err.message || 'Erreur inconnue';
    return { success: false, output: errMsg, filePath };
  }
}

/**
 * Nettoie le fichier temporaire
 */
async function cleanup(filePath) {
  try { await unlink(filePath); } catch { /* ignore */ }
}

/**
 * Extrait le code JS d'une réponse IA (enlève les blocs markdown si présents)
 */
function extractCode(response) {
  const match = response.match(/```(?:javascript|js|mjs)?\n?([\s\S]*?)```/);
  if (match) return match[1].trim();
  return response.trim();
}

/**
 * @param {Object} ctx
 * @param {string} ctx.input   Description de la tâche à exécuter
 * @param {Object} ctx.meta    { language?, allowNetwork? }
 */
export async function runExec({ input, meta = {} }) {
  const task          = meta.task || input;
  const memoryContext = meta.memoryContext || '';
  const fileId        = randomBytes(4).toString('hex');
  console.log(`[ExecAgent] Tâche: ${task.slice(0, 80)}`);

  const execSystem = buildNexusPrompt(EXEC_SYSTEM, memoryContext);

  // ── Étape 1 : Génère le code ─────────────────
  let code;
  try {
    const raw = await callAI(execSystem, `Tâche: ${task}`, {
      maxTokens: 4096,
      provider:  'claude', // Claude pour la qualité du code
    });
    code = extractCode(raw);
  } catch (err) {
    throw new Error(`Génération de code échouée: ${err.message}`);
  }

  // ── Étape 2 : Exécute (max 3 tentatives) ─────
  let attempt = 1;
  let result;

  while (attempt <= 3) {
    console.log(`[ExecAgent] Tentative ${attempt}/3...`);
    result = await runCode(code, `${fileId}_${attempt}`);

    if (result.success) {
      await cleanup(result.filePath);
      break;
    }

    console.warn(`[ExecAgent] Échec tentative ${attempt}: ${result.output.slice(0, 200)}`);
    await cleanup(result.filePath);

    if (attempt < 3) {
      // Demande à l'IA de corriger le code
      try {
        const raw = await callAI(FIX_SYSTEM,
          `Code:\n\`\`\`js\n${code}\n\`\`\`\n\nErreur:\n${result.output.slice(0, 500)}`,
          { maxTokens: 4096, provider: 'claude' }
        );
        code = extractCode(raw);
        console.log(`[ExecAgent] Code corrigé (tentative ${attempt + 1})`);
      } catch (fixErr) {
        console.warn('[ExecAgent] Correction échouée:', fixErr.message);
        break;
      }
    }

    attempt++;
  }

  // ── Résultat ─────────────────────────────────
  if (result.success) {
    const output =
      `✅ *Code exécuté avec succès* (${attempt} tentative${attempt > 1 ? 's' : ''})\n` +
      `${'─'.repeat(22)}\n` +
      `\`\`\`\n${result.output.slice(0, 3000)}\n\`\`\``;
    return {
      output,
      meta: { agent: 'exec', task: task.slice(0, 200), attempts: attempt, success: true },
    };
  } else {
    const output =
      `❌ *Exécution échouée* après ${attempt - 1} tentative(s)\n` +
      `${'─'.repeat(22)}\n` +
      `Erreur: ${result.output.slice(0, 500)}\n\n` +
      `Code final généré:\n\`\`\`js\n${code.slice(0, 1000)}\n\`\`\``;
    return {
      output,
      meta: { agent: 'exec', task: task.slice(0, 200), attempts: attempt - 1, success: false },
    };
  }
}
