// ══════════════════════════════════════════════
// queues/workerManager.js — Worker Victor (poller PostgreSQL)
//
// Remplace le Worker BullMQ : claim atomique FOR UPDATE SKIP LOCKED
// sur victor_jobs, même pattern que nexus/worker.js. Zéro Redis.
//
// Sémantique BullMQ conservée :
//   - concurrency 1 + minimum 10s entre deux jobs (rate limit IA)
//   - 3 tentatives, backoff exponentiel base 5s
//   - job.updateProgress() persiste la colonne progress
// ══════════════════════════════════════════════

import { prematchProcessor } from './workers/prematchWorker.js';
import { valueProcessor }    from './workers/valueWorker.js';
import { liveProcessor }     from './workers/liveWorker.js';
import { checkResults, updateVictorStats, weeklyVictorReview } from '../victor/core.js';
import { discoverNewPatterns } from '../victor/patterns.js';
import { computePatterns }    from '../victor/patterns-compute.js';
import { sendDailyStats, sendHeartbeat, sendAlert } from '../bot/telegram.js';
import { runHealthcheck }    from '../victor/healthcheck.js';
import { query }             from '../db/database.js';
import { pruneOldJobs }      from './victorQueue.js';
import { definirReveil }     from './reveil.js';

// Cadence après un job : d'autres peuvent attendre derrière, et la limite
// d'un job toutes les 10 s protège les quotas IA (ex-limiter BullMQ).
const POLL_ACTIF_MS    = 10_000;
// Cadence au repos. Le worker est désormais réveillé à l'ajout d'un job :
// ce sondage ne rattrape plus que les orphelins d'un process mort. À 10 s
// il maintenait le compute Neon éveillé en permanence — 864 000 requêtes
// par mois pour 5 jobs par jour, quota gratuit épuisé le 18/08 à 01:26.
const POLL_REPOS_MS    = Number(process.env.JOB_POLL_IDLE_MS || 20 * 60 * 1000);
const BACKOFF_BASE_MS  = 5_000;  // backoff exponentiel : 5s, 10s, 20s…

// Doit rester INFÉRIEUR au seuil de requeue du balayage (20 min), sinon
// un job lent est repris pendant qu'il tourne encore et consomme ses
// tentatives pour rien. Un échec explicite vaut mieux qu'un job fantôme.
const JOB_TIMEOUT_MS   = Number(process.env.JOB_TIMEOUT_MS || 12 * 60 * 1000);
const STALE_AFTER_MIN  = Number(process.env.JOB_STALE_MINUTES || 20);
// 6 h et non 2 : un job de 7h ou de 13h reste pertinent le soir même, et
// une indisponibilité de Render dépasse facilement deux heures. Le 15/08,
// le job de 13h a été abandonné après un seul essai pour cette raison.
// Au-delà de 6 h on renonce : le contexte du jour n'a plus de sens.
const RETRY_WINDOW_H   = Number(process.env.JOB_RETRY_WINDOW_HOURS || 6);

