// ══════════════════════════════════════════════
// nexus/lib/memory.js — Mémoire conversationnelle
// Stocke et charge l'historique par chatId
// ══════════════════════════════════════════════

import { query } from '../../db/database.js';

const MAX_HISTORY    = 20;  // messages max en mémoire
const MAX_CHARS      = 6000; // taille max de l'historique injectée dans le prompt

/**
 * Sauvegarde un message dans l'historique
 */
export async function saveMessage(chatId, role, content, agentType = null) {
  try {
    await query(
      `INSERT INTO nexus_memory (chat_id, role, content, agent_type)
       VALUES ($1, $2, $3, $4)`,
      [String(chatId), role, content.slice(0, 4000), agentType]
    );
  } catch (err) {
    console.error('[Memory] Erreur saveMessage:', err.message);
  }
}

/**
 * Charge les N derniers messages d'un chat
 * @returns {Array} [{ role, content, agent_type, created_at }]
 */
export async function getHistory(chatId, limit = MAX_HISTORY) {
  try {
    const { rows } = await query(
      `SELECT role, content, agent_type, created_at
       FROM nexus_memory
       WHERE chat_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(chatId), limit]
    );
    return rows.reverse(); // chronologique
  } catch (err) {
    console.error('[Memory] Erreur getHistory:', err.message);
    return [];
  }
}

/**
 * Efface tout l'historique d'un chat
 */
export async function clearHistory(chatId) {
  try {
    const { rowCount } = await query(
      'DELETE FROM nexus_memory WHERE chat_id = $1',
      [String(chatId)]
    );
    return rowCount;
  } catch (err) {
    console.error('[Memory] Erreur clearHistory:', err.message);
    return 0;
  }
}

/**
 * Formate l'historique comme bloc de contexte pour l'injection dans le prompt
 * @returns {string} texte formaté prêt à injecter
 */
export async function formatHistoryContext(chatId, limit = 10) {
  const history = await getHistory(chatId, limit);
  if (history.length === 0) return '';

  let context = '─── Historique de la conversation ───\n';
  let totalChars = 0;
  const filtered = [];

  // Garde les messages les plus récents dans la limite de chars
  for (const msg of [...history].reverse()) {
    const line = `${msg.role === 'user' ? 'Toi' : 'Nexus'}: ${msg.content}\n`;
    if (totalChars + line.length > MAX_CHARS) break;
    filtered.unshift(line);
    totalChars += line.length;
  }

  context += filtered.join('');
  context += '─────────────────────────────────────\n';
  return context;
}

/**
 * Nettoyage automatique — supprime les messages > N jours
 */
export async function cleanOldMemory(days = 7) {
  try {
    const { rowCount } = await query(
      `DELETE FROM nexus_memory WHERE created_at < NOW() - INTERVAL '${days} days'`
    );
    if (rowCount > 0) console.log(`[Memory] Nettoyage: ${rowCount} messages supprimés`);
    return rowCount;
  } catch (err) {
    console.error('[Memory] Erreur cleanOldMemory:', err.message);
    return 0;
  }
}
