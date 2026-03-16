// RADICAL-FIX.cjs — Solution définitive pour le JSON tronqué
// Lance avec: node RADICAL-FIX.cjs
const fs = require('fs');
const path = require('path');

console.log('\n══════════════════════════════════════════');
console.log('  🔧 RADICAL FIX — PronoSight v4.1');
console.log('══════════════════════════════════════════\n');

// ═══════════════════════════════════════════
// FIX 1: server.js — Ajouter le mode JSON natif Gemini
// ═══════════════════════════════════════════
console.log('📝 [1/3] Correction de server.js...');

const serverPath = path.join(__dirname, 'server.js');
let server = fs.readFileSync(serverPath, 'utf8');

// Trouve le bloc requestBody dans la route /api/gemini
const oldGenConfig = `generationConfig: {
        maxOutputTokens: Math.min(maxTokens || 4096, 8192),
        temperature: 0.7,
      }`;

const newGenConfig = `generationConfig: {
        maxOutputTokens: Math.min(maxTokens || 4096, 8192),
        temperature: 0.7,
        ...(jsonMode ? { responseMimeType: "application/json" } : {})
      }`;

if (server.includes(oldGenConfig)) {
  server = server.replace(oldGenConfig, newGenConfig);
  console.log('  ✅ generationConfig mis à jour');
} else {
  console.log('  ⚠️ generationConfig déjà modifié ou non trouvé');
}

// Ajoute jsonMode dans la destructuration des params
const oldDestructure = 'const { messages, useSearch = false, maxTokens = 4096, model = null } = req.body;';
const newDestructure = 'const { messages, useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = req.body;';