// ── Reprise des jobs orphelins ──────────────────────────────────
// Un job passé en 'running' dont le process meurt (redéploiement Render,
// spin-down du free tier, OOM) n'est plus jamais repris : claimNextJob()
// ne regarde que 'pending'. 26 jobs sont ainsi restés figés du 15/07 au
// 03/08/2026 — panne invisible de 3 semaines. Ce balayage est le filet.
async function requeueStaleJobs(seuilMin = STALE_AFTER_MIN) {
  try {
    // Un job récent mérite un retry (redémarrage Render passager).
    // Un job ancien ne doit PAS être rejoué : il porterait un contexte
    // périmé, et 26 zombies accumulés partiraient tous d'un coup au
    // premier déploiement. Au-delà de RETRY_WINDOW_H → abandon direct.
    const { rows } = await query(`
      UPDATE victor_jobs
      SET    status = CASE
                        WHEN attempts < max_attempts
                         AND started_at > NOW() - ($2 || ' hours')::interval
                        THEN 'pending' ELSE 'failed'
                      END,
             -- Message prudent : le process PEUT être mort, mais il peut
             -- aussi être vivant et le job simplement trop lent. Les 07,
             -- 08 et 09/08, ce libellé affirmait « process interrompu »
             -- alors que le service tournait depuis 34 h sans coupure —
             -- il attendait le quota football-data. Un diagnostic faux
             -- coûte plus cher qu'une absence de diagnostic.
             --
             -- COALESCE ne fige plus un message périmé : claimNextJob()
             -- remet la colonne error à NULL à chaque essai, donc une
             -- valeur non nulle ici est forcément la cause réelle
             -- consignée par ecrireVerdict(). Ce libellé n'apparaît que
             -- si le job n'a rien pu dire de lui-même.
             error  = COALESCE(error, 'Repris : toujours en cours après ' || $1 || ' min sans aboutir'),
             updated_at = NOW()
      WHERE  status = 'running'
        AND  started_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id, name, status
    `, [String(seuilMin), String(RETRY_WINDOW_H)]);

    if (rows.length > 0) {
      const requeues = rows.filter(r => r.status === 'pending').length;
      console.warn(`♻️  [Worker] ${rows.length} job(s) orphelin(s) — ${requeues} requeué(s), ${rows.length - requeues} abandonné(s) (trop ancien)`);
    }
    return rows.length;
  } catch (err) {
    console.error('❌ [Worker] Balayage des orphelins impossible:', err.message);
    return 0;
  }
}

// ── Dispatcher principal (inchangé fonctionnellement) ──────────
async function processor(job) {
  console.log(`\n⚙️  [Worker] Job reçu : ${job.name} #${job.id}`);

  switch (job.name) {

    case 'prematch':
      return prematchProcessor(job);

    case 'value':
      return valueProcessor(job);

    case 'live':
      return liveProcessor(job);

    case 'check-results': {
      console.log(`\n🔍 [check-results #${job.id}] Vérification résultats...`);
      await job.updateProgress(20);
      await checkResults();
      await job.updateProgress(60);
      await updateVictorStats();
      await job.updateProgress(85);

      try {
        const { rows } = await query(
          'SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE'
        );
        if (rows.length > 0) {
          await sendDailyStats(rows[0]);
          console.log(`   📊 [check-results #${job.id}] Stats Telegram envoyées`);
        }
      } catch (statErr) {
        console.warn(`   ⚠️  Stats Telegram échouées:`, statErr.message);
      }

      await job.updateProgress(100);
      return { done: true, date: new Date().toISOString().slice(0, 10) };
    }

    case 'weekly-review': {
      console.log(`\n📊 [weekly-review #${job.id}] Review hebdomadaire...`);

      // Recalcul des patterns depuis l'historique réel des matchs.
      // Sans ce rafraîchissement, ils se périment et sont désactivés
      // au bout de 30 jours — la table redeviendrait vide.
      await job.updateProgress(15);
      let patterns = { calcules: 0, ecrits: 0, matchs: 0 };
      try {
        patterns = await computePatterns({ jours: 120 });
      } catch (err) {
        console.warn('   ⚠️  Recalcul des patterns échoué:', err.message);
      }

      await job.updateProgress(45);
      await discoverNewPatterns();
      await job.updateProgress(70);
      await weeklyVictorReview();
      await job.updateProgress(100);
      return {
        done: true,
        week: new Date().toISOString().slice(0, 10),
        patternsEcrits: patterns.ecrits,
        matchsAnalyses: patterns.matchs,
      };
    }

    case 'heartbeat': {
      console.log(`\n💓 [heartbeat #${job.id}] Diagnostic de santé...`);
      await job.updateProgress(30);
      const diag = await runHealthcheck();
      await job.updateProgress(70);
      await sendHeartbeat(diag);
      await job.updateProgress(100);
      return { done: true, problemes: diag.problemes };
    }

    default:
      console.warn(`⚠️  [Worker] Job inconnu : ${job.name} — ignoré`);
      return { skipped: true, reason: `Job name inconnu: ${job.name}` };
  }
}

