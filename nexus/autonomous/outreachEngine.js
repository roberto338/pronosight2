// ══════════════════════════════════════════════
// nexus/autonomous/outreachEngine.js
// Find prospects + run personalized email campaigns
// via Brevo transactional API.
// ══════════════════════════════════════════════

import { runResearch } from '../agents/researchAgent.js';
import { runWrite    } from '../agents/writeAgent.js';
import { query }       from '../../db/database.js';
import fetch           from 'node-fetch';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Prospect parsing ─────────────────────────────

function parseProspectsFromText(text, count) {
  const prospects = [];
  const lines     = text.split('\n').filter(l => l.trim());

  for (const line of lines) {
    if (prospects.length >= count) break;
    const emailMatch = line.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    const nameMatch  = line.match(/^[-*•\d.]+\s*([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+){1,3})/);
    if (nameMatch || emailMatch) {
      prospects.push({
        name:      nameMatch ? nameMatch[1].trim() : 'Prospect',
        email:     emailMatch ? emailMatch[0] : null,
        platform:  line.toLowerCase().includes('linkedin') ? 'linkedin' : 'email',
        context:   line.trim().slice(0, 200),
        relevance: 'medium',
      });
    }
  }
  return prospects;
}

// ── Find prospects ────────────────────────────────

export async function findProspects(target, count = 10) {
  try {
    const { output } = await runResearch({
      input: `Trouve ${count} prospects réels pour: "${target}". Pour chaque: nom complet, email si disponible, plateforme (LinkedIn/email/Twitter), contexte pertinent. Format liste numérotée.`,
      meta:  { task: 'prospect_research', target, count },
    });
    return parseProspectsFromText(output, count);
  } catch (err) {
    console.error('[OutreachEngine] findProspects error:', err.message);
    return [];
  }
}

// ── Personalize email ─────────────────────────────

export async function personalizeEmail(prospect, campaignContext) {
  const { output } = await runWrite({
    input: `Rédige un email de prospection froide personnalisé.\n\nProspect: ${prospect.name}\nContexte: ${prospect.context}\nCampagne: ${campaignContext}\n\nFormat:\nSUJET: [objet accrocheur]\nCORPS:\n[email 150-200 mots, ton humain et direct]`,
    meta:  { task: 'cold_email', prospect: prospect.name },
  });

  const subjectMatch = output.match(/SUJET:\s*(.+)/i);
  const bodyMatch    = output.match(/CORPS:\s*([\s\S]+)/i);

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : `Opportunité pour ${prospect.name}`,
    body:    bodyMatch    ? bodyMatch[1].trim()    : output,
  };
}

// ── Send via Brevo ────────────────────────────────

export async function sendViaBrevo(prospect, subject, body, campaignName) {
  // Always insert to DB first
  const { rows } = await query(
    `INSERT INTO nexus_outreach (campaign, email, name, context, status)
     VALUES ($1, $2, $3, $4, 'queued') RETURNING id`,
    [campaignName.slice(0, 100), prospect.email || null, prospect.name, prospect.context?.slice(0, 500) || null]
  );
  const outreachId = rows[0].id;

  if (!process.env.BREVO_API_KEY) {
    console.warn('[OutreachEngine] BREVO_API_KEY absent — send skipped');
    return { outreachId, messageId: null };
  }
  if (!prospect.email) {
    await query(`UPDATE nexus_outreach SET status='skipped_no_email' WHERE id=$1`, [outreachId]);
    return { outreachId, messageId: null };
  }

  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sender: { name: process.env.BREVO_SENDER_NAME || 'Roberto', email: process.env.BREVO_SENDER_EMAIL || 'nexus@nexus-ai.app' },
        to:     [{ email: prospect.email, name: prospect.name }],
        subject,
        textContent: body,
      }),
    });
    const data      = await resp.json();
    const messageId = data.messageId || null;

    await query(
      `UPDATE nexus_outreach SET status='sent', brevo_msg_id=$1, sent_at=NOW() WHERE id=$2`,
      [messageId, outreachId]
    );
    return { outreachId, messageId };
  } catch (err) {
    console.error('[OutreachEngine] sendViaBrevo error:', err.message);
    await query(`UPDATE nexus_outreach SET status='failed' WHERE id=$1`, [outreachId]);
    return { outreachId, messageId: null };
  }
}

// ── Schedule follow-up ────────────────────────────

export async function scheduleFollowUp(outreachId, days) {
  await query(
    `UPDATE nexus_outreach SET follow_up_at = NOW() + ($1 || ' days')::INTERVAL WHERE id=$2`,
    [String(parseInt(days, 10)), outreachId]
  );
}

// ── Full campaign ─────────────────────────────────

export async function runOutreachCampaign(target, campaignMessage, count = 10) {
  const prospects = await findProspects(target, count);
  const results   = [];

  for (const prospect of prospects) {
    const { subject, body }          = await personalizeEmail(prospect, campaignMessage);
    const { outreachId, messageId }  = await sendViaBrevo(prospect, subject, body, campaignMessage.slice(0, 80));

    if (outreachId) await scheduleFollowUp(outreachId, 5);
    results.push({ prospect: prospect.name, email: prospect.email, outreachId, messageId, sent: !!messageId });

    await sleep(30_000); // 30s between sends
  }

  const sent = results.filter(r => r.sent).length;
  return {
    total:   results.length,
    sent,
    skipped: results.length - sent,
    summary: `Campagne "${campaignMessage.slice(0, 60)}" — ${sent}/${results.length} emails envoyés.`,
  };
}

// ── Pipeline entry point (from decisionEngine) ───

export async function outreachPipeline(decision) {
  const analysis = typeof decision.analysis === 'string'
    ? decision.analysis : JSON.stringify(decision.analysis || '');
  const target   = analysis.slice(0, 200) || 'entrepreneurs SaaS francophones';
  return runOutreachCampaign(target, analysis, 5);
}

// ── Cron: run follow-ups for due contacts ─────────

export async function runFollowUps() {
  const { rows } = await query(
    `SELECT * FROM nexus_outreach WHERE status='sent' AND follow_up_at <= NOW()`
  );
  const results = [];

  for (const row of rows) {
    const prospect     = { name: row.name, email: row.email, platform: 'email', context: row.context || '' };
    const { subject, body } = await personalizeEmail(prospect, `Relance — ${row.campaign}`);
    const { messageId }     = await sendViaBrevo(prospect, `Re: ${subject}`, body, row.campaign);
    await query(`UPDATE nexus_outreach SET status='followed_up' WHERE id=$1`, [row.id]);
    results.push({ outreachId: row.id, sent: !!messageId });
  }

  return { followUpsSent: results.filter(r => r.sent).length, total: rows.length };
}
