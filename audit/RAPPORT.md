# RAPPORT D'AUDIT — PronoSight

Audit du 03/09/2026. Lecture seule : aucune modification apportée au code pendant les phases 0 à 3.

## Résumé exécutif

**Couverture** — 12 fichiers audités en profondeur sur 126 suivis par git (27 023 lignes au total).
Les fichiers lus couvrent 100 % du chemin qui produit et note les pronostics : `server.js`,
`cron/scheduler.js`, `config/env.js`, l'ensemble de `queues/`, et le cœur de `victor/`
(`core.js`, `paris.js`, `odds.js`, `sources.js`, `prompt.js`). Le solde — `nexus/` (78 fichiers,
module en veille) et `public/` (frontend) — reste à lire.

**Findings** — 26 constats : **4 P0**, **8 P1**, 7 P2, 7 P3.

**Les trois risques majeurs**

1. La clé `VICTOR_API_KEY` **en service aujourd'hui** est lisible dans l'historique d'un dépôt
   GitHub public depuis le 31/03 (F-012). Le retrait du 05/08 n'a rien corrigé.
2. Trois routes HTTP **sans authentification** transforment une requête anonyme en dépense :
   les crédits de cotes peuvent être vidés en moins de deux minutes, et le débit football-data
   dont dépend toute la couche statistique peut être saturé en permanence (F-001, F-002, F-004).
3. Le matching d'équipes confond des clubs distincts — Manchester United avec Manchester City,
   Real Madrid avec Real Sociedad. Un pronostic peut être noté avec le score d'un autre match,
   et donc fausser le taux de réussite (F-018). Vérifié : ce n'est pas encore arrivé sur les
   69 pronostics notés, mais le risque devient actuel maintenant que Victor publie sur la Liga
   et la Premier League.

**Réponse chiffrée au quota** — le goulot n'est PAS celui qu'on croyait. Depuis le cache de
6 h déployé le 31/08, la consommation The Odds API est tombée à **4 crédits/jour** (mesuré les
01, 02 et 03/09), soit 120 sur 500 par mois. Le facteur limitant est désormais le **débit de
football-data** : 10 requêtes/minute pour 8 requêtes par run, ce qui autorise **2 runs
simultanés** — exactement le rythme actuel. Détail dans `QUOTA.md`.

---

## Findings

### [P0] F-001 — GET /api/odds/:sportKey est ouvert à l'internet et laisse le client choisir le nombre de crédits consommés

**Emplacement** : `server.js` — 241-262  
**Axe** : A1 · **Effort** : S

**Constat**

app.get('/api/odds/:sportKey', oddsLimiter, ...) — aucune vérification d'identité. Les paramètres regions et markets sont repris de req.query et transmis tels quels à The Odds API (server.js:249-256). oddsLimiter (server.js:67) autorise 20 requêtes/minute par IP.

**Impact**

The Odds API facture regions x markets. Un appel forge avec regions=us,uk,eu,au&markets=h2h,spreads,totals,outrings coute 16 credits. 20 req/min x 16 = 320 credits/minute depuis une seule IP. Le quota mensuel entier (500) est epuise en moins de 2 minutes, et Victor ne peut plus calculer aucune value ni publier de pronostic tant que le cycle n'a pas redemarre.

**Correctif**

Authentifier la route, ou la supprimer si le frontend ne s'en sert pas. A defaut : forcer regions et markets cote serveur au lieu de les lire dans la query, et brancher le compteur de credits sur un disjoncteur.

---

### [P0] F-002 — POST /api/gemini est un proxy LLM ouvert : le client choisit le modele, les messages et le plafond de tokens

**Emplacement** : `server.js` — 135-152  
**Axe** : A1 · **Effort** : S

**Constat**

app.post('/api/gemini', geminiLimiter, ...) — aucune verification d'identite. Le corps fournit messages, model, maxTokens, useSearch et jsonMode (server.js:142). geminiLimiter (server.js:60) autorise 12 requetes/minute par IP.

**Impact**

N'importe qui peut faire repondre la cle Gemini de Roberto sur le sujet de son choix, en choisissant le modele et jusqu'a 4096 tokens par defaut. Le quota journalier Gemini est la ressource dont depend la production de pronostics : son epuisement par un tiers arrete Victor. Le fallback Gemma partage la meme cle Google.

