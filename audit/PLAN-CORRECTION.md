# PLAN DE CORRECTION

Ordre imposé par la méthode : **P0 sécurité → garde-fous de coût → fiabilité → intégrité des
résultats → observabilité → qualité prédictive → dette.**

Rien n'est codé avant validation. Un commit par finding, message `fix(F-0xx): …`, et un test
qui échoue avant / passe après dès que le comportement est testable sans réseau.

## Lot A — Sécurité (à faire aujourd'hui)

| # | Finding | Action | Effort | Dépendance |
|---|---|---|---|---|
| 1 | **F-012** | **Régénérer `VICTOR_API_KEY` sur Render.** Action de Roberto, pas de code. Seule correction possible : réécrire l'historique ne rattrape pas les clones. | S | aucune |
| 2 | **F-001** | `/api/odds/:sportKey` — authentifier ou supprimer. Si conservée : forcer `regions` et `markets` côté serveur au lieu de les lire dans la query | S | vérifier l'usage réel dans `public/` |
| 3 | **F-002** | `/api/gemini` — authentifier ou supprimer | S | idem |
| 4 | **F-004** | `/api/football-data/*` — authentifier ou supprimer | S | idem |
| 5 | **F-005** | `/api/apifootball/*` — supprimer (compte suspendu) | S | trancher F-024 en même temps |

**Vérifié le 03/09 — les cinq proxys sont bien utilisés par le frontend** (`public/js/modules/api.js` :
3 appels à `/api/gemini`, 2 à `/api/odds`, 2 à `/api/football-data`, 2 à `/api/tsdb`, 2 à
`/api/apifootball`). Les supprimer casserait l'analyse manuelle du site.

Cela ferme la solution la plus simple et impose de choisir :

- **Authentifier au sens strict** suppose un compte utilisateur et une session côté serveur.
  Poser une clé partagée dans le JavaScript du navigateur reproduirait exactement F-012 — c'est
  ce qui a été corrigé le 05/08, il ne faut pas le refaire.
- **Rendre les routes inoffensives sans authentification**, ce qui est réaliste tout de suite :
  1. figer `regions` et `markets` côté serveur sur `/api/odds` — supprime le multiplicateur de
     crédits, qui est le cœur de F-001 ;
  2. liste blanche de chemins sur `/api/football-data` et `/api/apifootball` ;
  3. liste blanche de modèles et plafond de `maxTokens` sur `/api/gemini` ;
  4. **disjoncteur budgétaire global** : au-delà d'un seuil journalier lu dans `usage_log`
     (lot B), les routes publiques refusent avant d'appeler le fournisseur.

Le point 4 est le seul garde-fou structurel : les trois autres réduisent le coût unitaire d'un
abus, lui seul en borne le total. C'est pourquoi le lot B ne peut pas attendre le lot A.

**Ordre révisé** : faire d'abord les points 1 à 3 ci-dessus (une heure, effet immédiat sur le
coût unitaire), puis le lot B, puis l'authentification réelle quand il y aura des comptes.

## Lot B — Garde-fous de coût et de quota

| # | Finding | Action | Effort |
|---|---|---|---|
| 6 | **F-023** | Table `usage_log` + compteur journalier persisté. Migration numérotée 013, schéma régénéré par introspection (règle `CLAUDE.md`) | M |
| 7 | **F-023** | Alerte Telegram à 70 % puis 90 % du quota mensuel The Odds API | S |
| 8 | **F-008** | Plafonner les deux caches mémoire (LRU) et dériver `cacheKey` côté serveur | S |

## Lot C — Fiabilité

| # | Finding | Action | Effort |
|---|---|---|---|
| 9 | **F-017** | Propager un `AbortSignal` à `runVictor` pour que le plafond de 12 min annule réellement le travail, au lieu de l'abandonner en laissant un second démarrer | M |
| 10 | **F-014** | Faire remonter à la sentinelle Telegram l'échec d'ajout d'un job par le cron | S |
| 11 | **F-026** | Compter les bascules Gemini → Gemma, alerter au-delà d'un seuil hebdomadaire | S |
| 12 | **F-015** | Supprimer le keepalive en double dans `cron/scheduler.js` | S |

## Lot D — Intégrité des résultats

| # | Finding | Action | Effort |
|---|---|---|---|
| 13 | **F-018** | `teamsMatch` : exiger un recouvrement **strictement supérieur** à 0,5, privilégier `fixtureId`, et refuser l'appariement si plusieurs fixtures du jour correspondent. Tests sur les 5 cas réels (Manchester, Real Madrid, Milan, Atlético) | M |
| 14 | **F-019** | Ne renseigner `resultat_reel` que si la notation a abouti, pour qu'un échec IA passager reste rejouable | S |
| 15 | **F-022** | `prematchWorker` ne diffuse que ce que la base a confirmé, comme le fait déjà `valueWorker` | S |
| 16 | **F-021** | Renvoyer `null` sur l'égalité exacte (push) pour `OU`, `TT` et `AH` | S |

## Lot E — Observabilité et qualité prédictive

| # | Finding | Action | Effort |
|---|---|---|---|
| 17 | **F-016** | Colonne `moteur` sur `ps_pronostics` (migration 014), alimentée depuis `result.moteur` ; faire remonter le moteur par `valueWorker` | S |
| 18 | **F-020** | Porter le plancher 0,55 dans `validerEvent`, vérifier la cohérence confiance/probabilité, **et corriger l'affirmation inexacte du prompt** | S |
| 19 | **F-007** | Séparer le public du réservé sur les quatre routes de pronostics ; paginer `/history` | M |
| 20 | **F-011**, **F-009** | Réserver le détail de configuration à un appel authentifié ; message générique + identifiant de corrélation au lieu de `err.message` | S |

## Lot F — Dette

| # | Finding | Action | Effort |
|---|---|---|---|
| 21 | **F-003** | Supprimer `discoverNewPatterns()` — redondant avec `computePatterns()` | S |
| 22 | **F-024** | Trancher api-football : support api-sports, ou retirer `AF_KEY` de Render | S |
| 23 | **F-013** | `dotenv.config()` sans `override`, ou conditionné à `NODE_ENV !== 'production'` | S |
| 24 | **F-025** | Relance unique respectant `retry_after` sur Telegram | S |
| 25 | **F-010** | `days` en paramètre lié avec `make_interval` | S |
| 26 | **F-006** | Borner la date de `/api/matchs` à une fenêtre courte + cache LRU | M |

## Ce que le plan ne couvre pas

**Les manques structurels** (calibration, CLV, Kelly, backtest) ne sont pas des correctifs :
ce sont des constructions. Ils viennent après, et dans cet ordre — la **calibration d'abord**,
parce que Kelly appliqué à des probabilités non calibrées augmente la mise précisément là où
le modèle se trompe le plus.

**La lecture de `nexus/` (78 fichiers) et de `public/` (10 fichiers)** reste à faire. Le lot A
en dépend partiellement : savoir si le frontend utilise les proxys détermine s'il faut les
authentifier ou les supprimer.
