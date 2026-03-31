// ══════════════════════════════════════════════════════════════
// PronoSight v4.0 — app.js (VERSION STABLE GEMINI)
// ══════════════════════════════════════════════════════════════

import { LEAGUES, CATS, CUP_IDS, CACHE_TTL, ANALYSIS_CACHE_TTL,
         TSDB_LEAGUE_MAP, FD_COMP_MAP, TODAY_LEAGUES, ODDS_SPORT_MAP } from './modules/config.js';
import { state, MATCH_CACHE, getCachedAnalysis, setCachedAnalysis,
         clearOldCaches, getHist, saveHist, getFavs, saveFavs,
         getBankrollData, saveBankrollData } from './modules/state.js';
import { callClaude, callGemini, extractText, extractJSON, tsdbFetch, getLeagueEvents,
         tsdbToMatch, fdFetch, fdToMatch, fetchRealOdds, fetchApiStatus, fetchMatchDetails, fetchLeagueStandings, fetchLiveStats, fetchH2H, fetchRealStats } from './modules/api.js';
// ══════════════════════════════════════════════
// VARIABLES GLOBALES
// ══════════════════════════════════════════════
let _deferredPrompt = null;
let parlayCount = 0;
let _histFilter = { result: 'all', search: '' };
let _histMode = 'victor'; // 'victor' | 'personal'

// Victor IA — cache des données chargées au boot
const victorState = { today: null, stats: null, patterns: null, history: null, loading: false, loaded: false };
const VICTOR_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let victorLastFetch = 0;
let victorAbortController = null;
let _switchNavTimer = null; // debounce switchNav

// ══════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════
async function initApp() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
  if (localStorage.getItem('ps_theme') === 'light') {
    document.body.classList.add('light-mode');
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = '☀️';
  }
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
  // Charge les données Victor immédiatement, re-render dashboard quand prêt
  loadVictorData().then(() => renderDashboard());
  // Auto-refresh Victor toutes les 10 minutes (silencieux, arrière-plan)
  setInterval(() => loadVictorData({ force: false }).then(() => renderDashboard()), 10 * 60 * 1000);
  // Refresh au retour sur l'onglet uniquement si cache expiré
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - victorLastFetch > VICTOR_CACHE_TTL) {
      loadVictorData({ force: false }).then(() => renderDashboard());
    }
  });
  // Scan auto toutes les 3h si notifications activées
  autoScanAlerts();
  setInterval(autoScanAlerts, 3 * 60 * 60 * 1000);
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
  // Mise à jour visuelle immédiate (pas de debounce sur le CSS)
  const pv = document.getElementById('pronoView');
  if (pv) pv.style.display = tab === 'prono' ? 'block' : 'none';
  ['history','parlay','alerts','bankroll','quickpick','combo','dash','live','today','victor'].forEach(t => {
    const el = document.getElementById(t + 'View');
    if (el) el.classList.toggle('visible', t === tab);
  });
  ['prono','history','parlay','alerts','bankroll','quickpick','combo','dash','live','today','victor'].forEach(t => {
    const b = document.getElementById('nav-' + t);
    if (b) b.classList.toggle('active', t === tab);
  });
  // Live : démarre/arrête le refresh indépendamment du debounce
  if (tab === 'live') { fetchLive(false); startLiveAutoRefresh(); } else stopLiveAutoRefresh();

  // Debounce 150ms sur le chargement de données (évite les fetches en rafale)
  if (_switchNavTimer) clearTimeout(_switchNavTimer);
  _switchNavTimer = setTimeout(() => {
    _switchNavTimer = null;
    if (tab === 'history') renderHistory();
    if (tab === 'dash') renderDashboard();
    if (tab === 'victor') renderVictorView();
    if (tab === 'prono') renderPronoVictor();
    if (tab === 'today') fetchTodayMatches(false);
    if (tab === 'alerts') renderAlertFavs();
    if (tab === 'bankroll') renderBankroll();
    if (tab === 'parlay' && document.getElementById('parlayLegs')?.children.length === 0) {
      addParlayLeg(); addParlayLeg();
    }
  }, 150);
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

  // ── SOURCE 1 : Football-data.org (primaire pour Top 5 + coupes) ──
  const fdCompId = FD_COMP_MAP[state.selectedLeague.id];
  if (fdCompId && state.apiStatus?.footballData) {
    try {
      const todayISO = new Date().toISOString().slice(0, 10);
      const in14days = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const data = await fdFetch(`competitions/${fdCompId}/matches?dateFrom=${todayISO}&dateTo=${in14days}`);
      if (data?.matches?.length) {
        const leagueMeta = { name: state.selectedLeague.name, flag: state.selectedLeague.flag, id: state.selectedLeague.id };
        const formatted = data.matches.slice(0, 20).map(m => fdToMatch(m, leagueMeta));
        MATCH_CACHE[cacheKey] = { matches: formatted, ts: Date.now() };
        renderMatches(formatted, false);
        return;
      }
    } catch (e) {
      console.log('football-data.org indisponible:', e.message);
    }
  }

  // ── SOURCE 2 : TheSportsDB (fallback pour toutes les autres ligues) ──
  const tsdbId = TSDB_LEAGUE_MAP[state.selectedLeague.id];
  if (tsdbId) {
    try {
      const events = await getLeagueEvents(tsdbId);
      if (events && events.length > 0) {
        const formatted = events.map(tsdbToMatch);
        MATCH_CACHE[cacheKey] = { matches: formatted, ts: Date.now() };
        renderMatches(formatted, false);
        return;
      }
    } catch (e) {
      console.log('TheSportsDB indisponible:', e.message);
    }
  }

  // Pas de matchs trouvés → trêve ou données indisponibles
  // On n'utilise PAS Gemini ici : il retourne des matchs incorrects en période de trêve
  container.innerHTML = `
    <div class="match-loading" style="color:var(--muted);line-height:1.8">
      🗓️ <strong style="color:var(--text2)">Aucun match programmé</strong><br>
      <span style="font-size:11px">Trêve internationale ou calendrier indisponible pour cette ligue.</span><br>
      <span style="color:var(--accent);font-size:12px">↓ Saisissez les équipes manuellement pour obtenir une analyse</span>
    </div>`;

  // Pré-remplir les placeholders selon la ligue
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
    // Récupérer données football-data, classement, H2H, cotes réelles et stats API-Football en parallèle
    const [fdData, standings, h2hEvents, realOdds, realStats] = await Promise.all([
      fetchMatchDetails(t1, t2, state.selectedLeague?.id),
      fetchLeagueStandings(state.selectedLeague?.id),
      fetchH2H(state.selectedMatch?.home_team_id, state.selectedMatch?.away_team_id),
      fetchRealOdds(t1, t2, state.selectedLeague?.id),
      fetchRealStats(t1, t2, state.selectedLeague?.id)
    ]);

    // Extraire les stats des deux équipes depuis le classement
    let standingsCtx = '';
    if (standings?.length) {
      const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const n1 = normalize(t1), n2 = normalize(t2);
      const row1 = standings.find(r => { const n = normalize(r.team?.name || r.team?.shortName || ''); return n.includes(n1) || n1.includes(n); });
      const row2 = standings.find(r => { const n = normalize(r.team?.name || r.team?.shortName || ''); return n.includes(n2) || n2.includes(n); });
      const fmt = (r) => r ? `${r.position}e (${r.points} pts, ${r.won}V-${r.draw}N-${r.lost}D, forme: ${r.form || '?'})` : '?';
      if (row1 || row2) standingsCtx = `\nCLASSEMENT OFFICIEL: ${t1}: ${fmt(row1)} | ${t2}: ${fmt(row2)}`;
    }

    // H2H
    let h2hCtx = '';
    if (h2hEvents?.length) {
      const h2hLines = h2hEvents.map(e =>
        `${e.dateEvent || ''}: ${e.strHomeTeam} ${e.intHomeScore}-${e.intAwayScore} ${e.strAwayTeam}`
      ).join('\n');
      h2hCtx = `\nHISTORIQUE H2H (${h2hEvents.length} derniers face-à-face):\n${h2hLines}`;
    } else {
      h2hCtx = `\nH2H: Utilise tes connaissances des confrontations directes récentes entre ${t1} et ${t2}.`;
    }

    // Stats réelles API-Football (forme, blessures, H2H)
    let statsCtx = '';
    if (realStats) {
      const fmtForm = (fixtures, teamId) => {
        if (!fixtures?.length) return 'N/A';
        return fixtures.slice(0, 5).map(f => {
          const g = f.goals, teams = f.teams;
          const isHome = teams.home.id === teamId;
          let res;
          if (teams.home.winner === true) res = isHome ? 'W' : 'L';
          else if (teams.away.winner === true) res = isHome ? 'L' : 'W';
          else res = 'D';
          const score = `${g.home}-${g.away}`;
          const opp = isHome ? teams.away.name : teams.home.name;
          return `${res}(${score} vs ${opp})`;
        }).join(', ');
      };

      const fmtH2H = (fixtures) => {
        if (!fixtures?.length) return 'N/A';
        return fixtures.slice(0, 5).map(f => {
          const g = f.goals, teams = f.teams, date = f.fixture.date?.slice(0, 10) || '';
          return `${date}: ${teams.home.name} ${g.home}-${g.away} ${teams.away.name}`;
        }).join(' | ');
      };

      const fmtInj = (injuries) => {
        if (!injuries?.length) return 'aucun signalé';
        // Structure api-sports.io: i.player.type = type, i.player.reason = raison
        const unique = [];
        const seen = new Set();
        for (const i of injuries) {
          if (!seen.has(i.player?.name)) {
            seen.add(i.player?.name);
            unique.push(`${i.player?.name} (${i.player?.reason || i.player?.type || '?'})`);
          }
          if (unique.length >= 5) break;
        }
        return unique.join(', ') || 'aucun signalé';
      };

      statsCtx = `\n\n⚡ STATISTIQUES RÉELLES (API-Football — utilise ces données en priorité absolue):
- Forme récente ${t1}: ${fmtForm(realStats.form1, realStats.team1Id)}
- Forme récente ${t2}: ${fmtForm(realStats.form2, realStats.team2Id)}
- H2H récents: ${fmtH2H(realStats.h2h)}
- Blessés/suspendus ${t1}: ${fmtInj(realStats.injuries1)}
- Blessés/suspendus ${t2}: ${fmtInj(realStats.injuries2)}`;
    }

    // Score match aller (coupe / double confrontation)
    const leg1Val = (document.getElementById('leg1Score') || { value: '' }).value.trim();
    const leg1Ctx = leg1Val ? ` Score match aller: ${leg1Val}.` : '';

    // Prompt principal
    const prompt = `Tu es un expert en pronostics sportifs. Analyse ce match et réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown.

MATCH: ${t1} vs ${t2}
COMPÉTITION: ${league}
DATE: ${matchDate}${leg1Ctx}
SPORT: ${sport}${standingsCtx}${h2hCtx}${statsCtx}

Retourne EXACTEMENT cet objet JSON avec toutes ces clés, en remplaçant chaque valeur par ta vraie analyse:
{
  "sport": "${sport}",
  "team1": "${t1}",
  "team2": "${t2}",
  "team1_emoji": "emoji représentant ${t1}",
  "team2_emoji": "emoji représentant ${t2}",
  "league": "${league}",
  "match_date": "${matchDate}",
  "is_live": ${isLive},
  "proba_home": <entier 0-100, probabilité victoire ${t1}>,
  "proba_draw": <entier 0-100, probabilité nul — 0 si basketball>,
  "proba_away": <entier 0-100, probabilité victoire ${t2}>,
  "score_pred": "<score le plus probable ex: 2-1>",
  "score_pred_pct": <probabilité de ce score en %, entier>,
  "alt_score1": "<score alternatif 1>",
  "alt_score1_pct": <probabilité alt1 en %, entier>,
  "alt_score2": "<score alternatif 2>",
  "alt_score2_pct": <probabilité alt2 en %, entier>,
  "market_btts": "<Oui ou Non>",
  "market_btts_conf": <confiance BTTS en %, entier>,
  "market_over_line": "<2.5 ou 3.5>",
  "market_over": "<Over ou Under>",
  "market_over_conf": <confiance Over/Under en %, entier>,
  "market_handicap": "<ex: -1 ou +1>",
  "market_handicap_conf": <confiance handicap en %, entier>,
  "best_bet": "<description du meilleur pari recommandé>",
  "best_bet_market": "<1, X, 2, Over 2.5, BTTS, etc.>",
  "best_bet_confidence": <confiance du meilleur pari en %, entier 0-100>,
  "stars": <note qualité du pari de 1 à 5>,
  "traffic_light": "<vert, orange ou rouge>",
  "analysis": "<analyse experte en 3-4 phrases, en français>",
  "simple_explanation": "<explication simple avec emojis, en français>",
  "team1_form": ["W","D","L","W","W"],
  "team2_form": ["L","W","D","L","W"],
  "blessures_team1": ["<joueur blessé si connu>"],
  "blessures_team2": ["<joueur blessé si connu>"],
  "key_factors": [
    {"icon": "🏠", "text": "<facteur clé 1>"},
    {"icon": "📊", "text": "<facteur clé 2>"},
    {"icon": "⚽", "text": "<facteur clé 3>"},
    {"icon": "💪", "text": "<facteur clé 4>"}
  ],
  "odds_home": <cote estimée victoire ${t1}, nombre décimal>,
  "odds_draw": <cote estimée nul, nombre décimal>,
  "odds_away": <cote estimée victoire ${t2}, nombre décimal>,
  "odds_source": "estimation",
  "alt_bets": [
    {"market": "<marché ex: BTTS, Over 2.5, Double chance, Handicap>", "pick": "<sélection recommandée>", "confidence": <entier 50-90>, "desc": "<raison courte en français>"},
    {"market": "<marché 2>", "pick": "<sélection 2>", "confidence": <entier>, "desc": "<raison courte>"},
    {"market": "<marché 3>", "pick": "<sélection 3>", "confidence": <entier>, "desc": "<raison courte>"}
  ]
}

RÈGLES ABSOLUES:
- proba_home + proba_draw + proba_away = 100
- best_bet_confidence entre 50 et 95
- traffic_light = "vert" si best_bet_confidence >= 70, "orange" si >= 55, "rouge" sinon
- stars = 1 si confidence < 55, 2 si < 65, 3 si < 75, 4 si < 85, 5 si >= 85
- Toutes les chaînes en français sauf team1_form/team2_form (W/D/L)
${statsCtx ? '- PRIORITÉ ABSOLUE: Calibre les probabilités, la forme (team1_form/team2_form) et les blessures à partir des STATISTIQUES RÉELLES fournies ci-dessus. Ces données sont factuelles et récentes.' : '- Base ton analyse sur tes connaissances à jour de ces équipes.'}`;

    const data = await callGemini([{ role: 'user', content: prompt }], { maxTokens: 6000, jsonMode: true, cacheKey: `${t1}|${t2}|${league}` });

    
    const text = extractText(data);
    console.log('📝 Longueur réponse:', text.length);
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
    d.realOdds = realOdds;
    d.realStats = !!realStats;

    renderResults(d, evData, kellyData, '');
    
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
    
    renderResults(defaultAnalysis, null, null, '');
  } finally {
    btn.disabled = false;
    document.getElementById('loading').classList.remove('visible');
    ['ls1','ls2','ls3','ls4'].forEach(id => document.getElementById(id)?.classList.remove('show'));
  }
}

