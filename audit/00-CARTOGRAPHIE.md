# 00 — Cartographie réelle

Audit du 03/09/2026. Dépôt : 126 fichiers suivis par git, 27 023 lignes à lire
(125 `A_LIRE`, 1 `NON_APPLICABLE`). Voir `INVENTAIRE.csv` pour la preuve de couverture.

## Écarts entre la description de la compétence et la réalité

La compétence annonçait « 6 routes API ». Le dépôt en expose **17 dans `server.js`** plus
**~30 routes Nexus** montées sous `/nexus`. La surface d'attaque est donc environ huit fois
plus large que ce que l'audit supposait. Ce constat conditionne l'axe A1 et A8.

## Répartition du code

| Zone | Lignes | Rôle |
|---|---|---|
| `nexus/` | 10 515 | Système multi-agents — **en veille** (`NEXUS_MODE`), worker actif |
| `public/` | 5 413 | Frontend (navigateur) |
| `victor/` | 4 762 | Cœur analytique : sources, cotes, prompt, notation, patterns |
| `racine` | 2 035 | `server.js` (812 l.) + config projet |
| `queues/` | 888 | File de jobs PostgreSQL + workers |
| `db/` | 812 | Pool, schéma introspecté, migrations |
| `bot/` | 474 | Diffusion Telegram |
| `cron/` | 119 | Scheduler |
| `admin/`, `tools/`, `scripts/`, `config/`, `picks/` | 325 | Périphérie |

## Point d'entrée

`server.js` — Express. Ordre d'initialisation (`server.js:715-800`) :
`installerSurveillanceProcess()` → `startWorker()` → `setupQueueDashboard()` →
`startScheduler()` → `startNexusWorker()` + `startTelegramHandler()` → keepalive HTTP.

## Routes exposées (`server.js`)

| Ligne | Route | Protection observée |
|---|---|---|
| 135 | `POST /api/gemini` | `geminiLimiter` (12/min/IP) — **aucune authentification** |
| 241 | `GET /api/odds/:sportKey` | `oddsLimiter` (20/min/IP) — **aucune authentification** |
| 277 | `GET /api/football-data/*` | à vérifier phase 1 |
| 310 | `GET /api/tsdb/*` | à vérifier phase 1 |
| 338 | `GET /api/apifootball/*` | à vérifier phase 1 |
| 359 | `GET /api/status` | publique, pas d'accès base |
| 384 | `GET /api/victor/today` | à vérifier |
| 406 | `GET /api/victor/stats` | à vérifier |
| 468 | `GET /api/victor/patterns` | à vérifier |
| 489 | `GET /api/victor/history` | à vérifier |
| 518 | `POST /api/victor/refresh` | `x-api-key` = `VICTOR_API_KEY` |
| 552 | `GET /api/victor/health` | `generalLimiter` |
| 581 | `GET /api/matchs` | à vérifier |
| 629 | `GET /api/ping` | publique, pas d'accès base |
| 634 | `GET /api/queue-status` | à vérifier |
| 644 | `GET /api/victor/status` | à vérifier |
| 56, 704 | `use /nexus` | `nexusAuthLimiter` + `nexusLimiter` + Basic Auth + clé API |
| 710 | `get *` | SPA fallback |

## Emplacements clés

- **Scheduler** : `cron/scheduler.js` — 5 tâches Europe/Paris (07:00 prematch, 08:30
  heartbeat, 13:00 value, 23:30 check-results, dimanche 01:00 weekly-review) + keepalive.
- **File de jobs** : `queues/victorQueue.js` (insertion + réveil), `queues/workerManager.js`
  (claim `FOR UPDATE SKIP LOCKED`, exécution), `queues/reveil.js` (registre de réveil),
  `queues/workers/*.js` (prematch, value, live).
- **Prompts Victor** : `victor/prompt.js` (`VICTOR_PROMPT`).
- **Cascade IA** : `victor/core.js` — `geminiRequest()`, `groqRequest()`, `callAI()`.
- **Sources factuelles** : `victor/sources.js` (football-data, TheSportsDB, api-football),
  `victor/odds.js` (The Odds API + agrégation des marchés).
- **Notation** : `victor/core.js` (`checkResults`, `evalPronostic`), `victor/paris.js`
  (vocabulaire fermé des codes de pari).
- **Telegram** : `bot/telegram.js` (envoi seul), `nexus/telegramHandler.js` (polling).
- **Schéma SQL** : `db/schema_neon.sql` (généré par `db/introspect.js`, 19 tables).
- **Migrations** : `nexus/migrations/` (012 numérotées + runners).

## Variables d'environnement attendues

`PORT`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMMA_MODEL`, `GROQ_API_KEY`, `GROQ_MODEL`,
`ODDS_API_KEY`, `FOOTBALL_DATA_KEY`, `RAPIDAPI_KEY`, `API_FOOTBALL_KEY`, `DATABASE_URL`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_ADMIN_ID`, `ANTHROPIC_API_KEY`,
`VICTOR_API_KEY`, `NEXUS_API_KEY`, `NEXUS_CHAT_PASSWORD`, `NEXUS_MODE`, `RENDER_API_KEY`,
`RENDER_EXTERNAL_URL`, `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`, `BREVO_API_KEY`, `NETLIFY_TOKEN`,
`BUFFER_TOKEN`, plus les réglages optionnels (`JOB_POLL_IDLE_MS`, `ODDS_CACHE_MS`,
`GEMINI_THINKING_BUDGET`, `MARGE_COUP_ENVOI_MIN`…).

Sur Render, 20 variables sont définies (relevé du 25/08) ; `GROQ_MODEL`, `GEMMA_MODEL`,
`NEXUS_MODE` et les réglages de cadence n'y figurent pas — ce sont les défauts du code qui
s'appliquent.