if (server.includes(oldDestructure)) {
  server = server.replace(oldDestructure, newDestructure);
  console.log('  ✅ jsonMode paramètre ajouté');
} else {
  // Try alternate version
  const alt = 'const { messages, useSearch = false, maxTokens = 1000, model = null } = req.body;';
  const altNew = 'const { messages, useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = req.body;';
  if (server.includes(alt)) {
    server = server.replace(alt, altNew);
    console.log('  ✅ jsonMode paramètre ajouté (alt)');
  } else {
    console.log('  ⚠️ Destructure non trouvée, ajout manuel...');
    // Force it
    server = server.replace(
      /const \{ messages.*?\} = req\.body;/,
      'const { messages, useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = req.body;'
    );
    console.log('  ✅ jsonMode paramètre ajouté (regex)');
  }
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('  💾 server.js sauvegardé\n');

// ═══════════════════════════════════════════
// FIX 2: api.js — Réécriture complète callGemini + extractJSON
// ═══════════════════════════════════════════
console.log('📝 [2/3] Réécriture de api.js...');

const apiPath = path.join(__dirname, 'public', 'js', 'modules', 'api.js');
let api = fs.readFileSync(apiPath, 'utf8');

// === Remplace callGemini ===
const callGeminiStart = api.indexOf('export async function callGemini');
if (callGeminiStart === -1) {
  console.log('  ❌ callGemini non trouvée');
  process.exit(1);
}
// Find end of function
let braceCount = 0;
let callGeminiEnd = -1;
let started = false;
for (let i = callGeminiStart; i < api.length; i++) {
  if (api[i] === '{') { braceCount++; started = true; }
  if (api[i] === '}') braceCount--;
  if (started && braceCount === 0) { callGeminiEnd = i + 1; break; }
}

const newCallGemini = `export async function callGemini(messages, { useSearch = false, maxTokens = 4096, model = null, jsonMode = false } = {}) {
  const body = { messages, maxTokens, jsonMode };
  if (model) body.model = model;
  if (useSearch) body.useSearch = true;

  console.log('📤 Envoi à /api/gemini:', { maxTokens, useSearch, jsonMode, model });

  const resp = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('❌ Erreur HTTP:', resp.status, errText);
    throw new Error('HTTP ' + resp.status + ': ' + errText);
  }

  const data = await resp.json();

  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  if (!data.content || !data.content.length) throw new Error('Réponse vide');
  
  console.log('✅ Réponse reçue:', data);
  return data;
}`;

api = api.substring(0, callGeminiStart) + newCallGemini + api.substring(callGeminiEnd);
console.log('  ✅ callGemini réécrite');

// === Remplace extractText ===
const extractTextStart = api.indexOf('export function extractText');
if (extractTextStart !== -1) {
  braceCount = 0; started = false;
  let extractTextEnd = -1;
  for (let i = extractTextStart; i < api.length; i++) {
    if (api[i] === '{') { braceCount++; started = true; }
    if (api[i] === '}') braceCount--;
    if (started && braceCount === 0) { extractTextEnd = i + 1; break; }
  }
  const newExtractText = `export function extractText(data) {
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}`;
  api = api.substring(0, extractTextStart) + newExtractText + api.substring(extractTextEnd);
  console.log('  ✅ extractText réécrite');
}

// === Remplace extractJSON ===
const extractJSONStart = api.indexOf('export function extractJSON');
if (extractJSONStart !== -1) {
  braceCount = 0; started = false;
  let extractJSONEnd = -1;
  for (let i = extractJSONStart; i < api.length; i++) {
    if (api[i] === '{') { braceCount++; started = true; }
    if (api[i] === '}') braceCount--;
    if (started && braceCount === 0) { extractJSONEnd = i + 1; break; }
  }

  const newExtractJSON = `export function extractJSON(text) {
  // Nettoyage agressif
  let clean = text
    .replace(/\`\`\`json/gi, '')
    .replace(/\`\`\`/g, '')
    .trim();

  // Supprime TOUT ce qui est avant le premier {
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) {
    console.warn('🔍 Pas de { trouvé dans:', clean.slice(0, 200));
    return null;
  }
  clean = clean.substring(firstBrace);

  // Supprime TOUT ce qui est après le dernier }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1) {
    clean = clean.substring(0, lastBrace + 1);
  }

  // Supprime les caractères de contrôle
  clean = clean.replace(/[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, ' ');

  // Essai 1: Parse direct
  try {
    const result = JSON.parse(clean);
    console.log('✅ JSON parsé directement (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e) {
    console.warn('⚠️ Échec parse direct:', e.message);
  }

  // Essai 2: Compacte tout sur une ligne et re-parse
  let oneLine = clean.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\s+/g, ' ');
  try {
    const result = JSON.parse(oneLine);
    console.log('✅ JSON parsé après compactage');
    return result;
  } catch (e) {
    console.warn('⚠️ Échec compactage:', e.message);
  }

  // Essai 3: Réparation agressive du JSON tronqué
  let repaired = oneLine;

  // Coupe après la dernière propriété complète "key":"value" ou "key":number
  const lastComplete = Math.max(
    repaired.lastIndexOf('",'),
    repaired.lastIndexOf('},'),
    repaired.lastIndexOf('],'),
    repaired.lastIndexOf('e,'),  // true/false
    repaired.search(/\\d,(?=[^"]*$)/)  // number,
  );

  if (lastComplete > repaired.length * 0.3) {
    repaired = repaired.substring(0, lastComplete + 1);
  }

  // Supprime les virgules traînantes
  repaired = repaired.replace(/,\\s*$/, '');
  repaired = repaired.replace(/,\\s*([}\\]])/g, '$1');

  // Ferme les guillemets
  const quotes = (repaired.match(/"/g) || []).length;
  if (quotes % 2 !== 0) repaired += '"';

  // Ferme les crochets et accolades
  let ob = (repaired.match(/\\[/g) || []).length;
  let cb = (repaired.match(/\\]/g) || []).length;
  let oc = (repaired.match(/\\{/g) || []).length;
  let cc = (repaired.match(/\\}/g) || []).length;
  while (cb < ob) { repaired += ']'; cb++; }
  while (cc < oc) { repaired += '}'; cc++; }

  try {
    const result = JSON.parse(repaired);
    console.log('✅ JSON réparé (' + Object.keys(result).length + ' clés)');
    return result;
  } catch (e) {
    console.error('❌ Échec réparation:', e.message);
    console.error('   Fin du JSON:', repaired.slice(-150));
  }

  // Essai 4: Troncature brutale — coupe de plus en plus jusqu'à ce que ça parse
  for (let cutoff = repaired.length - 1; cutoff > repaired.length * 0.3; cutoff -= 50) {
    let chunk = repaired.substring(0, cutoff);
    // Nettoie la fin
    chunk = chunk.replace(/,\\s*"[^"]*$/, '');
    chunk = chunk.replace(/,\\s*$/, '');
    const q = (chunk.match(/"/g) || []).length;
    if (q % 2 !== 0) chunk += '"';
    ob = (chunk.match(/\\[/g) || []).length;
    cb = (chunk.match(/\\]/g) || []).length;
    oc = (chunk.match(/\\{/g) || []).length;
    cc = (chunk.match(/\\}/g) || []).length;
    while (cb < ob) { chunk += ']'; cb++; }
    while (cc < oc) { chunk += '}'; cc++; }
    try {
      const result = JSON.parse(chunk);
      if (Object.keys(result).length >= 5) {
        console.log('✅ JSON récupéré par troncature (' + Object.keys(result).length + ' clés)');
        return result;
      }
    } catch { /* continue cutting */ }
  }

  console.error('❌ ÉCHEC TOTAL — impossible de parser le JSON');
  return null;
}`;

  api = api.substring(0, extractJSONStart) + newExtractJSON + api.substring(extractJSONEnd);
  console.log('  ✅ extractJSON réécrite (avec 4 niveaux de récupération)');
}

fs.writeFileSync(apiPath, api, 'utf8');
console.log('  💾 api.js sauvegardé\n');

// ═══════════════════════════════════════════
// FIX 3: app.js — Prompt + jsonMode + appels corrigés
// ═══════════════════════════════════════════
console.log('📝 [3/3] Correction de app.js...');

const appPath = path.join(__dirname, 'public', 'js', 'app.js');
let app = fs.readFileSync(appPath, 'utf8');

// Remplace le prompt d'analyse
const promptStart = app.indexOf("const prompt = `Tu es un expert");
if (promptStart === -1) {
  console.log('  ⚠️ Prompt non trouvé — peut-être déjà modifié');
} else {
  // Find the closing of the template literal
  let promptEnd = -1;
  // Look for `; after leg1Ctx or just `;
  const searchFrom = promptStart + 50;
  const leg1Idx = app.indexOf('leg1Ctx', searchFrom);
  if (leg1Idx !== -1) {
    promptEnd = app.indexOf(';', leg1Idx) + 1;
  } else {
    // Find closing backtick-semicolon
    for (let i = searchFrom; i < app.length; i++) {
      if (app[i] === '`' && app[i+1] === ';') {
        promptEnd = i + 2;
        break;
      }
    }
  }

  if (promptEnd > promptStart) {
    const newPrompt = `const prompt = \`Analyse sportive expert. Réponds UNIQUEMENT en JSON valide.
Match: \${t1} vs \${t2} | \${league} | \${matchDate}
Infos: \${webInfo.slice(0, 1200)}
JSON avec ces clés exactes (remplace les valeurs):
{"sport":"\${sport}","team1":"\${t1}","team2":"\${t2}","team1_emoji":"🏠","team2_emoji":"🏃","league":"\${league}","match_date":"\${matchDate}","is_live":\${isLive},"proba_home":55,"proba_draw":25,"proba_away":20,"score_pred":"2-1","score_pred_pct":18,"alt_score1":"1-1","alt_score1_pct":14,"alt_score2":"1-0","alt_score2_pct":12,"market_btts":"Oui","market_btts_conf":62,"market_over_line":"2.5","market_over":"Over","market_over_conf":58,"market_handicap":"-1","market_handicap_conf":50,"best_bet":"Victoire \${t1}","best_bet_market":"1","best_bet_confidence":68,"stars":3,"traffic_light":"vert","analysis":"Analyse en 3 phrases.","simple_explanation":"Explication simple avec emojis.","team1_form":["W","D","W","L","W"],"team2_form":["L","W","D","W","L"],"blessures_team1":[],"blessures_team2":[],"key_factors":[{"icon":"📊","text":"Facteur 1"},{"icon":"🏠","text":"Facteur 2"},{"icon":"💪","text":"Facteur 3"}],"odds_home":1.85,"odds_draw":3.40,"odds_away":4.20,"odds_source":"estimation"}\${leg1Ctx}\`;`;

    app = app.substring(0, promptStart) + newPrompt + app.substring(promptEnd);
    console.log('  ✅ Prompt simplifié');
  }
}

// Ajoute jsonMode: true aux appels d'analyse (le 2ème callGemini dans analyze)
// Cherche l'appel qui fait l'analyse JSON (pas le web search)
// Pattern: callGemini([{ role: 'user', content: prompt }], { maxTokens: 6000 })
const analyzeCallOld = "{ maxTokens: 6000 }";
const analyzeCallNew = "{ maxTokens: 6000, jsonMode: true }";
if (app.includes(analyzeCallOld)) {
  app = app.replace(analyzeCallOld, analyzeCallNew);
  console.log('  ✅ jsonMode: true ajouté à l\'appel d\'analyse');
} else {
  console.log('  ⚠️ Appel analyse 6000 non trouvé');
}

// Aussi pour les appels de matchs (loadMatches fallback Gemini)
// Pas besoin de jsonMode pour ceux-là car ils sont petits

fs.writeFileSync(appPath, app, 'utf8');
console.log('  💾 app.js sauvegardé\n');

// ═══════════════════════════════════════════
// Vérification finale
// ═══════════════════════════════════════════
console.log('══════════════════════════════════════════');
console.log('  📋 VÉRIFICATION FINALE');
console.log('══════════════════════════════════════════\n');

// Check server.js
const s = fs.readFileSync(serverPath, 'utf8');
console.log('server.js:');
console.log('  jsonMode param:', s.includes('jsonMode = false') ? '✅' : '❌');
console.log('  responseMimeType:', s.includes('responseMimeType') ? '✅' : '❌');

// Check api.js
const a = fs.readFileSync(apiPath, 'utf8');
console.log('api.js:');
console.log('  callGemini jsonMode:', a.includes('jsonMode = false') ? '✅' : '❌');
console.log('  extractJSON 4 essais:', a.includes('Essai 4') ? '✅' : '❌');
console.log('  troncature brutale:', a.includes('troncature brutale') ? '✅' : '❌');

// Check app.js
const p = fs.readFileSync(appPath, 'utf8');
console.log('app.js:');
console.log('  prompt simplifié:', p.includes('Réponds UNIQUEMENT en JSON valide') ? '✅' : '❌');
console.log('  jsonMode: true:', p.includes('jsonMode: true') ? '✅' : '❌');

const tokens = p.match(/maxTokens:\s*\d+/g);
console.log('  maxTokens:', tokens);

console.log('\n══════════════════════════════════════════');
console.log('  🚀 Maintenant lance:');
console.log('  git add -A');
console.log('  git commit -m "v4.1: Gemini JSON mode + robust parser"');
console.log('  git push origin master');
console.log('══════════════════════════════════════════\n');