**Correctif**

Authentifier la route ou la supprimer. Si elle sert au frontend, la restreindre a une liste blanche de modeles et de tailles, et compter la consommation par IP dans usage_log.

---

### [P0] F-004 — GET /api/football-data/* est ouvert et permet de saturer en permanence les 10 req/min dont Victor depend

**Emplacement** : `server.js` — 277-305  
**Axe** : A1 · **Effort** : S

**Constat**

app.get('/api/football-data/*', generalLimiter, ...) — aucune authentification. req.params[0] est concatene tel quel dans l'URL amont (server.js:284-286). generalLimiter autorise 60 requetes/minute par IP.

**Impact**

football-data plafonne a 10 requetes/minute, toutes cles confondues. 60 req/min depuis une seule IP saturent ce debit six fois. Or football-data est la SEULE source de statistiques de Victor (forme, classement, H2H, buteurs) : un tiers peut donc, sans authentification, priver l'analyse de 7h de tout contexte statistique. Le chemin amont n'est pas valide non plus : n'importe quel endpoint football-data est atteignable via le proxy.

**Correctif**

Authentifier ou supprimer la route. Si le frontend s'en sert, restreindre a une liste blanche de chemins et partager le limiteur de debit avec victor/sources.js au lieu d'avoir deux consommateurs concurrents.

---

### [P0] F-012 — La cle VICTOR_API_KEY actuellement en service figure dans l'historique d'un depot public

**Emplacement** : `public/js/app.js (historique)` — commits 8a062c6 -> cdef5f8  
**Axe** : A1 · **Effort** : S

**Constat**

git log --all -S <valeur de VICTOR_API_KEY lue dans .env> renvoie 2 commits : 8a062c6 (31/03/2026, ajout dans le code client) et cdef5f8 (05/08/2026, retrait). L'API GitHub confirme roberto338/pronosight2 avec private=false. La valeur trouvee dans l'historique est identique a celle utilisee en production aujourd'hui (64 caracteres).

**Impact**

Quatre mois d'exposition publique. Le retrait du 05/08 n'a rien corrige : la valeur reste lisible par quiconque clone le depot. Cette cle protege POST /api/victor/refresh (declenche une analyse complete : appels IA, credits The Odds API, diffusion Telegram aux abonnes) et sert de repli d'authentification a toute l'API Nexus. 0 fork et 0 star au 03/09, mais l'absence de clone constate n'est pas une garantie.

**Correctif**

Regenerer VICTOR_API_KEY sur Render. C'est la SEULE action qui corrige : reecrire l'historique ne rattrape pas les clones deja faits. Verifier au passage que NEXUS_API_KEY, definie depuis, n'a jamais transite par le code client.

---

### [P1] F-005 — GET /api/apifootball/* est ouvert et relaie la cle x-apisports-key sans validation de chemin

**Emplacement** : `server.js` — 338-354  
**Axe** : A1 · **Effort** : S

**Constat**

app.get('/api/apifootball/*', generalLimiter, ...) — aucune authentification, req.params[0] concatene dans l'URL (server.js:343), aucune verification du corps de reponse.

**Impact**

Severite limitee aujourd'hui car le compte api-football est suspendu depuis le 21/08 : la route ne rend rien d'exploitable. Elle redeviendra un P0 identique a F-004 le jour ou le compte sera reactive. A noter : contrairement aux autres proxys, celui-ci ne teste meme pas resp.ok — or cette API repond HTTP 200 avec l'erreur dans le corps.

**Correctif**

Authentifier ou supprimer. Trancher en meme temps que le sort de l'integration api-football.

---

### [P1] F-006 — GET /api/matchs declenche une collecte multi-sources complete avec une cle de cache choisie par l'appelant

**Emplacement** : `server.js` — 581-626  
**Axe** : A1 · **Effort** : M

**Constat**

La date vient de req.query, validee par le seul regex ^d{4}-d{2}-d{2}$ (server.js:582). Le cache _cacheMatchs (server.js:578) est indexe sur cette date, sans plafond de taille ni eviction. En cas de miss, la route appelle getOddsEvents() puis getFixturesOfDay() (server.js:592-593), soit une vingtaine d'appels amont.

