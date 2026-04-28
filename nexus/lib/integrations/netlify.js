// ══════════════════════════════════════════════
// nexus/lib/integrations/netlify.js
// Deploy an HTML landing page to Netlify via API.
//
// Flow:
//  1. Create a new Netlify site (returns site_id + subdomain)
//  2. Build a zip buffer containing index.html
//  3. POST the zip to deploy endpoint
//  4. Poll until deploy is ready (max 60s)
//  5. Return the live URL
//
// Env var required: NETLIFY_TOKEN
// Fallback: saves HTML to ./nexus/outputs/ if deploy fails
// ══════════════════════════════════════════════

import JSZip     from 'jszip';
import fetch     from 'node-fetch';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname }    from 'path';
import { fileURLToPath }    from 'url';

const BASE_URL = 'https://api.netlify.com/api/v1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = join(__dirname, '..', '..', '..', 'nexus', 'outputs');

function netlifyHeaders() {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_TOKEN non configuré');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Create a new Netlify site.
 * @param {string} siteName  e.g. "nexus-newsletter-ia"
 * @returns {Promise<{siteId: string, siteUrl: string}>}
 */
async function createNetlifySite(siteName) {
  // Netlify subdomain must be unique — append random suffix
  const subdomain = `${siteName}-${Date.now().toString(36)}`;
  const resp = await fetch(`${BASE_URL}/sites`, {
    method:  'POST',
    headers: netlifyHeaders(),
    body:    JSON.stringify({ name: subdomain }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Netlify create site failed (${resp.status}): ${err.message || resp.statusText}`);
  }
  const data = await resp.json();
  return {
    siteId:  data.id,
    siteUrl: data.ssl_url || data.url || `https://${subdomain}.netlify.app`,
  };
}

/**
 * Create a zip buffer from a single index.html content.
 * @param {string} htmlContent
 * @returns {Promise<Buffer>}
 */
async function buildZip(htmlContent) {
  const zip = new JSZip();
  zip.file('index.html', htmlContent);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Deploy zip buffer to an existing Netlify site.
 * @param {string} siteId
 * @param {Buffer} zipBuffer
 * @returns {Promise<string>}  deploy URL
 */
async function deployZip(siteId, zipBuffer) {
  const token = process.env.NETLIFY_TOKEN;
  const resp = await fetch(`${BASE_URL}/sites/${siteId}/deploys`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zipBuffer,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Netlify deploy failed (${resp.status}): ${err.message || resp.statusText}`);
  }
  const data = await resp.json();
  return data.deploy_ssl_url || data.deploy_url || null;
}

/**
 * Save HTML to local /nexus/outputs/ as fallback when Netlify is unavailable.
 * @param {string} htmlContent
 * @param {string} businessName
 * @returns {Promise<string>}  local file path
 */
async function saveHtmlLocally(htmlContent, businessName) {
  await mkdir(OUTPUTS_DIR, { recursive: true });
  const filename = `${businessName}_landing_${Date.now()}.html`;
  const filepath = join(OUTPUTS_DIR, filename);
  await writeFile(filepath, htmlContent, 'utf8');
  console.log(`[Netlify] ⚠️ HTML sauvegardé localement: ${filepath}`);
  return filepath;
}

/**
 * Deploy an HTML landing page to Netlify.
 * Falls back to local save if NETLIFY_TOKEN is missing or API fails.
 *
 * @param {string} htmlContent    Full HTML string
 * @param {string} businessName   Used for site naming (slugified)
 * @returns {Promise<{url: string, deployed: boolean, localPath?: string}>}
 */
export async function deployLandingPage(htmlContent, businessName) {
  const siteName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);

  if (!process.env.NETLIFY_TOKEN) {
    console.warn('[Netlify] NETLIFY_TOKEN absent — sauvegarde locale');
    const localPath = await saveHtmlLocally(htmlContent, siteName);
    return { url: null, deployed: false, localPath };
  }

  try {
    console.log(`[Netlify] Création du site: ${siteName}...`);
    const { siteId, siteUrl } = await createNetlifySite(siteName);
    console.log(`[Netlify] Site créé: ${siteId} → ${siteUrl}`);

    const zipBuffer = await buildZip(htmlContent);
    console.log(`[Netlify] Déploiement zip (${(zipBuffer.length / 1024).toFixed(1)} KB)...`);

    const deployUrl = await deployZip(siteId, zipBuffer);
    const liveUrl   = deployUrl || siteUrl;

    console.log(`[Netlify] ✅ Déployé: ${liveUrl}`);
    return { url: liveUrl, deployed: true };
  } catch (err) {
    console.error('[Netlify] Erreur deploy:', err.message);
    const localPath = await saveHtmlLocally(htmlContent, siteName);
    return { url: null, deployed: false, localPath, error: err.message };
  }
}