function renderResults(d, evData, kellyData, leg1Score) {
  const isBk = d.sport === 'basketball';
  let wi = 0;
  if (d.proba_away > d.proba_home && d.proba_away > (d.proba_draw || 0)) wi = 2;
  else if (!isBk && (d.proba_draw || 0) > d.proba_home && (d.proba_draw || 0) > d.proba_away) wi = 1;

  const globalConf = d.fdData ? computeAdvancedConfidence(d, d.fdData).global : computeGlobalConfidence(d, evData);
  const confInfo = getConfidenceLabel(globalConf);
  const starsText = confInfo.label;
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

  const altBetsHTML = (d.alt_bets?.length)
    ? d.alt_bets.map(b => {
        const c = b.confidence || 0;
        const col = c >= 70 ? '#00dd55' : c >= 55 ? '#ffcc00' : '#ff6633';
        return `<div class="alt-bet-card">
          <div class="alt-bet-market">${b.market}</div>
          <div class="alt-bet-pick">${b.pick}</div>
          <div class="alt-bet-conf" style="color:${col}">${c}%</div>
          <div class="alt-bet-desc">${b.desc}</div>
        </div>`;
      }).join('')
    : '';
  const altBetsBlock = altBetsHTML
    ? `<div class="alt-bets-section"><div class="section-title">🎯 Marchés alternatifs</div><div class="alt-bets-grid">${altBetsHTML}</div></div>`
    : '';

  let oddsTableBlock = '';
  if (d.realOdds?.bookmakers && Object.keys(d.realOdds.bookmakers).length) {
    const bks = d.realOdds.bookmakers;
    const allHomes = Object.values(bks).map(b => b.home).filter(Boolean);
    const allDraws = Object.values(bks).map(b => b.draw).filter(Boolean);
    const allAways = Object.values(bks).map(b => b.away).filter(Boolean);
    const bestHome = Math.max(...allHomes), bestDraw = Math.max(...allDraws), bestAway = Math.max(...allAways);
    const rows = Object.entries(bks).map(([name, odds]) => {
      const hBest = odds.home === bestHome ? ' odds-best' : '';
      const dBest = odds.draw === bestDraw ? ' odds-best' : '';
      const aBest = odds.away === bestAway ? ' odds-best' : '';
      const drawCell = odds.draw ? `<td class="odds-cell${dBest}">${odds.draw.toFixed(2)}</td>` : '<td class="odds-cell odds-na">—</td>';
      return `<tr><td class="odds-bk">${name}</td><td class="odds-cell${hBest}">${odds.home?.toFixed(2) || '—'}</td>${drawCell}<td class="odds-cell${aBest}">${odds.away?.toFixed(2) || '—'}</td></tr>`;
    }).join('');
    oddsTableBlock = `<div class="odds-table-section">
      <div class="section-title">📡 Cotes réelles bookmakers</div>
      <table class="odds-table">
        <thead><tr><th>Bookmaker</th><th>${d.team1}</th><th>Nul</th><th>${d.team2}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="odds-best-hint">🟢 Meilleure cote disponible</div>
    </div>`;
  } else if (!state.apiStatus?.odds) {
    oddsTableBlock = `<div class="odds-no-key">
      📡 <strong>Cotes réelles non disponibles</strong> —
      <span onclick="showOddsKeyModal()" style="color:var(--accent);cursor:pointer;text-decoration:underline">Configure une clé The Odds API</span>
      (gratuit · 500 req/mois · Bet365, Unibet, Betclic...)
    </div>`;
  }

  const html = `
    <button class="new-btn" onclick="resetToStart()">← Nouvelle analyse</button>
    <div class="result-tracker" id="resultTracker">
      <span class="result-tracker-label">Résultat de ce pari :</span>
      <button class="result-btn result-win"  onclick="markLastResult('win')"  id="rbWin">✅ Gagné</button>
      <button class="result-btn result-lose" onclick="markLastResult('lose')" id="rbLose">❌ Perdu</button>
      <button class="result-btn result-draw" onclick="markLastResult('draw')" id="rbDraw">🤝 Nul</button>
      <button class="result-btn result-push" onclick="markLastResult('push')" id="rbPush">↩️ Push</button>
      <button class="result-btn result-share" onclick="shareAnalysis()" id="rbShare">📤 Partager</button>
    </div>
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
    <div class="analysis-block ${isBk ? 'bk' : ''}"><div class="analysis-header">📊 Analyse experte IA${d.realStats ? ' <span class="live-stats-badge">📡 Stats réelles</span>' : ''}</div>${d.analysis}</div>
    <div class="proba-section"><div class="section-title">🔑 Facteurs clés</div><div class="factors-grid">${factors}</div></div>
    ${altBetsBlock}
    ${oddsTableBlock}
    <div class="chat-section">
      <div class="chat-header">
        <div class="chat-avatar">🤖</div>
        <div>
          <div class="chat-title">Assistant IA</div>
          <div class="chat-subtitle">Questions sur cette analyse ou sur n'importe quel match</div>
        </div>
      </div>
      <div class="chat-suggestions">
        <button class="chat-chip" onclick="chatQuickSuggestion('Pourquoi ce pronostic ?')">Pourquoi ce pronostic ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Quels sont les risques ?')">Quels risques ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Que miseriez-vous et combien ?')">Que miser ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Donne-moi les stats clés des deux équipes')">Stats des équipes</button>
      </div>
      <div class="chat-messages" id="chatMessages">
        <div class="chat-msg chat-msg-ai">
          <div class="chat-bubble-ai">Bonjour ! Je peux vous expliquer cette analyse, discuter des risques, ou analyser n'importe quel autre match. Que souhaitez-vous savoir ?</div>
        </div>
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chatInput" placeholder="Ex: Pourquoi ce pronostic ? ou Analyse PSG vs Lyon..." onkeydown="handleChatKey(event)" maxlength="400">
        <button class="chat-send-btn" id="chatSendBtn" onclick="sendChatMessage()">➤</button>
      </div>
    </div>
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
  state.chatHistory = [];
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
    const h2hHomeWins = fdData.head2head.filter(h => h.winner === 'HOME_TEAM').length;
    scores.historique = (h2hHomeWins / fdData.head2head.length) * 100;
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
    global: Math.min(99, Math.max(10, Math.round(totalScore))),
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

function exportCSV() {
  const h = getHist();
  if (!h.length) { alert('Aucune analyse à exporter.'); return; }
  const headers = ['Date','Heure','Équipe 1','Équipe 2','Ligue','Pari recommandé','Cote','Confiance (%)','EV (%)','Mise (€)','Résultat','P&L (€)'];
  const rows = h.map(it => [
    it.date || '', it.time || '',
    it.team1 || '', it.team2 || '', it.league || '',
    it.best_bet || '', it.odds || '', it.confidence || '',
    it.ev != null ? it.ev : '', it.stake || '',
    it.result || 'pending', it.pnl != null ? it.pnl : ''
  ].map(v => `"${String(v).replace(/"/g, '""')}"`));
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.join(';')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pronosight-historique-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
window.exportCSV = exportCSV;