**Impact**

Deux effets. 1) Un appelant qui fait defiler des dates distinctes ne touche jamais le cache : chaque requete declenche une collecte complete et sature les 10 req/min de football-data, privant Victor de statistiques. 2) La Map grossit sans limite — chaque date connue ajoute une charge complete en memoire, jamais liberee.

**Correctif**

Authentifier, ou borner la date a une fenetre courte (J-7 a J+7) et plafonner la taille du cache avec eviction LRU.

---

### [P1] F-007 — Les quatre routes qui servent les pronostics renvoient SELECT * sans authentification : le contenu monetisable est gratuit

**Emplacement** : `server.js` — 384-515  
**Axe** : A8 · **Effort** : M

**Constat**

/api/victor/today (384), /stats (406), /patterns (468), /history (489) utilisent toutes SELECT * FROM ps_pronostics ou ps_victor_patterns et renvoient les lignes completes, protegees par le seul generalLimiter (60/min).

**Impact**

L'integralite du produit — pronostic, cote, analyse tactique, patterns, historique sur 90 jours — est recuperable en JSON par n'importe qui, sans compte. Un abonnement payant n'a aucun sens tant que la meme donnee est servie librement a cote. /history renvoie de plus toutes les lignes de la periode sans pagination.

**Correctif**

Separer ce qui est public (teaser, statistiques agregees) de ce qui est reserve, et authentifier le second. Ajouter une pagination bornee sur /history.

---

### [P1] F-016 — Le moteur IA qui a produit un pronostic n'est pas enregistré sur la ligne du pronostic

**Emplacement** : `victor/core.js + db/schema_neon.sql` — ps_pronostics (34 colonnes)  
**Axe** : A5 · **Effort** : S

**Constat**

ps_pronostics ne comporte aucune colonne moteur/modele (34 colonnes relevees par introspection le 03/09). Le moteur n'existe que dans victor_jobs.result, et seulement pour le job prematch : prematchWorker.js:51 renvoie moteur, valueWorker.js:49-55 ne le renvoie pas.

**Impact**

Une meme journee peut melanger deux moteurs. Releve des logs Render du 29/08 au 03/09 : Gemini a echoue un matin sur deux (30/08, 01/09, 03/09). Les 30/08 et 01/09 la reprise a rattrape avec Gemini ; le 03/09 c'est Gemma qui a ecrit les deux pronostics du jour, et le 21/08 Gemma avait deja ecrit les quatre pronostics apres un HTTP 503. Impossible aujourd'hui de dire, pour un pronostic donne, quel modele l'a produit — donc impossible de comparer la qualite des moteurs, alors que c'est exactement ce que melange un taux de reussite agrege.

**Correctif**

Ajouter une colonne moteur (et modele) a ps_pronostics via une migration numerotee, l'alimenter depuis result.moteur deja disponible dans runVictor, et faire remonter le moteur par valueWorker comme le fait prematchWorker.

---

### [P1] F-017 — Le plafond de duree n'interrompt pas le traitement : il l'abandonne, et un second peut demarrer en parallele

**Emplacement** : `queues/workerManager.js` — 203-215  
**Axe** : A2 · **Effort** : M

**Constat**

Promise.race([processor(job), <timeout JOB_TIMEOUT_MS>]) — la course rejette au bout de 12 minutes, mais rien n'annule processor(job), qui continue de s'executer. Le job repasse alors en 'pending' (branche catch) et sera reclame au tour suivant, lançant un SECOND runVictor pendant que le premier tourne toujours.

**Impact**

Deux pipelines concurrents sur la meme journee. Chacun peut atteindre broadcastDaily() et diffuser aux abonnes : doublon de message Telegram. Le garde-fou de deduplication en base (migration 010) empeche le doublon de ligne, pas le doublon d'envoi. Le cas ne s'est pas produit depuis que les executions durent 20 a 190 secondes, mais rien ne l'empeche structurellement.

**Correctif**

Passer un AbortSignal a runVictor et le propager aux fetch, pour que le depassement annule reellement le travail. A defaut, marquer le job comme non reclamable tant que le processeur precedent n'a pas rendu la main.

---

### [P1] F-018 — teamsMatch confond des clubs distincts qui partagent un mot : Manchester United avec Manchester City, Real Madrid avec Real Sociedad

