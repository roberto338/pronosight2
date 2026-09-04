# 01 — Points d'appel externes

Relevé par `grep` sur les hôtes et les clients. 42 `fetch` côté serveur, 15 côté navigateur
(`public/`), 1 seul `new Pool`, 2 instances `TelegramBot`.

## Hôtes contactés depuis le code serveur

| Hôte | Occurrences | Service | Déclencheur |
|---|---|---|---|
| `generativelanguage.googleapis.com` | 3 | Gemini + Gemma | cron (analyse), route `/api/gemini` |
| `api.groq.com` | 4 | Groq (repli 2) | cron (analyse), Nexus |
| `api.the-odds-api.com` | 4 | The Odds API — **facturé en crédits** | cron (analyse), route `/api/odds/:sportKey` |
| `api.football-data.org` | 4 | football-data | cron (analyse) |
| `www.thesportsdb.com` | 2 | TheSportsDB | cron (analyse) |
| `v3.football.api-sports.io` | 2 | API-Football — **compte suspendu depuis le 21/08** | cron (analyse) |
| `api.telegram.org` | 1 | Telegram | diffusion + polling Nexus |
| `api.anthropic.com` | 5 | Anthropic — **crédits épuisés** | voir ci-dessous |
| `www.googleapis.com` | 6 | Google (agents Nexus) | Nexus |
| `api.render.com`, `api.github.com`, `api.stripe.com`, `api.brevo.com` | 12 | Nexus / outillage | Nexus, scripts |
| `pronosight2.onrender.com` | 8 | auto-appel (keepalive) | scheduler + server |

## Appels Anthropic résiduels — à instruire en phase 1

La cascade Victor est Gemini → Gemma → Groq. Anthropic n'en fait plus partie, et les crédits
du compte sont épuisés (constaté dans les logs Render du 17/08 :
`credit balance is too low`). Cinq appels subsistent :

| Fichier:ligne | Contexte | Chemin |
|---|---|---|
| `victor/patterns.js:306` | `discoverNewPatterns()` | **chemin Victor** — exécuté par le job `weekly-review` (dimanche 01:00) |
| `nexus/lib/ai.js:36` | moteur Nexus | Nexus (repli Groq en place) |
| `nexus/agents/visionAgent.js:60` | agent vision | Nexus |
| `nexus/routes/chat.js:216` | chat web | Nexus |
| `scripts/generate-picks.js:14` | script ponctuel | manuel |

Le premier est le seul dans le chemin Victor : il tourne chaque dimanche et échoue depuis au
moins le 17/08. À vérifier en phase 1 : l'échec est-il journalisé, et le recalcul des patterns
est-il dégradé en conséquence ?

## Clients

- **PostgreSQL** : un seul pool, `db/database.js:13` (`max: 5`, `idleTimeoutMillis: 30000`,
  `connectionTimeoutMillis: 5000`). Aucun `new Pool()` dans une fonction — bon point.
- **Telegram** : `bot/telegram.js:18` (envoi seul, pas de polling) et
  `nexus/telegramHandler.js:130` (polling, intervalle 2 s).
- **Frontend** : 15 `fetch` dans `public/` — à confronter en phase 1 à l'axe A8 (aucune clé
  d'API ne doit y transiter).

## Routes qui relaient un service payant

Deux routes serveur transforment une requête HTTP anonyme en dépense :

- `POST /api/gemini` (`server.js:135`) → `generativelanguage.googleapis.com`
- `GET /api/odds/:sportKey` (`server.js:241`) → `api.the-odds-api.com`

Voir `findings.jsonl` : F-001 et F-002.
