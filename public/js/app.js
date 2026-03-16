// ══════════════════════════════════════════════════════════════
// PronoSight v4.0 — app.js (VERSION STABLE GEMINI)
// ══════════════════════════════════════════════════════════════

import { LEAGUES, CATS, CUP_IDS, CACHE_TTL, ANALYSIS_CACHE_TTL,
         TSDB_LEAGUE_MAP, FD_COMP_MAP, TODAY_LEAGUES, ODDS_SPORT_MAP } from './modules/config.js';
import { state, MATCH_CACHE, getCachedAnalysis, setCachedAnalysis,
         clearOldCaches, getHist, saveHist, getFavs, saveFavs,
         getBankrollData, saveBankrollData } from './modules/state.js';
import { callClaude, callGemini, extractText, extractJSON, tsdbFetch, getLeagueEvents,
         tsdbToMatch, fdFetch, fdToMatch, fetchRealOdds, fetchApiStatus, fetchMatchDetails, fetchLiveStats } from './modules/api.js';
// ══════════════════════════════════════════════
// VARIABLES GLOBALES
// ══════════════════════════════════════════════
let _deferredPrompt = null;
let parlayCount = 0;

// ══════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════
async function initApp() {
  clearOldCaches();
  const status = await fetchApiStatus();
  console.log('PronoSight v4.0 — APIs:', status);

  const oddsBtn = document.getElementById('oddsKeyBtn');
  if (oddsBtn) {
    if (status.odds) { oddsBtn.style.borderColor = '#00aaff'; oddsBtn.style.color = '#00aaff'; oddsBtn.textContent = '📡 ODDS ✓'; }
    else oddsBtn.title = 'Configurez ODDS_API_KEY dans .env sur le serveur';
  }
  const fdBtn = document.getElementById('fdKeyBtn');
  if (fdBtn) {
    if (status.footballData) { fdBtn.style.borderColor = 'var(--accent)'; fdBtn.style.color = 'var(--accent)'; fdBtn.textContent = '📅 FD ✓'; }
    else fdBtn.title = 'Configurez FOOTBALL_DATA_KEY dans .env sur le serveur';
  }

  const akBtn = document.getElementById('akChange');
  if (akBtn) {
    if (status.gemini) { akBtn.textContent = '✅ GEMINI'; akBtn.style.borderColor = '#00dd55'; akBtn.style.color = '#00dd55'; }
    else { akBtn.textContent = '❌ GEMINI'; akBtn.style.borderColor = '#ff3333'; akBtn.style.color = '#ff3333'; }
  }

  renderCats();
  renderLeagues();
  showStep(1);
  updateHistBadge();
  renderDashboard();
}

// ══════════════════════════════════════════════
// SPORT & NAVIGATION
// ══════════════════════════════════════════════
function selectSport(sport) {
  state.currentSport = sport;
  state.selectedLeague = null;
  state.selectedMatch = null;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-sport="${sport}"]`)?.classList.add('active');
  const btn = document.getElementById('analyzeBtn');
  if (btn) btn.classList.toggle('bk-btn', sport === 'basket');
  document.getElementById('bigSpinner')?.classList.toggle('bk', sport === 'basket');
  state.currentCat = 'all';
  state.filterText = '';
  document.getElementById('leagueSearch').value = '';
  renderCats(); renderLeagues(); showStep(1);
}

function showStep(n) {
  document.getElementById('step1panel').style.display = n >= 1 ? 'block' : 'none';
  document.getElementById('step2panel').style.display = n >= 2 ? 'block' : 'none';
  const res = document.getElementById('results');
  if(res) { res.innerHTML = ''; res.classList.remove('visible'); }
  document.getElementById('errorBox')?.classList.remove('visible');
  for (let i = 1; i <= 3; i++) {
    const num = document.getElementById('s' + i + 'n'), lbl = document.getElementById('s' + i + 'l');
    if(!num || !lbl) continue;
    num.classList.remove('active', 'done'); lbl.classList.remove('active');
    if (i < n) { num.classList.add('done'); num.textContent = '✓'; }
    else if (i === n) { num.classList.add('active'); num.textContent = i; lbl.classList.add('active'); }
    else num.textContent = i;
  }
}

function switchNav(tab) {
  const pv = document.getElementById('pronoView');
  if (pv) pv.style.display = tab === 'prono' ? 'block' : 'none';
  ['history','parlay','alerts','bankroll','quickpick','combo','dash','live','today'].forEach(t => {
    const el = document.getElementById(t + 'View');
    if (el) el.classList.toggle('visible', t === tab);
  });
  ['prono','history','parlay','alerts','bankroll','quickpick','combo','dash','live','today'].forEach(t => {
    const b = document.getElementById('nav-' + t);
    if (b) b.classList.toggle('active', t === tab);
  });
  if (tab === 'history') renderHistory();
  if (tab === 'dash') renderDashboard();
  if (tab === 'live') fetchLive(false);
  if (tab === 'today') fetchTodayMatches(false);
  if (tab === 'alerts') renderAlertFavs();
  if (tab === 'bankroll') renderBankroll();
  if (tab === 'parlay' && document.getElementById('parlayLegs')?.children.length === 0) {
    addParlayLeg(); addParlayLeg();
  }
}

function toggleTheme() {
  document.body.classList.toggle('light-mode');
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = document.body.classList.contains('light-mode') ? '☀️' : '🌙';
  localStorage.setItem('ps_theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
}

// ══════════════════════════════════════════════
// LEAGUES & MATCHES
// ══════════════════════════════════════════════
function renderCats() {
  const cats = CATS[state.currentSport] || [];
  document.getElementById('leagueCats').innerHTML = cats.map(c =>
    `<button class="cat-btn ${c.id === state.currentCat ? 'active' : ''}" onclick="setCat('${c.id}')">${c.label}</button>`
  ).join('');
}

function setCat(cat) { state.currentCat = cat; renderCats(); renderLeagues(); }

function filterLeagues() { 
  state.filterText = document.getElementById('leagueSearch').value.toLowerCase(); 
  renderLeagues(); 
}

function renderLeagues() {
  let list = LEAGUES.filter(l => l.sport === state.currentSport);
  if (state.currentCat !== 'all') list = list.filter(l => l.cat === state.currentCat);
  if (state.filterText) list = list.filter(l => l.name.toLowerCase().includes(state.filterText) || l.country.toLowerCase().includes(state.filterText));
  const isBk = state.currentSport === 'basket';
  document.getElementById('leaguesGrid').innerHTML = list.map(l => `
    <div class="league-card ${state.selectedLeague?.id === l.id ? (isBk ? 'selected bk-sel' : 'selected') : ''}" onclick="pickLeague('${l.id}')">
      <div class="league-flag">${l.flag}</div>
      <div><div class="league-name">${l.name}</div><div class="league-tier">${l.country} · ${l.tier}</div></div>
    </div>`).join('');
}

async function pickLeague(id) {
  const cr = document.getElementById('cupLegRow');
  if (cr) cr.style.display = CUP_IDS.includes(id) ? 'block' : 'none';
  state.selectedLeague = LEAGUES.find(l => l.id === id);
  state.selectedMatch = null;
  document.getElementById('team1').value = '';
  document.getElementById('team2').value = '';
  renderLeagues(); 
  showStep(2);
  await loadMatches();
}

async function loadMatches() {
  const container = document.getElementById('matchesContainer');
  
  // Vider le conteneur et afficher le chargement
  container.innerHTML = '<div class="match-loading"><div class="mini-spinner"></div>Chargement des matchs...</div>';
  
  const cacheKey = state.selectedLeague.id;
  
  // Vérifier le cache d'abord
  const cached = MATCH_CACHE[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) { 
    renderMatches(cached.matches, true); 
    return; 
  }

  // Essayer TheSportsDB d'abord (c'est gratuit et fiable)
  const tsdbId = TSDB_LEAGUE_MAP[state.selectedLeague.id];
  if (tsdbId) {
    try {
      const events = await getLeagueEvents(tsdbId);
      if (events && events.length > 0) {
        // Les événements sont déjà au format match grâce à notre nouvelle fonction
        MATCH_CACHE[cacheKey] = { matches: events, ts: Date.now() };
        renderMatches(events, false);
        return;
      }
    } catch (e) {
      console.log('TheSportsDB indisponible, passage à Gemini');
    }
  }

  // Si TheSportsDB échoue, essayer Gemini
  try {
    const lname = state.selectedLeague.name + ' (' + state.selectedLeague.country + ')';
    
    const today = new Date();
    const todayStr = today.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    
    const prompt = `Donne les matchs de ${lname} pour aujourd'hui (${todayStr}) et demain.

RÈGLES STRICTES :
- Réponds avec un seul objet JSON valide
- N'écris aucun texte avant ou après
- N'utilise pas \`\`\`json
- N'utilise pas Markdown
- Si tu ne trouves aucun match, retourne exactement {"matches":[]}

