# PronoSight v4.0 — Architecture Sécurisée

## Quoi de neuf ?

### 🔒 Sécurité (Critique → Résolu)
- **Backend Express** proxy toutes les API (Claude, Odds, football-data, TheSportsDB)
- **Zéro clé API exposée** côté client — tout dans `.env` sur le serveur
- **Helmet** pour les headers de sécurité + CSP
- **Rate limiting** par route (15 req/min Claude, 20 req/min Odds)

### 📦 Maintenabilité (Élevée → Résolu)
- **HTML** pur (383 lignes) — plus d'inline scripts ni styles
- **CSS** externalisé (`main.css`, 680 lignes)
- **JS modulaire** ES6 avec imports :
  - `app.js` — entry point (1126 lignes)
  - `modules/config.js` — constantes, ligues, mappings
  - `modules/state.js` — gestion d'état centralisée
  - `modules/api.js` — toutes les API via `/api/*` proxy

### 🛡️ Fiabilité (Moyenne → Résolu)
- **Plus de proxies CORS publics** (corsproxy.io, allorigins)
- **TheSportsDB** passe par `/api/tsdb/` — zéro CORS
- **football-data.org** passe par `/api/football-data/` — zéro CORS
- **Gestion d'erreurs** améliorée (quota, rate limit, clé invalide)

## Démarrage rapide

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer les clés API
cp .env.example .env
# Éditer .env avec tes clés (seule ANTHROPIC_API_KEY est obligatoire)

# 3. Lancer le serveur
npm start
# ou en mode dev (auto-reload)
npm run dev

# 4. Ouvrir dans le navigateur
# http://localhost:3000
```

## Structure

```
pronosight/
├── server.js              ← Backend Express (proxy API, sécurité)
├── .env                   ← Clés API (JAMAIS commité)
├── .env.example           ← Template
├── package.json
├── public/
│   ├── index.html         ← HTML pur, pas d'inline
│   ├── css/
│   │   └── main.css       ← Tous les styles
│   └── js/
│       ├── app.js         ← Entry point ES6 module
│       └── modules/
│           ├── config.js  ← Ligues, constantes
│           ├── state.js   ← État global
│           └── api.js     ← Appels API (via backend proxy)
```

## Routes API (backend)

| Route | Source | Clé requise |
|-------|--------|-------------|
| `POST /api/claude` | Anthropic | `ANTHROPIC_API_KEY` |
| `GET /api/odds/:sport` | The Odds API | `ODDS_API_KEY` |
| `GET /api/football-data/*` | football-data.org | `FOOTBALL_DATA_KEY` |
| `GET /api/tsdb/*` | TheSportsDB | (gratuit) |
| `GET /api/status` | — | — |

## Prochaines étapes

1. **Splitter `app.js`** en modules plus petits (analyse, history, live, combos...)
2. **Ajouter des tests** (Jest ou Vitest)
3. **Docker** pour le déploiement
4. **WebSocket** pour les scores live temps réel
