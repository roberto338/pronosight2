# PronoSight v4.1 — Victor IA + Nexus

Plateforme de pronostics sportifs propulsée par l'intelligence artificielle.
**Victor** analyse tous les sports, toutes compétitions, 48h à l'avance.
**Nexus** : assistant multi-agents (chat web + Telegram) avec mémoire long terme et moteurs autonomes.

## Architecture

| Composant | Technologie |
|---|---|
| Backend | Node.js 20 + Express |
| IA Victor | Gemini 2.0 Flash (+ Google Search) avec fallback Groq llama-3.1 |
| IA Nexus | Claude (Anthropic) |
| Base de données | PostgreSQL |
| Queues | Redis + BullMQ |
| Bot | Telegram @pronosight_bot |
| Déploiement | Render.com (auto-deploy depuis GitHub) — variables : voir render.yaml |

## Victor — Le cerveau IA

35 ans d'expérience simulée. Scout international, consultant TV, ex-collaborateur de staffs techniques.

- Détecte automatiquement les matchs via **web search en temps réel**
- Analyse forme, blessures, H2H, stats, météo
- Intègre les **patterns historiques** (15 patterns de démarrage)
- Génère pronostic principal, value bet, score prédit, phrase signature
- **S'améliore** chaque semaine via review automatique des erreurs

## Structure

```
pronosight/
├── server.js            ← Backend Express (proxy API + routes Victor)
├── package.json
├── render.yaml          ← Config déploiement Render.com
│
├── victor/
│   ├── prompt.js        ← Prompt système de Victor (VICTOR_PROMPT)
│   ├── core.js          ← runVictor, checkResults, updateVictorStats,
│   │                       weeklyVictorReview, getVictorBriefing
│   ├── patterns.js      ← detectPatterns, updatePatternAfterResult,
│   │                       discoverNewPatterns, formatPatternsForVictor
│   └── test.js          ← Test rapide (node victor/test.js)
│
├── bot/
│   ├── telegram.js      ← broadcastDaily, sendAlert, sendDailyStats
│   └── test-telegram.js ← Test connexion (node bot/test-telegram.js)
│
├── cron/
│   └── scheduler.js     ← 4 jobs planifiés (07h, 13h, 23h30, dim 01h)
│
├── db/
│   ├── schema_neon.sql  ← SOURCE DE VÉRITÉ : 18 tables (4 ps_* + 14 nexus_*)
│   ├── database.js      ← Pool pg, query(), getClient()
│   └── init.js          ← Init tables + 15 patterns (node db/init.js)
│
├── scripts/
│   └── generate-picks.js ← Script GitHub Actions (Claude + web search)
│
└── public/              ← Frontend SPA (intact)
    ├── index.html
    ├── css/main.css
    └── js/
        ├── app.js
        └── modules/
            ├── api.js
            ├── config.js
            └── state.js
```

## Variables d'environnement

```bash
# OBLIGATOIRES
ANTHROPIC_API_KEY=      # Claude Sonnet — Victor core
GEMINI_API_KEY=         # Gemini — fallback + web search
DATABASE_URL=           # PostgreSQL connection string
TELEGRAM_BOT_TOKEN=     # Bot Telegram
TELEGRAM_CHANNEL_ID=    # Canal de diffusion (-100xxxxxxxxx)
VICTOR_API_KEY=         # Clé interne (protège /api/victor/refresh)

# OPTIONNELLES
GROQ_API_KEY=           # Fallback Groq si Gemini quota
FOOTBALL_DATA_KEY=      # football-data.org (calendriers)
RAPIDAPI_KEY=           # API-Football (stats, blessures)
ODDS_API_KEY=           # The Odds API (cotes bookmakers)
GEMINI_MODEL=gemini-2.0-flash
```

## Cron Jobs (heure de Paris)

| Horaire | Action |
|---|---|
| 07h00 quotidien | Analyse complète du jour → broadcast Telegram |
| 13h00 quotidien | Refresh matchs du soir |
| 23h30 quotidien | Vérification résultats + stats journalières |
| Dimanche 01h00 | Review hebdo + découverte nouveaux patterns |

## Routes API Victor

| Route | Description | Auth |
|---|---|---|
| `GET /api/victor/today` | Pronostics du jour | — |
| `GET /api/victor/stats` | Taux réussite global et par sport | — |
| `GET /api/victor/patterns` | Patterns actifs (forts/moyens/émergents) | — |
| `GET /api/victor/history?days=30` | Historique pronostics vérifiés | — |
| `GET /api/victor/status` | Santé du système | — |
| `POST /api/victor/refresh` | Force un nouveau run Victor | `x-api-key` |

## Routes API existantes (proxy)

| Route | Source |
|---|---|
| `POST /api/gemini` | Gemini + Groq fallback |
| `GET /api/odds/:sport` | The Odds API |
| `GET /api/football-data/*` | football-data.org |
| `GET /api/tsdb/*` | TheSportsDB |
| `GET /api/apifootball/*` | API-Football (RapidAPI) |
| `GET /api/status` | Statut clés API |

## Lancement local

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer les clés API
cp .env.example .env
# Remplir .env avec tes clés

# 3. Initialiser la base de données
node db/init.js

# 4. Lancer le serveur
npm start        # production
npm run dev      # dev (auto-reload)

# Ouvrir http://localhost:3000
```

## Tests

```bash
# Test Victor complet (appel Claude + web search + DB)
node victor/test.js

# Test connexion Telegram
node bot/test-telegram.js

# Ré-initialiser la DB (idempotent)
node db/init.js
```

## Déploiement Render.com

Variables à configurer dans **Environment Variables** du service Render :

```
ANTHROPIC_API_KEY
GEMINI_API_KEY
GROQ_API_KEY
DATABASE_URL
TELEGRAM_BOT_TOKEN
TELEGRAM_CHANNEL_ID
VICTOR_API_KEY
FOOTBALL_DATA_KEY
RAPIDAPI_KEY
ODDS_API_KEY
GEMINI_MODEL=gemini-2.0-flash
NODE_ENV=production
```

Le déploiement se déclenche automatiquement à chaque push sur `master`.

## Base de données

Tables PostgreSQL avec préfixe `ps_` (cohabitation avec RelanceHub) :

| Table | Rôle |
|---|---|
| `ps_pronostics` | Pronostics générés par Victor |
| `ps_victor_patterns` | Patterns statistiques (H2H, situationnels) |
| `ps_victor_rules` | Règles hebdomadaires auto-générées |
| `ps_victor_stats` | Taux de réussite journaliers |