function renderHistory() {
  // MOD 4 — Victor mode check (auto-bascule sur perso si Victor vide)
  const victorPicks = victorState.loaded ? (victorState.history?.pronostics || []) : [];
  const hasVictor   = victorPicks.length > 0;
  if (!hasVictor) _histMode = 'personal';

  if (_histMode === 'victor' && hasVictor) {
    const vH = victorState.history;
    document.getElementById('hTotal').textContent  = vH.total || 0;
    document.getElementById('hWins').textContent   = vH.corrects || 0;
    document.getElementById('hLoses').textContent  = Math.max(0, (vH.total || 0) - (vH.corrects || 0));
    document.getElementById('hRate').textContent   = vH.taux != null ? vH.taux + '%' : '—';
    const pnlEl = document.getElementById('hPnl');   if (pnlEl)  { pnlEl.textContent  = '—'; pnlEl.style.color  = '#888'; }
    const confEl = document.getElementById('hAvgConf'); if (confEl) confEl.textContent = '—';
    const leagueEl = document.getElementById('hLeagueStats');
    if (leagueEl) leagueEl.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:8px">
      <button class="hist-filter-btn active" onclick="window._setHistMode('victor')">🎙️ Victor</button>
      <button class="hist-filter-btn" onclick="window._setHistMode('personal')">👤 Personnel</button></div>`;
    const list = document.getElementById('histList');
    const q = (_histFilter.search || '').toLowerCase();
    const filtered = victorPicks.filter(p => {
      const r = p.pronostic_correct === true ? 'win' : p.pronostic_correct === false ? 'lose' : 'pending';
      if (_histFilter.result !== 'all' && r !== _histFilter.result) return false;
      if (q && ![(p.equipe_a||''),(p.equipe_b||''),(p.sport||'')].some(s => s.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!filtered.length) { list.innerHTML = '<div class="hist-empty">🔍 Aucun résultat Victor pour ce filtre</div>'; return; }
    list.innerHTML = filtered.map(p => {
      const correct = p.pronostic_correct;
      const cls = correct === true ? 'hist-win' : correct === false ? 'hist-lose' : '';
      const badge = correct === true ? '✅' : correct === false ? '❌' : '⏳';
      const confColor = p.confiance === 'Élevé' ? '#00dd55' : p.confiance === 'Moyen' ? '#ffcc00' : '#ff6644';
      return `<div class="hist-card ${cls}">
        <div style="flex:1">
          <div style="font-weight:700;font-size:14px">${p.equipe_a||''} vs ${p.equipe_b||''}</div>
          <div style="font-size:10px;color:var(--muted)">${p.sport||''} · ${p.competition||''}</div>
          <div style="font-size:12px;color:var(--accent);margin-top:4px">🎯 ${p.pronostic_principal||''}</div>
          ${p.value_bet ? `<div style="font-size:11px;color:#00aaff;margin-top:2px">💡 ${p.value_bet}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <div style="font-size:22px">${badge}</div>
          <div style="font-size:10px;color:var(--muted)">${p.date||''}</div>
          ${p.cote_estimee ? `<div style="font-size:11px;font-weight:700;color:var(--accent)">@${parseFloat(p.cote_estimee).toFixed(2)}</div>` : ''}
          <div style="font-size:10px;font-weight:700;color:${confColor}">${p.confiance||''}</div>
        </div>
      </div>`;
    }).join('');
    return;
  }

  // ── Mode personnel (historique localStorage) ──
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

  // Stats par ligue (+ toggle si Victor disponible)
  const leagueEl = document.getElementById('hLeagueStats');
  if (leagueEl) {
    const byLeague = {};
    h.forEach(x => {
      const k = x.league || 'Autre';
      if (!byLeague[k]) byLeague[k] = { total: 0, wins: 0, loses: 0 };
      byLeague[k].total++;
      if (x.result === 'win') byLeague[k].wins++;
      else if (x.result === 'lose') byLeague[k].loses++;
    });
    const sorted = Object.entries(byLeague).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
    const toggleHtml = hasVictor ? `<div style="display:flex;gap:6px;margin-bottom:8px">
      <button class="hist-filter-btn" onclick="window._setHistMode('victor')">🎙️ Victor</button>
      <button class="hist-filter-btn active" onclick="window._setHistMode('personal')">👤 Personnel</button></div>` : '';
    leagueEl.innerHTML = toggleHtml + (sorted.length ? sorted.map(([league, s]) => {
      const wr = s.wins + s.loses > 0 ? Math.round(s.wins / (s.wins + s.loses) * 100) : null;
      const col = wr === null ? '#888' : wr >= 60 ? '#00dd55' : wr >= 40 ? '#ffcc00' : '#ff3333';
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px">
        <div style="flex:1;color:var(--text2)">${league}</div>
        <div style="color:var(--muted)">${s.total} analyses</div>
        <div style="font-weight:700;color:${col};min-width:36px;text-align:right">${wr !== null ? wr + '%' : '—'}</div>
      </div>`;
    }).join('') : '');
  }

  const list = document.getElementById('histList');
  if (!h.length) { list.innerHTML = '<div class="hist-empty">📭 Aucune analyse</div>'; return; }

  // Appliquer les filtres
  const q = (_histFilter.search || '').toLowerCase();
  const filtered = h.filter(it => {
    if (_histFilter.result !== 'all' && it.result !== _histFilter.result) return false;
    if (q && !(
      (it.team1 || '').toLowerCase().includes(q) ||
      (it.team2 || '').toLowerCase().includes(q) ||
      (it.league || '').toLowerCase().includes(q)
    )) return false;
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="hist-empty">🔍 Aucun résultat pour ce filtre</div>';
    return;
  }

  list.innerHTML = filtered.map(it => {
    const cls = it.result === 'win' ? 'hist-win' : it.result === 'lose' ? 'hist-lose' : '';
    const pnlStr = it.pnl && it.pnl !== 0 ? `<span style="color:${it.pnl > 0 ? '#00dd55' : '#ff3333'};font-weight:700;font-size:11px">${it.pnl > 0 ? '+' : ''}${it.pnl}€</span>` : '';
    return `<div class="hist-card ${cls}">
      <div style="flex:1">
        <div style="font-weight:700;font-size:14px">${it.team1} vs ${it.team2}</div>
        <div style="font-size:10px;color:var(--muted)">${it.league}</div>
        <div style="font-size:12px;color:var(--accent);margin-top:4px">🎯 ${it.best_bet} · ${it.confidence}%</div>
        ${pnlStr}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div style="font-size:10px;color:var(--muted)">${it.date} ${it.time}</div>
        <select class="hist-result-select" onchange="setResult(${it.id},this.value)">
          <option value="pending"${it.result === 'pending' ? ' selected' : ''}>⏳ En attente</option>
          <option value="win"${it.result === 'win' ? ' selected' : ''}>✅ Gagné</option>
          <option value="lose"${it.result === 'lose' ? ' selected' : ''}>❌ Perdu</option>
          <option value="draw"${it.result === 'draw' ? ' selected' : ''}>🤝 Nul</option>
          <option value="push"${it.result === 'push' ? ' selected' : ''}>↩️ Push</option>
        </select>
      </div>
    </div>`;
  }).join('');
}

function setHistFilter(result, btn) {
  _histFilter.result = result;
  document.querySelectorAll('.hist-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderHistory();
}
window.setHistFilter = setHistFilter;

function setHistSearch(val) {
  _histFilter.search = val;
  renderHistory();
}
window.setHistSearch = setHistSearch;

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

  // Streak sur le dashboard
  const resolved = hist.filter(h => h.result === 'win' || h.result === 'lose');
  let streak = 0, streakType = '';
  for (const e of resolved) {
    if (!streakType) streakType = e.result;
    if (e.result === streakType) streak++; else break;
  }
  const el4 = document.getElementById('dashStreak');
  const el4b = document.getElementById('dashStreakBar');
  if (el4) {
    if (!streak) { el4.textContent = '—'; el4.style.color = '#888'; }
    else {
      const isWin = streakType === 'win';
      el4.textContent = (isWin ? '🔥 ' : '💀 ') + streak + (isWin ? 'W' : 'L');
      el4.style.color = isWin ? '#00dd55' : '#ff3333';
      if (el4b) { el4b.style.background = isWin ? '#00dd55' : '#ff3333'; el4b.style.width = Math.min(100, streak * 15) + '%'; }
    }
  }

  // MOD 3 — Stats Victor (override si données disponibles)
  if (victorState.loaded && victorState.stats?.global?.total > 0) {
    const vg = victorState.stats.global;
    if (el2) el2.textContent = (vg.taux_global || 0) + '%';
    const vRoi = victorState.stats.derniere_maj?.roi_mise_fixe;
    if (el3 && vRoi != null) { el3.textContent = (vRoi >= 0 ? '+' : '') + vRoi + 'u'; el3.style.color = vRoi >= 0 ? '#00dd55' : '#ff3333'; }
    // Série depuis Victor history
    const vPicks = victorState.history?.pronostics || [];
    let vStreak = 0, vSType = '';
    for (const vp of vPicks) {
      const vr = vp.pronostic_correct === true ? 'win' : vp.pronostic_correct === false ? 'lose' : null;
      if (!vr) continue;
      if (!vSType) vSType = vr;
      if (vr === vSType) vStreak++; else break;
    }
    if (el4 && vStreak > 0) {
      const vWin = vSType === 'win';
      el4.textContent = (vWin ? '🔥 ' : '💀 ') + vStreak + (vWin ? 'W' : 'L');
      el4.style.color = vWin ? '#00dd55' : '#ff3333';
      if (el4b) { el4b.style.background = vWin ? '#00dd55' : '#ff3333'; el4b.style.width = Math.min(100, vStreak * 15) + '%'; }
    }
  }

  // MOD 1 — Derniers picks : Victor en priorité, perso en fallback
  const rp = document.getElementById('dashRecentPicks');
  if (rp) {
    const victorPicksToday = victorState.loaded ? (victorState.today?.pronostics || []) : [];
    if (victorPicksToday.length > 0) {
      rp.onclick = null;
      rp.innerHTML = victorPicksToday.slice(0, 5).map(p => {
        const confColor = p.confiance === 'Élevé' ? '#00dd55' : p.confiance === 'Moyen' ? '#ffcc00' : '#ff6644';
        const confArrow = p.confiance === 'Élevé' ? '↑↑' : p.confiance === 'Moyen' ? '↑' : '→';
        return `<div class="dash-pick-row" onclick="switchNav('victor')" style="cursor:pointer">
          <div class="dash-pick-result" style="background:${confColor};color:#000;font-size:10px;font-weight:800;min-width:28px;text-align:center;padding:0 4px">${confArrow}</div>
          <div style="flex:1">
            <div class="dash-pick-match">${p.equipe_a || ''} vs ${p.equipe_b || ''}</div>
            <div class="dash-pick-league">🎯 ${p.pronostic_principal || ''} · ${p.sport || ''}</div>
          </div>
        </div>`;
      }).join('') + `<div style="text-align:center;padding:8px 0 2px;font-size:11px;color:var(--muted);cursor:pointer" onclick="switchNav('victor')">🎙️ Voir l'analyse complète →${victorState.lastUpdated ? ` <span style="opacity:.6">· 🔄 ${victorState.lastUpdated.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</span>` : ''}</div>`;
    } else if (hist.length) {
      rp.innerHTML = hist.slice(0, 5).map(h => {
        const rc = h.result === 'win' ? 'win' : h.result === 'lose' ? 'loss' : 'pending';
        return `<div class="dash-pick-row"><div class="dash-pick-result ${rc}">${h.result === 'win' ? 'W' : h.result === 'lose' ? 'L' : '?'}</div>
          <div style="flex:1"><div class="dash-pick-match">${h.team1 || ''} vs ${h.team2 || ''}</div>
          <div class="dash-pick-league">${h.best_bet || ''} | ${h.league || ''}</div></div></div>`;
      }).join('');
      rp.onclick = () => switchNav('history');
    } else {
      rp.innerHTML = '<div class="dash-empty">Aucun pick encore<br><button class="dash-cta" onclick="switchNav(\'victor\')">🎙️ Voir Victor</button></div>';
    }
  }

  const fl = document.getElementById('dashFavLeagues');
  if (fl) {
    const favs = getFavs();
    if (!favs.length) {
      fl.innerHTML = '<div class="dash-empty" style="font-size:11px">Aucune ligue favorite<br><button class="dash-cta" onclick="switchNav(\'alerts\')">🔔 Choisir des ligues</button></div>';
    } else {
      fl.innerHTML = LEAGUES.filter(l => favs.includes(l.id)).slice(0, 6).map(l => {
        const lHist = hist.filter(h => h.league && h.league.includes(l.name));
        const lRes = lHist.filter(h => h.result !== 'pending');
        const lWr = lRes.length ? Math.round(lRes.filter(h => h.result === 'win').length / lRes.length * 100) : null;
        const col = lWr === null ? '#888' : lWr >= 60 ? '#00dd55' : lWr >= 40 ? '#ffcc00' : '#ff3333';
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;cursor:pointer" onclick="pickLeague('${l.id}');switchNav('prono')">
          <div style="font-size:16px">${l.flag}</div>
          <div style="flex:1"><div style="font-weight:600">${l.name}</div><div style="color:var(--muted);font-size:10px">${l.country}</div></div>
          <div style="font-weight:700;color:${col}">${lWr !== null ? lWr + '%' : '—'}</div>
        </div>`;
      }).join('');
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
  const resolved = getHist().filter(x => x.result !== 'pending');

  // Current bankroll & stats
  let current = initial;
  resolved.forEach(e => { current += (parseFloat(e.pnl) || 0); });
  const profit = current - initial;
  const roi = initial > 0 ? Math.round(profit / initial * 10000) / 100 : 0;

  const el1 = document.getElementById('bkCurrent'); if (el1) el1.textContent = initial > 0 ? current.toFixed(0) + '€' : '—';
  const el2 = document.getElementById('bkProfit'); if (el2) { el2.textContent = initial > 0 ? (profit >= 0 ? '+' : '') + profit.toFixed(1) + '€' : '—'; el2.style.color = profit >= 0 ? '#00dd55' : '#ff3333'; }
  const el3 = document.getElementById('bkROI'); if (el3) el3.textContent = initial > 0 ? (roi >= 0 ? '+' : '') + roi + '%' : '—';

  // Streak
  let streak = 0, streakType = '';
  for (const e of resolved) {
    if (e.result === 'win' || e.result === 'lose') {
      if (!streakType) streakType = e.result;
      if (e.result === streakType) streak++;
      else break;
    }
  }
  const el4 = document.getElementById('bkStreak');
  if (el4) {
    if (!streak) { el4.textContent = '—'; el4.style.color = ''; }
    else { el4.textContent = (streakType === 'win' ? '🔥 ' : '❄️ ') + streak + (streakType === 'win' ? 'W' : 'L'); el4.style.color = streakType === 'win' ? '#00dd55' : '#ff3333'; }
  }

  // Canvas chart
  const canvas = document.getElementById('bkCanvas');
  if (canvas && initial > 0) {
    const ctx2 = canvas.getContext('2d');
    const W = canvas.offsetWidth || 300, H = canvas.offsetHeight || 120;
    canvas.width = W; canvas.height = H;
    const points = [initial];
    [...resolved].reverse().forEach(e => { points.push(points[points.length - 1] + (parseFloat(e.pnl) || 0)); });
    if (points.length < 2) {
      ctx2.fillStyle = '#555'; ctx2.font = '12px monospace'; ctx2.textAlign = 'center';
      ctx2.fillText('Pas assez de données', W / 2, H / 2);
    } else {
      const minV = Math.min(...points), maxV = Math.max(...points), range = maxV - minV || 1;
      const pad = { t: 14, b: 18, l: 8, r: 8 };
      const toX = i => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
      const toY = v => pad.t + (1 - (v - minV) / range) * (H - pad.t - pad.b);
      ctx2.clearRect(0, 0, W, H);
      // Baseline
      const baseY = toY(initial);
      ctx2.beginPath(); ctx2.strokeStyle = '#333'; ctx2.lineWidth = 1; ctx2.setLineDash([4, 4]);
      ctx2.moveTo(pad.l, baseY); ctx2.lineTo(W - pad.r, baseY); ctx2.stroke(); ctx2.setLineDash([]);
      // Gradient fill
      const isPos = current >= initial;
      const grad = ctx2.createLinearGradient(0, pad.t, 0, H - pad.b);
      grad.addColorStop(0, isPos ? 'rgba(0,221,85,0.25)' : 'rgba(255,51,51,0.25)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx2.beginPath();
      ctx2.moveTo(toX(0), toY(points[0]));
      points.forEach((v, i) => { if (i > 0) ctx2.lineTo(toX(i), toY(v)); });
      ctx2.lineTo(toX(points.length - 1), H - pad.b); ctx2.lineTo(toX(0), H - pad.b);
      ctx2.closePath(); ctx2.fillStyle = grad; ctx2.fill();
      // Line
      ctx2.beginPath(); ctx2.strokeStyle = isPos ? '#00dd55' : '#ff3333'; ctx2.lineWidth = 2; ctx2.lineJoin = 'round';
      ctx2.moveTo(toX(0), toY(points[0]));
      points.forEach((v, i) => { if (i > 0) ctx2.lineTo(toX(i), toY(v)); });
      ctx2.stroke();
      // Last dot
      ctx2.beginPath(); ctx2.arc(toX(points.length - 1), toY(points[points.length - 1]), 4, 0, Math.PI * 2);
      ctx2.fillStyle = isPos ? '#00dd55' : '#ff3333'; ctx2.fill();
      // Labels
      ctx2.fillStyle = '#888'; ctx2.font = '10px monospace'; ctx2.textAlign = 'left';
      ctx2.fillText(Math.round(maxV) + '€', pad.l + 2, pad.t + 10);
      ctx2.fillText(Math.round(minV) + '€', pad.l + 2, H - pad.b - 2);
    }
  }

  // Log
  const logEl = document.getElementById('bkLog');
  if (logEl) {
    if (!resolved.length) {
      logEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;font-family:\'JetBrains Mono\',monospace">Aucune mise enregistrée</div>';
    } else {
      logEl.innerHTML = resolved.slice(0, 20).map(e => {
        const pnl = parseFloat(e.pnl) || 0;
        const icon = e.result === 'win' ? '✅' : e.result === 'lose' ? '❌' : '↩️';
        const col = e.result === 'win' ? '#00dd55' : e.result === 'lose' ? '#ff3333' : '#888';
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
          <div style="font-size:16px">${icon}</div>
          <div style="flex:1"><div style="font-weight:600">${e.team1} vs ${e.team2}</div>
          <div style="color:var(--muted);font-size:10px;font-family:'JetBrains Mono',monospace">${e.best_bet} · ${e.date}</div></div>
          <div style="font-weight:700;color:${col}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}€</div>
        </div>`;
      }).join('');
    }
  }
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
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const allMatches = [];
    const promises = TODAY_LEAGUES.map(league =>
      getLeagueEvents(league.tsdb).then(events => {
        (events || []).filter(e => e.dateEvent === todayStr || e.dateEvent === tomorrowStr)
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
  showStep(2);
}

// ══════════════════════════════════════════════
// LIVE SCORES + AUTO-REFRESH
// ══════════════════════════════════════════════
const LIVE_REFRESH_SEC = 60;
let _liveInterval = null;

function startLiveAutoRefresh() {
  stopLiveAutoRefresh();
  state.liveCountdown = LIVE_REFRESH_SEC;
  _liveInterval = setInterval(() => {
    state.liveCountdown--;
    const fill = document.getElementById('liveRefreshFill');
    if (fill) fill.style.width = ((LIVE_REFRESH_SEC - state.liveCountdown) / LIVE_REFRESH_SEC * 100) + '%';
    if (state.liveCountdown <= 0) {
      state.liveCountdown = LIVE_REFRESH_SEC;
      fetchLive(true);
    }
  }, 1000);
}

function stopLiveAutoRefresh() {
  if (_liveInterval) { clearInterval(_liveInterval); _liveInterval = null; }
  const fill = document.getElementById('liveRefreshFill');
  if (fill) fill.style.width = '0%';
}

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
  // Reset bar after manual refresh
  if (force) {
    state.liveCountdown = LIVE_REFRESH_SEC;
    const fill = document.getElementById('liveRefreshFill');
    if (fill) fill.style.width = '0%';
  }
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
  showStep(2);
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

async function autoScanAlerts() {
  if (Notification.permission !== 'granted') return;
  const favs = getFavs();
  if (!favs.length) return;
  const lastScan = parseInt(localStorage.getItem('ps_last_auto_scan') || '0');
  if (Date.now() - lastScan < 3 * 60 * 60 * 1000) return;
  localStorage.setItem('ps_last_auto_scan', String(Date.now()));
  const thresh = parseInt(localStorage.getItem('ps_alert_thresh') || '70');
  const names = LEAGUES.filter(l => favs.includes(l.id)).map(l => l.name + ' (' + l.country + ')').join(', ');
  try {
    const data = await callGemini([{
      role: 'user',
      content: `Recherche les matchs dans les 24h pour : ${names}. Retourne uniquement JSON: {"signals":[{"league":"x","team1":"x","team2":"x","best_bet":"x","confidence":75}]} Seulement confidence >= ${thresh}. Max 5.`
    }], { maxTokens: 600 });
    const parsed = extractJSON(extractText(data));
    const signals = parsed?.signals || [];
    signals.forEach(s => {
      new Notification(`⚡ PronoSight — ${s.team1} vs ${s.team2}`, {
        body: `🎯 ${s.best_bet} · ${s.confidence}% confiance\n${s.league}`,
        icon: '/favicon.ico',
        tag: `ps-${s.team1}-${s.team2}`
      });
    });
  } catch { /* silencieux */ }
}

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
  if (legs.children.length >= 10) { alert('Maximum 10 matchs'); return; }
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
// ONGLET PRONOSTICS — Alimenté par Victor
// ══════════════════════════════════════════════

let _pronoSportFilter = 'all';

const SPORT_EMOJIS = {
  football: '⚽', soccer: '⚽',
  basketball: '🏀', basket: '🏀',
  tennis: '🎾',
  mma: '🥊', boxe: '🥊', boxing: '🥊',
  f1: '🏎️', formule1: '🏎️', motorsport: '🏎️',
  rugby: '🏉', handball: '🤾', volleyball: '🏐',
  cyclisme: '🚴', golf: '⛳', snooker: '🎱',
};

function _getSportEmoji(sport) {
  if (!sport) return '🏆';
  const key = sport.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SPORT_EMOJIS[key] || SPORT_EMOJIS[sport.toLowerCase()] || '🏆';
}

function _normalizeSport(sport) {
  if (!sport) return 'autre';
  const s = sport.toLowerCase();
  if (s.includes('foot') || s.includes('soccer')) return 'football';
  if (s.includes('basket') || s === 'nba') return 'basketball';
  if (s.includes('tennis')) return 'tennis';
  if (s.includes('mma') || s.includes('box')) return 'mma';
  if (s.includes('f1') || s.includes('formule') || s.includes('motor')) return 'f1';
  return 'autre';
}

function filterProno(sport, btn) {
  _pronoSportFilter = sport;
  document.querySelectorAll('#pronoSportTabs .tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderPronoList();
}
window.filterProno = filterProno;

function renderPronoVictor() {
  const container = document.getElementById('pronoVictorContent');
  if (!container) return;

  if (!victorState.loaded) {
    container.innerHTML = `<div class="card"><div style="text-align:center;padding:40px;color:var(--muted)">
      <div style="font-size:32px">🎙️</div>
      <div style="margin-top:10px;font-weight:700;color:var(--text2)">Chargement des pronostics Victor...</div>
    </div></div>`;
    loadVictorData().then(() => renderPronoVictor());
    return;
  }
  _renderPronoList();
}
window.renderPronoVictor = renderPronoVictor;

function _renderPronoList() {
  const container = document.getElementById('pronoVictorContent');
  if (!container) return;

  const allPicks = victorState.today?.pronostics || [];
  const updateTime = victorState.today?.generated_at
    ? new Date(victorState.today.generated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : null;

  if (!allPicks.length) {
    const h = new Date().getHours();
    const nextRun = h < 7 ? '07h00' : h < 13 ? '13h00' : '07h00 demain';
    container.innerHTML = `<div class="card">
      <div style="text-align:center;padding:40px">
        <div style="font-size:40px">🎙️</div>
        <div style="margin-top:12px;font-size:16px;font-weight:800;color:var(--text1)">Victor analyse en cours...</div>
        <div style="margin-top:6px;font-size:13px;color:var(--muted)">Prochaine analyse à ${nextRun}</div>
        <button onclick="forceVictorRefresh()" style="margin-top:18px;background:var(--accent);color:#000;border:none;border-radius:10px;padding:10px 22px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Exo 2',sans-serif;letter-spacing:1px">
          ⚡ Forcer l'analyse
        </button>
      </div>
    </div>`;
    return;
  }

  // Filtrer par sport
  const filtered = _pronoSportFilter === 'all'
    ? allPicks
    : allPicks.filter(p => _normalizeSport(p.sport) === _pronoSportFilter);

  // Grouper par sport
  const bySport = {};
  filtered.forEach(p => {
    const sportKey = _normalizeSport(p.sport);
    const label = p.sport || 'Autres';
    if (!bySport[sportKey]) bySport[sportKey] = { label, picks: [] };
    bySport[sportKey].picks.push(p);
  });

  const headerHtml = `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0 12px;flex-wrap:wrap;gap:6px">
    <div style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">
      🎙️ VICTOR · ${allPicks.length} PRONOSTIC${allPicks.length > 1 ? 'S' : ''}
      ${updateTime ? `· <span style="opacity:.7">🔄 ${updateTime}</span>` : ''}
    </div>
    <button onclick="refreshPronoVictor()" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:5px 12px;font-size:11px;cursor:pointer;font-family:'JetBrains Mono',monospace">🔄 Actualiser</button>
  </div>`;

  if (!filtered.length) {
    container.innerHTML = headerHtml + `<div class="card"><div style="text-align:center;padding:30px;color:var(--muted);font-size:13px">
      Aucun pronostic pour ce sport aujourd'hui.
    </div></div>`;
    return;
  }

  const groupsHtml = Object.entries(bySport).map(([sportKey, { label, picks }]) => {
    const emoji = _getSportEmoji(label);
    // Grouper par compétition dans chaque sport
    const byComp = {};
    picks.forEach(p => {
      const comp = p.competition || 'Autre';
      if (!byComp[comp]) byComp[comp] = [];
      byComp[comp].push(p);
    });

    const compsHtml = Object.entries(byComp).map(([comp, cPicks]) => {
      const picksHtml = cPicks.map(p => {
        const confColor = p.confiance === 'Élevé' ? '#00dd55' : p.confiance === 'Moyen' ? '#ffcc00' : '#ff6644';
        const confBg    = p.confiance === 'Élevé' ? 'rgba(0,221,85,.12)' : p.confiance === 'Moyen' ? 'rgba(255,204,0,.12)' : 'rgba(255,102,68,.12)';
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              ${p.heure ? `<div style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-bottom:4px">🕐 ${p.heure}</div>` : ''}
              <div style="font-weight:800;font-size:15px;color:var(--text1);margin-bottom:6px">${p.equipe_a || ''} <span style="color:var(--muted);font-weight:400">vs</span> ${p.equipe_b || ''}</div>
              <div style="background:var(--accent);color:#000;display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:800;margin-bottom:8px">
                🎯 ${p.pronostic_principal || ''}${p.cote_estimee ? ` · @${parseFloat(p.cote_estimee).toFixed(2)}` : ''}
              </div>
              ${p.value_bet ? `<div style="font-size:11px;color:#00aaff;margin-bottom:4px">💡 Value : <strong>${p.value_bet}</strong>${p.cote_value ? ` @${parseFloat(p.cote_value).toFixed(2)}` : ''}</div>` : ''}
              ${p.pari_a_eviter ? `<div style="font-size:11px;color:#ff6644;margin-bottom:4px">🚫 Éviter : ${p.pari_a_eviter}</div>` : ''}
              ${p.score_predit ? `<div style="font-size:11px;color:var(--muted);margin-bottom:4px">🏟️ Score prédit : <strong style="color:var(--text2)">${p.score_predit}</strong></div>` : ''}
              ${p.phrase_signature ? `<div style="font-size:11px;color:var(--muted);font-style:italic;border-top:1px solid var(--border);padding-top:8px;margin-top:6px">"${p.phrase_signature}"</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:60px">
              <div style="background:${confBg};border:1px solid ${confColor};color:${confColor};border-radius:8px;padding:4px 10px;font-size:11px;font-weight:800;white-space:nowrap">${p.confiance || ''}</div>
              ${p.enjeu ? `<div style="font-size:9px;color:var(--muted);text-align:right;max-width:80px;line-height:1.3">${p.enjeu.slice(0,50)}</div>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');

      return `<div style="margin-bottom:8px">
        <div style="font-size:10px;letter-spacing:2px;color:var(--muted);font-family:'JetBrains Mono',monospace;padding:8px 0 6px;border-bottom:1px solid var(--border);margin-bottom:10px">
          📋 ${comp.toUpperCase()}
        </div>
        ${picksHtml}
      </div>`;
    }).join('');

    return `<div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;letter-spacing:1px;color:var(--text1);margin-bottom:12px">
        ${emoji} ${label.toUpperCase()} <span style="color:var(--muted);font-weight:400;font-size:11px">(${picks.length})</span>
      </div>
      ${compsHtml}
    </div>`;
  }).join('');

  container.innerHTML = headerHtml + groupsHtml;
}

async function forceVictorRefresh() {
  const apiKey = 'd8828503422f052ab9a0aef79183a3f2da24080f48eff58da83a3cbc85c441ca';
  const btn = document.querySelector('#pronoVictorContent button');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyse en cours...'; }
  try {
    const r = await fetch('/api/victor/refresh', {
      method: 'POST',
      headers: { 'x-api-key': apiKey }
    });
    const d = await r.json();
    if (r.ok) {
      const container = document.getElementById('pronoVictorContent');
      if (container) container.innerHTML = `<div class="card"><div style="text-align:center;padding:32px;color:var(--muted)">
        <div style="font-size:32px">⚡</div>
        <div style="margin-top:10px;font-weight:700;color:var(--text2)">Victor est en train d'analyser...</div>
        <div style="margin-top:6px;font-size:12px">Résultats disponibles dans 30-60 secondes</div>
      </div></div>`;
      setTimeout(() => loadVictorData().then(() => renderPronoVictor()), 45000);
    }
  } catch(e) { console.warn('[forceVictorRefresh]', e.message); }
}
window.forceVictorRefresh = forceVictorRefresh;

async function refreshPronoVictor() {
  victorLastFetch = 0; // force le prochain fetch
  await loadVictorData({ force: true });
  renderPronoVictor();
}
window.refreshPronoVictor = refreshPronoVictor;

// VICTOR IA — Intégration frontend
// ══════════════════════════════════════════════

async function loadVictorData({ force = false } = {}) {
  // Cache TTL : skip si données récentes et pas de force
  if (!force && victorState.loaded && Date.now() - victorLastFetch < VICTOR_CACHE_TTL) return;
  // Déduplique les appels simultanés
  if (victorState.loading) return;

  // Annule un fetch précédent encore en vol
  if (victorAbortController) victorAbortController.abort();
  victorAbortController = new AbortController();
  const signal = victorAbortController.signal;

  victorState.loading = true;
  const prevTotal = victorState.today?.total || 0;
  try {
    const [todayRes, statsRes, patternsRes, historyRes] = await Promise.all([
      fetch('/api/victor/today',        { signal }).then(r => r.json()),
      fetch('/api/victor/stats',        { signal }).then(r => r.json()),
      fetch('/api/victor/patterns',     { signal }).then(r => r.json()),
      fetch('/api/victor/history?days=30', { signal }).then(r => r.json())
    ]);
    victorState.today       = todayRes;
    victorState.stats       = statsRes;
    victorState.patterns    = patternsRes;
    victorState.history     = historyRes;
    victorState.loaded      = true;
    victorState.lastUpdated = new Date();
    victorLastFetch         = Date.now();
    const newTotal = todayRes?.total || 0;
    if (prevTotal === 0 && newTotal > 0) showVictorUpdateNotif(newTotal);
  } catch(e) {
    if (e.name !== 'AbortError') console.warn('[Victor] Données indisponibles:', e.message);
  } finally {
    victorState.loading = false;
  }
}

function showVictorUpdateNotif(count) {
  // Supprime une notif existante
  document.getElementById('victorNotif')?.remove();
  const notif = document.createElement('div');
  notif.id = 'victorNotif';
  notif.style.cssText = 'position:fixed;top:58px;left:50%;transform:translateX(-50%);background:var(--accent);color:#000;padding:8px 18px;border-radius:20px;font-size:12px;font-weight:700;font-family:"Exo 2",sans-serif;z-index:9999;cursor:pointer;box-shadow:0 4px 20px rgba(0,170,255,.4);white-space:nowrap';
  notif.textContent = `🎙️ ${count} nouveau${count > 1 ? 'x' : ''} pick${count > 1 ? 's' : ''} Victor disponible${count > 1 ? 's' : ''}`;
  notif.onclick = () => { switchNav('victor'); notif.remove(); };
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 8000);
}
window.showVictorUpdateNotif = showVictorUpdateNotif;

function renderVictorPicks(picks, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!picks || !picks.length) {
    const h = new Date().getHours();
    const msg = h < 7
      ? `Pronostics disponibles à 07h00 (dans ${7 - h}h)`
      : h < 13 ? 'Run du matin disponible — prochain refresh à 13h00' : 'Prochain run à 07h00 demain';
    el.innerHTML = `<div style="text-align:center;padding:36px;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:12px">
      <div style="font-size:28px;margin-bottom:8px">🎙️</div>
      <strong style="color:var(--text2);font-size:13px">Victor analyse en cours...</strong><br>
      <span style="font-size:11px;margin-top:6px;display:block">${msg}</span>
    </div>`;
    return;
  }
  el.innerHTML = picks.map((p, i) => {
    const confColor = p.confiance === 'Élevé' ? '#00dd55' : p.confiance === 'Moyen' ? '#ffcc00' : '#ff6644';
    const confNum   = p.confiance === 'Élevé' ? 85 : p.confiance === 'Moyen' ? 70 : 55;
    return `<div class="qp-card${i === 0 ? ' top-pick' : ''}">
      ${i === 0 ? '<div class="qp-card-badge">🎙️ VICTOR TOP PICK</div>' : ''}
      <div class="qp-card-match">${p.equipe_a || ''} vs ${p.equipe_b || ''}</div>
      <div class="qp-card-league">${p.sport || ''} · ${p.competition || ''}</div>
      <div class="qp-card-bet">🎯 ${p.pronostic_principal || ''}</div>
      <div class="qp-card-stats">
        <span class="qp-chip" style="color:${confColor}">${confNum}% · ${p.confiance || ''}</span>
        ${p.cote_estimee ? `<span class="qp-chip">@${parseFloat(p.cote_estimee).toFixed(2)}</span>` : ''}
        ${p.value_bet ? `<span class="qp-chip" style="color:#00aaff">💡 ${p.value_bet}</span>` : ''}
      </div>
      ${p.score_predit ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">🏟️ Score prédit : <strong>${p.score_predit}</strong></div>` : ''}
      ${p.phrase_signature ? `<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:6px;border-top:1px solid var(--border);padding-top:6px">"${p.phrase_signature}"</div>` : ''}
    </div>`;
  }).join('');
}

function renderVictorView() {
  const el = document.getElementById('victorView');
  if (!el) return;
  if (!victorState.loaded) {
    el.innerHTML = `<div class="card"><div style="text-align:center;padding:40px;color:var(--muted)">
      <div style="font-size:32px">🎙️</div>
      <div style="margin-top:12px;font-weight:700;color:var(--text2)">Chargement de Victor...</div>
    </div></div>`;
    loadVictorData().then(() => renderVictorView());
    return;
  }
  const picks    = victorState.today?.pronostics || [];
  const g        = victorState.stats?.global || {};
  const patterns = victorState.patterns?.forts || [];
  const taux     = g.taux_global != null ? g.taux_global + '%' : '—';
  const roi      = victorState.stats?.derniere_maj?.roi_mise_fixe != null
    ? (victorState.stats.derniere_maj.roi_mise_fixe >= 0 ? '+' : '') + victorState.stats.derniere_maj.roi_mise_fixe + 'u'
    : '—';
  const totalVerif = g.total || 0;
  const updateTime = victorState.today?.generated_at
    ? new Date(victorState.today.generated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : null;
  const signature = picks[0]?.phrase_signature || '';

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title">🎙️ <span class="ct-accent">Victor</span> — Analyse du jour</div>
          ${updateTime ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">Dernière mise à jour : ${updateTime}</div>` : '<div style="font-size:11px;color:var(--muted);margin-top:2px">Aucune analyse aujourd\'hui</div>'}
        </div>
        <button class="qp-scan-btn" onclick="refreshVictorView()" style="font-size:11px;padding:8px 14px">🔄 Actualiser</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:20px;font-weight:800;color:#00dd55">${taux}</div>
          <div style="font-size:9px;color:var(--muted);letter-spacing:1px;margin-top:3px">WIN RATE</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:20px;font-weight:800;color:#00aaff">${roi}</div>
          <div style="font-size:9px;color:var(--muted);letter-spacing:1px;margin-top:3px">ROI</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:20px;font-weight:800;color:var(--yellow)">${totalVerif}</div>
          <div style="font-size:9px;color:var(--muted);letter-spacing:1px;margin-top:3px">VÉRIFIÉS</div>
        </div>
      </div>
      ${signature ? `<div style="background:var(--surface);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:16px;font-size:13px;font-style:italic;color:var(--text2)">"${signature}"</div>` : ''}
      <div style="font-size:10px;letter-spacing:2px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-bottom:10px">PICKS DU JOUR (${picks.length})</div>
      <div id="victorPicksList"></div>
    </div>
    ${patterns.length ? `<div class="card" style="margin-top:12px">
      <div style="font-size:10px;letter-spacing:2px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-bottom:12px">⚡ PATTERNS ACTIFS — FIABILITÉ ≥70%</div>
      ${patterns.map(p => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
        <div style="flex:1">
          <div style="font-weight:600;color:var(--text1)">${p.nom || ''}</div>
          <div style="color:var(--muted);font-size:11px;margin-top:2px">${(p.description || '').slice(0, 90)}</div>
        </div>
        <div style="font-weight:800;color:#00dd55;font-size:16px">${parseFloat(p.taux_confirmation || 0).toFixed(0)}%</div>
      </div>`).join('')}
    </div>` : ''}
  `;
  renderVictorPicks(picks, 'victorPicksList');
}

async function refreshVictorView() {
  victorLastFetch = 0; // force le prochain fetch
  await loadVictorData({ force: true });
  renderVictorView();
}
window.refreshVictorView = refreshVictorView;

function _setHistMode(mode) { _histMode = mode; renderHistory(); }
window._setHistMode = _setHistMode;

// ══════════════════════════════════════════════
// QUICK PICK
// ══════════════════════════════════════════════
async function runQuickPick() {
  const btn = document.getElementById('qpScanBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Chargement...'; }
  const resDiv = document.getElementById('qpResults');
  resDiv.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px">🎙️ Récupération des picks Victor...</div>';
  try {
    if (!victorState.loaded) await loadVictorData();
    const picks = victorState.today?.pronostics || [];
    renderVictorPicks(picks, 'qpResults');
  } catch (e) {
    resDiv.innerHTML = `<div style="color:var(--ev-neg);padding:12px">${e.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '&#x1F50D; SCANNER'; }
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

  const maxTokens = size <= 4 ? 3000 : size <= 6 ? 4500 : size <= 8 ? 6000 : 7500;

  try {
    res.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px">📡 Récupération des vrais matchs...</div>';

    // ── 1. Ligues à interroger selon le filtre ──
    const favs = getFavs();
    let leaguesToFetch;
    if (lf === 'basket') {
      leaguesToFetch = TODAY_LEAGUES.filter(l => l.sport === 'basketball');
    } else if (lf === 'favs' && favs.length) {
      leaguesToFetch = TODAY_LEAGUES.filter(l => favs.includes(l.id));
    } else {
      leaguesToFetch = TODAY_LEAGUES.filter(l => l.sport === 'soccer');
    }
    if (!leaguesToFetch.length) leaguesToFetch = TODAY_LEAGUES.filter(l => l.sport === 'soccer');

    // ── 2. Récupérer les vrais matchs des 3 prochains jours ──
    const todayStr = new Date().toISOString().slice(0, 10);
    const in3days  = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const realMatches = [];

    // Source A : Football-Data.org (top 5 + coupes)
    const fdLeagues = leaguesToFetch.filter(l => FD_COMP_MAP[l.id] && state.apiStatus?.footballData);
    await Promise.all(fdLeagues.map(async league => {
      try {
        const data = await fdFetch(`competitions/${FD_COMP_MAP[league.id]}/matches?dateFrom=${todayStr}&dateTo=${in3days}`);
        (data?.matches || []).forEach(m => {
          if (m.status === 'FINISHED' || m.status === 'IN_PLAY' || m.status === 'PAUSED') return;
          const match = fdToMatch(m, league);
          match.leagueId = league.id;
          realMatches.push(match);
        });
      } catch { /* ignore */ }
    }));

    // Source B : TheSportsDB pour les ligues non couvertes par FD.org
    const fdLeagueIds = new Set(fdLeagues.map(l => l.id));
    const tsdbLeagues = leaguesToFetch.filter(l => !fdLeagueIds.has(l.id) && l.tsdb);
    await Promise.all(tsdbLeagues.map(async league => {
      try {
        const events = await getLeagueEvents(league.tsdb);
        (events || [])
          .filter(e => e.dateEvent >= todayStr && e.dateEvent <= in3days)
          .forEach(e => {
            const m = tsdbToMatch(e);
            m.leagueName = league.name; m.leagueFlag = league.flag;
            m.leagueId = league.id; m.sport = league.sport;
            realMatches.push(m);
          });
      } catch { /* ignore */ }
    }));

    // ── 3. Dédupliquer et filtrer les matchs déjà joués ──
    const seen = new Set();
    const unique = realMatches.filter(m => {
      if (m.status === 'FT' || m.status === 'FINISHED') return false;
      const key = `${m.team1}|${m.team2}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    if (!unique.length) {
      throw new Error('Aucun match réel trouvé pour les 3 prochains jours. Vérifie ta connexion ou reviens plus tard.');
    }

    // ── 4. Adapter la taille si pas assez de matchs ──
    const actualSize = Math.min(size, unique.length);
    if (actualSize < size) {
      res.innerHTML = `<div style="text-align:center;padding:16px;color:var(--yellow);font-size:12px">⚠️ ${unique.length} matchs trouvés — combinés réduits à ${actualSize} sélections</div>`;
      await new Promise(r => setTimeout(r, 1500));
    }

    // ── 5. Construire la liste de matchs pour le prompt ──
    const matchList = unique.map((m, i) => {
      const lg = m.leagueName || m.league || '';
      const dt = m.date + (m.time && m.time !== 'TBD' ? ' ' + m.time : '');
      return `${i + 1}. ${m.team1} vs ${m.team2} | ${lg} | ${dt}`;
    }).join('\n');

    res.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px">🧠 Génération des combinés IA...</div>';

    // ── 6. Gemini génère les combos à partir UNIQUEMENT de ces matchs ──
    const prompt = `Tu es un expert en paris sportifs. Voici la liste EXACTE des vrais matchs disponibles:

${matchList}

Génère 4 combinés de EXACTEMENT ${actualSize} legs chacun. 4 types OBLIGATOIRES:
1. "blinde": cotes 1.20-1.65/leg, confiance >= 82% — SÉCURITÉ MAX
2. "value": EV+ (confiance > 1/odds en %), cotes 1.65-2.80/leg — VALUE BET
3. "equilibre": mix blinde + value, cotes 1.50-2.20/leg
4. "outsider": cotes 2.50-6.00/leg, confiance 52-70% — GROS POTENTIEL

RÈGLES ABSOLUES:
- Utilise UNIQUEMENT les matchs numérotés ci-dessus, JAMAIS d'autres matchs inventés
- Recopie les noms des équipes, la ligue et la date EXACTEMENT comme dans la liste
- Chaque match peut être dans plusieurs combos mais UNE SEULE FOIS par combo

JSON COMPACT (champs courts obligatoires):
{"combos":[{"type":"blinde","legs":[{"t1":"Equipe1","t2":"Equipe2","lg":"Compétition","dt":"JJ/MM","bet":"description pari","odds":1.45,"conf":85}],"cote":X.XX,"proba":XX,"ev":X.X,"verdict":"phrase courte"}]}

CALCULS: cote=produit des odds, proba=produit(conf/100)*100, ev=(proba/100)*(cote-1)-(1-proba/100).
EXACTEMENT ${actualSize} legs par combo, 4 combos total.`;

    const d2 = await callGemini([{ role: 'user', content: prompt }], { maxTokens, jsonMode: true });

    const parsed = extractJSON(extractText(d2));
    const combos = parsed?.combos || [];
    if (!combos.length) throw new Error('Aucun combiné généré — réessaie');

    const typeMap = {
      blinde:   { cls: 'csafe',     lbl: '🔒 BLINDÉ',    desc: 'Haute sécurité' },
      value:    { cls: 'cvalue',    lbl: '💹 VALUE BET',  desc: 'Valeur positive' },
      equilibre:{ cls: 'cbalanced', lbl: '⚖️ ÉQUILIBRÉ', desc: 'Risque maîtrisé' },
      outsider: { cls: 'coutsider', lbl: '🚀 OUTSIDER',  desc: 'Gros potentiel' },
      // compatibilité anciens types
      safe:     { cls: 'csafe',     lbl: '🔒 BLINDÉ',    desc: 'Haute sécurité' },
      balanced: { cls: 'cbalanced', lbl: '⚖️ ÉQUILIBRÉ', desc: 'Risque maîtrisé' },
    };

    res.innerHTML = combos.map(combo => {
      const legs = combo.legs || [];
      const cote  = combo.cote  || Math.round(legs.reduce((a, l) => a * (l.odds || 1), 1) * 100) / 100;
      const proba = combo.proba || Math.round(legs.reduce((a, l) => a * ((l.conf || 60) / 100), 1) * 10000) / 100;
      const ev    = combo.ev    ?? Math.round(((proba / 100) * (cote - 1) - (1 - proba / 100)) * 10000) / 100;
      const isPos = ev > 0;
      const gain  = Math.round(stake * cote * 100) / 100;
      const riskDot = proba >= 20 ? '🟢' : proba >= 5 ? '🟡' : '🔴';
      const riskLbl = proba >= 20 ? 'Faisable' : proba >= 5 ? 'Risqué' : 'Long shot';
      const t = typeMap[combo.type] || typeMap.equilibre;

      const legsHtml = legs.map((leg, i) => {
        const legEv = Math.round(((leg.conf / 100) * (leg.odds - 1) - (1 - leg.conf / 100)) * 100);
        const confCol = leg.conf >= 80 ? '#00dd55' : leg.conf >= 65 ? '#ffcc00' : '#ff6633';
        const evTag = legEv > 0
          ? `<span class="leg-ev-tag ev-pos-tag">EV+${legEv}%</span>`
          : `<span class="leg-ev-tag ev-neg-tag">EV${legEv}%</span>`;
        return `<div class="combo-leg">
          <div class="combo-leg-num">${i + 1}</div>
          <div class="combo-leg-info">
            <div class="combo-leg-match">${leg.t1} vs ${leg.t2}</div>
            <div class="combo-leg-bet">🎯 ${leg.bet} <span style="color:var(--accent)">@ ${leg.odds}</span></div>
            <div class="combo-leg-meta">${leg.lg} · ${leg.dt}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <div class="combo-leg-conf" style="color:${confCol}">${leg.conf}%</div>
            ${evTag}
          </div>
        </div>`;
      }).join('');

      return `<div class="combo-card ${t.cls}">
        <div class="combo-header-row">
          <div class="combo-badge">${t.lbl}</div>
          <div class="combo-risk-badge">${riskDot} ${riskLbl}</div>
        </div>
        <div class="combo-desc">${t.desc} · ${size} sélections</div>
        <div class="combo-legs">${legsHtml}</div>
        <div class="combo-verdict">"${combo.verdict || ''}"</div>
        <div class="combo-totals">
          <div class="combo-total"><div class="combo-total-val" style="color:var(--accent)">×${cote}</div><div class="combo-total-lbl">COTE</div></div>
          <div class="combo-total"><div class="combo-total-val" style="color:${proba >= 20 ? '#00dd55' : proba >= 5 ? '#ffcc00' : '#ff6633'}">${proba}%</div><div class="combo-total-lbl">PROBA</div></div>
          <div class="combo-total"><div class="combo-total-val" style="color:var(--accent3)">€${gain}</div><div class="combo-total-lbl">GAIN</div></div>
          <div class="combo-total"><div class="combo-total-val" style="color:${isPos ? 'var(--ev-pos)' : 'var(--ev-neg)'}">${isPos ? '+' : ''}${ev}%</div><div class="combo-total-lbl">EV</div></div>
        </div>
      </div>`;
    }).join('');

  } catch (e) {
    res.innerHTML = `<div style="color:var(--ev-neg);padding:16px;font-size:13px">❌ ${e.message}</div>`;
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
  const m = document.getElementById('oddsKeyModal');
  if (m) { m.style.display = 'flex'; setTimeout(() => document.getElementById('oddsKeyInput')?.focus(), 100); }
};

window.showFdKeyModal = function() {
  const m = document.getElementById('fdKeyModal');
  if (m) { m.style.display = 'flex'; setTimeout(() => document.getElementById('fdKeyInput')?.focus(), 100); }
};

window._saveOddsKey = function() {
  const key = document.getElementById('oddsKeyInput')?.value.trim();
  const status = document.getElementById('oddsKeyStatus');
  const info = document.getElementById('oddsKeyStatusInfo');
  if (!key) { if (status) { status.textContent = '⚠️ Clé vide'; status.style.color = '#ff3333'; } return; }
  localStorage.setItem('ps_oddskey', key);
  if (status) { status.textContent = '✅ Clé sauvegardée localement'; status.style.color = '#00dd55'; }
  if (info) info.textContent = '✅ Clé enregistrée — ajoutez ODDS_API_KEY=' + key.slice(0, 8) + '... dans votre .env pour activer';
  setTimeout(() => { document.getElementById('oddsKeyModal').style.display = 'none'; }, 1500);
};

window._saveFdKey = function() {
  const key = document.getElementById('fdKeyInput')?.value.trim();
  const status = document.getElementById('fdKeyStatus');
  if (!key) { if (status) { status.textContent = '⚠️ Clé vide'; status.style.color = '#ff3333'; } return; }
  localStorage.setItem('ps_fdkey', key);
  if (status) { status.textContent = '✅ Clé sauvegardée — ajoutez FOOTBALL_DATA_KEY=' + key.slice(0, 8) + '... dans votre .env'; status.style.color = '#00dd55'; }
  setTimeout(() => { document.getElementById('fdKeyModal').style.display = 'none'; }, 1500);
};

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
window.installPWA = installPWA;
window.filterToday = filterToday;
window.todayAnalyze = todayAnalyze;
window.fetchTodayMatches = fetchTodayMatches;
window.filterLive = filterLive;
window.prefillFromLive = prefillFromLive;
window.saveLiveKey = saveLiveKey;
window.clearMatchCache = clearMatchCache;

// ══════════════════════════════════════════════
// CHAT IA
// ══════════════════════════════════════════════
function chatQuickSuggestion(text) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = text;
  sendChatMessage();
}

function handleChatKey(e) {
  if (e.key === 'Enter') sendChatMessage();
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const msgs = document.getElementById('chatMessages');
  const sendBtn = document.getElementById('chatSendBtn');
  if (!input || !msgs) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  // Bulle utilisateur
  const userEl = document.createElement('div');
  userEl.className = 'chat-msg chat-msg-user';
  userEl.innerHTML = `<div class="chat-bubble-user">${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`;
  msgs.appendChild(userEl);

  // Indicateur de frappe
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-msg chat-msg-ai';
  typingEl.id = 'chatTyping';
  typingEl.innerHTML = '<div class="chat-typing"><span></span><span></span><span></span></div>';
  msgs.appendChild(typingEl);
  msgs.scrollTop = msgs.scrollHeight;
  if (sendBtn) sendBtn.disabled = true;

  const ctx = state.chatCtx;
  const contextPrompt = ctx
    ? `Tu es un expert en pronostics sportifs pour PronoSight. Contexte du match analysé — ${ctx.team1} vs ${ctx.team2} (${ctx.league}, ${ctx.match_date || 'à venir'}). Meilleur pari: ${ctx.best_bet} (confiance ${ctx.best_bet_confidence}%). Probabilités: ${ctx.team1} ${ctx.proba_home}%, Nul ${ctx.proba_draw || 0}%, ${ctx.team2} ${ctx.proba_away}%. Score prédit: ${ctx.score_pred}. Analyse: ${(ctx.analysis || '').slice(0, 500)}. Réponds en français, de manière concise (2-4 phrases max). Tu peux aussi analyser d'autres matchs si demandé.`
    : `Tu es un expert en pronostics sportifs pour PronoSight. Réponds en français, de manière concise (2-4 phrases max).`;

  const messages = [
    { role: 'user', content: contextPrompt },
    { role: 'assistant', content: 'Compris, je suis prêt à répondre à vos questions.' },
    ...state.chatHistory,
    { role: 'user', content: msg }
  ];

  try {
    const data = await callGemini(messages, { maxTokens: 600 });
    const reply = extractText(data);
    typingEl.remove();
    const aiEl = document.createElement('div');
    aiEl.className = 'chat-msg chat-msg-ai';
    aiEl.innerHTML = `<div class="chat-bubble-ai">${reply.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`;
    msgs.appendChild(aiEl);
    state.chatHistory.push({ role: 'user', content: msg });
    state.chatHistory.push({ role: 'assistant', content: reply });
  } catch (e) {
    typingEl.remove();
    const errEl = document.createElement('div');
    errEl.className = 'chat-msg chat-msg-ai';
    const errTxt = e.message.includes('429') ? 'Limite API atteinte, réessaie dans quelques secondes.' : 'Erreur de connexion, réessaie.';
    errEl.innerHTML = `<div class="chat-bubble-ai" style="color:var(--ev-neg)">⚠️ ${errTxt}</div>`;
    msgs.appendChild(errEl);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function markLastResult(val) {
  const h = getHist();
  if (!h.length) return;
  const it = h[0];
  const odds = parseFloat(it.odds) || 0;
  const stake = parseFloat(it.stake) || 10;
  it.result = val;
  it.pnl = val === 'win' && odds > 1 ? Math.round((odds - 1) * stake * 100) / 100 : val === 'lose' ? -stake : 0;
  saveHist(h);
  renderDashboard();
  // Feedback visuel sur les boutons
  ['rbWin','rbLose','rbDraw','rbPush'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('result-btn-active');
  });
  const activeId = val === 'win' ? 'rbWin' : val === 'lose' ? 'rbLose' : val === 'draw' ? 'rbDraw' : 'rbPush';
  const activeBtn = document.getElementById(activeId);
  if (activeBtn) activeBtn.classList.add('result-btn-active');
}
window.markLastResult = markLastResult;

async function shareAnalysis() {
  const h = getHist();
  const it = h[0];
  if (!it) return;

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 600 * dpr;
  canvas.height = 320 * dpr;
  canvas.style.width = '600px';
  canvas.style.height = '320px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, 600, 320);

  // Accent border top
  const grad = ctx.createLinearGradient(0, 0, 600, 0);
  grad.addColorStop(0, '#00aaff');
  grad.addColorStop(1, '#7b2fff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 4);

  // Logo
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#00aaff';
  ctx.fillText('🔮 PRONOSIGHT', 24, 32);

  // League
  ctx.font = '11px monospace';
  ctx.fillStyle = '#666';
  ctx.fillText((it.league || '').toUpperCase(), 24, 52);

  // Teams
  ctx.font = 'bold 26px sans-serif';
  ctx.fillStyle = '#ffffff';
  const matchStr = `${it.team1}  vs  ${it.team2}`;
  ctx.fillText(matchStr, 24, 96);

  // Separator line
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, 112);
  ctx.lineTo(576, 112);
  ctx.stroke();

  // Best bet
  ctx.font = '11px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('PARI RECOMMANDÉ', 24, 138);
  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = '#00dd55';
  ctx.fillText(it.best_bet || '—', 24, 162);

  // Confidence
  const conf = it.confidence || 0;
  const confColor = conf >= 70 ? '#00dd55' : conf >= 55 ? '#ffcc00' : '#ff6633';
  ctx.font = '11px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('CONFIANCE', 220, 138);
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = confColor;
  ctx.fillText(`${conf}%`, 220, 166);

  // Odds
  if (it.odds) {
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('COTE', 340, 138);
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#00aaff';
    ctx.fillText(`×${parseFloat(it.odds).toFixed(2)}`, 340, 166);
  }

  // EV
  if (it.ev != null) {
    const evColor = it.ev > 0 ? '#00dd55' : '#ff3333';
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('EV', 450, 138);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillStyle = evColor;
    ctx.fillText(`${it.ev > 0 ? '+' : ''}${it.ev.toFixed(1)}%`, 450, 166);
  }

  // Stars
  const stars = '★'.repeat(it.stars || 3) + '☆'.repeat(5 - (it.stars || 3));
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#ffcc00';
  ctx.fillText(stars, 24, 210);

  // Date
  ctx.font = '11px monospace';
  ctx.fillStyle = '#444';
  ctx.fillText(`Analyse du ${it.date} — pronosight.app`, 24, 240);

  // Disclaimer
  ctx.font = '10px monospace';
  ctx.fillStyle = '#333';
  ctx.fillText('⚠️ Outil d\'analyse IA — pas un conseil financier. Jouez responsable.', 24, 300);

  // Convert to blob and share
  canvas.toBlob(async blob => {
    const file = new File([blob], 'pronosight-analyse.png', { type: 'image/png' });
    const shareData = {
      title: `PronoSight — ${it.team1} vs ${it.team2}`,
      text: `${it.best_bet} (${conf}% confiance)\n🔮 PronoSight`,
      files: [file]
    };
    try {
      if (navigator.canShare && navigator.canShare(shareData)) {
        await navigator.share(shareData);
      } else {
        // Fallback: download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'pronosight-analyse.png';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'pronosight-analyse.png';
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  }, 'image/png');
}
window.shareAnalysis = shareAnalysis;

window.chatQuickSuggestion = chatQuickSuggestion;
window.handleChatKey = handleChatKey;
window.sendChatMessage = sendChatMessage;

// Initialisation
document.addEventListener('DOMContentLoaded', initApp);

// PWA Install prompt
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _deferredPrompt = e; const btn = document.getElementById('pwaInstallBtn'); if (btn) btn.style.display = 'flex'; });

console.log('⚡ PronoSight v4.0 chargé - Toutes les fonctions sont exposées');// v4.1 deploy fix
