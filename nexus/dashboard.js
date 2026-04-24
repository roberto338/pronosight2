// ══════════════════════════════════════════════
// nexus/dashboard.js — Admin dashboard HTML
// Served at GET /nexus/dashboard
// ══════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function renderDashboard(tasks, stats) {
  const rows = tasks.map(t => `
    <tr>
      <td style="color:#64748b">#${t.id}</td>
      <td><span class="badge badge-${escHtml(t.agent_type)}">${escHtml(t.agent_type)}</span></td>
      <td class="trunc">${escHtml(t.input || '')}</td>
      <td><span class="status status-${escHtml(t.status)}">${escHtml(t.status)}</span></td>
      <td style="color:#64748b">${fmtDate(t.created_at)}</td>
      <td style="color:#64748b">${fmtDate(t.completed_at)}</td>
      <td><a href="/nexus/tasks/${t.id}?key=${escHtml('')}" class="btn-sm">↗</a></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
header{background:#1a1d2e;padding:14px 24px;border-bottom:1px solid #2d3748;display:flex;align-items:center;gap:10px}
header h1{font-size:1.25rem;color:#a78bfa;font-weight:700}
header span.sub{margin-left:auto;font-size:.75rem;color:#64748b}
.stats{display:flex;gap:12px;padding:20px 24px;flex-wrap:wrap}
.card{background:#1a1d2e;border:1px solid #2d3748;border-radius:8px;padding:14px 20px;min-width:120px}
.card .lbl{font-size:.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em}
.card .val{font-size:1.8rem;font-weight:700;margin-top:4px}
.section{padding:0 24px 32px}
.section h2{font-size:.8rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
table{width:100%;border-collapse:collapse;background:#1a1d2e;border-radius:8px;overflow:hidden;font-size:.83rem}
th{background:#12141f;padding:9px 12px;text-align:left;font-size:.7rem;color:#4a5568;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #2d3748}
td{padding:9px 12px;border-top:1px solid #1e2332}
.trunc{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8}
.badge{padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:700}
.badge-research{background:#1e3a5f;color:#60a5fa}
.badge-write{background:#1a3a2f;color:#34d399}
.badge-code{background:#3a1f1a;color:#f87171}
.badge-monitor{background:#3a2f1a;color:#fbbf24}
.badge-notify{background:#2d1a3a;color:#c084fc}
.badge-custom{background:#1a2d3a;color:#38bdf8}
.status{padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700}
.status-done{background:#1a3a2f;color:#34d399}
.status-running{background:#1e3a5f;color:#60a5fa}
.status-pending{background:#1e2332;color:#64748b}
.status-failed{background:#3a1f1a;color:#f87171}
.btn-sm{padding:2px 8px;background:#2d3748;color:#94a3b8;border-radius:4px;text-decoration:none;font-size:.72rem}
.btn-sm:hover{background:#4a5568;color:#e2e8f0}
.refresh{text-align:right;padding:6px 24px 12px;font-size:.75rem}
.refresh a{color:#a78bfa;text-decoration:none}
</style>
</head>
<body>
<header>
  <span style="font-size:1.4rem">🤖</span>
  <h1>NEXUS</h1>
  <span class="sub">PronoSight v4 — Multi-agent system</span>
</header>
<div class="stats">
  <div class="card"><div class="lbl">Total</div><div class="val" style="color:#a78bfa">${stats.total||0}</div></div>
  <div class="card"><div class="lbl">Terminées</div><div class="val" style="color:#34d399">${stats.done||0}</div></div>
  <div class="card"><div class="lbl">En cours</div><div class="val" style="color:#60a5fa">${stats.running||0}</div></div>
  <div class="card"><div class="lbl">En attente</div><div class="val" style="color:#64748b">${stats.pending||0}</div></div>
  <div class="card"><div class="lbl">Échouées</div><div class="val" style="color:#f87171">${stats.failed||0}</div></div>
</div>
<p class="refresh"><a href="/nexus/dashboard">↻ Rafraîchir</a></p>
<div class="section">
  <h2>50 dernières tâches</h2>
  <table>
    <thead><tr><th>#</th><th>Agent</th><th>Input</th><th>Statut</th><th>Créée</th><th>Terminée</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#4a5568;padding:32px">Aucune tâche enregistrée</td></tr>'}</tbody>
  </table>
</div>
</body></html>`;
}
