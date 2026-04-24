// ══════════════════════════════════════════════
// admin/bullBoard.js — Dashboard Bull Board
// Accessible sur /admin/queues
// ══════════════════════════════════════════════

import { createBullBoard }    from '@bull-board/api';
import { BullMQAdapter }      from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter }     from '@bull-board/express';
import { victorQueue }        from '../queues/victorQueue.js';

/**
 * Monte le dashboard Bull Board sur l'app Express.
 * @param {import('express').Application} app
 */
export function setupBullBoard(app) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues:        [new BullMQAdapter(victorQueue)],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: '🎙️ Victor IA — Queues',
      },
    },
  });

  // ── Protection basique par clé ─────────────
  app.use('/admin/queues', (req, res, next) => {
    const key = req.query.key || req.headers['x-admin-key'];
    const expected = process.env.VICTOR_API_KEY;
    if (!expected || key !== expected) {
      return res.status(401).json({ error: 'Accès non autorisé — ?key=VICTOR_API_KEY requis' });
    }
    next();
  });

  app.use('/admin/queues', serverAdapter.getRouter());

  console.log('📊 Bull Board monté sur /admin/queues');
}