**Emplacement** : `victor/core.js` — 979-1004  
**Axe** : A7 · **Effort** : M

**Constat**

La derniere passe de teamsMatch (core.js:996-1001) accepte un recouvrement de tokens des que shared.length / min(tokA, tokB) >= 0.5. Pour deux noms de deux mots partageant le premier, le ratio vaut exactement 0.5 et la comparaison passe. Verifie par execution le 03/09 : matchFixture('Manchester United vs Arsenal', [Manchester City 3-0 Arsenal]) renvoie le match de City ; 'Real Madrid vs Barcelona' renvoie Real Sociedad 1-4 Barcelona ; 'Milan vs Napoli' renvoie Inter Milan (via la regle de sous-chaine, core.js:985) ; 'Atletico Madrid vs Sevilla' renvoie Real Madrid 5-0 Sevilla. 5 faux positifs sur 7 cas testes.

**Impact**

Un faux positif ecrit le score d'un AUTRE match dans resultat_reel et note le pronostic gagne ou perdu sur cette base. Le taux de reussite, seule metrique qui justifierait un abonnement, s'en trouve fausse sans aucun signal. matchFixture retourne de plus le PREMIER candidat trouve (core.js:1015) sans arbitrer entre plusieurs correspondances possibles. Verification sur les 69 pronostics deja notes : aucune notation erronee a ce jour — les competitions couvertes jusqu'ici (Copa Libertadores, Championship, Eredivisie) n'ont pas presente de paire ambigue. Le risque devient actuel maintenant que Victor publie sur la Liga et la Premier League, ou Real Madrid et Real Sociedad, ou les deux Manchester, jouent le meme jour.

**Correctif**

Utiliser fixtureId quand il existe des deux cotes plutot que le nom. Pour le repli textuel : exiger un recouvrement strictement superieur a 0.5, ou refuser tout appariement lorsque plusieurs fixtures du jour correspondent, et journaliser l'ambiguite au lieu de choisir la premiere.

---

### [P1] F-020 — Le seuil de probabilite de 0.55 et la coherence confiance/probabilite sont annonces dans le prompt mais absents du code

**Emplacement** : `victor/prompt.js + victor/core.js` — prompt.js:178-179, core.js:1040-1082 (validerEvent)  
**Axe** : A6 · **Effort** : S

**Constat**

prompt.js:179 impose 'En dessous de 0.55 -> NE PAS proposer le pari du tout' et prompt.js:241 exige une confiance coherente avec la probabilite. Dans core.js, le mot probabilite n'apparait qu'a la ligne 648, dans le schema JSON envoye au modele. validerEvent (core.js:1040-1082) controle les equipes, le code de pari, le caractere notable et la plausibilite de la cote — jamais la probabilite ni sa coherence avec la confiance.

**Impact**

La value est calculee par p x cote - 1 et le pari est rejete si elle est negative. Ce garde-fou depend donc entierement d'un nombre que le modele s'attribue lui-meme, sans plancher ni verification. Une probabilite gonflee de 0.54 a 0.90 sur une cote a 1.85 fait passer de -0.001 a +0.665 : le pari est publie alors qu'il est perdant sur la duree. Le prompt affirme d'ailleurs (prompt.js:168-172) que gonfler les probabilites 'ne fera pas passer plus de paris' — c'est inexact, et le modele n'a aucun moyen de le verifier.

**Correctif**

Porter le plancher 0.55 dans validerEvent, verifier la coherence entre confiance et probabilite, et corriger l'affirmation du prompt. A terme, mesurer la calibration (voir Manques structurels) : c'est la seule facon de savoir si un 0.70 annonce vaut 0.70.

---

### [P1] F-023 — Aucune table de suivi de consommation : la question du quota restera une estimation

**Emplacement** : `db/schema_neon.sql` — 19 tables  
**Axe** : A9 · **Effort** : M

**Constat**

Introspection de la prod le 03/09 : 19 tables, aucune ne porte sur l'usage, le cout, les tokens ou le quota (nexus_* x14, ps_* x4, victor_jobs). Les seules traces de consommation sont des lignes de log Render, effacees au bout de trois semaines — verifie pendant cet audit, les logs anterieurs au 12/08 avaient deja disparu.

