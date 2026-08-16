// ══════════════════════════════════════════════
// tools/verif-syntaxe.js — contrôle de syntaxe de tous les modules
// ══════════════════════════════════════════════
//
// Le 16/08, un déploiement est parti en production avec une erreur de
// syntaxe : une paire de backticks glissée dans un commentaire SQL fermait
// le template literal qui l'entourait. Le service refusait de démarrer.
//
// Rien ne l'avait vu : `npm test` ne charge que victor/ et nexus/, jamais
// queues/. Et `node --check` ne suffit pas — il analyse en CommonJS et
// laisse passer ce cas précis. Seule une analyse en mode module le voit,
// d'où le --input-type=module sur l'entrée standard.
//
// Ce contrôle ne remplace pas les tests : il garantit seulement qu'aucun
// fichier du projet ne peut être syntaxiquement irrecevable pour Node.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE  = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const IGNORES = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

function fichiersJS(dir, acc = []) {
  for (const entree of readdirSync(dir)) {
    if (IGNORES.has(entree)) continue;
    const chemin = join(dir, entree);
    if (statSync(chemin).isDirectory()) fichiersJS(chemin, acc);
    else if (entree.endsWith('.js') || entree.endsWith('.mjs')) acc.push(chemin);
  }
  return acc;
}

const fichiers = fichiersJS(RACINE);
const echecs   = [];

for (const f of fichiers) {
  const source = readFileSync(f);
  // Les scripts du navigateur (public/) sont des modules eux aussi ;
  // ceux qui ne le sont pas passent quand même, le mode module est
  // un sur-ensemble du script pour ce qui nous intéresse ici.
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'],
    { input: source, encoding: 'utf8' });
  if (r.status !== 0) {
    const ligne = (r.stderr || '').split('\n').find(l => /Error/.test(l)) || 'erreur inconnue';
    echecs.push({ fichier: relative(RACINE, f), motif: ligne.trim() });
  }
}

if (echecs.length > 0) {
  console.error('\n❌ Syntaxe invalide — ces fichiers empêcheraient Node de démarrer :\n');
  for (const e of echecs) console.error(`   ${e.fichier}\n      ${e.motif}`);
  console.error(`\n${echecs.length} fichier(s) en échec sur ${fichiers.length}.\n`);
  process.exit(1);
}

console.log(`✅ Syntaxe : ${fichiers.length} fichier(s) analysé(s), 0 erreur`);
