// fix-prompt.js — Lance avec: node fix-prompt.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'js', 'app.js');
console.log('⚡ Correction du prompt dans', filePath);

let content = fs.readFileSync(filePath, 'utf8');

// Trouve le bloc du prompt d'analyse (entre "const prompt = `Tu es un expert" et le ";")
const startMarker = 'const prompt = `Tu es un expert';
const startIdx = content.indexOf(startMarker);

if (startIdx === -1) {
  console.log('❌ Prompt non trouvé. Déjà corrigé ?');
  process.exit(1);
}

// Trouve la fin du template literal (le `; qui ferme)
// On cherche le prochain backtick+point-virgule après le début
let depth = 0;
let endIdx = -1;
let inTemplate = false;

for (let i = startIdx + 'const prompt = `'.length; i < content.length; i++) {
  if (content[i] === '`' && content[i-1] !== '\\') {
    // Check if this closes our template literal
    // Look for the pattern: `; or ` + leg1Ctx + `;
    const after = content.substring(i, i + 50).trim();
    if (after.startsWith('`;') || after.startsWith('`\n') || after.match(/^`\s*;/)) {
      endIdx = content.indexOf(';', i) + 1;
      break;
    }
    // backtick followed by something else - might be ${} expression end
  }
}

if (endIdx === -1) {
  // Fallback: find line with leg1Ctx after the prompt
  const leg1Idx = content.indexOf('leg1Ctx', startIdx);
  if (leg1Idx !== -1) {
    endIdx = content.indexOf(';', leg1Idx) + 1;
  }
}

if (endIdx === -1) {
  console.log('❌ Fin du prompt non trouvée');
  process.exit(1);
}

console.log(`📍 Prompt trouvé: caractères ${startIdx} à ${endIdx}`);
console.log(`📝 Ancien prompt (${endIdx - startIdx} chars):`);
console.log(content.substring(startIdx, startIdx + 100) + '...');

const newPrompt = 'const prompt = `Tu es un expert en analyse sportive. Analyse en FRANCAIS uniquement.\nMatch : ${t1} vs ${t2} | Ligue : ${league} | Date : ${matchDate}\n\nINFOS WEB : ${webInfo.slice(0, 1500)}\n\nRetourne UNIQUEMENT un JSON valide sans backticks :\n{"sport":"${sport}","team1":"${t1}","team2":"${t2}","team1_emoji":"emoji","team2_emoji":"emoji","league":"${league}","match_date":"${matchDate}","is_live":${isLive},"proba_home":0,"proba_draw":0,"proba_away":0,"score_pred":"2-1","score_pred_pct":18,"alt_score1":"1-1","alt_score1_pct":15,"alt_score2":"1-0","alt_score2_pct":12,"market_btts":"Oui","market_btts_conf":65,"market_over_line":"2.5","market_over":"Over","market_over_conf":60,"market_handicap":"-1 Dom","market_handicap_conf":55,"best_bet":"meilleur pari","best_bet_market":"1","best_bet_confidence":70,"stars":4,"traffic_light":"vert","analysis":"3 phrases expert","simple_explanation":"2 phrases simples avec emojis","team1_form":["W","W","L","D","W"],"team2_form":["L","W","D","W","L"],"blessures_team1":["Joueur1"],"blessures_team2":["Joueur2"],"key_factors":[{"icon":"📊","text":"facteur 1"},{"icon":"🏠","text":"facteur 2"},{"icon":"💪","text":"facteur 3"},{"icon":"⚔️","text":"facteur 4"},{"icon":"📈","text":"facteur 5"}],"odds_home":0,"odds_draw":0,"odds_away":0,"odds_source":"estimation IA"}${leg1Ctx}`;';

content = content.substring(0, startIdx) + newPrompt + content.substring(endIdx);

fs.writeFileSync(filePath, content, 'utf8');
console.log('✅ Prompt remplacé avec succès !');
console.log(`📏 Nouveau prompt: ${newPrompt.length} chars (ancien: ${endIdx - startIdx} chars)`);

// Vérification
const check = fs.readFileSync(filePath, 'utf8');
const matches = check.match(/maxTokens:\s*\d+/g);
console.log('\n📋 maxTokens trouvés:', matches);
console.log('\n🚀 Maintenant lance:');
console.log('   git add -A');
console.log('   git commit -m "fix: simplify prompt"');
console.log('   git push origin master');
