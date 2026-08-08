// ══════════════════════════════════════════════
// nexus/test-unit.js — Tests hors ligne du module Nexus
//
// Usage : npm test   (lance Victor puis Nexus)
//
// Pourquoi ce fichier existe : Nexus n'avait aucun test. L'audit du
// 07/08/2026 y a trouvé quatre défauts qu'aucun test n'aurait laissés
// passer, et qui étaient tous silencieux en production :
//
//   1. extractAndSave() appelé avec 3 arguments au lieu de 4 — l'exception
//      était avalée par le catch interne, la mémoire long terme du chat web
//      n'était jamais écrite.
//   2. /nexus/google/callback sans vérification de state — n'importe qui
//      pouvait lier son compte Google à l'instance.
//   3. Les secrets rangés dans nexus_ltm remontaient dans getRelevantMemories()
//      et partaient dans les prompts IA.
//   4. consolidate() supprimait la connexion Google après 90 jours.
//
// Ces tests verrouillent les contrats correspondants. Aucun appel réseau,
// aucun accès base : uniquement de la vérification statique de signatures
// et de requêtes SQL, exécutable hors ligne et sans clé API.
// ══════════════════════════════════════════════

import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lire = (p) => readFileSync(join(__dirname, p), 'utf8');

let ok = 0, ko = 0;
const echecs = [];

function verifie(libelle, obtenu, attendu) {
  if (obtenu === attendu) {
    ok++;
  } else {
    ko++;
    echecs.push(`${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`);
  }
}

// ══════════════════════════════════════════════
// 1. extractAndSave — arité des appels
// ══════════════════════════════════════════════
// La signature est (taskId, agentType, input, output). Un appel à 3 arguments
// laisse `output` undefined : output.slice() lève, et le catch interne du
// module avale l'erreur. Panne totalement muette.
{
  const ltm    = lire('lib/longTermMemory.js');
  const routes = lire('routes/chat.js');
  const worker = lire('worker.js');

  const signature = ltm.match(/export async function extractAndSave\(([^)]*)\)/);
  verifie('extractAndSave a 4 paramètres',
    signature ? signature[1].split(',').length : 0, 4);

  // Tous les sites d'appel doivent passer 4 arguments (parenthèses simples ici :
  // aucun appel du dépôt n'imbrique d'appel dans ses arguments).
  for (const [nom, src] of [['routes/chat.js', routes], ['worker.js', worker]]) {
    const appels = [...src.matchAll(/[^.\w]extractAndSave\(([^)]*)\)/g)];
    verifie(`${nom} — au moins un appel à extractAndSave`, appels.length > 0, true);
    for (const [i, a] of appels.entries()) {
      verifie(`${nom} — appel #${i + 1} passe 4 arguments`,
        a[1].split(',').length, 4);
    }
  }
}

