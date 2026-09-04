// Répare et valide audit/findings.jsonl.
// Le JSONL doit rester lisible par machine : c'est ce qui lui permet de
// survivre à une compaction de contexte et d'être trié en phase 4.
import { readFileSync, writeFileSync } from 'node:fs';

const F = 'audit/findings.jsonl';
const lignes = readFileSync(F, 'utf8').trim().split('\n');

// Un backslash non suivi d'un caractère d'échappement JSON valide casse le parse.
const ECHAPPEMENTS_VALIDES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
function nettoyer(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && !ECHAPPEMENTS_VALIDES.has(s[i + 1])) continue; // backslash orphelin
    out += s[i];
  }
  return out;
}

const propres = lignes.map((l, i) => {
  try { JSON.parse(l); return l; }
  catch {
    const r = nettoyer(l);
    try { JSON.parse(r); console.log(`  ligne ${i + 1} réparée`); return r; }
    catch (e) { console.error(`  ligne ${i + 1} IRRÉCUPÉRABLE : ${e.message}`); process.exit(1); }
  }
});

writeFileSync(F, propres.join('\n') + '\n');

const f = propres.map(JSON.parse);
const parCle = (k) => f.reduce((a, x) => { a[x[k]] = (a[x[k]] || 0) + 1; return a; }, {});
console.log(`\n✅ ${f.length} findings, tous valides`);
console.log('  sévérité :', JSON.stringify(parCle('severite')));
console.log('  axes     :', JSON.stringify(parCle('axe')));
console.log('\n  P0 :');
f.filter(x => x.severite === 'P0').forEach(x => console.log(`    ${x.id}  ${x.fichier}  ${x.titre.slice(0, 78)}`));
