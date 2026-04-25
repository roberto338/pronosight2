// nexus/test_agents.js — Test de tous les agents Nexus
// Usage: node nexus/test_agents.js

import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'https://pronosight2.onrender.com';
const API_KEY  = process.env.NEXUS_API_KEY || process.env.VICTOR_API_KEY;

if (!API_KEY) {
  console.error('❌ NEXUS_API_KEY ou VICTOR_API_KEY manquante dans .env');
  process.exit(1);
}

async function dispatch(agentType, input, meta = {}) {
  const resp = await fetch(`${BASE_URL}/nexus/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ agentType, input, meta }),
  });
  return resp.json();
}

async function getTask(taskId) {
  const resp = await fetch(`${BASE_URL}/nexus/tasks/${taskId}`, {
    headers: { 'x-api-key': API_KEY },
  });
  return resp.json();
}

async function waitForTask(taskId, label, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 3000));
    const { task, outputs } = await getTask(taskId);
    if (task.status === 'done') {
      const out = outputs?.[0]?.output || '(pas de sortie)';
      console.log(`\n✅ [${label}] RÉUSSI`);
      console.log('─'.repeat(50));
      console.log(out.slice(0, 400));
      console.log('─'.repeat(50));
      return true;
    }
    if (task.status === 'failed') {
      console.log(`\n❌ [${label}] ÉCHOUÉ: ${task.error}`);
      return false;
    }
    process.stdout.write('.');
  }
  console.log(`\n⏱ [${label}] TIMEOUT`);
  return false;
}

// ══════════════════════════════════════════════
console.log('🤖 TEST NEXUS — Tous les agents\n');
console.log(`URL: ${BASE_URL}`);
console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
console.log('─'.repeat(50));

const tests = [
  {
    label:     '1. Research',
    agent:     'research',
    input:     'Quels sont les matchs de Ligue 1 ce weekend ?',
    timeout:   45000,
  },
  {
    label:     '2. Write',
    agent:     'write',
    input:     'Rédige un message court présentant Nexus en 3 lignes',
    timeout:   30000,
  },
  {
    label:     '3. Custom',
    agent:     'custom',
    input:     'Calcule le Kelly Criterion pour une cote de 2.10 avec 55% de confiance',
    timeout:   30000,
  },
  {
    label:     '4. Monitor (DB)',
    agent:     'monitor',
    input:     'health-check',
    meta:      { type: 'db' },
    timeout:   20000,
  },
  {
    label:     '5. Finance (init 1000€)',
    agent:     'finance',
    input:     'init 1000',
    meta:      { action: 'init', params: { amount: 1000 } },
    timeout:   20000,
  },
  {
    label:     '6. Finance (status)',
    agent:     'finance',
    input:     'status bankroll',
    meta:      { action: 'status' },
    timeout:   20000,
  },
  {
    label:     '7. Finance (kelly cote 1.85 confiance 0.60)',
    agent:     'finance',
    input:     'kelly cote 1.85 confiance 0.60',
    meta:      { action: 'kelly', params: { odds: 1.85, confidence: 0.60 } },
    timeout:   20000,
  },
  {
    label:     '8. Exec (calcul)',
    agent:     'exec',
    input:     'Calcule et affiche les 10 premiers nombres de Fibonacci',
    timeout:   60000,
  },
  {
    label:     '9. Browser (recherche web)',
    agent:     'browser',
    input:     'Trouve les résultats des matchs de Ligue 1 du dernier weekend',
    timeout:   45000,
  },
  {
    label:     '10. Planner',
    agent:     'planner',
    input:     'Recherche les matchs de foot ce weekend et écris un résumé des 3 plus intéressants',
    timeout:   120000,
  },
];

// Exécute les tests séquentiellement
for (const test of tests) {
  console.log(`\n⏳ Dispatch [${test.label}]...`);
  const result = await dispatch(test.agent, test.input, test.meta || {});
  if (!result.taskId) {
    console.log(`❌ Dispatch échoué:`, result);
    continue;
  }
  console.log(`   Task #${result.taskId} — Job #${result.jobId}`);
  await waitForTask(result.taskId, test.label, test.timeout);
}

console.log('\n\n🏁 Tests terminés');
