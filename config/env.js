// ══════════════════════════════════════════════════════════════
// config/env.js — Chargement de .env AVANT tout le reste
//
// Pourquoi ce fichier existe : en ESM, les déclarations `import` sont
// hoistées. Un `dotenv.config()` écrit dans le corps de server.js
// s'exécute donc APRÈS l'évaluation de tous les modules importés —
// db/database.js, victor/core.js, cron/scheduler.js ont déjà lu
// process.env et vu des variables vides.
//
// En production le problème est masqué (Render injecte les variables
// dans le process) et en dev aussi (`npm run dev` passe --env-file).
// Il ne se manifeste qu'avec un `node server.js` nu — et il rendait
// silencieusement inopérant le `{ override: true }` de server.js.
//
// La règle : importer CE module en premier dans tout point d'entrée.
// Les imports d'un même fichier s'évaluent dans l'ordre d'écriture,
// donc un premier import qui charge .env couvre tous les suivants.
// Même règle que victor/test-unit.js, qui l'applique déjà.
// ══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';

dotenv.config({ override: true });

export default process.env;