**Impact**

Impossible de repondre avec certitude a 'combien d'analyses par jour avant saturation'. Le compteur de credits The Odds API n'existe qu'en memoire du process et disparait a chaque redeploiement. Aucune alerte n'est possible a 70 % ou 90 % d'un plafond : le 31/08, il restait 38 credits sur 500 et rien ne l'avait signale — c'est l'audit qui l'a decouvert. Les tokens IA consommes ne sont journalises nulle part, ce qui rend la section 3.3 du modele de quota dependante de mesures ponctuelles au lieu d'un historique.

**Correctif**

Creer une table usage_log (date, service, endpoint, unites, tokens_entree, tokens_sortie, cout_estime) alimentee a chaque appel externe, plus un compteur journalier persiste et un seuil d'alerte. C'est le prerequis de tout garde-fou budgetaire.

---

### [P2] F-008 — Deux caches en memoire sans plafond ni eviction, alimentes par des cles que l'appelant choisit

**Emplacement** : `server.js` — 105-106,145-157,578-588  
**Axe** : A1 · **Effort** : S

**Constat**

analysisCache = new Map() (server.js:105) est alimente par cacheKey issu de req.body (server.js:142,157). _cacheMatchs = new Map() (server.js:578) est alimente par req.query.date. Aucun des deux n'a de taille maximale : la TTL n'est verifiee qu'a la lecture, jamais pour supprimer une entree.

**Impact**

Croissance memoire non bornee depuis deux endpoints anonymes. De plus, cacheKey etant fourni par le client sur /api/gemini, une reponse produite par un appelant peut etre servie a un autre qui utiliserait la meme cle — empoisonnement de cache si le frontend emploie des cles previsibles.

**Correctif**

Plafonner les deux caches (LRU), purger les entrees expirees periodiquement, et deriver cacheKey cote serveur au lieu de l'accepter du client.

---

### [P2] F-009 — Cinq routes renvoient err.message brut au client

**Emplacement** : `server.js` — 270,303,352,624,639  
**Axe** : A1 · **Effort** : S

**Constat**

res.status(500).json({ error: err.message }) aux lignes 270 (odds), 303 (football-data), 352 (apifootball), 639 (queue-status) ; res.json({ error: 'Calendrier indisponible', detail: err.message }) ligne 624.

**Impact**

Le message d'erreur interne fuit vers l'appelant : noms d'hote amont, messages de la couche pg, details de configuration. Aucune fuite de cle constatee dans le code lu, mais la surface est ouverte et evoluera avec le code.

**Correctif**

Journaliser le detail cote serveur, renvoyer un message generique et un identifiant de correlation au client.

---

### [P2] F-013 — dotenv.config({ override: true }) inverse la precedence : un fichier .env bat l'environnement de la plateforme

**Emplacement** : `config/env.js` — 23  
**Axe** : A1 · **Effort** : S

**Constat**

config/env.js:23. En production, Render injecte les variables dans le process ; avec override:true, tout fichier .env present dans l'image les ecraserait silencieusement. .env est bien gitignore (.gitignore:2) et absent du depot — le risque est donc conditionnel, pas actuel.

**Impact**

Deux consequences. 1) Si un .env arrive un jour dans l'image deployee, il prend le pas sur la configuration Render sans aucun signal. 2) En local, il devient impossible de surcharger une variable en ligne de commande : verifie le 18/09 pendant cet audit — un demarrage lance avec TELEGRAM_BOT_TOKEN vide et une DATABASE_URL bidon a malgre tout utilise le vrai jeton et la vraie base.

**Correctif**

Passer a dotenv.config() sans override, pour que l'environnement du process fasse foi. Si le comportement inverse est voulu en developpement, le conditionner a NODE_ENV !== 'production'.

---

### [P2] F-014 — L'echec d'ajout d'un job planifie n'est signale que par une ligne de console

**Emplacement** : `cron/scheduler.js` — 26-33  
**Axe** : A9 · **Effort** : S

**Constat**

enqueue() capture l'erreur, la journalise et poursuit (cron/scheduler.js:30-32). Aucune alerte, aucune trace en base.

**Impact**