// ── Claim atomique du prochain job ──────────────────────────────
async function claimNextJob() {
  const { rows } = await query(`
    UPDATE victor_jobs
    SET    status     = 'running',
           started_at = NOW(),
           updated_at = NOW(),
           attempts   = attempts + 1,
           -- Remis à zéro à chaque essai. Sans ça, la progression et le
           -- message d'erreur du tour précédent survivent et se lisent
           -- comme un diagnostic frais : le 16/08, le job affichait
           -- « progress 88 » hérité de la 1re tentative alors que la 3e
           -- n'avait pas écrit une seule ligne.
           progress   = 0,
           error      = NULL
    WHERE  id = (
      SELECT id
      FROM   victor_jobs
      WHERE  status = 'pending'
        AND  (scheduled_for IS NULL OR scheduled_for <= NOW())
      ORDER  BY priority ASC, created_at ASC
      LIMIT  1
      FOR    UPDATE SKIP LOCKED
    )
    RETURNING id, name, data, attempts, max_attempts AS "maxAttempts"
  `);
  return rows[0] || null;
}

// ── Écriture du verdict d'un job ────────────────────────────────
// Cet UPDATE ne doit JAMAIS pouvoir remonter. S'il échoue, le job reste
// 'running' sans une ligne d'explication : le balayage le reprend 20 min
// plus tard, brûle un essai, et le heartbeat annonce « toujours en cours
// après 20 min » alors que le job a échoué en deux minutes.
//
// C'est exactement ce qui s'est produit les 15 et 16/08 : un typage de
// paramètre ambigu ($1 servait à la fois de valeur assignée et de terme
// de comparaison, « inconsistent types deduced for parameter $1 ») rendait
// cet UPDATE impossible. Trois tentatives perdues, zéro pronostic, et un
// diagnostic faux affiché à Roberto.
async function ecrireVerdict(id, sql, params) {
  try {
    await query(sql, params);
    return true;
  } catch (err) {
    console.error(`❌ [Worker] Verdict non écrit pour #${id} : ${err.message} — repli minimal`);
    try {
      await query(
        `UPDATE victor_jobs
         SET status = 'failed', error = $1, completed_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [`Verdict inscriptible impossible : ${err.message}`.slice(0, 500), id]
      );
    } catch (err2) {
      console.error(`❌ [Worker] Repli impossible pour #${id} : ${err2.message}`);
    }
    return false;
  }
}

// ── Exécution d'un job réclamé ──────────────────────────────────
async function processClaimedJob(row) {
  const job = {
    id:   row.id,
    name: row.name,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}),
    updateProgress: async (p) => {
      try {
        await query(`UPDATE victor_jobs SET progress = $1, updated_at = NOW() WHERE id = $2`, [p, row.id]);
      } catch { /* le progress est cosmétique — jamais bloquant */ }
    },
  };

  try {
    // Plafond de durée : un job ne doit JAMAIS dépasser la fenêtre de
    // requeue du balayage (20 min), sinon il est repris alors qu'il
    // tourne encore, jusqu'à épuiser ses tentatives — ce qui s'est
    // produit les 07, 08 et 09/08 en affichant « process interrompu »
    // alors que le process était parfaitement vivant (34 h d'uptime).
    const result = await Promise.race([
      processor(job),
      new Promise((_, rejeter) =>
        setTimeout(() => rejeter(new Error(`Délai dépassé (${JOB_TIMEOUT_MS / 1000}s) — job interrompu par sécurité`)),
          JOB_TIMEOUT_MS).unref()
      ),
    ]);
    await ecrireVerdict(row.id,
      `UPDATE victor_jobs
       SET status = 'done', result = $1, error = NULL, progress = 100,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(result ?? {}), row.id]
    );
    console.log(`✅ [Worker] Job terminé : ${row.name} #${row.id}`, JSON.stringify(result ?? {}).slice(0, 100));
  } catch (err) {
    const willRetry = row.attempts < row.maxAttempts;
    const backoffMs = BACKOFF_BASE_MS * 2 ** (row.attempts - 1);
    console.error(`❌ [Worker] Job échoué : ${row.name} #${row.id} (tentative ${row.attempts}/${row.maxAttempts}) — ${err.message}`);

    // Un nouvel essai programmé dans 5 s ne doit pas attendre la cadence
    // de repos (20 min). On raccourcit la prochaine planification.
    if (willRetry) _replanifierDans = backoffMs + 500;

    // $1 est à la fois assigné à `status` (varchar) et comparé à 'pending'
    // (text). Sans le transtypage explicite, PostgreSQL refuse la requête :
    // « inconsistent types deduced for parameter $1 ». L'échec devenait
    // alors impossible à consigner — voir ecrireVerdict() ci-dessus.
    await ecrireVerdict(row.id,
      `UPDATE victor_jobs
       SET status = $1::text, error = $2,
           scheduled_for = CASE WHEN $1::text = 'pending'
                                THEN NOW() + ($3 || ' milliseconds')::interval
                                ELSE scheduled_for END,
           completed_at  = CASE WHEN $1::text = 'failed' THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE id = $4`,
      [willRetry ? 'pending' : 'failed', String(err.message).slice(0, 500), String(backoffMs), row.id]
    );
  }
}

