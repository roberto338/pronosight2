// ══════════════════════════════════════════════
// victor/healthcheck.js — Diagnostic de santé du système
//
// Un seul rôle : dire si Victor produit encore quelque chose.
// Alimente le heartbeat Telegram quotidien et /api/victor/health.
//
// Contexte : PronoSight est resté en panne du 15/07 au 03/08/2026 sans
// qu'aucun signal ne parte. Tous les garde-fous existants échouaient en
// silence. Ce module est le contre-poison.
// ══════════════════════════════════════════════

// ⚠️ Premier import obligatoire (imports ESM hoistés — cf. victor/core.js)
import 'dotenv/config';
import pool, { query } from '../db/database.js';
import { getFixturesOfDay, fetchWithTimeout } from './sources.js';

/**
 * Vérifie que le modèle Groq configuré existe encore.
 *
 * Groq retire ses modèles sans préavis (llama-3.1-70b, mixtral-8x7b,
 * gemma-7b l'ont déjà été). Le jour où le nôtre disparaît, le dernier
 * moteur de la cascade meurt sur un 404. Ce contrôle prévient AVANT
 * la panne au lieu de la constater après.
 *
 * @returns {Promise<{ok:boolean, message:string|null}>}
 */
export async function verifierModeleGroq() {
  const cle    = process.env.GROQ_API_KEY;
  const modele = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  if (!cle) return { ok: false, message: 'GROQ_API_KEY absente — plus aucun filet si Gemini tombe' };

  try {
    const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/models',
      { headers: { Authorization: `Bearer ${cle}` } }, 15_000);
    if (!resp.ok) return { ok: false, message: `Groq injoignable (HTTP ${resp.status})` };

    const ids = ((await resp.json()).data || []).map(m => m.id);
    if (!ids.includes(modele)) {
      return { ok: false, message: `Modèle Groq "${modele}" RETIRÉ — changer GROQ_MODEL (dispo : ${ids.filter(i => /llama|qwen|gpt/i.test(i)).slice(0, 4).join(', ')})` };
    }
    return { ok: true, message: null };
  } catch (err) {
    return { ok: false, message: `Contrôle Groq impossible : ${err.message}` };
  }
}

/**
 * @returns {Promise<{date:string, pronosticsAujourdhui:number, dernierPronostic:string|null,
 *                    jobs:{pending:number,running:number,done:number,failed:number},
 *                    jobsBloques:number, matchsDuJour:number|null, problemes:string[]}>}
 */
