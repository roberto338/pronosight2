// ══════════════════════════════════════════════
// nexus/autonomous/contentEngine.js
// Generates and schedules content for Roberto's
// projects across LinkedIn, Twitter, TikTok, Blog.
// ══════════════════════════════════════════════

import { runWrite } from '../agents/writeAgent.js';
import { query }    from '../../db/database.js';
import fetch        from 'node-fetch';

const PROJECTS = ['PronoSight', 'MÉTAFICTION', 'NutriPlan AI', 'Nexus', 'Fruity Arena'];

const FORMAT_INSTRUCTIONS = {
  linkedin:  'Rédige un post LinkedIn professionnel de 800-1200 caractères en français. Ton expert, accroche forte, insights concrets, CTA final. Max 3 hashtags.',
  twitter:   'Rédige un thread Twitter de 5-7 tweets en français. Premier tweet = accroche percutante < 280 chars. Numérote (1/, 2/...). Dernier tweet = CTA.',
  tiktok:    'Rédige un script vidéo TikTok 60 secondes en français. [HOOK 0-3s] accorche choc. [CONTENU 3-50s] 3 points clés rythmés. [CTA 50-60s] appel direct. Actions caméra entre crochets.',
  blog:      'Rédige un article SEO de 1200 mots en français. Structure: H1 accrocheur, intro avec mot-clé, 3-4 sections H2, conclusion avec CTA. Optimisé référencement.',
  instagram: 'Rédige une légende Instagram en français: 150-200 mots engageants, question finale pour commentaires, puis 10 hashtags pertinents.',
};

async function sendAdmin(msg) {
  const ADMIN = process.env.TELEGRAM_ADMIN_ID;
  if (!ADMIN) return;
  try {
    const { sendNexusMessage } = await import('../telegramHandler.js');
    await sendNexusMessage(ADMIN, msg);
  } catch { /* ignore */ }
}

// ── Generate content pieces ──────────────────────

export async function generateContent(project, topic, formats) {
  const results = { contentIds: [] };

  for (const format of formats) {
    const instruction = FORMAT_INSTRUCTIONS[format];
    if (!instruction) continue;

    try {
      const { output } = await runWrite({
        input: `Projet: ${project}\nSujet: ${topic}\n\nInstructions: ${instruction}`,
        meta:  { project, topic, format, platform: format },
      });

      const platform = format === 'blog' ? 'website' : format;
      const { rows } = await query(
        `INSERT INTO nexus_content (project, format, topic, content, platform, status)
         VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING id`,
        [project, format, topic, output, platform]
      );

      results[format]       = output;
      results.contentIds.push(rows[0].id);
    } catch (err) {
      console.error(`[ContentEngine] Error format ${format}:`, err.message);
    }
  }

  return results;
}

// ── Schedule via Buffer API ──────────────────────

export async function scheduleViaBuffer(contentId, platform, text, scheduledAt) {
  if (!process.env.BUFFER_TOKEN) {
    await query(`UPDATE nexus_content SET status='pending_manual' WHERE id=$1`, [contentId]);
    return null;
  }

  const profileIds = (process.env.BUFFER_PROFILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const params = new URLSearchParams();
  params.append('text', text.slice(0, 500));
  params.append('scheduled_at', Math.floor(new Date(scheduledAt).getTime() / 1000).toString());
  for (const id of profileIds) params.append('profile_ids[]', id);
  params.append('access_token', process.env.BUFFER_TOKEN);

  try {
    const resp = await fetch('https://api.bufferapp.com/1/updates/create.json', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const data      = await resp.json();
    const bufferId  = data.updates?.[0]?.id || data.id || null;

    await query(
      `UPDATE nexus_content SET buffer_post_id=$1, status='scheduled', scheduled_at=$2 WHERE id=$3`,
      [bufferId, scheduledAt, contentId]
    );
    return data;
  } catch (err) {
    console.error('[ContentEngine] scheduleViaBuffer error:', err.message);
    await query(`UPDATE nexus_content SET status='pending_manual' WHERE id=$1`, [contentId]);
    return null;
  }
}

// ── Weekly calendar generation ───────────────────

export async function generateWeeklyCalendar() {
  const calendar = [];
  const now      = new Date();
  const monday   = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));

  // Mon/Wed/Fri LinkedIn posts — cycle projects
  for (let i = 0; i < 3; i++) {
    const project = PROJECTS[i % PROJECTS.length];
    const topic   = `Actualité et insights ${project}`;
    const day     = new Date(monday);
    day.setDate(monday.getDate() + [0, 2, 4][i]);
    const result = await generateContent(project, topic, ['linkedin']);
    calendar.push({ format: 'linkedin', project, topic, scheduledDay: day, ...result });
  }

  // 1x Twitter thread
  const twProject = PROJECTS[0];
  const twResult  = await generateContent(twProject, `Thread hebdomadaire ${twProject}`, ['twitter']);
  calendar.push({ format: 'twitter', project: twProject, ...twResult });

  // 2x TikTok scripts
  for (let i = 0; i < 2; i++) {
    const project = PROJECTS[(i + 1) % PROJECTS.length];
    const result  = await generateContent(project, `Idée virale ${project}`, ['tiktok']);
    calendar.push({ format: 'tiktok', project, ...result });
  }

  // 1x Blog article
  const blogProject = PROJECTS[2 % PROJECTS.length];
  const blogResult  = await generateContent(blogProject, `Article SEO ${blogProject}`, ['blog']);
  calendar.push({ format: 'blog', project: blogProject, ...blogResult });

  return calendar;
}

// ── Content pipeline (called by decisionEngine) ──

export async function contentPipeline(decision) {
  const analysisStr = typeof decision.analysis === 'string'
    ? decision.analysis
    : JSON.stringify(decision.analysis || '');

  const projectMatch = PROJECTS.find(p => analysisStr.toLowerCase().includes(p.toLowerCase()));
  const project      = projectMatch || PROJECTS[0];
  const topic        = analysisStr.slice(0, 120) || 'Contenu stratégique';

  const result = await generateContent(project, topic, ['linkedin', 'twitter']);

  // Schedule LinkedIn post in 1 hour, Twitter in 2 hours
  for (let i = 0; i < result.contentIds.length; i++) {
    const id = result.contentIds[i];
    const at = new Date(Date.now() + (i + 1) * 3600000);
    await scheduleViaBuffer(id, ['linkedin', 'twitter'][i] || 'linkedin', result[['linkedin', 'twitter'][i]] || '', at);
  }

  return {
    project,
    topic,
    contentIds: result.contentIds,
    summary: `Contenu généré pour ${project}: LinkedIn + Twitter. ${result.contentIds.length} pièces créées.`,
  };
}

// ── Send calendar to Telegram for approval ───────

export async function sendCalendarForApproval(calendar) {
  const ICONS = { linkedin: '💼', twitter: '🐦', tiktok: '🎵', blog: '📝', instagram: '📸' };
  const lines = calendar.map(item =>
    `${ICONS[item.format] || '📌'} [${item.format.toUpperCase()}] ${item.project} — ${item.topic || 'Contenu'}`
  );
  const message =
    `📅 *Calendrier éditorial — semaine à venir*\n\n${lines.join('\n')}\n\n` +
    `_${calendar.length} pièces de contenu prêtes. Toutes sauvegardées dans la DB._`;

  await sendAdmin(message);
}
