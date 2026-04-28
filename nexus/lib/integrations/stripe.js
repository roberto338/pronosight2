// ══════════════════════════════════════════════
// nexus/lib/integrations/stripe.js
// Create a Stripe Product + recurring Price + Payment Link
// for the businessAgent pricing strategy.
//
// Flow:
//  1. Extract pricing from strategy text (regex fallback to defaults)
//  2. Create Stripe Product
//  3. Create recurring monthly Price
//  4. Create Payment Link
//  5. Return { productId, priceId, paymentUrl }
//
// Env var required: STRIPE_SECRET_KEY
// Fallback: returns null gracefully if key missing
// ══════════════════════════════════════════════

import fetch from 'node-fetch';

const STRIPE_BASE = 'https://api.stripe.com/v1';

function stripeHeaders() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurée');
  // Stripe uses HTTP Basic auth: key as username, empty password
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return {
    Authorization:  `Basic ${encoded}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Encode an object as application/x-www-form-urlencoded.
 * Handles nested objects with Stripe's bracket notation.
 */
function encodeStripeBody(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      parts.push(encodeStripeBody(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

/**
 * Extract pricing amount (in cents) from a strategy text.
 * Looks for patterns like "29€/mois", "49€/month", "€39", "$19"
 * Falls back to 2900 (29€) if nothing found.
 *
 * @param {string} strategyText
 * @returns {{ amountCents: number, currency: string }}
 */
export function extractPricing(strategyText) {
  // Try to match Pro plan pricing first
  const proMatch = strategyText.match(
    /(?:pro|premium|paid)[^€$\d]{0,30}([€$£])\s*(\d+)|([€$£])(\d+)[^€$\d]{0,30}(?:pro|premium|mois|month)/i
  );
  if (proMatch) {
    const amount = parseInt(proMatch[2] || proMatch[4], 10);
    const symbol = (proMatch[1] || proMatch[3] || '€').toLowerCase();
    const currency = symbol === '$' ? 'usd' : symbol === '£' ? 'gbp' : 'eur';
    if (amount > 0 && amount < 9999) {
      return { amountCents: amount * 100, currency };
    }
  }

  // Generic price extraction
  const genericMatch = strategyText.match(/([€$£])\s*(\d+)(?:\s*\/\s*(?:mois|month|mo))?/i)
                    || strategyText.match(/(\d+)\s*([€$£])(?:\s*\/\s*(?:mois|month|mo))?/i);
  if (genericMatch) {
    const amount   = parseInt(genericMatch[1] || genericMatch[2], 10);
    const symbol   = (genericMatch[1] || genericMatch[2] || '€');
    const currency = /\$/.test(symbol) ? 'usd' : /£/.test(symbol) ? 'gbp' : 'eur';
    if (!isNaN(amount) && amount > 0 && amount < 9999) {
      return { amountCents: amount * 100, currency };
    }
  }

  // Default: 29€/month
  return { amountCents: 2900, currency: 'eur' };
}

/**
 * Create a Stripe Product.
 * @param {string} name
 * @param {string} description
 * @returns {Promise<string>}  productId
 */
async function createProduct(name, description) {
  const resp = await fetch(`${STRIPE_BASE}/products`, {
    method:  'POST',
    headers: stripeHeaders(),
    body:    encodeStripeBody({ name, description: description.slice(0, 500) }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Stripe createProduct failed (${resp.status}): ${err.error?.message || resp.statusText}`);
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Create a recurring monthly Stripe Price.
 * @param {string} productId
 * @param {number} amountCents
 * @param {string} currency    e.g. 'eur'
 * @returns {Promise<string>}  priceId
 */
async function createPrice(productId, amountCents, currency) {
  const resp = await fetch(`${STRIPE_BASE}/prices`, {
    method:  'POST',
    headers: stripeHeaders(),
    body:    encodeStripeBody({
      product:    productId,
      unit_amount: amountCents,
      currency,
      recurring:  { interval: 'month' },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Stripe createPrice failed (${resp.status}): ${err.error?.message || resp.statusText}`);
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Create a Stripe Payment Link.
 * @param {string} priceId
 * @returns {Promise<string>}  payment link URL
 */
async function createPaymentLink(priceId) {
  const resp = await fetch(`${STRIPE_BASE}/payment_links`, {
    method:  'POST',
    headers: stripeHeaders(),
    body:    encodeStripeBody({
      'line_items[0][price]':    priceId,
      'line_items[0][quantity]': '1',
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Stripe createPaymentLink failed (${resp.status}): ${err.error?.message || resp.statusText}`);
  }
  const data = await resp.json();
  return data.url;
}

/**
 * Create a full Stripe product + price + payment link.
 * Falls back gracefully if STRIPE_SECRET_KEY is missing.
 *
 * @param {string} businessName    e.g. "Newsletter IA"
 * @param {string} strategyText    Used to extract pricing
 * @returns {Promise<{productId: string, priceId: string, paymentUrl: string, amountCents: number, currency: string, error?: string}|null>}
 */
export async function createStripeProduct(businessName, strategyText) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('[Stripe] STRIPE_SECRET_KEY absente — produit ignoré');
    return { productId: null, priceId: null, paymentUrl: null, error: 'STRIPE_SECRET_KEY manquante' };
  }

  try {
    const { amountCents, currency } = extractPricing(strategyText || '');
    const priceLabel = `${(amountCents / 100).toFixed(0)}${currency === 'eur' ? '€' : currency === 'usd' ? '$' : '£'}`;

    console.log(`[Stripe] Création produit: "${businessName} Pro" @ ${priceLabel}/mois`);

    const productId   = await createProduct(
      `${businessName} Pro`,
      `Plan Pro pour ${businessName} — généré par Nexus Business Builder`
    );
    console.log(`[Stripe] ✅ Produit créé: ${productId}`);

    const priceId     = await createPrice(productId, amountCents, currency);
    console.log(`[Stripe] ✅ Prix créé: ${priceId} (${priceLabel}/mois)`);

    const paymentUrl  = await createPaymentLink(priceId);
    console.log(`[Stripe] ✅ Payment link: ${paymentUrl}`);

    return { productId, priceId, paymentUrl, amountCents, currency };
  } catch (err) {
    console.error('[Stripe] Erreur:', err.message);
    return { productId: null, priceId: null, paymentUrl: null, error: err.message };
  }
}