// ── Boucle d'exécution ──────────────────────────────────────────
//
// Le worker ne découvre plus le travail en sondant : victorQueue le
// réveille au moment où un job est inséré (même processus). Le sondage
// périodique ne sert plus qu'à rattraper les orphelins d'un process mort,
// et devient donc très lent — ce qui laisse le compute Neon se suspendre
// au lieu d'être tenu éveillé 24 h sur 24.
let _running        = false;
let _timer          = null;
let _lastPrune      = 0;
let _enCours        = false;  // un tick est-il en train de tourner ?
let _reveilDemande  = false;  // réveil reçu pendant un tick → replanifier à 0
let _replanifierDans = null;  // backoff d'un retry : ne pas attendre le repos

// ── Sentinelle base de données ──────────────────────────────────
//
// La panne du 18/08 (quota de calcul Neon épuisé à 01:26) n'a déclenché
// AUCUNE alerte : le heartbeat quotidien établit son diagnostic en
// interrogeant la base, donc la seule panne qu'il ne peut structurellement
// pas signaler est celle de la base elle-même. Roberto l'a découverte en
// constatant l'absence de pronostics.
//
// Cette sentinelle ne sonde rien : elle observe les erreurs que le tick
// rencontre déjà. Aucune requête supplémentaire, donc aucun réveil du
// compute Neon — ce serait contradictoire avec le reste de ce fichier.
const ALERTE_APRES_MS = Number(process.env.DB_ALERTE_APRES_MS || 15 * 60 * 1000);
const ALERTE_REPOS_MS = 6 * 60 * 60 * 1000;   // pas plus d'une alerte par 6 h
let _baseKoDepuis  = null;
let _derniereAlerte = 0;

function estPanneBase(err) {
  const m = String(err?.message || '').toLowerCase();
  return ['quota', 'econnrefused', 'etimedout', 'timeout', 'terminated',
          'connection', 'too many clients', 'server closed'].some(t => m.includes(t));
}

function surveillerBase(err) {
  if (!err) {
    if (_baseKoDepuis) {
      const min = Math.round((Date.now() - _baseKoDepuis) / 60000);
      _baseKoDepuis = null;
      if (min >= 15) {
        sendAlert(`Base de données à nouveau joignable après ${min} min d'indisponibilité.`, 'success')
          .catch(() => { /* l'alerte est un bonus, jamais un blocage */ });
      }
    }
    return;
  }
  if (!estPanneBase(err)) return;
  if (!_baseKoDepuis) _baseKoDepuis = Date.now();

  const depuisMin = Math.round((Date.now() - _baseKoDepuis) / 60000);
  if (Date.now() - _baseKoDepuis < ALERTE_APRES_MS) return;
  if (Date.now() - _derniereAlerte < ALERTE_REPOS_MS) return;
  _derniereAlerte = Date.now();
  sendAlert(
    `Base de données injoignable depuis ${depuisMin} min — aucun pronostic ne peut être produit.\n${String(err.message).slice(0, 200)}`,
    'danger'
  ).catch(() => { /* si Telegram tombe aussi, rien à faire de plus */ });
}

