// ══════════════════════════════════════════════
// nexus/agents/browserAgent.js
// Navigue sur des sites web, extrait des données
// Utilise fetch + parsing HTML léger (sans Chromium)
// Pour les sites JS-heavy : résumé via Gemini Search
// ══════════════════════════════════════════════

import { callAI, callGemini } from '../lib/ai.js';

const BROWSER_SYSTEM = `Tu es un expert en extraction de données web.
Tu reçois le contenu HTML/texte d'une page web et une demande précise.
Extrais uniquement les informations demandées de façon structurée et claire.
Si le contenu est insuffisant, dis-le explicitement.
Réponds en français. Sois précis et concis.`;

const PLAN_SYSTEM = `Tu es un expert en scraping web.
Tu reçois une demande d'extraction de données et tu dois retourner un JSON:
{
  "url": "URL exacte à visiter",
  "selector_hint": "ce qu'on cherche sur la page (titre, prix, tableau, etc.)",
  "use_search": true/false
}
use_search = true si la page nécessite JavaScript ou si tu n'es pas sûr de l'URL exacte.
Retourne UNIQUEMENT le JSON, sans markdown.`;

/**
 * Nettoie le HTML pour ne garder que le texte utile
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
    .slice(0, 8000);
}

/**
 * Fetch une URL et retourne le texte brut
 */
async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NexusBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} pour ${url}`);
  const html = await resp.text();
  return stripHtml(html);
}

/**
 * @param {Object} ctx
 * @param {string} ctx.input   Description de ce qu'on veut extraire
 * @param {Object} ctx.meta    { url?: string directe, useSearch?: boolean }
 */
export async function runBrowser({ input, meta = {} }) {
  const task = meta.task || input;
  console.log(`[BrowserAgent] Tâche: ${task.slice(0, 80)}`);

  // ── Étape 1 : Détermine l'URL à visiter ──────
  let targetUrl  = meta.url    || null;
  let useSearch  = meta.useSearch || false;

  if (!targetUrl) {
    try {
      const raw = await callAI(PLAN_SYSTEM, `Demande: ${task}`, {
        maxTokens:   256,
        temperature: 0.1,
      });
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const plan = JSON.parse(match[0]);
        targetUrl = plan.url;
        useSearch = plan.use_search || false;
      }
    } catch { /* fallback to search */ }
  }

  // ── Étape 2a : Sites JS-heavy → Gemini Search ─
  if (useSearch || !targetUrl) {
    console.log(`[BrowserAgent] Mode Google Search pour: ${task.slice(0, 60)}`);
    const output = await callGemini(
      `Tu es un agent de navigation web expert. Réponds en français de façon claire et structurée.`,
      task,
      { useSearch: true, maxTokens: 3000, temperature: 0.3 }
    );
    return {
      output: `🌐 *Browser (Search)*\n${'─'.repeat(22)}\n\n${output}`,
      meta: { agent: 'browser', mode: 'search', task: task.slice(0, 200) },
    };
  }

  // ── Étape 2b : Fetch direct + extraction ─────
  console.log(`[BrowserAgent] Fetch: ${targetUrl}`);
  let pageText;
  try {
    pageText = await fetchPage(targetUrl);
  } catch (err) {
    // Fallback: Google Search si fetch échoue
    console.warn(`[BrowserAgent] Fetch échoué (${err.message}), fallback Search`);
    const output = await callGemini(
      `Tu es un agent de navigation web expert. Réponds en français.`,
      `${task}\nSource souhaitée: ${targetUrl}`,
      { useSearch: true, maxTokens: 3000, temperature: 0.3 }
    );
    return {
      output: `🌐 *Browser (fallback Search)*\n${'─'.repeat(22)}\n\n${output}`,
      meta: { agent: 'browser', mode: 'search-fallback', url: targetUrl },
    };
  }

  // ── Étape 3 : Analyse le contenu ─────────────
  const analysis = await callAI(
    BROWSER_SYSTEM,
    `Demande: ${task}\n\nContenu de la page (${targetUrl}):\n${pageText}`,
    { maxTokens: 2048, temperature: 0.2 }
  );

  return {
    output: `🌐 *Browser: ${targetUrl.slice(0, 50)}*\n${'─'.repeat(22)}\n\n${analysis}`,
    meta: { agent: 'browser', mode: 'fetch', url: targetUrl },
  };
}
