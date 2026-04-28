// ══════════════════════════════════════════════
// nexus/autonomous/revenueTracker.js
// Track revenue across all projects via Stripe.
// ══════════════════════════════════════════════

import { query }   from '../../db/database.js';
import { remember } from '../lib/longTermMemory.js';
import fetch        from 'node-fetch';

// ── Stripe helper ────────────────────────────────

function stripeAuth() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

async function stripeFetch(path, params = {}) {
  const auth = stripeAuth();
  if (!auth) return null;

  const url = new URL('https://api.stripe.com' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const resp = await fetch(url.toString(), { headers: { Authorization: auth } });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe ${path} ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Core functions ────────────────────────────────

export async function getStripeCharges(daysBack = 30, metadataProject = null) {
  if (!stripeAuth()) return [];
  try {
    const gte    = Math.floor((Date.now() - daysBack * 86_400_000) / 1000);
    const data   = await stripeFetch('/v1/charges', { 'created[gte]': gte, limit: 100 });
    let charges  = data?.data || [];
    if (metadataProject) charges = charges.filter(c => c.metadata?.project === metadataProject);
    return charges;
  } catch (err) {
    console.error('[RevenueTracker] getStripeCharges:', err.message);
    return [];
  }
}

export async function getStripeSubscriptions() {
  if (!stripeAuth()) return [];
  try {
    const data = await stripeFetch('/v1/subscriptions', { status: 'active', limit: 100 });
    return data?.data || [];
  } catch (err) {
    console.error('[RevenueTracker] getStripeSubscriptions:', err.message);
    return [];
  }
}

export function calculateMRR(subscriptions) {
  let totalCents = 0;
  for (const sub of subscriptions) {
    for (const item of sub.items?.data || []) {
      const amount        = item.price?.unit_amount || 0;
      const qty           = item.quantity || 1;
      const interval      = item.price?.recurring?.interval;
      const intervalCount = item.price?.recurring?.interval_count || 1;
      let monthly = amount * qty;
      if (interval === 'year')  monthly = (amount * qty) / 12;
      if (interval === 'week')  monthly = (amount * qty * 52) / 12;
      if (interval === 'day')   monthly = (amount * qty * 365) / 12;
      if (intervalCount > 1)    monthly = monthly / intervalCount;
      totalCents += monthly;
    }
  }
  return Math.round(totalCents) / 100;
}

export async function getRevenueByProject(daysBack = 30) {
  const charges  = await getStripeCharges(daysBack);
  const byProject = {};
  for (const c of charges) {
    if (c.status !== 'succeeded') continue;
    const project          = c.metadata?.project || 'unknown';
    byProject[project]     = (byProject[project] || 0) + c.amount / 100;
  }
  return byProject;
}

export async function syncRevenueToDb() {
  const charges  = await getStripeCharges(30);
  let newCount   = 0;
  for (const c of charges) {
    if (c.status !== 'succeeded') continue;
    const { rows: existing } = await query(
      `SELECT id FROM nexus_revenue WHERE stripe_charge_id=$1`, [c.id]
    );
    if (existing.length > 0) continue;
    await query(
      `INSERT INTO nexus_revenue (project, amount, currency, source, stripe_charge_id, stripe_customer, recorded_at)
       VALUES ($1, $2, $3, 'stripe', $4, $5, to_timestamp($6))`,
      [c.metadata?.project || 'unknown', c.amount / 100, (c.currency || 'eur').toUpperCase(), c.id, c.customer || null, c.created]
    );
    newCount++;
  }
  return newCount;
}

export async function buildRevenueReport() {
  if (!stripeAuth()) {
    return `💰 *Revenue Report*\n\n⚠️ Configurer \`STRIPE_SECRET_KEY\` pour activer le tracking.`;
  }

  try {
    const [subscriptions, charges30, byProject] = await Promise.all([
      getStripeSubscriptions(),
      getStripeCharges(30),
      getRevenueByProject(30),
    ]);

    const mrr      = calculateMRR(subscriptions);
    const success  = charges30.filter(c => c.status === 'succeeded');
    const total30  = success.reduce((s, c) => s + c.amount / 100, 0);
    const newUsers = new Set(success.map(c => c.customer)).size;

    const projectLines = Object.entries(byProject)
      .sort(([, a], [, b]) => b - a)
      .map(([p, v]) => `• **${p}**: ${v.toFixed(2)}€`)
      .join('\n') || '• Aucune donnée';

    const goal     = 1000;
    const progress = Math.min(100, Math.round((mrr / goal) * 100));

    return (
      `💰 *Revenue Update — ${new Date().toLocaleDateString('fr-FR')}*\n` +
      `${'━'.repeat(20)}\n` +
      `MRR Total: *${mrr.toFixed(2)}€*\n` +
      `Nouveaux clients: *${newUsers}*\n` +
      `Encaissé 30j: *${total30.toFixed(2)}€*\n` +
      `${'━'.repeat(20)}\n` +
      `*Par projet:*\n${projectLines}\n` +
      `${'━'.repeat(20)}\n` +
      `Objectif 1 000€ MRR: ${'█'.repeat(Math.floor(progress / 10))}${'░'.repeat(10 - Math.floor(progress / 10))} ${progress}%`
    );
  } catch (err) {
    return `💰 Revenue Report\n\n❌ Erreur: ${err.message}`;
  }
}

export async function sendDailyRevenueReport() {
  const report = await buildRevenueReport();
  const ADMIN  = process.env.TELEGRAM_ADMIN_ID;
  if (ADMIN) {
    try {
      const { sendNexusMessage } = await import('../telegramHandler.js');
      await sendNexusMessage(ADMIN, report);
    } catch (err) {
      console.error('[RevenueTracker] Telegram send error:', err.message);
    }
  }
  try {
    const subs = await getStripeSubscriptions();
    const mrr  = calculateMRR(subs);
    await remember('fact', 'current_mrr', `${mrr.toFixed(2)}€/mois`);
  } catch { /* silent */ }
}

export async function trackAllRevenue() {
  const [newRecords, report] = await Promise.all([syncRevenueToDb(), buildRevenueReport()]);
  console.log(`[RevenueTracker] ${newRecords} nouveaux enregistrements revenue`);
  return report;
}
