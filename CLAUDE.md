## Base de données — Règle de modification du schéma

Toute modification de structure BDD (table, colonne, index, contrainte) suit
obligatoirement ce processus, dans un seul et même changement (commit) :

1. Écrire une **migration numérotée** dans `nexus/migrations/`
   (suivant : `008_xxx.sql`, avec son runner `run_xxx.js` si besoin).
2. Appliquer la migration sur la base Neon de prod.
3. **Régénérer `db/schema_neon.sql` par introspection de la prod**
   (information_schema + pg_indexes + pg_constraint), jamais à la main.
4. Commiter migration + schéma régénéré ensemble.

**Ne JAMAIS éditer `db/schema_neon.sql` à la main.** Ce fichier est la source
de vérité de l'état de la base : il reflète la prod, il ne la précède pas.
Dernière régénération : 07/08/2026, après la migration 009
(19 tables — 4 ps_* + 14 nexus_* + victor_jobs).

L'étape 3 se fait avec **`node db/introspect.js`** (dump complet) ou
`node db/introspect.js <table>` (une seule table). C'est cet outil qui rend
la règle applicable — ne pas revenir à une mise à jour manuelle.

---

## Comportement par défaut — Critique systématique (Roberto Edition)

### Déclenchement automatique — sans phrase d'activation

Applique ce framework automatiquement dès que Roberto présente :
- une nouvelle idée business ou SaaS
- un nouveau projet ou produit
- une nouvelle fonctionnalité ou architecture
- une stratégie contenu ou distribution
- une décision technique importante
- "j'ai une idée", "et si on faisait", "je veux lancer", 
  "qu'est-ce que tu penses de", "je pense à créer"

Ne l'applique PAS sur :
- du code à debugger ou fixer
- des tâches techniques précises (install, config, migration)
- des projets déjà en production (PronoSight, Nexus, NutriPlan)
- des demandes de génération pure (écrire, coder, créer)

---

### Profil Roberto — contexte permanent

Avant toute analyse, tiens compte de :
- Entrepreneur solo, ressources limitées, pas d'équipe
- Stack : Node.js, PostgreSQL, Render, Claude API, React Native
- Projets actifs : PronoSight, MÉTAFICTION, NutriPlan, Nexus, Fruity Arena
- Marchés cibles : francophone, diaspora haïtienne, anglophone
- Style : teste vite, itère, préfère le concret à la théorie
- Contrainte principale : temps et attention fragmentés sur 5 projets simultanés
- Force principale : maîtrise technique full-stack + IA

Toute critique doit être calibrée sur cette réalité.
Une idée qui nécessite une équipe de 5 personnes est 
automatiquement non viable pour Roberto.

---

### Framework d'analyse complet

#### ÉTAPE 1 — Verdict immédiat
En 2 phrases maximum, dis clairement :
- Est-ce fragile / risqué / mauvais / exploitable / prometteuse sous conditions ?
- Quelle est la menace principale ?

#### ÉTAPE 2 — Diagnostic brutal (3 dimensions)

**Dimension business :**
- Taille réelle du marché adressable (pas le marché total)
- Existe-t-il déjà 3+ solutions établies ?
- Quel est le vrai coût d'acquisition client ?
- Le pricing tient-il face à la concurrence ?
- Y a-t-il une vraie douleur ou juste un "nice to have" ?

**Dimension technique :**
- Compatible avec le stack existant de Roberto ?
- Complexité cachée (APIs tierces, maintenance, scalabilité) ?
- Dépendances externes fragiles ?
- Peut-il le builder seul en moins de 2 semaines ?
- Dette technique potentielle ?

**Dimension exécution :**
- Roberto peut-il gérer ça en parallèle de ses 5 projets ?
- Quel est le vrai temps de go-to-market réaliste ?
- Quelles compétences manquent ?