Format exact attendu :
{"matches":[{"team1":"Nom","team2":"Nom","date":"JJ/MM","time":"HH:MM","live":false}]}`;    
    const data = await callGemini([{
      role: 'user',
      content: prompt
    }], { useSearch: true, maxTokens: 2000 });
    
    const text = extractText(data);
    const parsed = extractJSON(text);
    
    if (parsed?.matches && Array.isArray(parsed.matches) && parsed.matches.length > 0) {
      MATCH_CACHE[cacheKey] = { matches: parsed.matches, ts: Date.now() };
      renderMatches(parsed.matches, false);
      return;
    }
  } catch (e) {
    console.error('Erreur Gemini:', e);
  }
  
  // Si tout échoue, afficher la saisie manuelle
  container.innerHTML = '<div class="match-loading" style="color:var(--accent2)">Aucun match trouvé automatiquement.<br>Utilisez la saisie manuelle ci-dessous ↓</div>';
  
  // Pré-remplir avec des exemples selon la ligue
  const examples = {
    'ligue1': { team1: 'PSG', team2: 'Monaco' },
    'pl': { team1: 'Manchester City', team2: 'Arsenal' },
    'laliga': { team1: 'Real Madrid', team2: 'Barcelona' },
    'bundesliga': { team1: 'Bayern Munich', team2: 'Dortmund' },
    'seriea': { team1: 'Inter Milan', team2: 'Juventus' }
  };
  
  const ex = examples[state.selectedLeague.id];
  if (ex) {
    document.getElementById('team1').placeholder = ex.team1;
    document.getElementById('team2').placeholder = ex.team2;
  }
}

function clearMatchCache() {
  if (state.selectedLeague) delete MATCH_CACHE[state.selectedLeague.id];
  loadMatches();
}

function renderMatches(matches, fromCache) {
  const container = document.getElementById('matchesContainer');
  state.matches = matches;
  if (!matches.length) {
    container.innerHTML = '<div class="match-loading">Aucun match trouvé. Saisie manuelle disponible.</div>';
    return;
  }
  const cacheLabel = fromCache ? '<span class="match-cached" onclick="clearMatchCache()" title="Cliquer pour rafraîchir" style="cursor:pointer">⚡ CACHE — 🔄 Rafraîchir</span>' : '';
  container.innerHTML = `
    <div style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:9px;display:flex;align-items:center;gap:8px">
      ${matches.length} MATCHS TROUVÉS ${cacheLabel}
    </div>
    <div class="matches-list">${matches.map((m, i) => `
      <div class="match-item ${m.live ? 'live-match' : ''}" id="mi${i}" onclick="pickMatch(${i})">
        <div class="match-teams">
          <span class="match-team-name">${m.team1}</span>
          <span class="match-vs">VS</span>
          <span class="match-team-name">${m.team2}</span>
        </div>
        <div class="match-time">${m.live ? '<span class="live-tag">🔴 LIVE</span>' : `<div>${m.date}</div><div>${m.time}</div>`}</div>
        <button class="match-quick-btn" onclick="event.stopPropagation();quickAnalyzeMatch(${i})">⚡ Analyser</button>
      </div>`).join('')}
    </div>`;
}

function pickMatch(idx) {
  const m = state.matches[idx];
  if (!m) return;
  state.selectedMatch = m;
  document.getElementById('team1').value = m.team1;
  document.getElementById('team2').value = m.team2;
  document.querySelectorAll('.match-item').forEach(el => el.classList.remove('selected', 'bk-sel'));
  const el = document.getElementById('mi' + idx);
  if (el) { el.classList.add('selected'); if (state.currentSport === 'basket') el.classList.add('bk-sel'); }
}

async function quickAnalyzeMatch(i) {
  pickMatch(i);
  await new Promise(r => setTimeout(r, 100));
  document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await analyze();
}

// ══════════════════════════════════════════════
// EV + KELLY
// ══════════════════════════════════════════════
function calcEV(bookOdds, trueProb) {
  return Math.round((trueProb * (bookOdds - 1) - (1 - trueProb)) * 10000) / 100;
}

function calcKelly(bookOdds, trueProb, bankroll, fraction) {
  const b = bookOdds - 1;
  const kelly = (trueProb * (b + 1) - 1) / b;
  return {
    kelly: Math.round(kelly * 10000) / 100,
    stake: Math.round(Math.max(0, kelly * fraction * bankroll) * 100) / 100
  };
}

function computeGlobalConfidence(d, evData) {
  const scores = [], weights = [];
  
  scores.push(d.best_bet_confidence || 60);
  weights.push(0.40);
  
  if (evData && evData.ev !== null && evData.ev !== undefined) {
    let evScore = 50;
    if (evData.ev > 5) evScore = 90;
    else if (evData.ev > 0) evScore = 70;
    else if (evData.ev > -5) evScore = 40;
    else evScore = 20;
    scores.push(evScore);
    weights.push(0.20);
  } else {
    weights[0] = 0.50;
  }

  const f1 = (d.team1_form || []).filter(r => r === 'W').length;
  const f2 = (d.team2_form || []).filter(r => r === 'W').length;
  const favForm = d.proba_home > d.proba_away ? f1 : f2;
  let formScore = 50;
  if (favForm >= 4) formScore = 90;
  else if (favForm === 3) formScore = 70;
  else if (favForm === 2) formScore = 50;
  else formScore = 30;
  scores.push(formScore);
  weights.push(0.20);

  const favInj = d.proba_home >= d.proba_away ? (d.blessures_team1 || []) : (d.blessures_team2 || []);
  let injScore = 50;
  if (favInj.length === 0) injScore = 90;
  else if (favInj.length === 1) injScore = 70;
  else if (favInj.length <= 3) injScore = 50;
  else injScore = 25;
  scores.push(injScore);
  weights.push(0.10);

  const maxProba = Math.max(d.proba_home || 0, d.proba_away || 0, d.proba_draw || 0);
  let gapScore = 50;
  if (maxProba >= 65) gapScore = 90;
  else if (maxProba >= 55) gapScore = 70;
  else if (maxProba >= 45) gapScore = 50;
  else gapScore = 30;
  scores.push(gapScore);
  weights.push(0.10);

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let globalScore = 0;
  for (let i = 0; i < scores.length; i++) {
    globalScore += scores[i] * weights[i];
  }
  globalScore = Math.round(globalScore / totalWeight);

  const hist = getHist();
  const resolved = hist.filter(h => h.result === 'win' || h.result === 'lose');
  if (resolved.length >= 5) {
    const wins = resolved.filter(h => h.result === 'win').length;
    const wr = wins / resolved.length;
    if (wr >= 0.65) globalScore = Math.min(99, globalScore + 5);
    else if (wr <= 0.35) globalScore = Math.max(10, globalScore - 5);
  }

  return Math.min(99, Math.max(10, globalScore));
}

function getConfidenceLabel(score) {
  if (score >= 80) return { label: 'TRÈS ÉLEVÉE', color: '#00dd55', emoji: '🟢' };
  if (score >= 65) return { label: 'ÉLEVÉE', color: '#00cc44', emoji: '🟢' };
  if (score >= 50) return { label: 'MOYENNE', color: '#ffcc00', emoji: '🟡' };
  if (score >= 35) return { label: 'FAIBLE', color: '#ff6600', emoji: '🟠' };
  return { label: 'TRÈS FAIBLE', color: '#ff3333', emoji: '🔴' };
}

// ══════════════════════════════════════════════
// ANALYZE
// ══════════════════════════════════════════════
async function analyze() {
  const t1 = document.getElementById('team1').value.trim();
  const t2 = document.getElementById('team2').value.trim();
  const errBox = document.getElementById('errorBox');
  errBox.classList.remove('visible');
  if (!t1 || !t2) { errBox.textContent = '👆 Choisis un match ou saisis les deux équipes'; errBox.classList.add('visible'); return; }

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;
  document.getElementById('loading').classList.add('visible');
  document.getElementById('results').innerHTML = '';
  document.getElementById('results').classList.remove('visible');
  ['ls1','ls2','ls3','ls4'].forEach((id, i) => setTimeout(() => document.getElementById(id)?.classList.add('show'), i * 800));

  const sport = state.currentSport === 'basket' ? 'basketball' : 'football';
  const league = state.selectedLeague ? `${state.selectedLeague.name} (${state.selectedLeague.country})` : 'inconnue';
  const matchDate = state.selectedMatch?.date || 'à venir';
  const isLive = state.selectedMatch?.live || false;

  try {
    // Récupérer les données football-data si disponibles
    const fdData = await fetchMatchDetails(t1, t2, state.selectedLeague?.id);
    
    // Récupérer des infos web
    let webInfo = '';
    try {
      const searchData = await callGemini([{
        role: 'user',
        content: `${t1} vs ${t2} (${league} ${matchDate}): donne moi en 3 lignes: forme récente, blessures, historique des confrontations.`
      }], { useSearch: true, maxTokens: 2000 });
      webInfo = extractText(searchData);
    } catch { webInfo = 'Recherche web indisponible'; }

    // Prompt amélioré
    const prompt = `Analyse sportive expert. Réponds UNIQUEMENT en JSON valide.