Constate le 18/08 : la base Neon etant injoignable, le cron de 7h n'a pas pu creer son job. Rien n'a alerte, et l'absence de pronostic a ete decouverte par Roberto plusieurs heures plus tard. La sentinelle ajoutee depuis (queues/workerManager.js) couvre l'indisponibilite vue par le worker, mais pas l'echec d'insertion vu par le cron.

**Correctif**

Faire remonter l'echec a la sentinelle Telegram, ou consigner l'echec dans une table job_runs relue par le heartbeat.

---

### [P2] F-019 — Un echec passager de l'arbitrage IA rend le pronostic definitivement non notable

**Emplacement** : `victor/core.js` — 1357-1386  
**Axe** : A7 · **Effort** : S

**Constat**

Si callAI echoue, l'erreur est capturee (core.js:1370-1373) et pronosticCorrect reste null. L'UPDATE de la ligne 1377 s'execute malgre tout et renseigne resultat_reel. Or la requete de selection (core.js:1240-1241) ne reprend que les lignes ou resultat_reel IS NULL : le pronostic ne sera donc plus jamais represente a l'arbitrage.

**Impact**

Une indisponibilite momentanee des moteurs IA — Gemini 503 et Gemma 500 constates le 25/08 a 13:00, retrait du modele Groq constate le 18/08 — fige definitivement le pronostic en 'non note'. Il compte alors dans les 62 pronostics sans resultat sans qu'aucune trace n'indique pourquoi. Le chemin ne concerne que les pronostics anterieurs au vocabulaire ferme (pari_code), evaluerCode couvrant desormais tous les codes.

**Correctif**

Ne renseigner resultat_reel que si la notation a abouti, ou ajouter une colonne d'etat distinguant 'non notable' de 'notation echouee', cette derniere restant eligible a un nouveau passage.

---

### [P2] F-022 — Aucune transaction dans le depot : la diffusion Telegram peut annoncer des pronostics non enregistres

**Emplacement** : `db/database.js + victor/core.js` — database.js:62, core.js (boucle de sauvegarde)  
**Axe** : A3 · **Effort** : S

**Constat**

getClient() est exporte (db/database.js:62) mais n'est appele nulle part — grep sur BEGIN, COMMIT et getClient() dans victor/, queues/, bot/ et db/ ne renvoie que la definition. runVictor enregistre les pronostics un par un, puis prematchWorker diffuse result.events (prematchWorker.js:35), c'est-a-dire la liste EN MEMOIRE et non les lignes reellement ecrites.

**Impact**

Si une insertion echoue en cours de boucle — indisponibilite Neon, conflit inattendu — les abonnes recoivent un pronostic qui n'existe pas en base. Il ne sera jamais note, jamais compte dans le taux de reussite, et personne ne saura qu'il manque. Le job value est protege, lui : il ne diffuse que result.nouveaux, derive d'un RETURNING id (valueWorker.js:32,42).

**Correctif**

Aligner prematchWorker sur valueWorker : ne diffuser que ce que la base a confirme. La transaction n'est pas indispensable si la diffusion decoule de l'ecriture.

---

### [P2] F-026 — Gemini echoue un matin sur deux et la bascule vers Gemma n'alerte personne

**Emplacement** : `victor/core.js` — 219-245  
**Axe** : A5 · **Effort** : S

**Constat**

Releve des logs Render sur les analyses de 7h du 29/08 au 03/09 : Gemini echoue les 30/08, 01/09 et 03/09, soit un jour sur deux. La bascule est journalisee par un console.warn (core.js:229) et rien d'autre — ni compteur, ni alerte, ni trace en base.

**Impact**

Le repli n'est plus exceptionnel, il est routinier. Le 03/09, Gemma a produit les deux pronostics du jour ; le 21/08, les quatre. Gemma est un modele nettement plus faible, et la qualite des analyses en depend directement — sans que rien ne le signale ni ne permette de le mesurer a posteriori (voir F-016). Un taux de reussite calcule sur un melange Gemini/Gemma ne mesure aucun des deux.

**Correctif**

Compter les bascules et alerter au-dela d'un seuil hebdomadaire ; enregistrer le moteur sur la ligne du pronostic (F-016) pour rendre la comparaison possible. Verifier au passage si les 503 viennent du quota gratuit ou d'une saturation cote Google, ce qui orienterait vers un changement de modele ou de palier.