// ══════════════════════════════════════════════
// 2. Secrets en base — la catégorie 'system' ne doit jamais fuiter
// ══════════════════════════════════════════════
// getRelevantMemories() alimente directement les system prompts envoyés à
// Anthropic / Google / Groq. listMemories() alimente le dashboard HTML.
// consolidate() purge les vieilles mémoires — et supprimait les tokens.
{
  const ltm = lire('lib/longTermMemory.js');

  const bloc = (nom) => {
    const i = ltm.indexOf(`function ${nom}`);
    return i === -1 ? '' : ltm.slice(i, i + 1400);
  };

  verifie('getRelevantMemories exclut la catégorie system',
    /category\s*<>\s*'system'/.test(bloc('getRelevantMemories')), true);

  verifie('listMemories exclut system du listing global',
    /category\s*<>\s*'system'/.test(bloc('listMemories')), true);

  verifie('consolidate ne purge pas les secrets',
    /category\s*<>\s*'system'/.test(bloc('consolidate')), true);

  // Le magasin de tokens doit écrire en 'system', pas en 'fact'.
  const auth = lire('lib/googleAuth.js');
  verifie('googleAuth n\'écrit plus les tokens en catégorie fact',
    /VALUES\s*\('fact'/.test(auth), false);
}

// ══════════════════════════════════════════════
// 3. OAuth — le callback doit valider le state avant d'échanger le code
// ══════════════════════════════════════════════
{
  const auth   = lire('lib/googleAuth.js');
  const routes = lire('routes/google.js');

  verifie('getAuthUrl émet un state', /state,?\s*$|state,/m.test(auth) && /randomBytes/.test(auth), true);
  verifie('consumeState est exporté', /export async function consumeState/.test(auth), true);
  verifie('comparaison du state en timing-safe', /timingSafeEqual/.test(auth), true);
  verifie('le state est consommé (usage unique)', /DELETE FROM nexus_ltm WHERE key = \$1/.test(auth), true);

  // L'ordre compte : consumeState doit précéder exchangeCode, sinon le token
  // est déjà écrit quand la validation échoue.
  const iConsume  = routes.indexOf('await consumeState(');
  const iExchange = routes.indexOf('await exchangeCode(');
  verifie('le callback appelle consumeState', iConsume > -1, true);
  verifie('consumeState précède exchangeCode', iConsume > -1 && iConsume < iExchange, true);
}

// ══════════════════════════════════════════════
// 4. Worker — reprise des tâches orphelines et retry
// ══════════════════════════════════════════════
// Sans ce filet, une tâche 'running' dont le process meurt reste figée à vie.
// C'est la panne qui a bloqué 26 jobs Victor pendant 3 semaines.
{
  const worker = lire('worker.js');

  verifie('requeueStaleTasks existe', /function requeueStaleTasks/.test(worker), true);
  verifie('le balayage cible les tâches running',
    /status\s*=\s*'running'/.test(worker), true);
  verifie('le balayage tourne avant le claim',
    worker.indexOf('await requeueStaleTasks()') < worker.indexOf('while (_activeJobs < CONCURRENCY)'), true);
  verifie('le claim incrémente attempts',
    /attempts\s*=\s*attempts \+ 1/.test(worker), true);
  verifie('le claim reste atomique (SKIP LOCKED)',
    /FOR\s+UPDATE SKIP LOCKED/.test(worker), true);
  verifie('un échec transitoire repasse en pending',
    /willRetry \? 'pending' : 'failed'/.test(worker), true);
  verifie('backoff exponentiel',
    /BACKOFF_BASE_MS \* 2 \*\* /.test(worker), true);
}

// ══════════════════════════════════════════════
// 5. Le schéma doit porter les colonnes dont le worker dépend
// ══════════════════════════════════════════════
// claimNextJob() lit attempts et max_attempts : si le schéma de référence ne
// les déclare pas, une base recréée à neuf casse le worker au premier tick.
{
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema_neon.sql'), 'utf8');
  const iTable = schema.indexOf('CREATE TABLE IF NOT EXISTS nexus_tasks');
  const bloc   = schema.slice(iTable, schema.indexOf(');', iTable));

  verifie('nexus_tasks.attempts déclaré',     /attempts\s+INTEGER/.test(bloc), true);
  verifie('nexus_tasks.max_attempts déclaré', /max_attempts\s+INTEGER/.test(bloc), true);
  verifie('index de claim déclaré',
    /idx_nexus_tasks_claim/.test(schema), true);
}

// ══════════════════════════════════════════════
// 6. Aucun appel réseau ne doit partir sans plafond
// ══════════════════════════════════════════════
// Le worker n'a que 4 slots de concurrence : un fetch nu les immobilise
// pendant les 5 min de timeout undici par défaut, sans un seul log.
{
  const fichiers = [
    'lib/ai.js', 'agents/visionAgent.js', 'routes/chat.js',
    'lib/integrations/brevo.js', 'lib/integrations/netlify.js',
    'lib/integrations/stripe.js', 'autonomous/contentEngine.js',
    'autonomous/outreachEngine.js', 'autonomous/problemSolver.js',
    'autonomous/revenueTracker.js', 'autonomous/saasFactory.js',
  ];
  for (const f of fichiers) {
    const src = lire(f);
    if (!/fetch\(/.test(src)) continue;
    verifie(`${f} plafonne ses appels réseau`,
      /AbortSignal|fetchWithTimeout|AbortController/.test(src), true);
  }

  verifie('node-fetch n\'est plus importé nulle part',
    fichiers.some(f => /from 'node-fetch'/.test(lire(f))), false);
}

// ══════════════════════════════════════════════
// 7. Toutes les routes /nexus doivent être protégées
// ══════════════════════════════════════════════
// Deux exceptions assumées : /status (ping de monitoring, sans détail) et
// /google/callback (appelé par Google, protégé par le state).
// Le balayage porte sur TOUS les modules de routes/ découverts sur disque,
// pas sur une liste en dur : un nouveau fichier de routes est couvert d'office.
{
  const PUBLIQUES_ASSUMEES = ['/status', '/google/callback'];
  const NON_ROUTES = ['index.js', 'middleware.js'];

  const modules = readdirSync(join(__dirname, 'routes'))
    .filter((f) => f.endsWith('.js') && !NON_ROUTES.includes(f));

  verifie('les modules de routes sont trouvés', modules.length >= 6, true);

  let total = 0;
  for (const f of modules) {
    const src = lire(join('routes', f));
    const declarations = [...src.matchAll(
      /^router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*([A-Za-z_]+)?/gm
    )];
    total += declarations.length;

    for (const [, methode, chemin, middleware] of declarations) {
      if (PUBLIQUES_ASSUMEES.includes(chemin)) continue;
      const protegee = middleware === 'requireApiKey' || middleware === 'requireChatAuth';
      verifie(`${f} — ${methode.toUpperCase()} ${chemin} est protégée`, protegee, true);
    }
  }

  // Garde-fou de la découpe : 36 routes avant, 36 après. Si ce compte bouge
  // sans intention, c'est qu'un module a cessé d'être monté ou dupliqué.
  verifie('le total de routes est inchangé depuis la découpe', total, 36);

  // Chaque module de routes doit effectivement être monté par index.js.
  const index = lire('routes/index.js');
  for (const f of modules) {
    verifie(`${f} est monté par routes/index.js`,
      index.includes(`./${f}`), true);
  }
}

// ══════════════════════════════════════════════
// 8. Les middlewares d'auth comparent en temps constant
// ══════════════════════════════════════════════
// Le rate limiter borne le brute-force, mais la comparaison elle-même ne doit
// pas fuiter le secret caractère par caractère.
{
  const mw = lire('routes/middleware.js');

  verifie('timingSafeEqual est utilisé', /timingSafeEqual/.test(mw), true);
  verifie('requireApiKey exporté',   /export function requireApiKey/.test(mw), true);
  verifie('requireChatAuth exporté', /export function requireChatAuth/.test(mw), true);

  // Un `||` court-circuiterait : l'échec sur l'utilisateur répondrait plus
  // vite que l'échec sur le mot de passe, ce qui est mesurable.
  verifie('pas de court-circuit entre user et pass',
    /const userOk[\s\S]{0,120}const passOk/.test(mw), true);

  // Refus explicite si le mot de passe n'est pas configuré : sinon une
  // instance sans NEXUS_CHAT_PASSWORD serait ouverte à tous.
  verifie('refus si NEXUS_CHAT_PASSWORD absent',
    /if \(!expected\)[\s\S]{0,120}503/.test(mw), true);
}

// ══════════════════════════════════════════════
// 9. server.js doit charger .env avant tout autre import
// ══════════════════════════════════════════════
// Les imports ESM sont hoistés : un dotenv.config() dans le corps du fichier
// s'exécute après l'évaluation de db/database.js et consorts, qui ont déjà lu
// un process.env vide. Règle facile à casser en réordonnant les imports.
{
  const server = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
  const imports = [...server.matchAll(/^import\s+.*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)]
    .map((m) => m[1] || m[2]);

  verifie('server.js importe config/env.js en premier',
    imports[0], './config/env.js');

  verifie('plus de dotenv.config() dans le corps de server.js',
    /^dotenv\.config\(/m.test(server), false);
}

// ══════════════════════════════════════════════
// Bilan
// ══════════════════════════════════════════════
console.log('\n══════════════════════════════════════');
console.log(`  Nexus — ${ok} test(s) OK, ${ko} échec(s)`);
console.log('══════════════════════════════════════');

if (ko > 0) {
  console.log('\nÉchecs :');
  for (const e of echecs) console.log(`  ❌ ${e}`);
  process.exit(1);
}
console.log('✅ Tout passe\n');