Match: ${t1} vs ${t2} | ${league} | ${matchDate}
Infos: ${webInfo.slice(0, 1200)}
JSON avec ces clés exactes (remplace les valeurs):
{"sport":"${sport}","team1":"${t1}","team2":"${t2}","team1_emoji":"🏠","team2_emoji":"🏃","league":"${league}","match_date":"${matchDate}","is_live":${isLive},"proba_home":55,"proba_draw":25,"proba_away":20,"score_pred":"2-1","score_pred_pct":18,"alt_score1":"1-1","alt_score1_pct":14,"alt_score2":"1-0","alt_score2_pct":12,"market_btts":"Oui","market_btts_conf":62,"market_over_line":"2.5","market_over":"Over","market_over_conf":58,"market_handicap":"-1","market_handicap_conf":50,"best_bet":"Victoire ${t1}","best_bet_market":"1","best_bet_confidence":68,"stars":3,"traffic_light":"vert","analysis":"Analyse en 3 phrases.","simple_explanation":"Explication simple avec emojis.","team1_form":["W","D","W","L","W"],"team2_form":["L","W","D","W","L"],"blessures_team1":[],"blessures_team2":[],"key_factors":[{"icon":"📊","text":"Facteur 1"},{"icon":"🏠","text":"Facteur 2"},{"icon":"💪","text":"Facteur 3"}],"odds_home":1.85,"odds_draw":3.40,"odds_away":4.20,"odds_source":"estimation"}${leg1Ctx}`;

    const data = await callGemini([{ role: 'user', content: prompt }], { maxTokens: 6000, jsonMode: true });

    
    // ⚠️ VÉRIFICATION DU JSON AVANT PARSING
    const text = extractText(data);
    console.log('📝 Longueur réponse:', text.length);
    
    // Si la réponse est trop courte ou semble tronquée
    if (text.length < 100 || !text.includes('}') || (text.match(/{/g) || []).length !== (text.match(/}/g) || []).length) {
      console.warn('⚠️ Réponse suspecte, utilisation du plan B');
      throw new Error('Réponse tronquée');
    }
    
    let d = extractJSON(text);
    const text = extractText(data);
    let d = extractJSON(text);
    
    // Si le JSON est invalide, on crée une analyse par défaut
    if (!d) {
      console.warn('JSON invalide, utilisation des valeurs par défaut');
      d = {
        proba_home: 40,
        proba_draw: 30,
        proba_away: 30,
        score_pred: "1-1",
        score_pred_pct: 30,
        best_bet: "Match serré",
        best_bet_market: "X",
        best_bet_confidence: 60,
        analysis: `Analyse basée sur les données disponibles. ${t1} et ${t2} sont deux équipes compétitives.`,
        simple_explanation: `C'est un match équilibré entre ${t1} et ${t2}.`,
        team1_form: ["?", "?", "?", "?", "?"],
        team2_form: ["?", "?", "?", "?", "?"],
        blessures_team1: [],
        blessures_team2: [],
        compo_team1: "4-3-3: Composition type",
        compo_team2: "4-4-2: Composition type",
        key_factors: [
          {icon: "⚽", text: "Match à suivre", weight: 5},
          {icon: "📊", text: "Données en cours d'analyse", weight: 5}
        ],
        odds_home: 2.00,
        odds_draw: 3.20,
        odds_away: 3.50
      };
    }

    // Ajouter les champs manquants
    d.sport = sport;
    d.team1 = t1;
    d.team2 = t2;
    d.team1_emoji = "⚽";
    d.team2_emoji = "⚽";
    d.league = league;
    d.match_date = matchDate;
    d.is_live = isLive;
    d.stars = d.stars || Math.ceil((d.best_bet_confidence || 60) / 20);
    d.traffic_light = d.traffic_light || (d.best_bet_confidence >= 70 ? 'vert' : d.best_bet_confidence >= 50 ? 'orange' : 'rouge');

    // Sauvegarder dans le cache
    setCachedAnalysis(t1, t2, league, d);

    // Calculer EV et Kelly
    const bookOdds = parseFloat(document.getElementById('evOdds').value) || 0;
    const evMarket = (document.getElementById('evMarket').value || '').trim();
    const bankroll = parseFloat(document.getElementById('kellyBankroll').value) || 0;
    const kellyFraction = parseFloat(document.getElementById('kellyFraction').value) || 0.25;
    
    let evData = null, kellyData = null;
    
    if (bookOdds > 1 && evMarket) {
      let trueProb = 0;
      const mLow = evMarket.toLowerCase();
      if (mLow === '1') trueProb = d.proba_home / 100;
      else if (mLow === 'x' || mLow === 'nul') trueProb = (d.proba_draw || 0) / 100;
      else if (mLow === '2') trueProb = d.proba_away / 100;
      else trueProb = (d.best_bet_confidence || 60) / 100;
      
      if (trueProb > 0) {
        const ev = calcEV(bookOdds, trueProb);
        evData = { ev, trueProb, bookOdds, market: evMarket };
        if (bankroll > 0) {
          kellyData = { ...calcKelly(bookOdds, trueProb, bankroll, kellyFraction), bankroll, fraction: kellyFraction };
        }
      }
    }

    // Remplacer l'appel à computeGlobalConfidence par computeAdvancedConfidence dans renderResults
    // On va stocker fdData dans d pour qu'il soit accessible dans renderResults
    d.fdData = fdData;
    
    renderResults(d, evData, kellyData, '', null);
    
  } catch (e) {
    console.error('Erreur analyse:', e);
    errBox.innerHTML = 'Erreur lors de l\'analyse. Utilisation des valeurs par défaut.';
    errBox.classList.add('visible');
    
    // Analyse par défaut
    const defaultAnalysis = {
      sport: sport,
      team1: t1,
      team2: t2,
      team1_emoji: "⚽",
      team2_emoji: "⚽",
      league: league,
      match_date: matchDate,
      is_live: isLive,
      proba_home: 40,
      proba_draw: 30,
      proba_away: 30,
      score_pred: "1-1",
      score_pred_pct: 30,
      best_bet: "Match à suivre",
      best_bet_market: "X",
      best_bet_confidence: 60,
      stars: 3,
      traffic_light: "orange",
      analysis: `Analyse de ${t1} vs ${t2} en cours...`,
      simple_explanation: `Les statistiques détaillées ne sont pas disponibles pour le moment.`,
      team1_form: ["?", "?", "?", "?", "?"],
      team2_form: ["?", "?", "?", "?", "?"],
      blessures_team1: [],
      blessures_team2: [],
      compo_team1: "4-3-3: Composition type",
      compo_team2: "4-4-2: Composition type",
      key_factors: [
        {icon: "⚽", text: "Match à suivre sur notre plateforme", weight: 5}
      ],
      odds_home: 2.00,
      odds_draw: 3.20,
      odds_away: 3.50,
      fdData: null
    };
    
    renderResults(defaultAnalysis, null, null, '', null);
  } finally {
    btn.disabled = false;
    document.getElementById('loading').classList.remove('visible');
    ['ls1','ls2','ls3','ls4'].forEach(id => document.getElementById(id)?.classList.remove('show'));
  }
}

function processAnalysisResult(d, t1, t2, league, fromCache, realOddsData) {
  const bookOdds = parseFloat(document.getElementById('evOdds').value) || 0;
  const evMarket = (document.getElementById('evMarket').value || '').trim();
  const bankroll = parseFloat(document.getElementById('kellyBankroll').value) || 0;
  const kellyFraction = parseFloat(document.getElementById('kellyFraction').value) || 0.25;
  let evData = null, kellyData = null;

  if (bookOdds > 1 && evMarket) {
    let trueProb = 0;
    const mLow = evMarket.toLowerCase();
    if (mLow === '1') trueProb = d.proba_home / 100;
    else if (mLow === 'x' || mLow === 'nul') trueProb = (d.proba_draw || 0) / 100;
    else if (mLow === '2') trueProb = d.proba_away / 100;
    else trueProb = d.best_bet_confidence / 100;
    if (trueProb > 0) {
      const ev = calcEV(bookOdds, trueProb);
      evData = { ev, trueProb, bookOdds, market: evMarket };
      if (bankroll > 0) kellyData = { ...calcKelly(bookOdds, trueProb, bankroll, kellyFraction), bankroll, fraction: kellyFraction };
    }
  }

  const leg1Sv = (document.getElementById('leg1Score') || { value: '' }).value.trim();
  renderResults(d, evData, kellyData, leg1Sv, realOddsData);

  if (fromCache) {
    setTimeout(() => {
      const res = document.getElementById('results');
      if (res) {
        const badge = document.createElement('div');
        badge.innerHTML = '<div style="position:absolute;top:8px;right:8px;background:rgba(0,194,255,.12);color:#00c2ff;font-size:9px;font-family:monospace;padding:3px 7px;border-radius:4px;border:1px solid rgba(0,194,255,.3)">⚡ CACHE</div>';
        res.style.position = 'relative';
        res.insertBefore(badge.firstChild, res.firstChild);
      }
    }, 100);
  }
}

