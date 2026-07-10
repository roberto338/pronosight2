// ══════════════════════════════════════════════
// admin/queueDashboard.js — État de la file Victor
// Remplace Bull Board (BullMQ supprimé). /admin/queues
// Protégé par VICTOR_API_KEY (?key= ou x-admin-key)
// ══════════════════════════════════════════════

import { getQueueCounts, getRecentJobs } from '../queues/victorQueue.js';

export function setupQueueDashboard(app) {
  app.get('/admin/queues', async (req, res) => {
    const key = req.query.key || req.headers['x-admin-key'];
    const expected = process.env.VICTOR_API_KEY;
    if (!expected || key !== expected) {
      return res.status(401).json({ error: 'Accès non autorisé — ?key=VICTOR_API_KEY requis' });
    }

    try {
      const [counts, jobs] = await Promise.all([getQueueCounts(), getRecentJobs(30)]);
      if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
        return res.json({ backend: 'postgres', counts, jobs });
      }

      const badge = (s) => ({
        pending: '#f59e0b', running: '#3b82f6', done: '#10b981', failed: '#ef4444',
      }[s] || '#6b7280');

      const rows = jobs.map((j) => `
        <tr>
          <td>#${j.id}</td>
          <td><b>${j.name}</b></td>
          <td><span style="color:${badge(j.status)}">●</span> ${j.status}</td>
          <td>${j.progress}%</td>
          <td>${j.attempts}</td>
          <td>${j.created_at ? new Date(j.created_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : ''}</td>
          <td style="color:#ef4444">${j.error ? String(j.error).slice(0, 80) : ''}</td>
        </tr>`).join('');

      res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Victor — File PostgreSQL</title>
        <style>
          body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px}
          table{border-collapse:collapse;width:100%;font-size:14px}
          td,th{padding:6px 10px;border-bottom:1px solid #1e293b;text-align:left}
          .counts span{margin-right:18px;font-size:15px}
        </style></head><body>
        <h2>🎙️ Victor — File PostgreSQL (victor_jobs)</h2>
        <p class="counts">
          <span>⏳ pending: <b>${counts.pending}</b></span>
          <span>⚙️ running: <b>${counts.running}</b></span>
          <span>✅ done: <b>${counts.done}</b></span>
          <span>❌ failed: <b>${counts.failed}</b></span>
        </p>
        <table><tr><th>ID</th><th>Job</th><th>Statut</th><th>Progress</th><th>Essais</th><th>Créé</th><th>Erreur</th></tr>
        ${rows}</table>
        <p style="color:#64748b;margin-top:16px">Rafraîchir la page pour mettre à jour — ?format=json pour l'API</p>
        </body></html>`);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('📊 Dashboard file Victor monté sur /admin/queues');
}