function planifier(delaiMs) {
  if (!_running) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(tick, delaiMs);
}

// Appelée par victorQueue à chaque ajout de job, via queues/reveil.js.
function reveiller(raison = 'ajout de job') {
  if (!_running) return;
  if (_enCours) { _reveilDemande = true; return; }  // le tick en cours replanifiera
  planifier(0);
  console.log(`⚡ [Worker] Réveil — ${raison}`);
}

async function tick() {
  if (!_running) return;
  _enCours = true;
  let aTravaille = false;
  try {
    await requeueStaleJobs();     // avant tout claim : libère les zombies
    const row = await claimNextJob();
    if (row) {
      aTravaille = true;
      await processClaimedJob(row); // séquentiel : 1 job IA à la fois
    }

    // Purge quotidienne des vieux jobs terminés
    if (Date.now() - _lastPrune > 24 * 60 * 60 * 1000) {
      _lastPrune = Date.now();
      const n = await pruneOldJobs(14).catch(() => 0);
      if (n > 0) console.log(`🧹 [Worker] ${n} vieux job(s) purgés`);
    }
    surveillerBase(null);           // la base répond : on referme l'incident
  } catch (err) {
    console.error('❌ [Worker] Poll error:', err.message);
    surveillerBase(err);
    // Base injoignable : on réessaie plus souvent que la cadence de repos.
    // Une base qui refuse les connexions ne consomme pas de compute, et on
    // veut détecter son retour sans attendre 20 minutes.
    if (estPanneBase(err)) _replanifierDans = 2 * 60 * 1000;
  } finally {
    _enCours = false;
    // Trois cadences, de la plus urgente à la plus économe :
    //   0            → un réveil est arrivé pendant le tick
    //   backoff      → un job vient d'être reprogrammé pour un nouvel essai
    //   POLL_ACTIF   → on vient de travailler, d'autres jobs attendent peut-être
    //   POLL_REPOS   → rien à faire : on laisse la base dormir
    let delai;
    if (_reveilDemande)              { delai = 0; }
    else if (_replanifierDans !== null) { delai = _replanifierDans; }
    else if (aTravaille)             { delai = POLL_ACTIF_MS; }
    else                             { delai = POLL_REPOS_MS; }
    _reveilDemande   = false;
    _replanifierDans = null;
    planifier(delai);
  }
}

export function startWorker() {
  if (_running) {
    console.log('⚙️  Worker déjà démarré');
    return true;
  }
  _running = true;
  definirReveil('victor', reveiller);

  // ── Reprise immédiate au démarrage ────────────────────────────
  // Une seule instance, un seul worker, concurrency 1 : au boot, un job
  // encore en 'running' appartenait forcément au process précédent. Il
  // est orphelin par définition — inutile d'attendre le balayage.
  //
  // Le 15/08, le job value de 13h a été tué par un SIGTERM de Render à
  // 75% d'avancement. Il est resté 'running', et quand le balayage l'a
  // enfin vu, la fenêtre de rejeu de 2 h avait expiré : abandonné après
  // un seul essai, alors que deux tentatives restaient disponibles.
  requeueStaleJobs(0)
    .then(n => { if (n > 0) console.warn(`♻️  [Worker] ${n} job(s) repris au démarrage`); })
    .catch(() => { /* le balayage périodique prendra le relais */ });

  planifier(2_000);
  console.log(`⚙️  Worker Victor démarré — réveil à l'ajout, sondage de secours toutes les ${Math.round(POLL_REPOS_MS / 60000)} min`);
  return true;
}

export function stopWorker() {
  _running = false;
  definirReveil('victor', null);
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log('[Worker] Arrêté (le job en cours se termine)');
}

export function getWorker() {
  return _running ? { backend: 'postgres', running: true } : null;
}

export default startWorker;