function renderResults(d, evData, kellyData, leg1Score, realOddsData) {
  const isBk = d.sport === 'basketball';
  let wi = 0;
  if (d.proba_away > d.proba_home && d.proba_away > (d.proba_draw || 0)) wi = 2;
  else if (!isBk && (d.proba_draw || 0) > d.proba_home && (d.proba_draw || 0) > d.proba_away) wi = 1;

  const globalConf = d.fdData ? computeAdvancedConfidence(d, d.fdData).global : computeGlobalConfidence(d, evData);
  const confInfo = getConfidenceLabel(globalConf);
  const tl = d.traffic_light || 'orange';
  const tlEmoji = tl === 'vert' ? '🟢' : tl === 'orange' ? '🟡' : '🔴';
  const tlLabel = tl === 'vert' ? 'BON PARI' : tl === 'orange' ? 'MOYEN' : 'RISQUÉ';
  const tlColor = tl === 'vert' ? 'var(--ev-pos)' : tl === 'orange' ? 'var(--yellow)' : 'var(--ev-neg)';
  const stars = Math.min(5, Math.max(1, d.stars || Math.ceil(d.best_bet_confidence / 20)));
  const starsStr = '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
  const isSignal = d.best_bet_confidence >= 75;
  const formDot = r => r ? `<div class="form-dot ${({ W: 'fd-w', D: 'fd-d', L: 'fd-l' })[r] || 'fd-d'}">${r}</div>` : '';
  const form1 = (d.team1_form || []).map(formDot).join('');
  const form2 = (d.team2_form || []).map(formDot).join('');
  const wTop = isBk ? 'top bk-top' : 'top';
  const drawRow = !isBk ? `<div class="proba-row"><div class="proba-label">⚖️ Nul</div><div class="proba-bar-bg"><div class="proba-bar pb-draw" style="width:${d.proba_draw || 0}%"></div></div><div class="proba-pct">${d.proba_draw || 0}%</div></div>` : '';

  let evBlock = '';
  if (evData) {
    const isPos = evData.ev > 0;
    evBlock = `<div class="ev-result ${isPos ? 'ev-pos' : 'ev-neg'}"><div><div class="ev-result-label">💰 Value Bet — ${evData.market} @ ${evData.bookOdds}</div><div class="ev-result-value">${isPos ? '+' : ''}${evData.ev}% EV</div><div class="ev-verdict">${isPos ? '✅ VALEUR POSITIVE' : '❌ VALEUR NÉGATIVE'}</div></div><div style="text-align:center;flex-shrink:0"><div style="font-size:42px">${isPos ? '💚' : '🔴'}</div></div></div>`;
  }

  let kellyBlock = '';
  if (kellyData && evData?.ev > 0) {
    kellyBlock = `<div class="kelly-result"><div><div class="kelly-result-label">📊 Mise optimale (Kelly × ${kellyData.fraction})</div><div class="kelly-result-value">€${kellyData.stake}</div><div class="kelly-explain">Kelly brut : ${kellyData.kelly}% · Bankroll : €${kellyData.bankroll}</div></div><div style="text-align:center;flex-shrink:0"><div style="font-size:38px">💜</div></div></div>`;
  }

  const factors = (d.key_factors || []).map(f => `<div class="factor-item"><div class="factor-icon">${f.icon || '📌'}</div><div>${f.text}</div></div>`).join('');

  const html = `
    <button class="new-btn" onclick="resetToStart()">← Nouvelle analyse</button>
    <div class="match-banner"><div class="match-banner-inner">
      <div class="team-block"><span class="team-emoji">${d.team1_emoji || '⚽'}</span><div class="team-big">${d.team1}</div></div>
      <div class="vs-center"><div class="vs-big">VS</div><div class="league-pill">${d.league}</div><div class="match-date-tag">${d.is_live ? '🔴 EN DIRECT' : d.match_date}</div></div>
      <div class="team-block"><span class="team-emoji">${d.team2_emoji || '⚽'}</span><div class="team-big">${d.team2}</div></div>
    </div></div>
    ${evBlock}${kellyBlock}
    <div class="simple-explanation"><div class="simple-title">🧒 En termes simples :</div><div class="simple-text">${d.simple_explanation || ''}</div></div>
    <div class="confidence-block">
      <div class="conf-section"><div class="conf-label">Confiance</div><div class="conf-tl">${tlEmoji}</div><div class="conf-tl-text" style="color:${tlColor}">${tlLabel}</div></div>
      <div class="conf-divider"></div>
      <div class="conf-section"><div class="conf-label">Note</div><div class="conf-stars">${starsStr}</div><div class="conf-stars-text">${starsText} (${d.best_bet_confidence}%)</div></div>
      <div class="conf-divider"></div>
      <div class="conf-section" style="flex:2;text-align:left"><div class="conf-label">🎯 Meilleur pari</div><div class="conf-pick">${d.best_bet}</div></div>
    </div>
    <div class="winner-section">
      <div class="winner-card ${wi === 0 ? wTop : ''}"><div class="winner-icon">${d.team1_emoji || '⚽'}</div><div class="winner-label">${(d.team1 || '').substring(0, 12)}</div><div class="winner-pct">${d.proba_home}%</div><div class="winner-fav">${wi === 0 ? '⭐ Favori' : ''}</div></div>
      ${!isBk ? `<div class="winner-card ${wi === 1 ? wTop : ''}"><div class="winner-icon">⚖️</div><div class="winner-label">Nul</div><div class="winner-pct">${d.proba_draw || 0}%</div><div class="winner-fav">${wi === 1 ? '⭐ Favori' : ''}</div></div>` : ''}
      <div class="winner-card ${wi === 2 ? wTop : ''}"><div class="winner-icon">${d.team2_emoji || '⚽'}</div><div class="winner-label">${(d.team2 || '').substring(0, 12)}</div><div class="winner-pct">${d.proba_away}%</div><div class="winner-fav">${wi === 2 ? '⭐ Favori' : ''}</div></div>
    </div>
    <div class="proba-section"><div class="section-title">📊 Probabilités</div>
      <div class="proba-row"><div class="proba-label">${d.team1}</div><div class="proba-bar-bg"><div class="proba-bar ${isBk ? 'pb-bk-home' : 'pb-home'}" style="width:0%" data-w="${d.proba_home}"></div></div><div class="proba-pct">${d.proba_home}%</div></div>
      ${drawRow}
      <div class="proba-row"><div class="proba-label">${d.team2}</div><div class="proba-bar-bg"><div class="proba-bar ${isBk ? 'pb-bk-away' : 'pb-away'}" style="width:0%" data-w="${d.proba_away}"></div></div><div class="proba-pct">${d.proba_away}%</div></div>
    </div>
    <div class="score-grid">
      <div class="score-card ${wTop}"><div class="score-lbl">Score probable</div><div class="score-num">${d.score_pred}</div><div class="score-sub">${d.score_pred_pct}%</div></div>
      <div class="score-card"><div class="score-lbl">Alt 1</div><div class="score-num" style="font-size:24px">${d.alt_score1}</div><div class="score-sub">${d.alt_score1_pct}%</div></div>
      <div class="score-card"><div class="score-lbl">Alt 2</div><div class="score-num" style="font-size:24px">${d.alt_score2}</div><div class="score-sub">${d.alt_score2_pct}%</div></div>
    </div>
    <div class="form-section"><div class="section-title">📈 Forme récente (5 derniers)</div><div class="form-grid">
      <div class="form-team"><div class="form-team-name">${d.team1}</div><div class="form-dots">${form1}</div></div>
      <div class="form-team"><div class="form-team-name">${d.team2}</div><div class="form-dots">${form2}</div></div>
    </div></div>
    <div class="analysis-block ${isBk ? 'bk' : ''}"><div class="analysis-header">📊 Analyse experte IA</div>${d.analysis}</div>
    <div class="proba-section"><div class="section-title">🔑 Facteurs clés</div><div class="factors-grid">${factors}</div></div>
  `;

  const c = document.getElementById('results');
  if(c) {
    c.innerHTML = html; 
    c.classList.add('visible');
  }
  for (let i = 1; i <= 3; i++) { 
    const n = document.getElementById('s' + i + 'n'); 
    if(n) { n.classList.remove('active'); n.classList.add('done'); n.textContent = '✓'; }
  }
  setTimeout(() => {
    document.querySelectorAll('.proba-bar[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  }, 120);
  if(c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.chatCtx = d;
  addToHistory(d, evData);
}
// Nouveau système de confiance avancé
function computeAdvancedConfidence(d, fdData) {
  const weights = {
    forme: 0.20,
    blessures: 0.15,
    historique: 0.10,
    domicile: 0.10,
    motivation: 0.10,
    cotes: 0.10,
    iaConfidence: 0.15,
    dataQuality: 0.10
  };
  
  let scores = {};
  
  // 1. Forme récente
  const homeWins = (d.team1_form || []).filter(r => r === 'W').length;
  const awayWins = (d.team2_form || []).filter(r => r === 'W').length;
  scores.forme = (homeWins * 20 + awayWins * 20) / 2;
  
  // 2. Blessures
  scores.blessures = d.blessures_team1?.length === 0 && d.blessures_team2?.length === 0 ? 90 :
                     d.blessures_team1?.length <= 1 && d.blessures_team2?.length <= 1 ? 70 : 40;
  
  // 3. Historique des confrontations
  if (fdData?.head2head?.length) {
    const homeWins = fdData.head2head.filter(h => h.winner === 'HOME_TEAM').length;
    scores.historique = (homeWins / fdData.head2head.length) * 100;
  } else {
    scores.historique = 50;
  }
  
  // 4. Avantage domicile
  scores.domicile = d.proba_home > d.proba_away ? 80 : 40;
  
  // 5. Motivation (selon position au classement)
  scores.motivation = 70;
  
  // 6. Cotes
  if (d.odds_home && d.odds_away) {
    const impliedProb = (1/d.odds_home) * 100;
    scores.cotes = Math.min(100, Math.abs(impliedProb - d.proba_home) < 10 ? 80 : 50);
  } else {
    scores.cotes = 50;
  }
  
  // 7. Confiance IA
  scores.iaConfidence = d.best_bet_confidence || 60;
  
  // 8. Qualité des données
  scores.dataQuality = fdData ? 80 : 50;
  
  // Calcul pondéré
  let totalScore = 0;
  for (let key in weights) {
    totalScore += (scores[key] || 50) * weights[key];
  }
  
  return {
    global: Math.round(totalScore),
    details: scores,
    weights: weights
  };
}

function resetToStart() {
  state.selectedMatch = null;
  document.getElementById('team1').value = '';
  document.getElementById('team2').value = '';
  document.getElementById('evOdds').value = '';
  document.getElementById('evMarket').value = '';
  showStep(state.selectedLeague ? 2 : 1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ══════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════
function updateHistBadge() { const b = document.getElementById('histBadge'); if (b) b.textContent = getHist().length; }

function addToHistory(d, evData) {
  const h = getHist();
  h.unshift({
    id: Date.now(), date: new Date().toLocaleDateString('fr-FR'),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    team1: d.team1, team2: d.team2, league: d.league,
    best_bet: d.best_bet, best_bet_market: d.best_bet_market || '1',
    confidence: d.best_bet_confidence, odds: d.odds_home || d.odds_away || 0,
    ev: evData?.ev ?? null, stake: evData?.stake ?? null,
    proba_home: d.proba_home, proba_away: d.proba_away, proba_draw: d.proba_draw || 0,
    score_pred: d.score_pred || '', traffic_light: d.traffic_light || 'orange',
    stars: d.stars || 3, sport: d.sport || 'football', result: 'pending', pnl: 0
  });
  if (h.length > 50) h.splice(50);
  saveHist(h); updateHistBadge();
}

function setResult(id, val) {
  const h = getHist();
  const it = h.find(x => x.id === id);
  if (it) {
    it.result = val;
    const odds = parseFloat(it.odds) || 0;
    const stake = parseFloat(it.stake) || 10;
    it.pnl = val === 'win' && odds > 1 ? Math.round((odds - 1) * stake * 100) / 100 : val === 'lose' ? -stake : 0;
    saveHist(h); renderHistory(); renderDashboard();
  }
}

function clearHistory() { if (!confirm('Effacer tout ?')) return; localStorage.removeItem('ps_hist'); renderHistory(); updateHistBadge(); }

function renderHistory() {
  const h = getHist();
  const res = h.filter(x => x.result !== 'pending');
  const wins = res.filter(x => x.result === 'win').length;
  const loses = res.filter(x => x.result === 'lose').length;
  let pnl = 0;
  res.forEach(x => {
    const odds = parseFloat(x.odds) || 0, stake = parseFloat(x.stake) || 10;
    if (x.result === 'win' && odds > 1) pnl += Math.round((odds - 1) * stake * 100) / 100;
    else if (x.result === 'lose') pnl -= stake;
  });

  document.getElementById('hTotal').textContent = h.length;
  document.getElementById('hWins').textContent = wins;
  document.getElementById('hLoses').textContent = loses;
  document.getElementById('hRate').textContent = res.length ? Math.round(wins / res.length * 100) + '%' : '—';
  const pnlEl = document.getElementById('hPnl');
  if (pnlEl) { pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(0) + '€'; pnlEl.style.color = pnl >= 0 ? '#00dd55' : '#ff3333'; }
  const avgConf = h.length ? Math.round(h.reduce((a, x) => a + (x.confidence || 0), 0) / h.length) : 0;
  const confEl = document.getElementById('hAvgConf');
  if (confEl) confEl.textContent = avgConf ? avgConf + '%' : '—';

  const list = document.getElementById('histList');
  if (!h.length) { list.innerHTML = '<div class="hist-empty">📭 Aucune analyse</div>'; return; }
  list.innerHTML = h.map(it => {
    const cls = it.result === 'win' ? 'hist-win' : it.result === 'lose' ? 'hist-lose' : '';
    return `<div class="hist-card ${cls}">
      <div style="flex:1"><div style="font-weight:700;font-size:14px">${it.team1} vs ${it.team2}</div>
      <div style="font-size:10px;color:var(--muted)">${it.league}</div>
      <div style="font-size:12px;color:var(--accent);margin-top:4px">🎯 ${it.best_bet} · ${it.confidence}%</div></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div style="font-size:10px;color:var(--muted)">${it.date} ${it.time}</div>
        <select class="hist-result-select" onchange="setResult(${it.id},this.value)">
          <option value="pending"${it.result === 'pending' ? ' selected' : ''}>⏳ En attente</option>
          <option value="win"${it.result === 'win' ? ' selected' : ''}>✅ Gagné</option>
          <option value="lose"${it.result === 'lose' ? ' selected' : ''}>❌ Perdu</option>
          <option value="push"${it.result === 'push' ? ' selected' : ''}>↩️ Push</option>
        </select></div></div>`;
  }).join('');
}

// ══════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════
function renderDashboard() {
  const hist = getHist();
  const br = parseFloat(localStorage.getItem('ps_bankroll') || '1000');
  const wins = hist.filter(h => h.result === 'win').length;
  const total = hist.filter(h => h.result !== 'pending').length;
  const pnl = hist.reduce((a, h) => a + (parseFloat(h.pnl) || 0), 0);
  const wr = total > 0 ? Math.round(wins / total * 100) : 0;

  const el1 = document.getElementById('dashBankroll'); if (el1) el1.textContent = br.toFixed(0) + '€';
  const el2 = document.getElementById('dashWinrate'); if (el2) el2.textContent = wr + '%';
  const el3 = document.getElementById('dashPnl');
  if (el3) { el3.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '€'; el3.style.color = pnl >= 0 ? '#00dd55' : '#ff3333'; }

  const rp = document.getElementById('dashRecentPicks');
  if (rp) {
    if (!hist.length) {
      rp.innerHTML = '<div class="dash-empty">Aucun pari encore<br><button class="dash-cta" onclick="switchNav(\'prono\')">🔮 Analyser un match</button></div>';
    } else {
      rp.innerHTML = hist.slice(0, 5).map(h => {
        const rc = h.result === 'win' ? 'win' : h.result === 'lose' ? 'loss' : 'pending';
        return `<div class="dash-pick-row"><div class="dash-pick-result ${rc}">${h.result === 'win' ? 'W' : h.result === 'lose' ? 'L' : '?'}</div>
          <div style="flex:1"><div class="dash-pick-match">${h.team1 || ''} vs ${h.team2 || ''}</div>
          <div class="dash-pick-league">${h.best_bet || ''} | ${h.league || ''}</div></div></div>`;
      }).join('');
      rp.onclick = () => switchNav('history');
    }
  }
}

// ══════════════════════════════════════════════
// BANKROLL
// ══════════════════════════════════════════════
function setBankroll() {
  const val = parseFloat(document.getElementById('bkInitial').value);
  if (!val || val <= 0) { alert('Entre un montant valide'); return; }
  const d = getBankrollData();
  d.initial = val; d.current = d.current || val;
  if (!d.log) d.log = [];
  saveBankrollData(d);
  localStorage.setItem('ps_bankroll', val.toString());
  renderBankroll(); renderDashboard();
}

function resetBankroll() {
  if (!confirm('Réinitialiser ?')) return;
  localStorage.removeItem('ps_bankroll_data');
  localStorage.removeItem('ps_bankroll');
  renderBankroll(); renderDashboard();
}

function renderBankroll() {
  const d = getBankrollData();
  const initial = d.initial || parseFloat(localStorage.getItem('ps_bankroll')) || 0;
  const log = d.log || [];
  let current = initial;
  log.forEach(e => { current += (e.pnl || 0); });
  const profit = current - initial;
  const roi = initial > 0 ? Math.round(profit / initial * 10000) / 100 : 0;
  const el1 = document.getElementById('bkCurrent'); if (el1) el1.textContent = initial > 0 ? current.toFixed(0) + '€' : '—';
  const el2 = document.getElementById('bkProfit'); if (el2) { el2.textContent = initial > 0 ? (profit >= 0 ? '+' : '') + profit.toFixed(1) + '€' : '—'; el2.style.color = profit >= 0 ? '#00dd55' : '#ff3333'; }
  const el3 = document.getElementById('bkROI'); if (el3) el3.textContent = initial > 0 ? (roi >= 0 ? '+' : '') + roi + '%' : '—';
}

// ══════════════════════════════════════════════
// TODAY'S MATCHES
// ══════════════════════════════════════════════
async function fetchTodayMatches(force) {
  if (state.todayLoaded && !force) return;
  const content = document.getElementById('todayContent');
  const todayStr = new Date().toISOString().slice(0, 10);
  const dateEl = document.getElementById('todayDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  if (content) content.innerHTML = '<div class="today-loading">⏳ Chargement...</div>';

  try {
    const allMatches = [];
    const promises = TODAY_LEAGUES.map(league =>
      getLeagueEvents(league.tsdb).then(events => {
        (events || []).filter(e => e.dateEvent === todayStr || e.dateEvent === new Date(Date.now() + 86400000).toISOString().slice(0, 10))
          .forEach(e => {
            const m = tsdbToMatch(e);
            m.leagueName = league.name; m.leagueFlag = league.flag;
            m.leagueId = league.id; m.sport = league.sport;
            allMatches.push(m);
          });
      }).catch(() => {})
    );
    await Promise.all(promises);
    allMatches.sort((a, b) => a.live && !b.live ? -1 : !a.live && b.live ? 1 : (a.time || '').localeCompare(b.time || ''));
    state.todayData = allMatches;
    state.todayLoaded = true;
    renderTodayMatches();
  } catch (e) {
    if (content) content.innerHTML = `<div class="today-empty"><div style="font-size:40px">⚠️</div><div style="margin-top:10px">${e.message}</div></div>`;
  }
}

function renderTodayMatches() {
  const content = document.getElementById('todayContent');
  if (!content) return;
  const filtered = state.todayData.filter(m => {
    if (state.todayFilter === 'live') return m.live;
    if (state.todayFilter === 'soccer') return m.sport === 'soccer';
    if (state.todayFilter === 'basketball') return m.sport === 'basketball';
    return true;
  });
  if (!filtered.length) {
    content.innerHTML = '<div class="today-empty"><div style="font-size:48px">📭</div><div style="margin-top:12px;font-weight:700">Aucun match</div></div>';
    return;
  }
  const byLeague = {};
  filtered.forEach(m => {
    const key = m.leagueFlag + ' ' + m.leagueName;
    if (!byLeague[key]) byLeague[key] = [];
    byLeague[key].push(m);
  });
  let html = `<div class="today-summary"><span>⚽ <strong>${filtered.length}</strong> matchs</span></div>`;
  Object.entries(byLeague).forEach(([league, matches]) => {
    html += `<div class="today-league-block"><div class="today-league-title">${league}</div>`;
    matches.forEach(m => {
      const score = (m.score1 != null && m.score2 != null) ? m.score1 + ' - ' + m.score2 : 'vs';
      const idx = state.todayData.indexOf(m);
      html += `<div class="today-match-row">
        <div class="today-match-time" style="color:${m.live ? '#ff3333' : 'var(--text2)'}">${m.live ? '🔴 LIVE' : m.time || '--:--'}</div>
        <div class="today-match-teams"><span class="today-team">${m.team1}</span><span class="today-score">${score}</span><span class="today-team today-team-away">${m.team2}</span></div>
        <button class="today-analyze-btn" onclick="todayAnalyze(${idx})">⚡</button></div>`;
    });
    html += '</div>';
  });
  content.innerHTML = html;
}

function filterToday(filter, btn) {
  state.todayFilter = filter;
  document.querySelectorAll('.today-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderTodayMatches();
}

function todayAnalyze(idx) {
  const m = state.todayData[idx];
  if (!m) return;
  const league = LEAGUES.find(l => l.id === m.leagueId);
  if (league) state.selectedLeague = league;
  state.selectedMatch = m;
  switchNav('prono');
  document.getElementById('team1').value = m.team1;
  document.getElementById('team2').value = m.team2;
  showStep(3);
}

// ══════════════════════════════════════════════
// LIVE SCORES
// ══════════════════════════════════════════════
async function fetchLive(force) {
  const btn = document.getElementById('liveRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Chargement...'; }
  const content = document.getElementById('liveContent');
  if (content) content.innerHTML = '<div class="live-empty"><div style="font-size:32px">📡</div><div style="margin-top:8px;color:var(--muted)">Connexion...</div></div>';

  try {
    const topLeagues = ['pl','ligue1','laliga','bundesliga','seriea','ucl','uel','nba'];
    const results = await Promise.all(topLeagues.map(lid => {
      const tsdbId = TSDB_LEAGUE_MAP[lid];
      return tsdbId ? getLeagueEvents(tsdbId).catch(() => []) : Promise.resolve([]);
    }));

    const seen = {};
    state.liveData = [];
    results.flat().forEach(e => {
      const key = (e.strHomeTeam || '') + (e.strAwayTeam || '') + (e.dateEvent || '');
      if (!seen[key]) { seen[key] = true; state.liveData.push(tsdbToMatch(e)); }
    });

    state.liveData.sort((a, b) => {
      const order = { "Aujourd'hui": 0, "Demain": 1 };
      const ao = order[a.date] ?? 2, bo = order[b.date] ?? 2;
      if (ao !== bo) return ao - bo;
      if (a.live && !b.live) return -1;
      if (!a.live && b.live) return 1;
      return (a.time || '').localeCompare(b.time || '');
    });

    const ts = document.getElementById('liveLastUpdate');
    if (ts) ts.textContent = 'Mis à jour ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    renderLiveContent();
  } catch (e) {
    if (content) content.innerHTML = `<div class="live-empty"><div style="font-size:32px">⚠️</div><div style="margin-top:8px">${e.message}</div></div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Actualiser'; }
  }
}

function renderLiveContent() {
  const content = document.getElementById('liveContent');
  if (!content) return;
  const filtered = state.liveData.filter(m => state.liveFilter === 'all' || m.sport === state.liveFilter);
  if (!filtered.length) {
    content.innerHTML = '<div class="live-empty"><div style="font-size:40px">📭</div><div style="margin-top:10px">Aucun match</div></div>';
    return;
  }
  const byLeague = {};
  filtered.forEach(m => { const l = m.league || 'Autre'; if (!byLeague[l]) byLeague[l] = []; byLeague[l].push(m); });
  let html = '';
  Object.entries(byLeague).forEach(([league, matches]) => {
    html += `<div class="live-league-block"><div class="live-league-name">${league}</div>`;
    matches.forEach(m => {
      const isLive = m.live || m.status === 'LIVE';
      const score = (m.score1 != null && m.score2 != null) ? m.score1 + ' — ' + m.score2 : '— — —';
      html += `<div class="live-match-row" onclick="prefillFromLive('${(m.team1||'').replace(/'/g,"\\'")}','${(m.team2||'').replace(/'/g,"\\'")}')">
        <div class="live-match-teams"><span class="live-team">${m.team1}</span><span class="live-score ${isLive ? 'live-score-active' : ''}">${score}</span><span class="live-team live-team-away">${m.team2}</span></div>
        <button class="live-analyze-btn" onclick="event.stopPropagation();prefillFromLive('${(m.team1||'').replace(/'/g,"\\'")}','${(m.team2||'').replace(/'/g,"\\'")}')">⚡</button></div>`;
    });
    html += '</div>';
  });
  content.innerHTML = html;
}

function filterLive() { state.liveFilter = document.getElementById('liveSportFilter').value || 'all'; renderLiveContent(); }

function prefillFromLive(t1, t2) {
  switchNav('prono');
  document.getElementById('team1').value = t1;
  document.getElementById('team2').value = t2;
  showStep(3);
}

function saveLiveKey() { 
  alert('Les clés API sont maintenant configurées sur le serveur dans le fichier .env'); 
}

// ══════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════
function renderAlertFavs() {
  const favs = getFavs();
  const banner = document.getElementById('alertPermBanner');
  if (banner) banner.style.display = Notification.permission === 'granted' ? 'none' : 'flex';
  const top = ['ligue1','pl','laliga','bundesliga','seriea','ucl','nba','euroleague'];
  const grid = document.getElementById('alertFavGrid');
  if (!grid) return;
  grid.innerHTML = LEAGUES.filter(l => top.includes(l.id)).map(l => {
    const on = favs.includes(l.id);
    return `<div class="alert-fav-card${on ? ' fav-on' : ''}" onclick="toggleFav('${l.id}')">
      <div style="font-size:14px">${on ? '🔔' : '🔕'}</div>
      <div><div class="alert-fav-name">${l.flag} ${l.name}</div><div class="alert-fav-country">${l.country}</div></div></div>`;
  }).join('');
}

function toggleFav(id) { const f = getFavs(); const idx = f.indexOf(id); if (idx >= 0) f.splice(idx, 1); else f.push(id); saveFavs(f); renderAlertFavs(); }

function requestNotifPerm() { Notification.requestPermission().then(p => { if (p === 'granted') { document.getElementById('alertPermBanner').style.display = 'none'; new Notification('PronoSight', { body: 'Notifications activées !' }); } }); }

async function scanAlerts() {
  const favs = getFavs();
  if (!favs.length) { alert('Sélectionne au moins une ligue'); return; }
  const thresh = parseInt(document.getElementById('alertThresh').value) || 70;
  const btn = document.getElementById('alertScanBtn');
  btn.disabled = true; btn.textContent = 'Scan en cours...';
  const resDiv = document.getElementById('alertResults');
  const names = LEAGUES.filter(l => favs.includes(l.id)).map(l => l.name + ' (' + l.country + ')').join(', ');
  try {
    const data = await callGemini([{
      role: 'user',
      content: `Recherche les matchs dans les 3 prochains jours pour : ${names}. Pour chaque match estime la confiance IA. TOUT EN FRANCAIS. Retourne uniquement JSON: {"signals":[{"league":"x","team1":"x","team2":"x","date":"JJ/MM","best_bet":"x","confidence":75,"reason":"Raison"}]} Seulement confidence >= ${thresh}. Max 8.`
    }], { useSearch: true, maxTokens: 900 });
    const parsed = extractJSON(extractText(data));
    const signals = parsed?.signals || [];
    resDiv.innerHTML = signals.length
      ? signals.map(s => `<div class="alert-hit"><div style="font-weight:700">⚡ ${s.team1} vs ${s.team2}</div><div style="font-size:10px;color:var(--muted)">${s.league} · ${s.date}</div><div style="font-size:12px;color:var(--yellow);margin-top:5px">🎯 ${s.best_bet} · <strong>${s.confidence}%</strong></div></div>`).join('')
      : '<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px">Aucun signal. Baisse le seuil ou réessaie.</div>';
  } catch (e) {
    resDiv.innerHTML = `<div style="color:var(--ev-neg);font-size:12px;padding:12px">${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🔍 SCANNER MES LIGUES';
  }
}

// ══════════════════════════════════════════════
// PARLAY BUILDER
// ══════════════════════════════════════════════
function addParlayLeg() {
  const legs = document.getElementById('parlayLegs');
  if (legs.children.length >= 6) { alert('Maximum 6 matchs'); return; }
  parlayCount++;
  const n = parlayCount, num = legs.children.length + 1;
  const div = document.createElement('div');
  div.className = 'parlay-leg'; div.id = 'pl' + n;
  div.innerHTML = `<div class="parlay-leg-header"><div class="parlay-leg-title">Match ${num}</div><button class="parlay-remove" onclick="document.getElementById('pl${n}').remove()">✕</button></div>
    <div class="parlay-inputs">
      <div class="parlay-field"><label>Equipes</label><input class="parlay-input" id="pt${n}" placeholder="PSG vs Lyon"></div>
      <div class="parlay-field"><label>Pari</label><input class="parlay-input" id="pb${n}" placeholder="PSG gagne"></div>
      <div class="parlay-field"><label>Cote</label><input class="parlay-input" type="number" step="0.01" min="1" id="po${n}" placeholder="1.85"></div>
      <div class="parlay-field"><label>Proba %</label><input class="parlay-input" type="number" min="1" max="99" id="pp${n}" placeholder="62"></div>
    </div>`;
  legs.appendChild(div);
}

function calcParlay() {
  const legs = document.querySelectorAll('.parlay-leg');
  if (legs.length < 2) { alert('Ajoute au moins 2 matchs'); return; }
  const stake = parseFloat(document.getElementById('parlayStake').value) || 10;
  let combOdds = 1, combProb = 1, valid = 0;
  legs.forEach(leg => {
    const n = leg.id.replace('pl', '');
    const odds = parseFloat(document.getElementById('po' + n)?.value) || 0;
    const prob = parseFloat(document.getElementById('pp' + n)?.value) || 0;
    if (odds > 1) { combOdds *= odds; if (prob > 0) combProb *= (prob / 100); valid++; }
  });
  if (valid < 2) { alert('Remplis au moins 2 matchs'); return; }
  combOdds = Math.round(combOdds * 100) / 100;
  const probPct = Math.round(combProb * 10000) / 100;
  const potWin = Math.round(stake * combOdds * 100) / 100;
  const ev = Math.round((combProb * (combOdds - 1) - (1 - combProb)) * 10000) / 100;
  const isPos = ev > 0;
  const res = document.getElementById('parlayResult');
  res.style.display = 'block';
  res.innerHTML = `<div style="background:var(--surface);border:1px solid ${isPos ? 'rgba(127,255,107,.4)' : 'var(--border)'};border-radius:var(--r);padding:20px">
    <div style="font-size:10px;letter-spacing:2px;color:var(--muted);margin-bottom:12px">RÉSULTAT PARLAY</div>
    <div class="parlay-result-row"><div class="parlay-result-label">Cote combinée</div><div class="parlay-result-val" style="color:var(--accent)">${combOdds}</div></div>
    <div class="parlay-result-row"><div class="parlay-result-label">Probabilité</div><div class="parlay-result-val">${probPct}%</div></div>
    <div class="parlay-result-row"><div class="parlay-result-label">Gain potentiel</div><div class="parlay-result-val" style="color:var(--accent3)">€${potWin}</div></div>
    <div class="parlay-result-row"><div class="parlay-result-label">Value (EV)</div><div class="parlay-result-val" style="color:${isPos ? 'var(--ev-pos)' : 'var(--ev-neg)'}">${isPos ? '+' : ''}${ev}%</div></div>
  </div>`;
}

// ══════════════════════════════════════════════
// QUICK PICK
// ══════════════════════════════════════════════
async function runQuickPick() {
  const btn = document.getElementById('qpScanBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scan...'; }
  const resDiv = document.getElementById('qpResults');
  resDiv.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px">🔍 Recherche...</div>';
  const favs = getFavs();
  const leagueNames = favs.length
    ? LEAGUES.filter(l => favs.includes(l.id)).map(l => l.name + ' (' + l.country + ')').join(', ')
    : 'Ligue 1, Premier League, La Liga, Champions League, NBA';
  try {
    const data = await callGemini([{
      role: 'user',
      content: `Date: ${new Date().toLocaleDateString('fr-FR')}. Matchs du jour et demain dans: ${leagueNames}. FRANCAIS. JSON: {"picks":[{"league":"x","team1":"x","team2":"x","date":"JJ/MM","best_bet":"x","confidence":75,"odds":1.85,"reason":"phrase"}]} Max 8, triés par confiance, >= 60%.`
    }], { useSearch: true, maxTokens: 1200 });
    const picks = extractJSON(extractText(data))?.picks || [];
    resDiv.innerHTML = picks.length
      ? picks.map((p, i) => `<div class="qp-card${i === 0 ? ' top-pick' : ''}">
          ${i === 0 ? '<div class="qp-card-badge">🏆 TOP PICK</div>' : ''}
          <div class="qp-card-match">${p.team1} vs ${p.team2}</div>
          <div class="qp-card-league">${p.league} · ${p.date}</div>
          <div class="qp-card-bet">🎯 ${p.best_bet}</div>
          <div class="qp-card-stats"><span class="qp-chip" style="color:${p.confidence >= 75 ? '#00dd55' : '#ffcc00'}">${p.confidence}%</span>${p.odds ? `<span class="qp-chip">@${p.odds}</span>` : ''}</div>
        </div>`).join('')
      : '<div style="text-align:center;padding:30px;color:var(--muted)">Aucun pick. Réessaie plus tard.</div>';
  } catch (e) {
    resDiv.innerHTML = `<div style="color:var(--ev-neg);padding:12px">${e.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 SCANNER'; }
  }
}

// ══════════════════════════════════════════════
// COMBOS AUTO
// ══════════════════════════════════════════════
async function buildCombos() {
  const btn = document.getElementById('comboBuildBtn');
  btn.disabled = true; btn.textContent = 'Génération...';
  const res = document.getElementById('comboResults');
  const size = parseInt(document.getElementById('comboSize').value) || 3;
  const stake = parseFloat(document.getElementById('comboStake').value) || 20;
  const lf = document.getElementById('comboLeagueFilter').value;
  const favs = getFavs();
  let ctx;
  if (lf === 'football') ctx = 'Ligue 1, Premier League, La Liga, Bundesliga, Serie A, Champions League';
  else if (lf === 'basket') ctx = 'NBA, Euroleague';
  else if (favs.length) ctx = LEAGUES.filter(l => favs.includes(l.id)).map(l => l.name).join(', ');
  else ctx = 'Ligue 1, Premier League, La Liga, Champions League';

  try {
    const d1 = await callGemini([{
      role: 'user',
      content: `Recherche les VRAIS matchs programmés pour les 3 prochains jours dans: ${ctx}. Pour chaque match: equipe1, equipe2, competition, date.`
    }], { useSearch: true, maxTokens: 1200 });
    const info = extractText(d1);

    const d2 = await callGemini([{
      role: 'user',
      content: `Matchs trouvés:\n${info.slice(0, 1000)}\n\nA partir de CES matchs, 3 combinés de ${size} legs chacun. JSON: {"combos":[{"type":"safe","label":"Sécurisé","legs":[{"team1":"x","team2":"x","league":"x","date":"JJ/MM","bet":"1","odds":1.45,"confidence":84,"proba":76,"reason":"phrase"}],"combined_odds":2.1,"combined_proba":42,"ev":5.2,"verdict":"phrase"}]} 3 types: safe, value, balanced. EXACTEMENT ${size} legs par combo.`
    }], { maxTokens: 4000 });

    const parsed = extractJSON(extractText(d2));
    const combos = parsed?.combos || [];
    if (!combos.length) throw new Error('Aucun combiné généré');

    res.innerHTML = combos.map((combo, ci) => {
      const odds = combo.combined_odds || combo.legs.reduce((a, l) => Math.round(a * l.odds * 100) / 100, 1);
      const proba = combo.combined_proba || Math.round(combo.legs.reduce((a, l) => a * (l.proba / 100), 1) * 10000) / 100;
      const ev = combo.ev ?? Math.round((proba / 100 * (odds - 1) - (1 - proba / 100)) * 10000) / 100;
      const isPos = ev > 0;
      const typeStyles = { safe: { cls: 'csafe', lbl: '🛡️ SÉCURISÉ' }, value: { cls: 'cvalue', lbl: '💹 VALEUR' }, balanced: { cls: 'cbalanced', lbl: '⚖️ ÉQUILIBRÉ' } };
      const t = typeStyles[combo.type] || typeStyles.balanced;
      return `<div class="combo-card ${t.cls}">
        <div class="combo-badge">${t.lbl}</div>
        <div class="combo-legs">${combo.legs.map((leg, i) => `
          <div class="combo-leg"><div class="combo-leg-num">${i + 1}</div><div class="combo-leg-info">
            <div class="combo-leg-match">${leg.team1} vs ${leg.team2}</div>
            <div class="combo-leg-bet">🎯 ${leg.bet} @ ${leg.odds}</div>
            <div class="combo-leg-meta">${leg.league} · ${leg.date}</div>
          </div><div class="combo-leg-conf" style="color:${leg.confidence >= 80 ? '#00dd55' : '#ffcc00'}">${leg.confidence}%</div></div>`).join('')}
        </div>
        <div class="combo-totals">
          <div class="combo-total"><div class="combo-total-val" style="color:var(--accent)">${odds}</div><div class="combo-total-lbl">COTE</div></div>
          <div class="combo-total"><div class="combo-total-val">${proba}%</div><div class="combo-total-lbl">PROBA</div></div>
          <div class="combo-total"><div class="combo-total-val" style="color:var(--accent3)">€${Math.round(stake * odds * 100) / 100}</div><div class="combo-total-lbl">GAIN</div></div>
          <div class="combo-total"><div class="combo-total-val" style="color:${isPos ? 'var(--ev-pos)' : 'var(--ev-neg)'}">${isPos ? '+' : ''}${ev}%</div><div class="combo-total-lbl">EV</div></div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    res.innerHTML = `<div style="color:var(--ev-neg);padding:16px">${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.innerHTML = '✨ GÉNÉRER';
  }
}

// ══════════════════════════════════════════════
// API KEY MODALS
// ══════════════════════════════════════════════
window.showApiKeyModal = function() {
  document.getElementById('apiKeyModal').classList.add('show');
  setTimeout(() => document.getElementById('akInput').focus(), 100);
};

window._saveKey = function() {
  const key = document.getElementById('akInput').value.trim();
  if (!key) {
    document.getElementById('akErr').style.display = 'block';
    return;
  }
  localStorage.setItem('ps_apikey', key);
  document.getElementById('apiKeyModal').classList.remove('show');
  alert('Clé API sauvegardée localement. Redémarrez le serveur pour l\'utiliser avec Gemini.');
};

window.showOddsKeyModal = function() {
  const key = prompt("Entrez votre clé API The Odds API (optionnelle):");
  if (key) {
    localStorage.setItem('ps_oddskey', key);
    alert('Clé Odds API sauvegardée. Redémarrez le serveur.');
  }
};

window.showFdKeyModal = function() {
  const key = prompt("Entrez votre clé API football-data.org (optionnelle):");
  if (key) {
    localStorage.setItem('ps_fdkey', key);
    alert('Clé football-data.org sauvegardée. Redémarrez le serveur.');
  }
};

window._saveOddsKey = window.showOddsKeyModal;
window._saveFdKey = window.showFdKeyModal;

// ══════════════════════════════════════════════
// PWA
// ══════════════════════════════════════════════
function installPWA() { if (_deferredPrompt) { _deferredPrompt.prompt(); _deferredPrompt.userChoice.then(() => { _deferredPrompt = null; }); } }

// ══════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') resetToStart();
  if (e.key === 'h' || e.key === 'H') switchNav('history');
  if (e.key === 'p' || e.key === 'P') switchNav('prono');
  if (e.key === 'Enter') {
    const t1 = document.getElementById('team1'), t2 = document.getElementById('team2');
    if (t1?.value.trim() && t2?.value.trim()) analyze();
  }
});

// ══════════════════════════════════════════════
// EXPOSITION GLOBALE
// ══════════════════════════════════════════════
window.selectSport = selectSport;
window.switchNav = switchNav;
window.filterLeagues = filterLeagues;
window.setCat = setCat;
window.pickLeague = pickLeague;
window.pickMatch = pickMatch;
window.quickAnalyzeMatch = quickAnalyzeMatch;
window.analyze = analyze;
window.resetToStart = resetToStart;
window.addParlayLeg = addParlayLeg;
window.calcParlay = calcParlay;
window.scanAlerts = scanAlerts;
window.toggleFav = toggleFav;
window.requestNotifPerm = requestNotifPerm;
window.setResult = setResult;
window.clearHistory = clearHistory;
window.setBankroll = setBankroll;
window.resetBankroll = resetBankroll;
window.runQuickPick = runQuickPick;
window.buildCombos = buildCombos;
window.toggleTheme = toggleTheme;
window.showApiKeyModal = showApiKeyModal;
window.showOddsKeyModal = showOddsKeyModal;
window.showFdKeyModal = showFdKeyModal;
window._saveKey = _saveKey;
window._saveOddsKey = _saveOddsKey;
window._saveFdKey = _saveFdKey;
window.installPWA = installPWA;
window.filterToday = filterToday;
window.todayAnalyze = todayAnalyze;
window.fetchTodayMatches = fetchTodayMatches;
window.filterLive = filterLive;
window.prefillFromLive = prefillFromLive;
window.saveLiveKey = saveLiveKey;
window.clearMatchCache = clearMatchCache;

// Initialisation
document.addEventListener('DOMContentLoaded', initApp);

// PWA Install prompt
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _deferredPrompt = e; const btn = document.getElementById('pwaInstallBtn'); if (btn) btn.style.display = 'flex'; });

console.log('⚡ PronoSight v4.0 chargé - Toutes les fonctions sont exposées');// v4.1 deploy fix
