// ══════════════════════════════════════════════
// nexus/routes/index.js — Assemblage des routes /nexus
//
// Remplace l'ancien nexus/routes.js (836 lignes) découpé par domaine.
// Les sous-routers sont montés à la racine : chacun déclare ses chemins
// complets ('/chat/send', '/autonomous/saas'…), ce qui garde les URLs
// strictement identiques à l'avant-découpe.
//
// L'ordre de montage compte : memory doit précéder tasks, sinon rien —
// les préfixes sont disjoints. À l'intérieur de memory.js en revanche,
// /memory/consolidate doit rester avant /memory/:category.
// ══════════════════════════════════════════════

import { Router } from 'express';

import tasksRoutes      from './tasks.js';
import planningRoutes   from './planning.js';
import memoryRoutes     from './memory.js';
import chatRoutes       from './chat.js';
import autonomousRoutes from './autonomous.js';
import googleRoutes     from './google.js';

const router = Router();

router.use(tasksRoutes);
router.use(planningRoutes);
router.use(memoryRoutes);
router.use(chatRoutes);
router.use(autonomousRoutes);
router.use(googleRoutes);

// Filet 404 — doit rester en dernier.
// Sans lui, un chemin /nexus inconnu traverse le router et tombe sur le
// catch-all SPA de server.js : le client reçoit la page d'accueil PronoSight
// en HTTP 200 et ne peut pas distinguer une route disparue d'un succès.
router.use((req, res) => {
  res.status(404).json({ error: `Route Nexus inconnue : ${req.method} ${req.originalUrl}` });
});

export default router;