---

### [P3] F-003 — Appel Anthropic residuel et redondant dans le job hebdomadaire

**Emplacement** : `victor/patterns.js` — 306  
**Axe** : A5 · **Effort** : S

**Constat**

discoverNewPatterns() appelle fetch('https://api.anthropic.com/v1/messages'). Anthropic ne fait plus partie de la cascade Victor (Gemini -> Gemma -> Groq, victor/core.js:215-263). Les logs Render du 17/08 montrent 'credit balance is too low' sur ce compte.

**Impact**

Verifie le 03/09 : l'echec EST journalise (patterns.js:328, console.error) — il n'est donc pas silencieux, contrairement a l'hypothese de depart. Et la fonction est redondante : ps_victor_patterns continue de s'alimenter chaque semaine (3 patterns le 29/08, 6 le 22/08, 1 le 15/08) via computePatterns(), le calcul deterministe appele juste avant dans le meme job (workerManager.js:153). discoverNewPatterns() est donc du code mort qui echoue chaque dimanche sans consequence fonctionnelle, sur un compte dont les credits sont epuises.

**Correctif**

Supprimer discoverNewPatterns() et son appel, computePatterns() couvrant deja le besoin de facon deterministe. A defaut, la basculer sur callAI().

---

### [P3] F-010 — Interpolation de chaine dans une requete SQL — non exploitable en l'etat

**Emplacement** : `server.js` — 489-497  
**Axe** : A1 · **Effort** : S

**Constat**

INTERVAL '${days} days' avec days = Math.min(parseInt(req.query.days) || 30, 90). parseInt neutralise toute chaine non numerique (NaN -> 30), et Math.min borne le haut.

**Impact**

Aucun impact aujourd'hui : la valeur ne peut etre qu'un entier. Le signalement porte sur le motif, pas sur une faille : si la coercition disparait lors d'une modification ulterieure, l'injection devient immediate. Les 129 autres requetes du fichier sont parametrees.

**Correctif**

Passer days en parametre lie ($1) avec make_interval, pour supprimer le motif.

---

### [P3] F-011 — /api/status et /api/victor/status exposent publiquement l'inventaire de configuration

**Emplacement** : `server.js` — 359-377,644-701  
**Axe** : A1 · **Effort** : S

**Constat**

Les deux routes sont sans authentification et renvoient la presence de chaque cle API, le modele IA utilise, le commit et la branche deployes, l'uptime, l'etat de la base et les compteurs de la file.

**Impact**

Reconnaissance facilitee : un tiers connait la pile exacte, la version deployee et quels services sont configures. Aucune valeur secrete n'est renvoyee. Utile au diagnostic, ce qui justifie de les garder — mais pas en acces libre.

**Correctif**

Reserver le detail a un appel authentifie et ne laisser en public qu'un ok/degraded.

---

### [P3] F-015 — Keepalive en double, sans timeout et sans unref

**Emplacement** : `cron/scheduler.js` — 99-107  
**Axe** : A2 · **Effort** : S

**Constat**

Un setInterval de 10 min appelle /api/ping (cron/scheduler.js:99-106). server.js:797 en definit un second, identique, avec AbortSignal.timeout(15000) et .unref(). Celui du scheduler n'a ni l'un ni l'autre.

**Impact**

Deux pings au lieu d'un toutes les 10 minutes — sans consequence sur les quotas puisque /api/ping ne touche ni la base ni un service tiers. Le fetch sans timeout peut rester pendu, et l'absence de unref retarde un arret propre du process.

**Correctif**

Supprimer le doublon du scheduler et conserver celui de server.js, deja correct.

---

### [P3] F-021 — Un pari a seuil entier serait note perdant au lieu de rembourse

**Emplacement** : `victor/paris.js` — 104-122  
**Axe** : A7 · **Effort** : S

**Constat**

evaluerCode traite OU par total > seuil ou total < seuil (paris.js:105), TT de meme (paris.js:121), et AH par ecartVise + handicap > 0 (paris.js:116). Sur un seuil entier, l'egalite renvoie false dans les deux sens. parserCode accepte pourtant n'importe quel nombre (paris.js:46-66) : OU:OVER:2 ou AH:HOME:-1 sont des codes valides.

