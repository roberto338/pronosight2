// ══════════════════════════════════════════════
// nexus/projects.js — Multi-project manager
// Static config + daily briefing + weekly report
// ══════════════════════════════════════════════

export const PROJECTS = {
  pronosight: {
    name:        'PronoSight v5',
    url:         'https://pronosight2.onrender.com',
    stack:       ['Node.js', 'PostgreSQL', 'Render', 'Claude'],
    status:      'active',
    monitor:     true,
    weeklyReport: true,
    description: 'Système multi-agents IA pour pronostics sportifs',
  },
  metafiction: {
    name:        'MÉTAFICTION',
    url:         null,
    stack:       ['React Native', 'Expo', 'Node.js'],
    status:      'in-development',
    monitor:     false,
    weeklyReport: true,
    description: 'Application mobile de fiction interactive',
  },
  nutriplan: {
    name:        'NutriPlan AI',
    url:         'https://nutriplan-ai-w6nc.polsia.app',
    stack:       ['Polsia', 'OpenAI'],
    status:      'active',
    monitor:     true,
    weeklyReport: true,
    description: 'Application de planification nutritionnelle IA',
  },
  nexus: {
    name:        'Nexus',
    url:         'https://pronosight2.onrender.com/nexus/dashboard',
    stack:       ['Node.js', 'BullMQ', 'Redis', 'Claude'],
    status:      'active',
    monitor:     true,
    weeklyReport: false,
    description: 'Système IA autonome multi-agents',
  },
  fruityArena: {
    name:        'Fruity Arena',
    url:         null,
    stack:       ['ElevenLabs', 'Kling AI', 'Remotion'],
    status:      'in-production',
    monitor:     false,
    weeklyReport: true,
    description: 'Jeux de casino en production vidéo IA',
  },
};

const STATUS_ICONS = {
  'active':         '✅',
  'in-development': '🔨',
  'in-production':  '🎬',
  'paused':         '⏸',
  'archived':       '📦',
};

/**
 * Generate the daily morning briefing.
 * Called every day at 08:00 by cron.
 */
export async function generateDailyBriefing() {
  const { query }       = await import('../db/database.js');
  const { listMemories } = await import('./lib/longTermMemory.js');

  // Queue + task stats
  const { rows: qStats } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')                        AS pending,
      COUNT(*) FILTER (WHERE status = 'running')                        AS running,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h' AND status = 'done') AS done24h,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h' AND status = 'failed') AS failed24h
    FROM nexus_tasks
  `).catch(() => ({ rows: [{}] }));

  // Active goals
  const { rows: goals } = await query(
    `SELECT title, progress, deadline FROM nexus_goals WHERE status = 'active' ORDER BY deadline ASC NULLS LAST LIMIT 5`
  ).catch(() => ({ rows: [] }));

  // Memory stats
  const { rows: memRows } = await query(
    `SELECT COUNT(*)::int AS total FROM nexus_ltm WHERE confidence > 0`
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const mems      = await listMemories(null).catch(() => []);
  const lastMem   = mems.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))[0];
  const q         = qStats[0] || {};
  const date      = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  // Project status line
  const projectLine = Object.values(PROJECTS)
    .map(p => `${STATUS_ICONS[p.status] || '◦'} ${p.name}`)
    .join('\n');

  // Goals section
  const goalLines = goals.length > 0
    ? goals.map(g => {
        const filled   = Math.round(g.progress / 10);
        const bar      = '█'.repeat(filled) + '░'.repeat(10 - filled);
        const deadline = g.deadline
          ? ` _${new Date(g.deadline).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}_`
          : '';
        return `• *${g.title}*${deadline}: ${g.progress}% ${bar}`;
      }).join('\n')
    : '_Aucun objectif actif. Utilise /goal pour en ajouter._';

  return (
    `☀️ *Nexus Daily Briefing*\n_${date}_\n${'━'.repeat(22)}\n\n` +
    `📊 *Projets:*\n${projectLine}\n\n` +
    `🎯 *Objectifs:*\n${goalLines}\n\n` +
    `⚙️ *Activité 24h:* ${q.done24h || 0} tâches ✅ | ${q.failed24h || 0} ❌ | ${q.pending || 0} en attente\n` +
    `🧠 *Mémoire:* ${memRows[0]?.total || 0} entrées${lastMem ? ` | _Dernière: ${lastMem.value.slice(0, 50)}_` : ''}\n\n` +
    `${'━'.repeat(22)}\n_Envoie n'importe quel message — Jarvis s'en occupe_`
  );
}

/**
 * Generate the weekly project report (Monday 08:00).
 * Research + 3 actions per active project.
 */
export async function generateWeeklyProjectReport() {
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN_ID) return;

  const { sendNexusMessage }  = await import('./telegramHandler.js');
  const { runResearch }       = await import('./agents/researchAgent.js');
  const { callAI }            = await import('./lib/ai.js');

  const reportable = Object.values(PROJECTS).filter(p => p.weeklyReport);
  const date       = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

  await sendNexusMessage(ADMIN_ID, `📋 *Rapport hebdo Projets — ${date}*\n⏳ Analyse en cours...`);

  let fullReport = `📋 *Rapport Hebdo — ${date}*\n${'━'.repeat(22)}\n\n`;

  for (const project of reportable) {
    try {
      const research = await runResearch({
        input: `Actualités, tendances et opportunités cette semaine pour: ${project.description}. Stack: ${project.stack.join(', ')}. Concurrents notables, nouvelles features similaires, opportunités à saisir.`,
        meta:  { chatId: null },
      });

      const actions = await callAI(
        'Tu es un consultant produit. Donne exactement 3 actions concrètes et courtes en bullet points, basées sur la recherche. Chaque action: max 1 ligne.',
        `Projet: ${project.name}\nStatut: ${project.status}\nRecherche: ${research.output.slice(0, 800)}`,
        { maxTokens: 300, temperature: 0.4 }
      );

      fullReport +=
        `${STATUS_ICONS[project.status] || '◦'} *${project.name}*\n` +
        `${research.output.slice(0, 350)}...\n\n` +
        `🎯 *Actions:*\n${actions.slice(0, 300)}\n\n` +
        `${'─'.repeat(18)}\n\n`;
    } catch (err) {
      fullReport += `${STATUS_ICONS[project.status] || '◦'} *${project.name}*: ❌ ${err.message}\n\n`;
    }
  }

  // Send in chunks if too long
  const chunks = [];
  let remaining = fullReport;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 3800));
    remaining = remaining.slice(3800);
  }
  for (const chunk of chunks) {
    await sendNexusMessage(ADMIN_ID, chunk);
    await new Promise(r => setTimeout(r, 500));
  }
}
