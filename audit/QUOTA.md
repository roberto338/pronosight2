# QUOTA — Combien d'analyses par jour avant saturation ?

Mesures du 03/09/2026. Tout chiffre non marqué `[HYPOTHÈSE]` vient d'une constante lue dans le
code, d'un en-tête HTTP relevé sur un appel réel, ou d'une ligne de log Render.

## 3.1 — L'unité de travail n'est pas ce que l'on croit

**Une analyse n'est pas un match.** Le pipeline traite **tous les matchs du jour en un seul
appel IA**. Le 03/09 : `🤖 Analyse IA de 26 match(s) réel(s)` puis un unique appel Gemini.

La conséquence change tout le modèle : **le coût ne suit pas le nombre de matchs, il suit le
nombre de compétitions**, qui détermine les appels de cotes et de statistiques.

Séquence exacte d'un run (`victor/core.js:447-700`) :

| Étape | Fichier:ligne | Coût externe |
|---|---|---|
| Calendrier Odds API | `odds.js:175` (`/events`) | **0 crédit** — endpoint gratuit |
| Matchs du jour (4 sources) | `sources.js:322` | football-data 1, TheSportsDB n, api-football 1 (suspendu) |
| Indice de forme | `sources.js:363` | 2 requêtes football-data |
| Classement | `sources.js:419` | 1 req / compétition |
| Confrontations directes | `sources.js:474` | 1 req / match (max 4) |
| Buteurs | `sources.js:446` | 1 req / compétition |
| Cotes du marché | `odds.js:227` | **2 crédits / compétition** |
| Patterns | `core.js` (`ps_victor_patterns`) | 1 requête Neon |
| Appel IA | `core.js:589` | **1 appel** pour tous les matchs |
| Sauvegarde + diffusion | `core.js:657`, `bot/telegram.js` | n requêtes Neon + 1 message |

## 3.2 — Fan-out mesuré (analyse du 03/09, 07:00)

```
07:00:07  The Odds API : 18 matchs sur 47 compétitions        → 0 crédit
07:00:11  Sources : football-data=2 · thesportsdb=12 · odds-api=18 → 31 uniques
07:00:13  Indice de forme : 186 équipes (2 requêtes)
07:00:13  Classement : 2 compétitions
07:00:13  H2H : 2 matchs
07:00:14  Buteurs : 20 équipes
07:00:14  Cotes : 2 compétitions interrogées → 4 crédits, 484 restants
07:00:16  Analyse IA de 26 matchs → 1 appel
07:01:52  Moteur : Gemma (Gemini a échoué)
```

| Service | Par run | Détail |
|---|---|---|
| The Odds API `/events` | 1 appel, **0 crédit** | `odds.js:175` |
| The Odds API `/odds` | **4 crédits** (2 compétitions × 2) | `odds.js:227` |
| football-data | ~8 requêtes | forme 2 + classement 2 + H2H 2 + buteurs 2 |
| TheSportsDB | 1 par sport | clé gratuite « 3 », plafonnée à 3 évènements |
| api-football | 2 appels **perdus** | compte suspendu (F-024) |
| Cascade IA | 1 appel abouti, **2 tentés** un jour sur deux | Gemini échoue 3 matins sur 6 (F-026) |
| Neon | ~15 requêtes | patterns, insertions, jobs |
| Telegram | 1 message | si ≥ 1 pronostic |

**Point clé sur les crédits** : un crédit n'est pas une requête. `regions=eu&markets=h2h,totals`
= 1 × 2 = **2 crédits par compétition** (`odds.js:41`, `CREDITS_PAR_COMPET`).

## 3.4 — Limites réelles

| Fournisseur | Limite | Source de la mesure |
|---|---|---|
| **The Odds API** | 500 crédits/mois, cycle **calendaire** | En-têtes `x-requests-remaining` / `-used` : 472 utilisés le 31/08, remis à 4 le 01/09 |
| **football-data** | **10 req/min**, 12 compétitions | Palier gratuit vérifié par `/v4/competitions` (12 TIER_ONE + Copa Libertadores) ; limiteur interne à 9/min (`sources.js`) |
| **Gemini / Gemma** | RPM, RPD, TPM `[HYPOTHÈSE]` | Non relevés — à confirmer dans la console Google AI Studio |
| **Groq** | RPD `[HYPOTHÈSE]` | Non relevé — en-têtes `x-ratelimit-*` disponibles sur un appel réel |
| **Neon** | plan payant depuis le 18/08 | Pooler utilisé, `max: 5` connexions |
| **Render** | à confirmer | — |

## 3.5 — Calcul

```
N_jour = min(
  crédits_restants / (jours_restants × crédits_par_run),
  débit_football-data × fenêtre / requêtes_par_run,
  RPD_modèle / appels_IA_par_run
)
```

Résultat au 03/09 (484 crédits restants, 27 jours, 2 compétitions/run) :

| Ressource | Limite | Coût / run | Runs/jour max | Limitant ? |
|---|---|---|---|---|
| The Odds API | 500/mois — 484 restants | 4 crédits | **4** | |
| football-data | 10 req/min | 8 req sur ~2 min | **2** | ◄── **OUI** |
| Gemini (RPD) `[HYPOTHÈSE]` | 200/jour | 2 appels | 100 | |
| Groq (filet) `[HYPOTHÈSE]` | 1000/jour | 1 appel | 1000 | |

### Réponse binaire : The Odds API plafonne-t-elle avant les fournisseurs IA ?

**NON — et c'est un renversement par rapport à l'hypothèse de travail.**

Le 31/08, il restait 28 crédits sur 500 et The Odds API paraissait être le goulot. Le cache de
6 h déployé le soir même a fait tomber la consommation de ~15 à **4 crédits/jour** (mesuré les
01, 02 et 03/09 : 496 → 484). À ce rythme, 120 crédits par mois sur 500 : **la marge est de
4 fois**.

Le facteur limitant est désormais le **débit de football-data** : 10 requêtes/minute pour
~8 requêtes par run, ce qui autorise 2 runs concurrents. C'est exactement le rythme actuel
(07:00 et 13:00) — le système tourne **à sa limite**, sans marge.

## Conclusion

- **Goulot réel** : le débit football-data, pas les crédits de cotes.
- **Rythme recommandé** : 2 runs/jour, le rythme actuel. Toute analyse supplémentaire dans la
  même fenêtre saturerait le débit et dégraderait la couche statistique.
- **Le vrai plafond n'est pas un quota, c'est la couverture** : 2 compétitions cotées le 03/09
  contre 5 le 31/08. Ce qui limite Victor, ce n'est pas le nombre d'analyses possibles, c'est
  le nombre de matchs sur lesquels il dispose à la fois de cotes et de statistiques.

### Les trois leviers qui déplacent ce plafond

1. **Partager le limiteur football-data** entre `victor/sources.js` et le proxy
   `/api/football-data/*` (F-004). Aujourd'hui deux consommateurs indépendants se disputent
   les mêmes 10 req/min — et le second est ouvert à l'internet.
2. **Mettre en cache les données stables** (classements, buteurs) : elles changent une fois par
   journée de championnat, pas deux fois par jour. Diviserait par deux les requêtes par run.
3. **Passer football-data au palier Standard** (49 €/mois, 30 compétitions au lieu de 12,
   60 req/min au lieu de 10). C'est le seul levier qui augmente à la fois le débit ET la
   couverture — donc le nombre de matchs réellement analysables.

Le point 1 et le point 2 sont gratuits. Le point 3 se justifie quand il y aura des abonnés.
