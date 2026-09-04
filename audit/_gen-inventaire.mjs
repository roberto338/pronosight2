import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const fichiers = readFileSync('audit/_tracked.txt', 'utf8').split(/\r?\n/).filter(Boolean);

const ROLE = (p) => {
  if (p.startsWith('nexus/migrations/')) return 'migration SQL / runner';
  if (p.startsWith('nexus/agents/'))     return 'agent Nexus';
  if (p.startsWith('nexus/lib/'))        return 'lib Nexus';
  if (p.startsWith('nexus/'))            return 'Nexus (module en veille)';
  if (p.startsWith('victor/'))           return 'coeur Victor (analyse, sources, notation)';
  if (p.startsWith('queues/'))           return 'file de jobs / workers';
  if (p.startsWith('bot/'))              return 'diffusion Telegram';
  if (p.startsWith('cron/'))             return 'scheduler';
  if (p.startsWith('db/'))               return 'accès et schéma base';
  if (p.startsWith('public/'))           return 'frontend';
  if (p.startsWith('admin/'))            return 'dashboard admin';
  if (p.startsWith('config/'))           return 'chargement env';
  if (p.startsWith('tools/'))            return 'outillage dev';
  if (p.startsWith('scripts/'))          return 'script ponctuel';
  if (p.startsWith('picks/'))            return 'données picks';
  if (p === 'server.js')                 return 'point d entree Express';
  return 'racine / config projet';
};

// NON_APPLICABLE réservé aux binaires, assets et fichiers générés.
const NA = (p) => {
  if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|mp3|mp4|pdf)$/i.test(p)) return 'asset binaire';
  if (p.endsWith('.gitkeep')) return 'fichier vide de structure';
  if (p === 'db/schema_neon.sql') return null; // généré MAIS à confronter au code → à lire
  return null;
};

const lignes = ['chemin,lignes,sha1,role_presume,statut,findings'];
let aLire = 0, na = 0;
for (const f of fichiers) {
  let contenu = '', nb = 0, sha = '';
  try {
    contenu = readFileSync(f);
    nb = contenu.toString('utf8').split('\n').length;
    sha = createHash('sha1').update(contenu).digest('hex').slice(0, 12);
  } catch { nb = 0; sha = 'illisible'; }
  const raison = NA(f);
  const statut = raison ? `NON_APPLICABLE(${raison})` : 'A_LIRE';
  raison ? na++ : aLire++;
  lignes.push(`${f},${nb},${sha},"${ROLE(f)}",${statut},`);
}
writeFileSync('audit/INVENTAIRE.csv', lignes.join('\n') + '\n');
console.log(`INVENTAIRE.csv : ${fichiers.length} fichiers — ${aLire} A_LIRE, ${na} NON_APPLICABLE`);

// Volume de code à lire, par zone
const parZone = {};
for (const f of fichiers) {
  if (NA(f)) continue;
  const z = ROLE(f);
  parZone[z] = (parZone[z] || 0) + (readFileSync(f, 'utf8').split('\n').length);
}
console.log('\nLignes à lire par zone :');
Object.entries(parZone).sort((a, b) => b[1] - a[1])
  .forEach(([z, n]) => console.log(`  ${String(n).padStart(6)}  ${z}`));
console.log(`  ${String(Object.values(parZone).reduce((a, b) => a + b, 0)).padStart(6)}  TOTAL`);
