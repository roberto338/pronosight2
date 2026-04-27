// ══════════════════════════════════════════════
// nexus/dashboard.js — Nexus v2.0 Dashboard
// Served at GET /nexus/dashboard
// ══════════════════════════════════════════════

import { PROJECTS } from './projects.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtAgo(d) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  if (s < 60)     return `${s}s`;
  if (s < 3600)   return `${Math.round(s/60)}m`;
  if (s < 86400)  return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}j`;
}

const CAT_COLORS = { project:'#3b82f6', preference:'#a78bfa', pattern:'#34d399', person:'#fbbf24', fact:'#f87171', feedback:'#38bdf8' };
const CAT_ICONS  = { project:'📁', preference:'⚙️', pattern:'🔄', person:'👤', fact:'📌', feedback:'💬' };
const STATUS_COLORS = { active:'#34d399', 'in-development':'#fbbf24', 'in-production':'#60a5fa', paused:'#94a3b8', archived:'#4a5568' };
const STATUS_LABELS = { active:'Active', 'in-development':'En dev', 'in-production':'En prod', paused:'Pause', archived:'Archivé' };

export function renderDashboard(tasks, stats, memStats = {}, goalsRows = [], routinesRows = []) {
  const { total: memTotal = 0, countByCategory = [], recentMemories = [], topConfirmed = [] } = memStats;

  // ── Task rows ──────────────────────────────
  const taskRows = tasks.map(t => `
    <tr>
      <td style="color:#64748b;font-size:.75rem">#${t.id}</td>
      <td><span class="badge badge-${esc(t.agent_type)}">${esc(t.agent_type)}</span></td>
      <td class="trunc">${esc(t.input || '')}</td>
      <td><span class="status status-${esc(t.status)}">${esc(t.status)}</span></td>
      <td style="color:#64748b;font-size:.75rem">${fmtDate(t.created_at)}</td>
      <td style="color:#64748b;font-size:.75rem">${t.completed_at ? fmtAgo(t.completed_at)+' ago' : '—'}</td>
      <td><a href="/nexus/tasks/${t.id}?key=" class="btn-sm">↗</a></td>
    </tr>`).join('');

  // ── Project cards ──────────────────────────
  const projectCards = Object.values(PROJECTS).map(p => {
    const color = STATUS_COLORS[p.status] || '#94a3b8';
    const label = STATUS_LABELS[p.status] || p.status;
    const url   = p.url ? `<a href="${esc(p.url)}" target="_blank" style="color:#64748b;font-size:.72rem;text-decoration:none">${esc(p.url.replace('https://', ''))}</a>` : '<span style="color:#4a5568;font-size:.72rem">no url</span>';
    const stack = p.stack.map(s => `<span class="stack-tag">${esc(s)}</span>`).join('');
    return `
      <div class="project-card">
        <div class="proj-header">
          <span class="proj-name">${esc(p.name)}</span>
          <span class="proj-status" style="color:${color}">${label}</span>
        </div>
        <div style="font-size:.75rem;color:#64748b;margin:4px 0">${esc(p.description)}</div>
        <div style="margin-top:6px">${stack}</div>
        <div style="margin-top:6px">${url}</div>
      </div>`;
  }).join('');

  // ── Goals rows ─────────────────────────────
  const goalRows = goalsRows.map(g => {
    const bar = `<div class="prog-bar"><div class="prog-fill" style="width:${g.progress}%"></div></div>`;
    const dl  = g.deadline ? new Date(g.deadline).toLocaleDateString('fr-FR', { day:'numeric', month:'short' }) : '—';
    return `<tr>
      <td style="color:#64748b;font-size:.75rem">#${g.id}</td>
      <td style="color:#e2e8f0">${esc(g.title)}</td>
      <td>${bar} <span style="color:#94a3b8;font-size:.72rem">${g.progress}%</span></td>
      <td style="color:#64748b;font-size:.75rem">${dl}</td>
      <td><span class="status status-${esc(g.status)}">${esc(g.status)}</span></td>
    </tr>`;
  }).join('');

  // ── Routine rows ───────────────────────────
  const routineRows = routinesRows.map(r => `
    <tr>
      <td style="color:#64748b;font-size:.75rem">#${r.id}</td>
      <td style="color:#e2e8f0">${esc(r.name)}</td>
      <td style="font-family:monospace;font-size:.72rem;color:#a78bfa">${esc(r.cron_expression)}</td>
      <td><span class="badge badge-${esc(r.task_type)}">${esc(r.task_type)}</span></td>
      <td>${r.active ? '<span style="color:#34d399">🟢 active</span>' : '<span style="color:#f87171">🔴 stopped</span>'}</td>
      <td style="color:#64748b;font-size:.75rem">${r.last_run ? fmtAgo(r.last_run)+' ago' : 'never'}</td>
    </tr>`).join('');

  // ── Memory pills ───────────────────────────
  const catPills = countByCategory.map(c => {
    const color = CAT_COLORS[c.category] || '#94a3b8';
    const icon  = CAT_ICONS[c.category]  || '▸';
    return `<span class="cat-pill" style="border-color:${color};color:${color}">${icon} ${c.category} <b>${c.count}</b></span>`;
  }).join('');

  const recentMemRows = recentMemories.map(m => {
    const color = CAT_COLORS[m.category] || '#94a3b8';
    return `<tr>
      <td style="color:${color};font-size:.72rem">${CAT_ICONS[m.category] || '▸'} ${esc(m.category)}</td>
      <td style="color:#a78bfa;font-family:monospace;font-size:.78rem">${esc(m.key)}</td>
      <td class="trunc" style="max-width:260px;color:#94a3b8">${esc(m.value)}</td>
      <td style="color:#64748b;text-align:center">${m.times_confirmed}×</td>
      <td style="color:#64748b;font-size:.72rem">${fmtAgo(m.last_seen)} ago</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus v2.0 — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0c14;color:#e2e8f0;min-height:100vh}
