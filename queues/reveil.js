// ══════════════════════════════════════════════
// queues/reveil.js — Réveil des workers sans sondage
// ══════════════════════════════════════════════
//
// Les deux workers sondaient PostgreSQL en permanence — Victor toutes les
// 10 s, Nexus toutes les 15 s — pour découvrir des tâches que le même
// processus venait de créer. Ce sondage à vide n'apportait rien, sinon
// d'empêcher le compute Neon de se mettre en veille et de le facturer
// 24 h sur 24 : quota du palier gratuit épuisé le 18/08 à 01:26, base
// injoignable, aucun pronostic ce jour-là.
//
// Les tâches naissent toutes dans ce processus (cron interne, route HTTP,
// bot Telegram) : il suffit donc de prévenir le worker au moment de
// l'insertion. Le sondage périodique ne sert plus qu'à rattraper les
// orphelins d'un process mort, et peut devenir très lent.
//
// Ce module minuscule existe pour éviter un cycle d'import entre les
// modules qui insèrent et ceux qui exécutent.

const _reveils = new Map();   // nom → fonction de réveil

/**
 * Un worker enregistre ici sa fonction de réveil au démarrage,
 * et la retire (fn = null) à l'arrêt.
 * @param {string} nom  'victor' | 'nexus'
 */
export function definirReveil(nom, fn) {
  if (typeof fn === 'function') _reveils.set(nom, fn);
  else _reveils.delete(nom);
}

/**
 * Prévient un worker qu'il a du travail. Sans effet si ce worker n'est
 * pas démarré (tests, scripts ponctuels) : la tâche sera simplement prise
 * au prochain sondage de secours.
 * @returns {boolean} vrai si un worker a bien été prévenu
 */
export function reveillerWorker(nom, raison = 'nouvelle tâche') {
  const fn = _reveils.get(nom);
  if (!fn) return false;
  try { fn(raison); return true; }
  catch (err) { console.warn(`⚠️  [Reveil:${nom}] ${err.message}`); return false; }
}
