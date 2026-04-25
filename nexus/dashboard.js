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

const CAT_ICONS = { project:'📁', preference:'⚙️', pattern:'🔄', person:'👤', fact:'📌', feedback:'💬' };
const CAT_COLORS = {
  project:    '#3b82f6',
  preference: '#a78bfa',
  pattern:    '#34d399',
  person:     '#fbbf24',
  fact:       '#f87171',
  feedback:   '#38bdf8',
};

export function renderDashboard(tasks, stats, memStats = {}) {
  const { total: memTotal = 0, countByCategory = [], recentMemories = [], topConfirmed = [] } = memStats;

  // ── Task rows ──────────────────────────────────
  const taskRows = tasks.map(t => `
    <tr>
      <td style="color:#64748b">#${t.id}</td>
      <td><span class="badge badge-${escHtml(t.agent_type)}">${escHtml(t.agent_type)}</span></td>
      <td class="trunc">${escHtml(t.input || '')}</td>
      <td><span class="status status-${escHtml(t.status)}">${escHtml(t.status)}</span></td>
      <td style="color:#64748b">${fmtDate(t.created_at)}</td>
      <td style="color:#64748b">${fmtDate(t.completed_at)}</td>
      <td><a href="/nexus/tasks/${t.id}?key=" class="btn-sm">↗</a></td>
    </tr>`).join('');

  // ── Memory category pills ──────────────────────
  const catPills = countByCategory.map(c => {
    const color = CAT_COLORS[c.category] || '#94a3b8';
    const icon  = CAT_ICONS[c.category] || '▸';
    return `<span class="cat-pill" style="border-color:${color};color:${color}">${icon} ${c.category} <b>${c.count}</b></span>`;
  }).join('');

  // ── Recent memories table ─────────────────────
  const recentRows = recentMemories.map(m => {
    const color = CAT_COLORS[m.category] || '#94a3b8';
    const icon  = CAT_ICONS[m.category]  || '▸';
    return `<tr>
      <td><span style="color:${color};font-size:.75rem">${icon} ${escHtml(m.category)}</span></td>
      <td style="color:#a78bfa;font-size:.8rem;font-family:monospace">${escHtml(m.key)}</td>
      <td class="trunc" style="max-width:280px;color:#94a3b8">${escHtml(m.value)}</td>
      <td style="color:#64748b;text-align:center">${m.times_confirmed}×</td>
      <td style="color:#64748b">${fmtDate(m.last_seen)}</td>
    </tr>`;
  }).join('');

  // ── Top confirmed memories ─────────────────────
  const topRows = topConfirmed.map(m => {
    const color = CAT_COLORS[m.category] || '#94a3b8';
    return `<tr>
      <td style="color:${color};font-size:.75rem">${CAT_ICONS[m.category] || '▸'} ${escHtml(m.category)}</td>
      <td style="color:#a78bfa;font-family:monospace;font-size:.8rem">${escHtml(m.key)}</td>
      <td class="trunc" style="color:#e2e8f0">${escHtml(m.value)}</td>
      <td style="color:#34d399;text-align:center;font-weight:700">${m.times_confirmed}×</td>
    </tr>`;
  }).join('');

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
.card.accent{border-color:#a78bfa33}
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
.badge-radar{background:#1a3a1a;color:#4ade80}
.badge-planner{background:#3a1a3a;color:#f0abfc}
.badge-exec{background:#3a2a1a;color:#fb923c}
.badge-api{background:#1a3a3a;color:#22d3ee}
.badge-browser{background:#2a1a3a;color:#c4b5fd}
.badge-finance{background:#1a2a1a;color:#86efac}
.status{padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700}
.status-done{background:#1a3a2f;color:#34d399}
.status-running{background:#1e3a5f;color:#60a5fa}
.status-pending{background:#1e2332;color:#64748b}
.status-failed{background:#3a1f1a;color:#f87171}
.btn-sm{padding:2px 8px;background:#2d3748;color:#94a3b8;border-radius:4px;text-decoration:none;font-size:.72rem}
.btn-sm:hover{background:#4a5568;color:#e2e8f0}
.refresh{text-align:right;padding:6px 24px 12px;font-size:.75rem}
.refresh a{color:#a78bfa;text-decoration:none}
.cat-pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.cat-pill{padding:3px 10px;border-radius:12px;border:1px solid;font-size:.75rem;font-weight:600}
.mem-divider{border:none;border-top:1px solid #2d3748;margin:0 0 20px}
</style>
</head>
<body>
<header>
  <span style="font-size:1.4rem">🤖</span>
  <h1>NEXUS</h1>
  <span class="sub">Multi-agent system — Dashboard</span>
</header>

<!-- ── Task stats ── -->
<div class="stats">
  <div class="card"><div class="lbl">Total tâches</div><div class="val" style="color:#a78bfa">${stats.total||0}</div></div>
  <div class="card"><div class="lbl">Terminées</div><div class="val" style="color:#34d399">${stats.done||0}</div></div>
  <div class="card"><div class="lbl">En cours</div><div class="val" style="color:#60a5fa">${stats.running||0}</div></div>
  <div class="card"><div class="lbl">En attente</div><div class="val" style="color:#64748b">${stats.pending||0}</div></div>
  <div class="card"><div class="lbl">Échouées</div><div class="val" style="color:#f87171">${stats.failed||0}</div></div>
  <div class="card accent"><div class="lbl">🧠 Mémoires</div><div class="val" style="color:#a78bfa">${memTotal}</div></div>
</div>

<p class="refresh"><a href="/nexus/dashboard">↻ Rafraîchir</a></p>

<!-- ── Tasks table ── -->
<div class="section">
  <h2>50 dernières tâches</h2>
  <table>
    <thead><tr><th>#</th><th>Agent</th><th>Input</th><th>Statut</th><th>Créée</th><th>Terminée</th><th></th></tr></thead>
    <tbody>${taskRows || '<tr><td colspan="7" style="text-align:center;color:#4a5568;padding:32px">Aucune tâche enregistrée</td></tr>'}</tbody>
  </table>
</div>

<!-- ── Long-term Memory section ── -->
<div class="section">
  <h2>🧠 Mémoire long terme</h2>
  ${catPills ? `<div class="cat-pills">${catPills}</div>` : '<p style="color:#4a5568;font-size:.8rem;margin-bottom:14px">Aucune mémoire — se remplit au fil des tâches</p>'}

  ${topConfirmed.length > 0 ? `
  <p style="font-size:.72rem;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Plus confirmées</p>
  <table style="margin-bottom:20px">
    <thead><tr><th>Catégorie</th><th>Clé</th><th>Valeur</th><th>Confirmations</th></tr></thead>
    <tbody>${topRows}</tbody>
  </table>` : ''}

  ${recentMemories.length > 0 ? `
  <p style="font-size:.72rem;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Dernières apprises</p>
  <table>
    <thead><tr><th>Catégorie</th><th>Clé</th><th>Valeur</th><th>Vues</th><th>Dernière fois</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table>` : ''}
</div>

</body></html>`;
}
