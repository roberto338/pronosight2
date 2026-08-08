// ══════════════════════════════════════════════
// nexus/routes/middleware.js — Authentification des routes /nexus
//
// Deux régimes distincts :
//   requireApiKey   — routes programmatiques (x-api-key), pour les scripts
//                     et les appels machine.
//   requireChatAuth — surfaces navigateur (chat, dashboard, OAuth), en
//                     Basic Auth pour que le navigateur affiche la popup.
//
// Le plafond de tentatives est posé côté serveur (nexusAuthLimiter dans
// server.js) : sans lui, le mot de passe serait brute-forçable ici même.
// ══════════════════════════════════════════════

import { timingSafeEqual } from 'crypto';

/**
 * Comparaison à durée constante de deux chaînes.
 * timingSafeEqual exige des longueurs égales — on teste la longueur d'abord,
 * ce qui fuite la taille du secret mais rien de son contenu.
 */
function egalConstant(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Routes programmatiques — clé dans l'en-tête x-api-key ou ?key= */
export function requireApiKey(req, res, next) {
  const key      = req.headers['x-api-key'] || req.query.key;
  const expected = process.env.NEXUS_API_KEY || process.env.VICTOR_API_KEY;
  if (!expected || !key || !egalConstant(key, expected)) {
    return res.status(401).json({ error: 'Non autorisé — x-api-key invalide' });
  }
  next();
}

/** Surfaces navigateur — Basic Auth, utilisateur « roberto » par défaut */
export function requireChatAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Nexus Chat"');
    return res.status(401).send('Authentication required');
  }
  const decoded  = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const user     = decoded.slice(0, colonIdx);
  const pass     = decoded.slice(colonIdx + 1);

  const expected     = process.env.NEXUS_CHAT_PASSWORD;
  const expectedUser = process.env.NEXUS_CHAT_USER || 'roberto';

  if (!expected) {
    return res.status(503).send('NEXUS_CHAT_PASSWORD non configuré — accès refusé');
  }
  // Les deux comparaisons sont évaluées sans court-circuit : un `||` aurait
  // rendu l'échec sur le nom d'utilisateur mesurable.
  const userOk = egalConstant(user, expectedUser);
  const passOk = egalConstant(pass, expected);
  if (!userOk || !passOk) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Nexus Chat"');
    return res.status(401).send('Identifiants invalides');
  }
  next();
}
