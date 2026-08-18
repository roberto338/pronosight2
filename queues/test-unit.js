// ══════════════════════════════════════════════
// queues/test-unit.js — Canal de réveil des workers
// ══════════════════════════════════════════════
//
// Depuis le 18/08, aucun worker ne sonde plus PostgreSQL en continu :
// chacun est réveillé au moment où une tâche est insérée. Ce canal devient
// donc le maillon dont dépend le déclenchement de TOUS les pronostics, et
// de toutes les réponses de Nexus. S'il casse en silence, plus rien ne
// part — et le sondage de secours (20 min) masque la panne en la
// transformant en simple lenteur.

import { definirReveil, reveillerWorker } from './reveil.js';

let ok = 0, ko = 0;
function verifie(libelle, obtenu, attendu) {
  const bon = JSON.stringify(obtenu) === JSON.stringify(attendu);
  console.log(`  ${bon ? '✅' : '❌'} ${libelle}${bon ? '' : ` — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`}`);
  bon ? ok++ : ko++;
}

console.log('\n── Canal de réveil ──');

// Sans worker enregistré : ne doit pas lever. Les scripts ponctuels et les
// tests insèrent des tâches sans worker en face.
verifie('sans worker → silencieux', reveillerWorker('victor', 'test'), false);

// Worker enregistré : reçoit bien la raison
let recuVictor = null;
definirReveil('victor', (raison) => { recuVictor = raison; });
verifie('worker enregistré → appelé', reveillerWorker('victor', 'prematch #42'), true);
verifie('raison transmise', recuVictor, 'prematch #42');

// ── Isolation entre les deux workers ──
// Victor et Nexus partagent le module mais pas leur file : un job Victor
// ne doit jamais réveiller Nexus, sinon Nexus interrogerait la base à
// chaque pronostic — exactement le trafic qu'on vient de supprimer.
let recuNexus = null;
definirReveil('nexus', (raison) => { recuNexus = raison; });
recuVictor = null;
verifie('nexus réveillé', reveillerWorker('nexus', 'custom #7'), true);
verifie('nexus a reçu', recuNexus, 'custom #7');
verifie('victor pas réveillé au passage', recuVictor, null);

// Un worker qui lève ne doit JAMAIS faire échouer l'insertion : la tâche
// est déjà en base, elle sera prise au sondage de secours.
definirReveil('victor', () => { throw new Error('worker cassé'); });
verifie('worker en erreur → insertion préservée', reveillerWorker('victor', 'test'), false);
verifie('nexus survit à la panne de victor', reveillerWorker('nexus', 'test'), true);

// Débranchement (stopWorker) — l'un ne débranche pas l'autre
definirReveil('victor', null);
verifie('victor débranché', reveillerWorker('victor', 'test'), false);
verifie('nexus toujours branché', reveillerWorker('nexus', 'test'), true);

// Une valeur non fonction est ignorée plutôt que d'exploser à l'appel
definirReveil('nexus', 'pas une fonction');
verifie('valeur invalide ignorée', reveillerWorker('nexus', 'test'), false);

// Nom inconnu : sans effet, jamais d'exception
verifie('worker inconnu → silencieux', reveillerWorker('inexistant', 'test'), false);

console.log(`\n${ko === 0 ? '✅' : '❌'} Files de jobs — ${ok} test(s) OK, ${ko} échec(s)\n`);
process.exit(ko === 0 ? 0 : 1);