**Impact**

Chez un bookmaker, ces cas sont rembourses (push), pas perdus. Les compter comme perdus sous-estime le taux de reussite et fausse le rendement, la mise etant en realite rendue. Verification en base le 03/09 : les 14 codes distincts utilises a ce jour ont tous des seuils a virgule (0.5, 1.5, 2.5, 3.5, 215.5). Le cas ne s'est donc jamais produit — il reste ouvert tant que le vocabulaire accepte les entiers.

**Correctif**

Renvoyer null sur l'egalite exacte pour OU, TT et AH, afin que le pari soit traite comme non notable plutot que perdu ; ou restreindre parserCode aux seuils a virgule.

---

### [P3] F-024 — Deux appels par analyse vers un compte api-football suspendu depuis le 21/08

**Emplacement** : `victor/sources.js` — 323, 345  
**Axe** : A4 · **Effort** : S

**Constat**

getFixturesOfDay (sources.js:323) et getResultsOfDay (sources.js:345) appellent fetchApiFootball des que AF_KEY est definie. La cle l'est toujours sur Render (relevé du 25/08 : API_FOOTBALL_KEY et RAPIDAPI_KEY presentes). Le compte repond HTTP 200 avec errors.access depuis le 21/08.

**Impact**

Faible mais reel : deux appels reseau inutiles par analyse, soit environ quatre par jour, chacun avec son timeout. Aucun quota consomme puisque le compte est suspendu. A crediter : contrairement au proxy HTTP (F-005), ce chemin teste bien data.errors sur un HTTP 200 (sources.js:294-296) et journalise le rejet — la suspension est visible dans les logs a chaque analyse.

**Correctif**

Trancher : reactiver le compte via le support api-sports, ou retirer AF_KEY de Render pour que le code court-circuite proprement (sources.js:255 renvoie deja 'cle absente' sans appel reseau).

---

### [P3] F-025 — Le retry_after de Telegram n'est pas gere : un message limite est perdu

**Emplacement** : `bot/telegram.js` — 30-38  
**Axe** : A4 · **Effort** : S

**Constat**

send() (bot/telegram.js:30-38) delegue a bot.sendMessage sans traitement du code 429 ni du champ parameters.retry_after. Les appelants capturent l'exception et la journalisent (ex. bot/telegram.js:232 pour sendAlert), mais aucun ne reessaie.

**Impact**

Un message rejete pour depassement de debit est definitivement perdu. Le volume actuel — un broadcast par job, au plus trois par jour — est tres loin des plafonds Telegram, donc le cas ne s'est jamais produit. Il deviendrait actuel avec une diffusion par abonne plutot que sur un canal unique. A crediter : l'echec n'est pas avale, il est journalise.

**Correctif**

Ajouter une relance unique respectant retry_after avant d'abandonner.

---

## Manques structurels

Ces quatre briques **n'existent pas** dans le code. Ce ne sont pas des régressions : elles n'ont
jamais été construites. Elles sont donc exclues des compteurs P0–P3 ci-dessus.

Vérifié le 03/09 par recherche sur `kelly`, `brier`, `closing` et `backtest` : aucune occurrence.

| Brique | Ce qu'elle apporterait | Coût | À partir de quand |
|---|---|---|---|
| **Calibration** (Brier, log-loss) | Savoir si un « 70 % » de Victor vaut vraiment 70 %. C'est le seul contrôle possible sur `probabilite`, aujourd'hui non vérifiée (F-020) | S | Dès maintenant : 61 paris notés suffisent pour une première courbe |
| **CLV** (closing line value) | Meilleur indicateur précoce de qualité, bien avant que le ROI ne soit significatif | M — nécessite de stocker la cote au pronostic ET à la clôture | Dès maintenant, c'est ce qui fait gagner le plus de temps |
| **Kelly** | Dimensionnement des mises | S | Seulement une fois la calibration mesurée — sans elle, Kelly amplifie une erreur d'estimation |
| **Backtest** | Valider une stratégie sans attendre des mois | L | Quand l'historique dépassera ~200 paris |

L'ordre compte : **calibration d'abord**. Kelly sur des probabilités non calibrées augmente la
mise sur les paris où le modèle se trompe le plus.