export async function runHealthcheck({ verifierSources = true } = {}) {
  const dateISO   = new Date().toISOString().slice(0, 10);
  const problemes = [];

  // ── Production de pronostics ────────────────────────────────
  let pronosticsAujourdhui = 0;
  let dernierPronostic = null;
  try {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE date = CURRENT_DATE)::int AS aujourdhui,
              MAX(date)::text                                  AS dernier
       FROM ps_pronostics`
    );
    pronosticsAujourdhui = rows[0]?.aujourdhui ?? 0;
    dernierPronostic     = rows[0]?.dernier ?? null;

    if (dernierPronostic) {
      const jours = Math.floor((Date.now() - new Date(dernierPronostic).getTime()) / 864e5);
      if (jours >= 2) problemes.push(`Aucun pronostic depuis ${jours} jours`);
    } else {
      problemes.push('Aucun pronostic en base');
    }
  } catch (err) {
    problemes.push(`Base inaccessible : ${err.message}`);
  }

  // ── État de la file ─────────────────────────────────────────
  const jobs = { pending: 0, running: 0, done: 0, failed: 0 };
  let jobsBloques = 0;
  let appariementsAmbigus = 0;
  try {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS n FROM victor_jobs GROUP BY status`
    );
    for (const r of rows) if (r.status in jobs) jobs[r.status] = r.n;

    // Le heartbeat tourne DANS un job 'heartbeat' : il se comptait
    // lui-même. Le 25/08 il annonçait « en cours 1 » alors que rien
    // n'était bloqué — un bulletin de santé qui s'inquiète de sa propre
    // existence apprend à son lecteur à ignorer ses alertes.
    const { rows: soi } = await query(
      `SELECT COUNT(*)::int AS n FROM victor_jobs
       WHERE status = 'running' AND name = 'heartbeat'`
    );
    jobs.running = Math.max(0, jobs.running - (soi[0]?.n ?? 0));

    const { rows: bloques } = await query(
      `SELECT COUNT(*)::int AS n FROM victor_jobs
       WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes'`
    );
    jobsBloques = bloques[0]?.n ?? 0;

    if (jobsBloques > 0) problemes.push(`${jobsBloques} job(s) figé(s) en 'running'`);

    // ── File de revue des appariements ambigus (migration 013) ──────
    // checkResults refuse de noter un pronostic quand deux rencontres du
    // jour le revendiquent avec la même force. Sans ce compteur, le refus
    // serait invisible et le pronostic disparaîtrait des statistiques sans
    // explication — le contraire du but recherché.
    try {
      const { rows: amb } = await query(
        `SELECT COUNT(*)::int AS n FROM ps_appariements_ambigus WHERE resolu = false`
      );
      appariementsAmbigus = amb[0]?.n ?? 0;
      if (appariementsAmbigus > 0) {
        problemes.push(`${appariementsAmbigus} pronostic(s) non noté(s) — appariement ambigu à arbitrer`);
      }
    } catch { /* table absente = migration non appliquée, sans conséquence ici */ }

    // Un échec RÉCENT est actionnable ; un échec de juillet est une
    // scorie en attente de purge. Les mélanger noyait le signal utile :
    // le 07/08, le heartbeat annonçait « 9 job(s) en échec » alors que
    // le fait marquant était l'échec du prematch du matin même.
    const { rows: recents } = await query(
      `SELECT name, attempts, max_attempts, left(coalesce(error,''), 80) AS motif
       FROM victor_jobs
       -- 24 h et non 36 : le heartbeat tourne une fois par jour, une
       -- fenêtre plus large lui fait re-signaler un échec déjà rapporté
       -- la veille. Le 10/08, il annonçait deux jobs abandonnés qui
       -- dataient de l'avant-veille et étaient déjà résolus.
       WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`
    );
    for (const r of recents) {
      problemes.push(`job "${r.name}" abandonné après ${r.attempts}/${r.max_attempts} essais — ${r.motif}`);
    }

    // Le compteur affiché doit refléter ce sur quoi Roberto peut AGIR.
    // Le 25/08, « échoués 2 » désignait deux jobs du 15 et du 16 août,
    // déjà diagnostiqués et en attente de purge automatique. Un chiffre
    // alarmant qui ne demande aucune action est un chiffre nuisible.
    jobs.failedRecents = recents.length;
    jobs.failedAnciens = Math.max(0, jobs.failed - recents.length);
    if (jobs.failedAnciens > 5) {
      problemes.push(`${jobs.failedAnciens} ancien(s) job(s) en échec (purge automatique sous 14 j)`);
    }
  } catch (err) {
    problemes.push(`File inaccessible : ${err.message}`);
  }

  // ── Disponibilité des sources de données ────────────────────
  let matchsDuJour = null;
  if (verifierSources) {
    try {
      matchsDuJour = (await getFixturesOfDay(dateISO)).length;
      if (matchsDuJour === 0) {
        // Pas forcément une panne : intersaison, jour creux…
        problemes.push('Aucun match trouvé par les sources aujourd\'hui');
      }
    } catch (err) {
      problemes.push(`Sources de données KO : ${err.message}`);
    }
  }

  // ── Configuration ───────────────────────────────────────────
  if (!process.env.TELEGRAM_BOT_TOKEN)  problemes.push('TELEGRAM_BOT_TOKEN absent');
  if (!process.env.TELEGRAM_CHANNEL_ID) problemes.push('TELEGRAM_CHANNEL_ID absente');
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    problemes.push('Aucune clé IA configurée (GEMINI_API_KEY / GROQ_API_KEY)');
  }

  // ── Moteur de secours ───────────────────────────────────────
  let groq = { ok: true, message: null };
  if (verifierSources) {
    groq = await verifierModeleGroq();
    if (!groq.ok) problemes.push(groq.message);
  }

  return {
    date: dateISO, pronosticsAujourdhui, dernierPronostic,
    jobs, jobsBloques, appariementsAmbigus, matchsDuJour,
    groqOk: groq.ok,
    problemes,
  };
}

export default runHealthcheck;

// ── Exécution directe : node victor/healthcheck.js ───────────
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const diag = await runHealthcheck();
  console.log(JSON.stringify(diag, null, 2));
  if (diag.problemes.length > 0) {
    console.error(`\n❌ ${diag.problemes.length} problème(s) détecté(s)`);
  } else {
    console.log('\n✅ Système sain');
  }
  await pool.end().catch(() => {});
  process.exitCode = diag.problemes.length > 0 ? 1 : 0;
}