a{color:inherit;text-decoration:none}

/* Header */
header{background:#111420;padding:14px 24px;border-bottom:1px solid #1e2535;display:flex;align-items:center;gap:12px}
header .logo{font-size:1.3rem;font-weight:800;color:#a78bfa;letter-spacing:-.02em}
header .ver{background:#a78bfa22;color:#a78bfa;font-size:.65rem;padding:2px 7px;border-radius:10px;font-weight:700;letter-spacing:.06em}
header .sub{margin-left:auto;font-size:.72rem;color:#4a5568}
.refresh-bar{display:flex;justify-content:flex-end;padding:8px 24px 0;font-size:.72rem}
.refresh-bar a{color:#a78bfa}

/* Stats grid */
.stat-grid{display:flex;gap:10px;padding:16px 24px;flex-wrap:wrap}
.stat{background:#111420;border:1px solid #1e2535;border-radius:10px;padding:12px 18px;min-width:110px;flex:1}
.stat.accent{border-color:#a78bfa33}
.stat .lbl{font-size:.65rem;color:#4a5568;text-transform:uppercase;letter-spacing:.1em}
.stat .val{font-size:1.75rem;font-weight:800;margin-top:2px}

/* Sections */
.section{padding:0 24px 28px}
.section h2{font-size:.7rem;color:#4a5568;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;padding-top:4px}

/* Projects grid */
.proj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:4px}
.project-card{background:#111420;border:1px solid #1e2535;border-radius:10px;padding:12px 14px}
.proj-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
.proj-name{font-size:.85rem;font-weight:700;color:#e2e8f0}
.proj-status{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.stack-tag{background:#1e2535;color:#64748b;font-size:.65rem;padding:2px 6px;border-radius:4px;margin-right:3px;margin-top:2px;display:inline-block}

/* Tables */
table{width:100%;border-collapse:collapse;background:#111420;border-radius:10px;overflow:hidden;font-size:.82rem}
th{background:#0d0f1a;padding:8px 12px;text-align:left;font-size:.65rem;color:#4a5568;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #1e2535}
td{padding:8px 12px;border-top:1px solid #151924}
.trunc{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8}

/* Badges */
.badge{padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:700}
.badge-research{background:#1e3a5f;color:#60a5fa}.badge-write{background:#1a3a2f;color:#34d399}
.badge-code{background:#3a1f1a;color:#f87171}.badge-monitor{background:#3a2f1a;color:#fbbf24}
.badge-notify{background:#2d1a3a;color:#c084fc}.badge-custom{background:#1a2d3a;color:#38bdf8}
.badge-radar{background:#1a3a1a;color:#4ade80}.badge-planner{background:#3a1a3a;color:#f0abfc}
.badge-exec{background:#3a2a1a;color:#fb923c}.badge-api{background:#1a3a3a;color:#22d3ee}
.badge-browser{background:#2a1a3a;color:#c4b5fd}.badge-finance{background:#1a2a1a;color:#86efac}
.badge-business{background:#3a1a1a;color:#fca5a5}.badge-vision{background:#1a1a3a;color:#818cf8}

/* Status */
.status{padding:2px 7px;border-radius:10px;font-size:.68rem;font-weight:700}
.status-done{background:#1a3a2f;color:#34d399}.status-running{background:#1e3a5f;color:#60a5fa}
.status-pending{background:#1e2535;color:#64748b}.status-failed{background:#3a1f1a;color:#f87171}
.status-active{background:#1a3a2f;color:#34d399}.status-abandoned{background:#3a1f1a;color:#f87171}

.btn-sm{padding:2px 8px;background:#1e2535;color:#94a3b8;border-radius:4px;font-size:.7rem}
.btn-sm:hover{background:#2d3748;color:#e2e8f0}

/* Progress bar */
.prog-bar{display:inline-block;width:80px;height:6px;background:#1e2535;border-radius:3px;vertical-align:middle;margin-right:6px}
.prog-fill{height:100%;background:#a78bfa;border-radius:3px}

/* Memory */
.cat-pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.cat-pill{padding:3px 10px;border-radius:12px;border:1px solid;font-size:.73rem;font-weight:600}

/* Divider */
hr{border:none;border-top:1px solid #1e2535;margin:0 0 20px}
</style>
</head>
<body>

<header>
  <span style="font-size:1.4rem">🤖</span>
  <span class="logo">NEXUS</span>
  <span class="ver">v2.0</span>
  <span class="sub">Autonomous AI system — ${new Date().toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</span>
</header>

<!-- Stats -->
<div class="stat-grid">
  <div class="stat"><div class="lbl">Total tâches</div><div class="val" style="color:#a78bfa">${stats.total||0}</div></div>
  <div class="stat"><div class="lbl">Terminées</div><div class="val" style="color:#34d399">${stats.done||0}</div></div>
  <div class="stat"><div class="lbl">En cours</div><div class="val" style="color:#60a5fa">${stats.running||0}</div></div>
  <div class="stat"><div class="lbl">En attente</div><div class="val" style="color:#94a3b8">${stats.pending||0}</div></div>
  <div class="stat"><div class="lbl">Échouées</div><div class="val" style="color:#f87171">${stats.failed||0}</div></div>
  <div class="stat accent"><div class="lbl">🧠 Mémoires</div><div class="val" style="color:#a78bfa">${memTotal}</div></div>
  <div class="stat accent"><div class="lbl">🎯 Objectifs</div><div class="val" style="color:#34d399">${goalsRows.length}</div></div>
  <div class="stat accent"><div class="lbl">⚙️ Routines</div><div class="val" style="color:#fbbf24">${routinesRows.filter(r=>r.active).length}</div></div>
</div>

<div class="refresh-bar"><a href="/nexus/dashboard">↻ Rafraîchir</a></div>

<!-- Projects -->
<div class="section" style="padding-top:16px">
  <h2>📊 Projets actifs</h2>
  <div class="proj-grid">${projectCards}</div>
</div>

<!-- Goals -->
${goalsRows.length > 0 ? `
<div class="section">
  <h2>🎯 Objectifs</h2>
  <table>
    <thead><tr><th>#</th><th>Titre</th><th>Progression</th><th>Deadline</th><th>Statut</th></tr></thead>
    <tbody>${goalRows || '<tr><td colspan="5" style="text-align:center;color:#4a5568;padding:20px">Aucun objectif</td></tr>'}</tbody>
  </table>
</div>` : ''}

<!-- Routines -->
${routinesRows.length > 0 ? `
<div class="section">
  <h2>⚙️ Routines automatiques</h2>
  <table>
    <thead><tr><th>#</th><th>Nom</th><th>Cron</th><th>Agent</th><th>Statut</th><th>Dernière run</th></tr></thead>
    <tbody>${routineRows}</tbody>
  </table>
</div>` : ''}

<!-- Tasks -->
<div class="section">
  <h2>📋 50 dernières tâches</h2>
  <table>
    <thead><tr><th>#</th><th>Agent</th><th>Input</th><th>Statut</th><th>Créée</th><th>Terminée</th><th></th></tr></thead>
    <tbody>${taskRows || '<tr><td colspan="7" style="text-align:center;color:#4a5568;padding:28px">Aucune tâche</td></tr>'}</tbody>
  </table>
</div>

<!-- Long-term Memory -->
<div class="section">
  <h2>🧠 Mémoire long terme</h2>
  ${catPills ? `<div class="cat-pills">${catPills}</div>` : '<p style="color:#4a5568;font-size:.8rem;margin-bottom:14px">Vide — se remplit au fil des tâches</p>'}
  ${recentMemories.length > 0 ? `
  <table>
    <thead><tr><th>Catégorie</th><th>Clé</th><th>Valeur</th><th>Vues</th><th>Il y a</th></tr></thead>
    <tbody>${recentMemRows}</tbody>
  </table>` : ''}
</div>

</body></html>`;
}
