// ══════════════════════════════════════════════════════════════
// PronoSight — app.js
// ══════════════════════════════════════════════════════════════

import { LEAGUES } from './modules/config.js';
import { state, setCachedAnalysis, clearOldCaches, getFavs, saveFavs } from './modules/state.js';
import { callGemini, extractText, extractJSON, fetchRealOdds, fetchApiStatus, fetchMatchDetails,
         fetchLeagueStandings, fetchH2H, fetchRealStats } from './modules/api.js';
import { probabilitesDepuisCotes, pourcentages100 } from './modules/probabilites.js';
import { assainir, echapperHtml } from './modules/securite.js';
import { htmlEcranValeurs } from './modules/valeurs.js';
import { icone, iconeSport, ecusson } from './modules/icones.js';
import { htmlUne, htmlAAnalyser, ligneMatch, rangCompet } from './modules/accueil.js';
import { htmlLive, htmlAujourdhui, htmlCompetitions, htmlMesParis, htmlVictor } from './modules/ecrans.js';
import { creerPari, bilanParis, courbeBankroll, versCsv } from './modules/paris.js';
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
  poserIcones();
  if (localStorage.getItem('ps_theme') === 'light') {
    document.body.classList.add('light-mode');
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = icone('soleil');
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

  // Les boutons de clés API sont des outils d'administration : un visiteur
  // n'a pas à voir « ❌ GEMINI » ni l'état de l'infrastructure.
  if (localStorage.getItem('ps_admin_key')) document.body.classList.add('admin');
  // Les favoris étaient des identifiants de ligue (« ligue1 ») ; ce sont
  // désormais des noms de compétition tels que les sources les écrivent.
  const favs = getFavs();
  if (favs.some(f => LEAGUES.some(l => l.id === f))) saveFavs([...new Set(favs.map(f => LEAGUES.find(l => l.id === f)?.name || f))]);
  // La barre du bas et la feuille « Plus » sont en position fixe : rattachées
  // à <body>, sinon un ancêtre transformé (.container) les fait défiler.
  ['plusFond', 'plusFeuille', 'pariFond', 'pariFeuille'].forEach(id => { const n = document.getElementById(id); if (n) document.body.appendChild(n); });
  const bas = document.querySelector('.bottom-nav'); if (bas) document.body.appendChild(bas);
  loadValeurs();

  const akBtn = document.getElementById('akChange');
  if (akBtn) {
    if (status.gemini) { akBtn.textContent = '✅ GEMINI'; akBtn.style.borderColor = '#00dd55'; akBtn.style.color = '#00dd55'; }
    else { akBtn.textContent = '❌ GEMINI'; akBtn.style.borderColor = '#ff3333'; akBtn.style.color = '#ff3333'; }
  }

  majBadgeParis();
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
  // Notifications sur les compétitions suivies : uniquement à partir de
  // données réelles (pronos publiés, values détectées), jamais d'un scan IA.
  Promise.all([loadVictorData(), loadValeurs()]).then(notifierFavoris);
}

// ══════════════════════════════════════════════
// SPORT & NAVIGATION
// ══════════════════════════════════════════════

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

function switchPronoMode(mode, btn) {
  // Toggle onglets Victor IA ↔ Analyse manuelle
  const victorSection = document.getElementById('pronoVictorSection');
  const manuelSection = document.getElementById('pronoManuelSection');
  if (!victorSection || !manuelSection) return;

  victorSection.style.display = mode === 'victor' ? 'block' : 'none';
  manuelSection.style.display  = mode === 'manuel'  ? 'block' : 'none';

  // Mise à jour des onglets actifs (uniquement les boutons pronoTab*)
  ['pronoTabVictor','pronoTabManuel'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  if (btn) btn.classList.add('active');

  // Initialisation paresseuse : lance les ligues la première fois qu'on ouvre l'analyse manuelle
  if (mode === 'manuel' && !manuelSection.dataset.initialized) {
    manuelSection.dataset.initialized = 'true';
    showStep(1);
    dessinerChoixMatch();
  }
}

function switchNav(tab) {
  // Mise à jour visuelle immédiate (pas de debounce sur le CSS)
  const pv = document.getElementById('pronoView');
  if (pv) pv.style.display = tab === 'prono' ? 'block' : 'none';
  ['history','parlay','alerts','dash','live','today','victor','valeurs'].forEach(t => {
    const el = document.getElementById(t + 'View');
    if (el) el.classList.toggle('visible', t === tab);
  });
  ['prono','history','parlay','alerts','dash','live','today','victor','valeurs'].forEach(t => {
    const b = document.getElementById('nav-' + t);
    if (b) b.classList.toggle('active', t === tab);
  });
  // Barre du bas (mobile) : une rubrique rangée dans « Plus » allume « Plus ».
  const enBas = ['dash', 'prono', 'valeurs', 'live'];
  document.querySelectorAll('.bn-btn').forEach(b => {
    const n = b.dataset.nav;
    b.classList.toggle('active', n === tab || (n === 'plus' && !enBas.includes(tab)));
  });
  document.querySelectorAll('.plus-grille button').forEach(b => b.classList.toggle('active', b.dataset.nav === tab));
  fermerPlus();
  // Selon le thème, c'est <body> qui défile (overflow:auto), pas la fenêtre.
  window.scrollTo(0, 0); document.body.scrollTop = 0;
  // Live : rafraîchi tant que l'onglet est ouvert, arrêté sinon.
  if (tab === 'live') demarrerDirect(); else arreterDirect();

  // Debounce 150ms sur le chargement de données (évite les fetches en rafale)
  if (_switchNavTimer) clearTimeout(_switchNavTimer);
  _switchNavTimer = setTimeout(() => {
    _switchNavTimer = null;
    if (tab === 'history') dessinerMesParis();
    if (tab === 'dash') renderDashboard();
    if (tab === 'victor') renderVictorView();
    if (tab === 'valeurs') renderValeursView();
    if (tab === 'prono') renderPronoVictor();
    if (tab === 'today') dessinerAujourdhui(true);
    if (tab === 'alerts') dessinerCompetitions(true);
    if (tab === 'parlay' && document.getElementById('parlayLegs')?.children.length === 0) {
      addParlayLeg(); addParlayLeg();
    }
  }, 150);
}

/** Remplace chaque <i data-ico="nom"> par son pictogramme. */
function poserIcones(racine = document) {
  racine.querySelectorAll('i[data-ico]').forEach(i => { i.outerHTML = icone(i.dataset.ico); });
}

// ══════════════════════════════════════════════
// ACCUEIL — le programme du jour, prêt à analyser
// ══════════════════════════════════════════════
const programme = { matchs: [], charge: false, ts: 0 };

async function chargerProgramme() {
  if (programme.charge && Date.now() - programme.ts < 5 * 60 * 1000) return;
  try {
    const r = await fetch(`/api/matchs?date=${new Date().toISOString().slice(0, 10)}`);
    const j = r.ok ? await r.json() : null;
    programme.matchs = Array.isArray(j?.matchs) ? j.matchs : [];
  } catch { programme.matchs = []; }
  programme.charge = true; programme.ts = Date.now();
}

function dessinerAccueil() {
  const une = document.getElementById('dashUne');
  if (une) une.innerHTML = htmlUne({
    aVenir: programme.charge ? programme.matchs.filter(m => m.statut === 'NS' || m.statut === 'LIVE').length : null,
    valeurs: valeursState.valeurs?.aujourdhui?.length || 0,
    pronos: victorState.today?.total || 0,
  });
  const liste = document.getElementById('dashAAnalyser');
  if (liste) liste.innerHTML = htmlAAnalyser(programme.matchs, { charge: programme.charge, favoris: getFavs() });
}

/** Ligue de l'app correspondant au libellé de compétition d'une source. */
function ligueDepuisCompet(competition = '') {
  const c = normaliserNom(competition);
  if (!c) return null;
  return LEAGUES.find(l => { const n = normaliserNom(l.name); return n === c || c.includes(n) || n.includes(c); }) || null;
}

/**
 * Lance une VRAIE analyse du match : bascule sur « Analyser un match »,
 * renseigne les équipes et la ligue, puis exécute analyze().
 * Avant, le bouton ⚡ affichait « Victor analyse… » sans rien analyser.
 */
async function analyserMatch({ team1, team2, competition = '', leagueId = null, live = false, heure = '', sportKey = null } = {}) {
  if (!team1 || !team2) return;
  switchNav('prono');
  switchPronoMode('manuel', document.getElementById('pronoTabManuel'));
  const ligue = (leagueId && LEAGUES.find(l => l.id === leagueId)) || ligueDepuisCompet(competition);
  if (ligue) { state.selectedLeague = ligue; state.currentSport = ligue.sport === 'basketball' ? 'basket' : 'football'; }
  state.selectedMatch = { team1, team2, live, date: "Aujourd'hui", time: heure, league: competition, sport_key: sportKey };
  if (!ligue) state.selectedLeague = competition ? { id: null, name: competition, country: '', sport: 'football' } : null;
  showStep(2);
  const s2 = document.getElementById('s2l');
  if (s2) s2.textContent = ligue ? ligue.name : (competition || 'Match choisi');
  document.getElementById('team1').value = team1;
  document.getElementById('team2').value = team2;
  await new Promise(r => setTimeout(r, 60));
  document.getElementById('step2panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await analyze();
}

function analyserDepuisAccueil(i) {
  const m = programme.matchs[i];
  if (m) analyserMatch({ team1: m.equipe_a, team2: m.equipe_b, competition: m.competition, live: m.statut === 'LIVE', heure: m.heure, sportKey: m.sport_key });
}

function ouvrirAnalyseLibre() {
  switchNav('prono');
  switchPronoMode('manuel', document.getElementById('pronoTabManuel'));
}

// ── Analyse : étape 1, un match réel du programme ──
let _competChoisie = null;
async function dessinerChoixMatch() {
  const zc = document.getElementById('choixCompet'), zm = document.getElementById('choixMatchs');
  if (!zc || !zm) return;
  if (!programme.charge) { zm.innerHTML = '<div class="vm-note" style="margin:0">Chargement du programme…</div>'; await chargerProgramme(); }
  const ouverts = programme.matchs.map((m, index) => ({ ...m, index })).filter(m => m.statut === 'NS' || m.statut === 'LIVE');
  if (!ouverts.length) {
    zc.innerHTML = '';
    zm.innerHTML = `<div class="etat-vide" style="padding:18px 10px"><div class="etat-vide-icone">${icone('calendrier')}</div><div class="etat-vide-titre">Plus de match aujourd'hui</div><div class="etat-vide-texte">Le programme du jour est terminé. Tu peux saisir une affiche à la main.</div></div>`;
    return;
  }
  const favs = getFavs();
  const compets = [...new Set(ouverts.map(m => m.competition))]
    .sort((a, b) => favs.includes(b) - favs.includes(a) || rangCompet(a) - rangCompet(b));
  if (!_competChoisie || !compets.includes(_competChoisie)) _competChoisie = compets[0];
  zc.innerHTML = compets.map(c => `<button class="tab ${c === _competChoisie ? 'active' : ''}" data-c="${echapperHtml(c)}" onclick="choisirCompet(this.dataset.c)">${echapperHtml(c)}<span class="tab-compte">${ouverts.filter(m => m.competition === c).length}</span></button>`).join('');
  zm.innerHTML = ouverts.filter(m => m.competition === _competChoisie)
    .sort((a, b) => String(a.heure).localeCompare(String(b.heure))).map(ligneMatch).join('');
}
function choisirCompet(c) { _competChoisie = c; dessinerChoixMatch(); }
function saisieLibre() {
  state.selectedMatch = null; state.selectedLeague = null;
  showStep(2);
  const s2 = document.getElementById('s2l'); if (s2) s2.textContent = 'Saisie libre';
  ['team1', 'team2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('team1')?.focus();
}

function ouvrirPlus() {
  document.getElementById('plusFeuille')?.classList.add('ouverte');
  document.getElementById('plusFond')?.classList.add('ouvert');
}
function fermerPlus() {
  document.getElementById('plusFeuille')?.classList.remove('ouverte');
  document.getElementById('plusFond')?.classList.remove('ouvert');
}

// ══════════════════════════════════════════════
// VALUE DE MARCHÉ — signaux du jour et bilan vérifiable
// ══════════════════════════════════════════════
const valeursState = { valeurs: null, bilan: null, erreur: false, ts: 0, enCours: null };

async function loadValeurs({ force = false } = {}) {
  if (!force && valeursState.ts && Date.now() - valeursState.ts < VICTOR_CACHE_TTL) return;
  if (valeursState.enCours) return valeursState.enCours;
  valeursState.enCours = (async () => {
    try {
      const [v, b] = await Promise.all([
        fetch('/api/victor/valeurs').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        fetch('/api/victor/bilan').then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      // Pas d'assainir() ici : modules/valeurs.js échappe lui-même chaque chaîne.
      valeursState.valeurs = v; valeursState.bilan = b;
      valeursState.erreur = false; valeursState.ts = Date.now();
    } catch (err) {
      console.warn('[Values] indisponibles :', err.message);
      valeursState.erreur = !valeursState.valeurs;
    } finally {
      valeursState.enCours = null;
      majBadgeValeurs();
      dessinerAccueil();
    }
  })();
  return valeursState.enCours;
}

function majBadgeValeurs() {
  const n = valeursState.valeurs?.aujourdhui?.length || 0;
  const badge = document.getElementById('valeursBadge');
  if (badge) { badge.textContent = n; badge.style.display = n ? '' : 'none'; }
  const pastille = document.getElementById('valeursPastille');
  if (pastille) pastille.style.display = n ? '' : 'none';
}

function bankrollDefinie() {
  return bilanParis(lireParis(), { bankrollInitiale: bankrollDepart() }).bankroll;
}

function dessinerValeurs() {
  const el = document.getElementById('valeursView');
  if (el) el.innerHTML = htmlEcranValeurs({ ...valeursState, bankroll: bankrollDefinie() });
}

async function renderValeursView() {
  dessinerValeurs();
  await loadValeurs();
  dessinerValeurs();
}

async function rechargerValeurs() {
  valeursState.erreur = false;
  await loadValeurs({ force: true });
  dessinerValeurs();
}

function toggleTheme() {
  document.body.classList.toggle('light-mode');
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = icone(document.body.classList.contains('light-mode') ? 'soleil' : 'lune');
  localStorage.setItem('ps_theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
}

// ══════════════════════════════════════════════
// LEAGUES & MATCHES
// ══════════════════════════════════════════════






/**
 * Normalise un nom de compétition pour le rapprochement.
 * « Coupe du Monde 2026 » et « FIFA World Cup » ne se rejoindront pas —
 * c'est voulu : mieux vaut afficher « aucun match » que les mauvais.
 */
function normaliserNom(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(championnat|ligue|league|liga|serie|division|primera|coupe|cup|de|du|des|la|le|les|of|the)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
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
  // ls1 immédiat, ls2 après 1s (Google Search), ls3/ls4 déclenchés manuellement après
  document.getElementById('ls1')?.classList.add('show');
  setTimeout(() => document.getElementById('ls2')?.classList.add('show'), 1000);

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
      fetchRealOdds(t1, t2, state.selectedLeague?.id, state.selectedMatch?.sport_key),
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
      // Aucun historique fourni : on ne demande pas à l'IA d'en inventer un.
      h2hCtx = `\nH2H: non disponible — n'invente aucune confrontation directe.`;
    }

    // ── Forme réelle via Google Search (fallback si API-Football indisponible) ──
    let liveFormCtx = '';
    let liveForm1 = null, liveForm2 = null;
    if (!realStats) {
      try {
        document.getElementById('ls2')?.classList.add('show');
        const today = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        const searchPrompt = `Cherche sur le web les 5 derniers résultats en championnat de "${t1}" et "${t2}" en ${today}.
Réponds UNIQUEMENT avec ce JSON, sans texte avant ni après :
{
  "team1_form": ["W ou D ou L","W ou D ou L","W ou D ou L","W ou D ou L","W ou D ou L"],
  "team1_results": ["score vs adversaire","score vs adversaire","score vs adversaire","score vs adversaire","score vs adversaire"],
  "team2_form": ["W ou D ou L","W ou D ou L","W ou D ou L","W ou D ou L","W ou D ou L"],
  "team2_results": ["score vs adversaire","score vs adversaire","score vs adversaire","score vs adversaire","score vs adversaire"],
  "team1_injuries": "liste des blessés/suspendus connus ou aucun signalé",
  "team2_injuries": "liste des blessés/suspendus connus ou aucun signalé"
}
Ordre : du plus récent (index 0) au plus ancien (index 4). W=victoire, D=nul, L=défaite.`;

        const formData = await callGemini(
          [{ role: 'user', content: searchPrompt }],
          { useSearch: true, maxTokens: 800, jsonMode: false }
        );
        const formText = extractText(formData);
        const formJSON = extractJSON(formText);
        if (formJSON && formJSON.team1_form?.length && formJSON.team2_form?.length) {
          liveForm1 = formJSON.team1_form;
          liveForm2 = formJSON.team2_form;
          liveFormCtx = `\n\n⚡ FORME RÉELLE (Google Search — PRIORITÉ ABSOLUE):
- Derniers résultats ${t1}: ${(formJSON.team1_results || liveForm1).join(' | ')}
- Derniers résultats ${t2}: ${(formJSON.team2_results || liveForm2).join(' | ')}
- Blessés/suspendus ${t1}: ${formJSON.team1_injuries || 'inconnu'}
- Blessés/suspendus ${t2}: ${formJSON.team2_injuries || 'inconnu'}`;
          console.log('✅ Forme réelle récupérée via Google Search');
        }
      } catch (formErr) {
        console.warn('⚠️ Google Search forme échoué:', formErr.message);
      }
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
SPORT: ${sport}${standingsCtx}${h2hCtx}${statsCtx}${liveFormCtx}

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
  "team1_form": [<5 derniers résultats W/D/L UNIQUEMENT s'ils figurent dans les données ci-dessus, sinon tableau vide>],
  "team2_form": [<idem pour ${t2}>],
  "blessures_team1": [<joueurs blessés UNIQUEMENT s'ils figurent dans les données ci-dessus, sinon tableau vide>],
  "blessures_team2": [<idem pour ${t2}>],
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
- N'invente AUCUN fait : ni résultat, ni blessé, ni cote, ni confrontation. Une donnée absente reste absente.
- Les probabilités et les cotes seront recalculées par PronoSight à partir des cotes réelles des bookmakers quand elles existent : donne ta meilleure estimation, sans plus.
${(statsCtx || liveFormCtx) ? '- PRIORITÉ ABSOLUE : appuie ton analyse sur les DONNÉES RÉELLES fournies ci-dessus.' : '- Peu de données réelles sont disponibles pour ce match : dis-le clairement dans l\'analyse et reste prudent.'}`;

    document.getElementById('ls3')?.classList.add('show');
    const data = await callGemini([{ role: 'user', content: prompt }], { maxTokens: 6000, jsonMode: true, cacheKey: `${t1}|${t2}|${league}` });
    document.getElementById('ls4')?.classList.add('show');

    
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
        alt_score1: "2-1", alt_score1_pct: 20,
        alt_score2: "0-1", alt_score2_pct: 15,
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

    // Surcharge team_form avec les vraies données Google Search si disponibles
    if (liveForm1?.length === 5) d.team1_form = liveForm1;
    if (liveForm2?.length === 5) d.team2_form = liveForm2;

    // ── Probabilités calculées, pas écrites par l'IA ──
    // Voir modules/probabilites.js. Les chiffres de l'IA ne sont gardés que
    // faute de cotes réelles, et l'écran le signale alors explicitement.
    if (!realStats && !liveForm1) d.team1_form = [];
    if (!realStats && !liveForm2) d.team2_form = [];
    const marche = sport === 'football' ? probabilitesDepuisCotes(realOdds) : null;
    if (marche) {
      const [ph, pd, pa] = pourcentages100([marche.proba.home, marche.proba.draw, marche.proba.away]);
      d.proba_home = ph; d.proba_draw = pd; d.proba_away = pa;
      const [s1, s2, s3] = marche.scores;
      d.score_pred = s1.score;  d.score_pred_pct = Math.round(s1.p * 100);
      d.alt_score1 = s2.score;  d.alt_score1_pct = Math.round(s2.p * 100);
      d.alt_score2 = s3.score;  d.alt_score2_pct = Math.round(s3.p * 100);
      d.market_over_line = '2.5';
      d.market_over = marche.over25 >= 0.5 ? 'Over' : 'Under';
      d.market_over_conf = Math.round(Math.max(marche.over25, 1 - marche.over25) * 100);
      d.market_btts = marche.btts >= 0.5 ? 'Oui' : 'Non';
      d.market_btts_conf = Math.round(Math.max(marche.btts, 1 - marche.btts) * 100);
      d.odds_home = +marche.cotes.home.toFixed(2);
      d.odds_draw = +marche.cotes.draw.toFixed(2);
      d.odds_away = +marche.cotes.away.toFixed(2);
      d.odds_source = marche.source;
      d.proba_source = 'marche';
      d.marche = { over25: marche.over25, btts: marche.btts, proba: marche.proba };
      // La confiance du meilleur pari devient sa probabilité de marché quand
      // le pari correspond à une ligne calculée.
      const m = String(d.best_bet_market || '').toLowerCase().trim();
      const pMarche = m === '1' ? marche.proba.home : m === 'x' ? marche.proba.draw : m === '2' ? marche.proba.away
        : /over\s*2[.,]5/.test(m) ? marche.over25 : /under\s*2[.,]5/.test(m) ? 1 - marche.over25
        : /btts|deux .quipes/.test(m) ? marche.btts : null;
      if (pMarche != null) {
        d.best_bet_confidence = Math.round(pMarche * 100);
        d.stars = d.best_bet_confidence < 55 ? 1 : d.best_bet_confidence < 65 ? 2 : d.best_bet_confidence < 75 ? 3 : d.best_bet_confidence < 85 ? 4 : 5;
        d.traffic_light = d.best_bet_confidence >= 70 ? 'vert' : d.best_bet_confidence >= 55 ? 'orange' : 'rouge';
      }
    } else {
      d.proba_source = 'ia';
      d.odds_source = 'estimation IA — non vérifiée';
    }

    // Sauvegarder dans le cache
    setCachedAnalysis(t1, t2, league, d);

    // Calculer EV et Kelly
    const bookOdds = parseFloat(document.getElementById('evOdds')?.value) || 0;
    const evMarket = (document.getElementById('evMarket')?.value || '').trim();
    const bankroll = parseFloat(document.getElementById('bankroll')?.value) || 0;
    const kellyFraction = parseFloat(document.getElementById('kellyFraction')?.value) || 0.25;
    
    let evData = null, kellyData = null;
    
    if (bookOdds > 1 && evMarket) {
      // Espérance et Kelly uniquement sur des probabilités de MARCHÉ. Sur une
      // estimation de l'IA, elles affichaient une précision qui n'existe pas
      // — et une mise conseillée en conséquence.
      let trueProb = 0;
      const mLow = evMarket.toLowerCase();
      if (d.proba_source === 'marche') {
        if (mLow === '1') trueProb = d.marche.proba.home;
        else if (mLow === 'x' || mLow === 'nul') trueProb = d.marche.proba.draw;
        else if (mLow === '2') trueProb = d.marche.proba.away;
        else if (/over\s*2[.,]5/.test(mLow)) trueProb = d.marche.over25;
        else if (/under\s*2[.,]5/.test(mLow)) trueProb = 1 - d.marche.over25;
        else if (/btts/.test(mLow)) trueProb = d.marche.btts;
      }
      
      if (trueProb > 0) {
        const ev = calcEV(bookOdds, trueProb);
        evData = { ev, trueProb, bookOdds, market: evMarket };
        if (bankroll > 0) {
          kellyData = { ...calcKelly(bookOdds, trueProb, bankroll, kellyFraction), bankroll, fraction: kellyFraction };
        }
      }
    }

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
      alt_score1: "2-1", alt_score1_pct: 20,
      alt_score2: "0-1", alt_score2_pct: 15,
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

function renderResults(dBrut, evData, kellyData, leg1Score) {
  // Toute chaîne venue de l'IA, d'une API ou de la saisie est échappée
  // avant d'entrer dans le HTML. Voir modules/securite.js.
  const d = assainir(dBrut);
  const isBk = d.sport === 'basketball';
  let wi = 0;
  if (d.proba_away > d.proba_home && d.proba_away > (d.proba_draw || 0)) wi = 2;
  else if (!isBk && (d.proba_draw || 0) > d.proba_home && (d.proba_draw || 0) > d.proba_away) wi = 1;

  const tl = d.traffic_light || 'orange';
  const tlLabel = tl === 'vert' ? 'Bon pari' : tl === 'orange' ? 'Pari moyen' : 'Pari risqué';
  const tlCls = tl === 'vert' ? 'haute' : tl === 'orange' ? 'moyenne' : 'basse';
  const stars = Math.min(5, Math.max(1, d.stars || Math.ceil(d.best_bet_confidence / 20)));
  const formDot = r => r ? `<div class="form-dot ${({ W: 'fd-w', D: 'fd-d', L: 'fd-l' })[r] || 'fd-d'}">${({ W: 'V', D: 'N', L: 'D' })[r] || r}</div>` : '';
  // Une forme inconnue (« ? ») n'est pas une forme : on n'affiche que du réel.
  const formeReelle = (f) => (Array.isArray(f) && f.some(r => ['W', 'D', 'L'].includes(r)) ? f : []);
  const form1 = formeReelle(d.team1_form).map(formDot).join('');
  const form2 = formeReelle(d.team2_form).map(formDot).join('');
  const coteJuste = (p) => (p > 0 ? (100 / p).toFixed(2) : '—');

  // Les trois issues, façon tableau de cotes : probabilité + cote juste.
  const issues = [
    { lib: '1', nom: d.team1, p: d.proba_home, i: 0 },
    ...(!isBk ? [{ lib: 'N', nom: 'Match nul', p: d.proba_draw || 0, i: 1 }] : []),
    { lib: '2', nom: d.team2, p: d.proba_away, i: 2 },
  ];
  const issuesHtml = issues.map(x => `<div class="an-issue ${wi === x.i ? 'favori' : ''}">
      <span class="an-issue-lib">${x.lib}</span>
      <b>${x.p ?? 0}<small>%</small></b>
      <span class="an-issue-nom">${x.nom}</span>
      <span class="an-issue-cote">cote juste ${coteJuste(x.p)}</span>
    </div>`).join('');
  const barre = issues.map(x => `<i class="seg-${x.i}" style="width:${x.p || 0}%"></i>`).join('');

  let evBlock = '';
  if (evData) {
    const isPos = evData.ev > 0;
    evBlock = `<div class="an-carte an-ev ${isPos ? 'pos' : 'neg'}">
      <div class="an-ev-tete">${icone(isPos ? 'hausse' : 'croix')}<span>Ta cote : ${evData.market} @ ${evData.bookOdds}</span></div>
      <div class="an-ev-val">${isPos ? '+' : ''}${evData.ev} %<small>de valeur espérée</small></div>
      <div class="an-ev-texte">${isPos ? 'La cote est au-dessus du prix juste : sur la durée, ce pari rapporte.' : 'La cote est sous le prix juste : le bookmaker garde l\'avantage. À éviter.'}</div>
      ${kellyData && isPos ? `<div class="an-ev-mise">Mise suggérée (Kelly × ${kellyData.fraction}) : <b>${kellyData.stake} €</b> sur ${kellyData.bankroll} €</div>` : ''}
    </div>`;
  }

  const factors = (d.key_factors || []).map(f => `<div class="an-facteur">${icone('fleche', { taille: 16 })}<div>${f.text}</div></div>`).join('');


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
    oddsTableBlock = `<div class="an-carte">
      <div class="titre-section">${icone('stats')}Les cotes des bookmakers</div>
      <table class="odds-table">
        <thead><tr><th>Bookmaker</th><th>1</th><th>N</th><th>2</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="odds-best-hint">En surbrillance : la meilleure cote du marché.</div>
    </div>`;
  }

  const html = `
    <div class="an-barre">
      <button class="bouton-discret" onclick="resetToStart()">${icone('fleche', { taille: 16, classe: 'retourne' })}Autre match</button>
      <button class="bouton-discret" onclick="shareAnalysis()" id="rbShare">Partager</button>
    </div>

    <div class="an-affiche">
      <div class="an-affiche-sur">${d.league}${d.is_live ? ' · <span class="an-direct">EN DIRECT</span>' : d.match_date ? ` · ${d.match_date}` : ''}</div>
      <div class="an-affiche-equipes">
        <div class="an-equipe">${ecusson(d.team1 || '', { taille: 64 })}<div>${d.team1}</div></div>
        <div class="an-vs">VS</div>
        <div class="an-equipe">${ecusson(d.team2 || '', { taille: 64 })}<div>${d.team2}</div></div>
      </div>
    </div>

    ${d.proba_source !== 'marche' ? `<div class="an-carte">
      <div class="titre-section">${icone('cible')}Qui gagne ?</div>
      <div class="an-source ia">${icone('eclair', { taille: 15 })}Aucune cote réelle trouvée pour ce match</div>
      <div class="an-texte">Sans cotes du marché, PronoSight n'affiche ni pourcentages, ni cote juste, ni score probable : ce seraient des chiffres inventés. La lecture ci-dessous est qualitative.</div>
    </div>` : `<div class="an-carte">
      <div class="titre-section">${icone('cible')}Qui gagne ?</div>
      <div class="an-source ${d.proba_source === 'marche' ? 'marche' : 'ia'}">${d.proba_source === 'marche'
        ? `${icone('bouclier', { taille: 15 })}Calculé sur les cotes réelles (${d.odds_source}), marge des bookmakers retirée`
        : `${icone('eclair', { taille: 15 })}Estimation de l'IA : aucune cote réelle trouvée pour ce match`}</div>
      <div class="an-issues">${issuesHtml}</div>
      <div class="an-barre-probas">${barre}</div>
    </div>`}

    <div class="an-carte an-verdict">
      <div class="titre-section">${icone('eclair')}Le verdict</div>
      <div class="an-verdict-pari">${d.best_bet}</div>
      ${d.proba_source === 'marche' ? `<div class="an-verdict-meta">
        <span class="an-pastille ${tlCls}">${tlLabel}</span>
        <span class="jauge ${tlCls}"><span class="jauge-segs">${[1, 2, 3, 4, 5].map(k => `<i class="${k <= stars ? 'on' : ''}"></i>`).join('')}</span>${d.best_bet_confidence} %</span>
      </div>` : `<div class="an-verdict-meta"><span class="an-pastille moyenne">Lecture de l'IA, non chiffrée</span></div>`}
      ${d.simple_explanation ? `<div class="an-simple">${d.simple_explanation}</div>` : ''}
    </div>

    ${evBlock}

    ${d.proba_source === 'marche' ? `<div class="an-carte">
      <div class="titre-section">${icone('ballon')}Scores les plus probables</div>
      <div class="an-scores">
        <div class="an-score principal"><b>${d.score_pred}</b><span>${d.score_pred_pct} %</span></div>
        <div class="an-score"><b>${d.alt_score1}</b><span>${d.alt_score1_pct} %</span></div>
        <div class="an-score"><b>${d.alt_score2}</b><span>${d.alt_score2_pct} %</span></div>
      </div>
      <div class="an-scores" style="grid-template-columns:1fr 1fr;margin-top:8px">
        <div class="an-score"><b>${Math.round(d.marche.over25 * 100)} %</b><span>Plus de 2,5 buts · cote juste ${(1 / d.marche.over25).toFixed(2)}</span></div>
        <div class="an-score"><b>${Math.round(d.marche.btts * 100)} %</b><span>Les deux marquent · cote juste ${(1 / d.marche.btts).toFixed(2)}</span></div>
      </div>
    </div>` : ''}

    ${form1 || form2 ? `<div class="an-carte">
      <div class="titre-section">${icone('historique')}Forme récente</div>
      <div class="an-forme"><span>${d.team1}</span><div class="form-dots">${form1 || '<em>—</em>'}</div></div>
      <div class="an-forme"><span>${d.team2}</span><div class="form-dots">${form2 || '<em>—</em>'}</div></div>
    </div>` : ''}

    ${d.analysis ? `<div class="an-carte">
      <div class="titre-section">${icone('loupe')}L'analyse${d.realStats ? ' <span class="an-pastille haute">stats réelles</span>' : ''}</div>
      <div class="an-texte">${d.analysis}</div>
      ${factors ? `<div class="an-facteurs">${factors}</div>` : ''}
    </div>` : ''}

    ${oddsTableBlock}

    <button class="dash-cta" style="width:100%;margin-bottom:12px" onclick="jouerPari('analyse')">${icone('portefeuille', { taille: 18 })} Je joue ce pari</button>

    <div class="chat-section">
      <div class="chat-header">
        <div class="chat-avatar">${icone('micro')}</div>
        <div>
          <div class="chat-title">Pose ta question</div>
          <div class="chat-subtitle">Sur ce match, ses risques, ou n'importe quelle autre affiche</div>
        </div>
      </div>
      <div class="chat-suggestions">
        <button class="chat-chip" onclick="chatQuickSuggestion('Pourquoi ce pronostic ?')">Pourquoi ce prono ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Quels sont les risques ?')">Quels risques ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Que miseriez-vous et combien ?')">Combien miser ?</button>
        <button class="chat-chip" onclick="chatQuickSuggestion('Donne-moi les stats clés des deux équipes')">Stats des équipes</button>
      </div>
      <div class="chat-messages" id="chatMessages">
        <div class="chat-msg chat-msg-ai">
          <div class="chat-bubble-ai">Une question sur ce match ? Je peux détailler l'analyse, les risques, ou étudier une autre affiche.</div>
        </div>
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chatInput" placeholder="Ex. : pourquoi ce prono ? ou analyse PSG – Lyon" onkeydown="handleChatKey(event)" maxlength="400">
        <button class="chat-send-btn" id="chatSendBtn" onclick="sendChatMessage()" aria-label="Envoyer">${icone('fleche')}</button>
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
  if(c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.chatCtx = d;
  state.chatHistory = [];
}
// Nouveau système de confiance avancé

function resetToStart() {
  state.selectedMatch = null;
  document.getElementById('team1').value = '';
  document.getElementById('team2').value = '';
  document.getElementById('evOdds').value = '';
  document.getElementById('evMarket').value = '';
  showStep(1);
  dessinerChoixMatch();
  window.scrollTo(0, 0); document.body.scrollTop = 0;
}

// ══════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════








// ══════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════
function renderDashboard() {
  dessinerAccueil();
  if (!programme.charge) chargerProgramme().then(() => { dessinerAccueil(); majBadgeDirect(); });

  // ── Mon suivi : uniquement les paris que l'utilisateur a enregistrés ──
  const suivi = document.getElementById('dashSuivi');
  if (suivi) {
    const paris = lireParis(), b = bilanParis(paris, { bankrollInitiale: bankrollDepart() });
    const st = (val, lib, cls = '') => `<div class="dash-stat"><div class="dash-stat-val ${cls}">${val}</div><div class="dash-stat-lbl">${lib}</div></div>`;
    suivi.innerHTML = paris.length || b.bankroll
      ? `<div class="dash-grid">
          ${st(b.bankroll != null ? `${b.bankroll.toFixed(0)} €` : '—', 'Bankroll')}
          ${st(b.regles ? `${b.profit >= 0 ? '+' : '−'}${Math.abs(b.profit).toFixed(0)} €` : '—', 'Gain net', b.profit > 0 ? 'pos' : b.profit < 0 ? 'neg' : '')}
          ${st(b.roi == null ? '—' : `${b.roi >= 0 ? '+' : '−'}${Math.abs(b.roi * 100).toFixed(1)} %`, 'Rendement', b.roi > 0 ? 'pos' : b.roi < 0 ? 'neg' : '')}
          ${st(b.attente, 'En attente')}
        </div>
        <button class="victor-actualiser" style="width:100%;justify-content:center;padding:11px;margin-top:12px;cursor:pointer" onclick="switchNav('history')">Ouvrir mes paris ${icone('fleche', { taille: 16 })}</button>`
      : `<div class="etat-vide" style="padding:18px 10px"><div class="etat-vide-icone">${icone('portefeuille')}</div>
          <div class="etat-vide-titre">Suis tes vrais résultats</div>
          <div class="etat-vide-texte">Enregistre les paris que tu joues — cote et mise réelles — et PronoSight calcule ta bankroll, ton gain et ton rendement.</div>
          <button class="dash-cta" style="margin-top:14px" onclick="switchNav('history')">Définir ma bankroll</button></div>`;
  }

  // ── Les pronos de Victor du jour ──
  const rp = document.getElementById('dashRecentPicks');
  if (rp) {
    const picks = victorState.loaded ? (victorState.today?.pronostics || []) : [];
    if (!victorState.loaded) rp.innerHTML = '<div class="vm-note" style="margin:0">Chargement…</div>';
    else if (!picks.length) {
      const h = new Date().getHours();
      rp.innerHTML = `<div class="vm-note" style="margin:0">Aucun prono publié aujourd'hui pour l'instant. Victor analyse à 7 h et 13 h, et ne publie que lorsqu'il voit un avantage — certains jours, rien.${h < 13 ? '' : ''}</div>`;
    } else {
      rp.innerHTML = picks.slice(0, 4).map(p => `<div class="dash-pick-row" onclick="switchNav('prono')" style="cursor:pointer">
          ${ecusson(p.equipe_a || '', { taille: 30 })}
          <div style="flex:1;min-width:0">
            <div class="dash-pick-match">${p.equipe_a || ''} – ${p.equipe_b || ''}</div>
            <div class="dash-pick-league">${p.pronostic_principal || ''}${p.cote_estimee ? ` · <b>${parseFloat(p.cote_estimee).toFixed(2)}</b>` : ''} · ${p.competition || p.sport || ''}</div>
          </div>
        </div>`).join('') + `<button class="victor-actualiser" style="width:100%;justify-content:center;padding:11px;margin-top:8px;cursor:pointer" onclick="switchNav('prono')">Voir les pronos de Victor ${icone('fleche', { taille: 16 })}</button>`;
    }
  }
}

// ══════════════════════════════════════════════
// BANKROLL
// ══════════════════════════════════════════════



// ══════════════════════════════════════════════
// TODAY'S MATCHES
// ══════════════════════════════════════════════




// ══════════════════════════════════════════════
// LIVE SCORES + AUTO-REFRESH
// ══════════════════════════════════════════════
let _minuterieDirect = null;

async function rafraichirProgramme() {
  programme.ts = 0;
  await chargerProgramme();
  majBadgeDirect();
}

function dessinerLive() {
  const el = document.getElementById('liveView');
  if (el) el.innerHTML = htmlLive(programme.matchs, { charge: programme.charge, maj: programme.ts, favoris: getFavs() });
}

async function demarrerDirect() {
  dessinerLive();
  await rafraichirProgramme();
  dessinerLive();
  arreterDirect();
  _minuterieDirect = setInterval(async () => { await rafraichirProgramme(); dessinerLive(); }, 120_000);
}
function arreterDirect() { if (_minuterieDirect) { clearInterval(_minuterieDirect); _minuterieDirect = null; } }

function majBadgeDirect() {
  const n = programme.matchs.filter(m => m.statut === 'LIVE').length;
  const b = document.getElementById('badgeDirect');
  if (b) { b.style.display = n ? '' : 'none'; document.getElementById('badgeDirectN').textContent = n; }
}

// ── Aujourd'hui ──
let _filtreJour = 'tous';
async function dessinerAujourdhui(recharger = false) {
  const el = document.getElementById('todayView');
  const dessiner = () => { if (el) el.innerHTML = htmlAujourdhui(programme.matchs, { charge: programme.charge, filtre: _filtreJour, favoris: getFavs() }); };
  dessiner();
  if (recharger || !programme.charge) { await chargerProgramme(); majBadgeDirect(); dessiner(); }
}
function filtrerAujourdhui(f) { _filtreJour = f; dessinerAujourdhui(); }

// ── Mes compétitions (favoris) ──
async function dessinerCompetitions(recharger = false) {
  const el = document.getElementById('alertsView');
  const etat = typeof Notification === 'undefined' ? 'denied' : Notification.permission;
  const dessiner = () => { if (el) el.innerHTML = htmlCompetitions(programme.matchs, { favoris: getFavs(), notifs: etat }); };
  dessiner();
  if (recharger && !programme.charge) { await chargerProgramme(); dessiner(); }
}
function basculerFavori(compet) {
  const f = getFavs(); const i = f.indexOf(compet);
  if (i >= 0) f.splice(i, 1); else f.push(compet);
  saveFavs(f); dessinerCompetitions(); dessinerAccueil();
}
async function activerNotifs() {
  if (typeof Notification === 'undefined') return;
  await Notification.requestPermission();
  dessinerCompetitions();
  notifierFavoris();
}

/** Prévient (une fois) des pronos et values publiés dans les compétitions suivies. */
function notifierFavoris() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const favs = new Set(getFavs());
  if (!favs.size) return;
  let vus;
  try { vus = new Set(JSON.parse(localStorage.getItem('ps_notifies') || '[]')); } catch { vus = new Set(); }
  const signaux = [
    ...(victorState.today?.pronostics || []).map(p => ({ cle: `v${p.id}`, compet: p.competition, titre: `${p.equipe_a} – ${p.equipe_b}`, corps: `Prono de Victor : ${p.pronostic_principal}${p.cote_estimee ? ` @ ${Number(p.cote_estimee).toFixed(2)}` : ''}` })),
    ...(valeursState.valeurs?.aujourdhui || []).map(v => ({ cle: `m${v.date}${v.match}${v.pari_code}`, compet: v.competition, titre: v.match, corps: `Value : ${v.libelle || v.pari_code} @ ${Number(v.cote).toFixed(2)} (${v.bookmaker})` })),
  ];
  for (const sgl of signaux) {
    if (!favs.has(sgl.compet) || vus.has(sgl.cle)) continue;
    vus.add(sgl.cle);
    try { new Notification(`PronoSight · ${sgl.titre}`, { body: sgl.corps, tag: sgl.cle }); } catch { /* navigateur sans notification */ }
  }
  try { localStorage.setItem('ps_notifies', JSON.stringify([...vus].slice(-200))); } catch { /* stockage plein */ }
}

// ── Mes paris ──
function lireParis() { try { return JSON.parse(localStorage.getItem('ps_paris') || '[]'); } catch { return []; } }
function ecrireParis(l) { localStorage.setItem('ps_paris', JSON.stringify(l)); majBadgeParis(); }
function bankrollDepart() {
  // Reprend la bankroll saisie dans l'ancienne version, si elle existe.
  const b = parseFloat(localStorage.getItem('ps_bankroll_depart') ?? localStorage.getItem('ps_bankroll'));
  return b > 0 ? b : null;
}
let _filtreParis = 'tous';

function majBadgeParis() {
  const n = lireParis().filter(p => p.resultat === 'attente').length;
  const b = document.getElementById('histBadge');
  if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
}

function dessinerMesParis() {
  const el = document.getElementById('historyView');
  if (!el) return;
  const paris = lireParis(), b0 = bankrollDepart();
  el.innerHTML = htmlMesParis(paris, bilanParis(paris, { bankrollInitiale: b0 }), { bankrollInitiale: b0, filtre: _filtreParis });
  dessinerCourbe(courbeBankroll(paris, b0));
}

function dessinerCourbe(points) {
  const canvas = document.getElementById('bkCanvas');
  if (!canvas) return;
  const W = canvas.offsetWidth || 320, H = canvas.offsetHeight || 140, dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.body);
  const coul = (v) => css.getPropertyValue(v).trim() || '#888';
  if (points.length < 2) {
    ctx.fillStyle = coul('--muted'); ctx.font = '600 13px Barlow, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('La courbe apparaît après ton premier pari réglé', W / 2, H / 2); return;
  }
  const min = Math.min(...points), max = Math.max(...points), ec = max - min || 1, pad = 12;
  const x = i => pad + (i / (points.length - 1)) * (W - 2 * pad);
  const y = v => pad + (1 - (v - min) / ec) * (H - 2 * pad);
  const hausse = points[points.length - 1] >= points[0];
  ctx.strokeStyle = coul('--border2'); ctx.setLineDash([4, 4]); ctx.beginPath();
  ctx.moveTo(pad, y(points[0])); ctx.lineTo(W - pad, y(points[0])); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = coul(hausse ? '--gagne' : '--perdu'); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.beginPath();
  points.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.stroke();
}

function definirBankroll() {
  const v = parseFloat(String(document.getElementById('bkInitial')?.value || '').replace(',', '.'));
  if (!(v > 0)) { alert('Entre un montant positif.'); return; }
  localStorage.setItem('ps_bankroll_depart', String(v));
  dessinerMesParis(); renderDashboard();
}
function filtrerParis(f) { _filtreParis = f; dessinerMesParis(); }
function reglerPari(id, resultat) {
  const l = lireParis(); const p = l.find(x => x.id === id);
  if (p) { p.resultat = resultat; ecrireParis(l); dessinerMesParis(); renderDashboard(); }
}
function supprimerPari(id) {
  if (!confirm('Supprimer ce pari ?')) return;
  ecrireParis(lireParis().filter(x => x.id !== id)); dessinerMesParis(); renderDashboard();
}
function effacerParis() {
  if (!confirm('Effacer tous tes paris ? C\'est définitif.')) return;
  ecrireParis([]); dessinerMesParis(); renderDashboard();
}
function exporterParis() {
  const url = URL.createObjectURL(new Blob([versCsv(lireParis())], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `pronosight-mes-paris-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/** Feuille « Je joue ce pari », pré-remplie avec ce que l'écran connaît déjà. */
/** Texte affichable → texte brut (les données Victor sont échappées au chargement). */
function brut(x) { const t = document.createElement('textarea'); t.innerHTML = String(x ?? ''); return t.value; }

/** « Je joue ce pari » depuis un prono de Victor, une value ou l'analyse en cours. */
function desassainir(v) {
  if (typeof v === 'string') return brut(v);
  if (Array.isArray(v)) return v.map(desassainir);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = desassainir(x); return o; }
  return v;
}

function jouerPari(source, i) {
  if (source === 'victor') {
    const p = victorState.today?.pronostics?.[i]; if (!p) return;
    ouvrirFormPari({ match: brut(`${p.equipe_a} – ${p.equipe_b}`), competition: brut(p.competition), pari: brut(p.pronostic_principal), cote: p.cote_estimee });
  } else if (source === 'value') {
    const v = valeursState.valeurs?.aujourdhui?.[i]; if (!v) return;
    ouvrirFormPari({ match: v.match.replace(/\s+vs\s+/i, ' – '), competition: v.competition, pari: v.libelle || v.pari_code, cote: v.cote });
  } else {
    const d = state.chatCtx; if (!d) return;
    ouvrirFormPari({ match: brut(`${d.team1} – ${d.team2}`), competition: brut(d.league), pari: brut(d.best_bet), cote: '' });
  }
}

function ouvrirFormPari({ match = '', competition = '', pari = '', cote = '' } = {}) {
  const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  val('fpMatch', match); val('fpPari', pari); val('fpCote', cote ? Number(cote).toFixed(2) : ''); val('fpCompet', competition);
  const b0 = bankrollDepart(), bilan = bilanParis(lireParis(), { bankrollInitiale: b0 });
  const conseil = bilan.bankroll ? Math.max(0.5, Math.round(bilan.bankroll * 0.01 * 2) / 2) : null;
  val('fpMise', conseil ?? '');
  document.getElementById('fpAide').textContent = conseil
    ? `Mise proposée : 1 % de ta bankroll (${bilan.bankroll.toFixed(0)} €). Modifie-la si besoin.`
    : 'Astuce : définis ta bankroll dans « Mes paris » pour une mise conseillée.';
  document.getElementById('fpErreur').textContent = '';
  document.getElementById('pariFeuille')?.classList.add('ouverte');
  document.getElementById('pariFond')?.classList.add('ouvert');
}
function fermerFormPari() {
  document.getElementById('pariFeuille')?.classList.remove('ouverte');
  document.getElementById('pariFond')?.classList.remove('ouvert');
}
function enregistrerPari() {
  const v = (id) => document.getElementById(id)?.value || '';
  const { pari, erreur } = creerPari({ match: v('fpMatch'), competition: v('fpCompet'), pari: v('fpPari'), cote: v('fpCote'), mise: v('fpMise') });
  if (erreur) { document.getElementById('fpErreur').textContent = erreur; return; }
  ecrireParis([pari, ...lireParis()]);
  fermerFormPari();
  renderDashboard();
  if (document.getElementById('historyView')?.classList.contains('visible')) dessinerMesParis();
  afficherToast('Pari enregistré dans « Mes paris »');
}
function afficherToast(texte) {
  document.getElementById('toastPs')?.remove();
  const t = document.createElement('div');
  t.id = 'toastPs'; t.className = 'toast-ps'; t.textContent = texte;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
}








// ══════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════





// ══════════════════════════════════════════════
// PARLAY BUILDER
// ══════════════════════════════════════════════
function addParlayLeg() {
  const legs = document.getElementById('parlayLegs');
  if (legs.children.length >= 10) { alert('10 sélections maximum'); return; }
  parlayCount++;
  const n = parlayCount, num = legs.children.length + 1;
  const div = document.createElement('div');
  div.className = 'parlay-leg'; div.id = 'pl' + n;
  div.innerHTML = `<div class="parlay-leg-header"><div class="parlay-leg-title">Sélection ${num}</div><button class="parlay-remove" onclick="document.getElementById('pl${n}').remove()" aria-label="Retirer">${icone('croix', { taille: 15 })}</button></div>
    <div class="parlay-inputs">
      <div class="parlay-field"><label>Match et pari</label><input class="parlay-input" id="pb${n}" placeholder="Lens gagne contre Lille"></div>
      <div class="parlay-field"><label>Cote</label><input class="parlay-input" type="number" step="0.01" min="1.01" inputmode="decimal" id="po${n}" placeholder="1,85"></div>
      <div class="parlay-field"><label>Ta proba % (facultatif)</label><input class="parlay-input" type="number" min="1" max="99" inputmode="numeric" id="pp${n}" placeholder="55"></div>
    </div>`;
  legs.appendChild(div);
}

function calcParlay() {
  const legs = [...document.querySelectorAll('.parlay-leg')].map(leg => {
    const n = leg.id.replace('pl', '');
    return { cote: parseFloat(document.getElementById('po' + n)?.value) || 0, proba: parseFloat(document.getElementById('pp' + n)?.value) || 0 };
  }).filter(l => l.cote > 1);
  if (legs.length < 2) { alert('Entre au moins deux cotes.'); return; }
  const mise = parseFloat(document.getElementById('parlayStake').value) || 0;
  const cote = legs.reduce((a, l) => a * l.cote, 1);
  // La valeur n'a de sens que si CHAQUE sélection a une probabilité : avant,
  // les sélections sans proba comptaient pour 100 %, et l'EV était faux.
  const toutes = legs.every(l => l.proba > 0 && l.proba < 100);
  const proba = toutes ? legs.reduce((a, l) => a * l.proba / 100, 1) : null;
  const ev = proba != null ? proba * cote - 1 : null;
  const marge = legs.length; // chaque sélection paie sa marge
  const res = document.getElementById('parlayResult');
  res.style.display = 'block';
  const ligne = (lib, val, cls = '') => `<div class="parlay-result-row"><div class="parlay-result-label">${lib}</div><div class="parlay-result-val ${cls}">${val}</div></div>`;
  res.innerHTML = `<div class="an-carte" style="margin-top:14px">
    ${ligne('Cote totale', cote.toFixed(2))}
    ${mise > 0 ? ligne('Gain si tout passe', `${(mise * cote).toFixed(2).replace('.', ',')} €`) : ''}
    ${proba != null ? ligne('Chances que tout passe', `${(proba * 100).toFixed(1).replace('.', ',')} %`) : ''}
    ${ev != null ? ligne('Valeur espérée', `${ev >= 0 ? '+' : '−'}${Math.abs(ev * 100).toFixed(1).replace('.', ',')} %`, ev >= 0 ? 'pos' : 'neg') : ''}
    <div class="vm-note">${proba == null ? 'Indique ta probabilité pour chaque sélection pour obtenir la valeur espérée. ' : ''}${marge} sélections : la marge du bookmaker est payée ${marge} fois.</div>
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

// Victor peut retourner : "Élevée", "Forte", "Très forte", "Moyenne", "Faible", "N/A"
// → normalise en 3 niveaux pour les couleurs/scores
function _confColor(conf) {
  if (!conf) return '#ff6644';
  const c = conf.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (c.includes('tres') || c.includes('tres') || c === 'forte' || c.includes('elev')) return '#00dd55';
  if (c.includes('moy')) return '#ffcc00';
  return '#ff6644';
}
function _confNum(conf) {
  if (!conf) return 50;
  const c = conf.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (c.includes('tres') || c === 'forte et tres forte') return 90;
  if (c === 'forte' || c.includes('elev')) return 80;
  if (c.includes('moy')) return 65;
  return 50;
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
    if (victorState.loadError) {
      container.innerHTML = `<div class="card" style="text-align:center;padding:30px;color:#ff6644">
        ⚠️ Serveur inaccessible —
        <button onclick="victorState.loadError=false;renderPronoVictor()" style="margin-left:8px;padding:4px 12px;border-radius:6px;background:var(--accent);border:none;color:var(--sur-accent,#000);cursor:pointer">↻ Réessayer</button>
      </div>`;
    } else {
      container.innerHTML = `<div class="card"><div style="text-align:center;padding:40px;color:var(--muted)">
        <div style="font-size:32px">🎙️</div>
        <div style="margin-top:10px;font-weight:700;color:var(--text2)">Chargement des pronostics Victor...</div>
      </div></div>`;
      loadVictorData().then(() => renderPronoVictor());
    }
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

  const barreSports = document.getElementById('pronoSportTabs');
  if (barreSports) barreSports.style.display = allPicks.length ? '' : 'none';
  if (!allPicks.length) {
    const h = new Date().getHours();
    const nextRun = h < 7 ? '07h00' : h < 13 ? '13h00' : '07h00 demain';
    // Le bouton « Forcer l'analyse » est une commande d'administration :
    // il déclenche un run complet (crédits IA + cotes). Réservé à l'admin.
    const estAdmin = !!localStorage.getItem('ps_admin_key');
    container.innerHTML = `<div class="card">
      <div class="etat-vide">
        <div class="etat-vide-icone">${icone('micro')}</div>
        <div class="etat-vide-titre">Aucune analyse pour aujourd'hui</div>
        <div class="etat-vide-texte">
          Victor étudie les matchs chaque matin à 7h. Il ne publie un pronostic que
          lorsque les chiffres lui donnent un avantage réel — les jours sans, il se tait.
          <br><br>Prochaine analyse à <strong style="color:var(--text2)">${nextRun}</strong>.
        </div>
        ${estAdmin ? `<button class="dash-cta" style="margin-top:18px" onclick="forceVictorRefresh()">Forcer l'analyse</button>` : ''}
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

  const headerHtml = `<div class="victor-tete">
    <div class="victor-resume">
      <strong>${allPicks.length}</strong> analyse${allPicks.length > 1 ? 's' : ''} retenue${allPicks.length > 1 ? 's' : ''} aujourd'hui
      ${updateTime ? `<span class="victor-maj">mise à jour à ${updateTime}</span>` : ''}
    </div>
    <button class="victor-actualiser" onclick="refreshPronoVictor()">${icone('rafraichir', { taille: 16 })}Actualiser</button>
  </div>`;

  if (!filtered.length) {
    container.innerHTML = headerHtml + `<div class="card"><div style="text-align:center;padding:30px;color:var(--muted);font-size:13px">
      Aucun pronostic pour ce sport aujourd'hui.
    </div></div>`;
    return;
  }

  // Un filtre de sport sans aucun prono ne sert à rien : on le masque.
  document.querySelectorAll('#pronoSportTabs .tab[data-psport]').forEach(b => {
    const sp = b.dataset.psport;
    b.style.display = sp === 'all' || allPicks.some(p => _normalizeSport(p.sport) === sp) ? '' : 'none';
  });

  const groupsHtml = Object.entries(bySport).map(([sportKey, { label, picks }]) => {
    // Grouper par compétition dans chaque sport
    const byComp = {};
    picks.forEach(p => {
      const comp = p.competition || 'Autre';
      if (!byComp[comp]) byComp[comp] = [];
      byComp[comp].push(p);
    });

    const compsHtml = Object.entries(byComp).map(([comp, cPicks]) => {
      const picksHtml = cPicks.map(p => {
        const confColor = _confColor(p.confiance);
        const confBg    = confColor === '#00dd55' ? 'rgba(0,221,85,.12)' : confColor === '#ffcc00' ? 'rgba(255,204,0,.12)' : 'rgba(255,102,68,.12)';
        // Niveau de confiance en classe plutôt qu'en couleur codée en dur :
        // le thème clair peut ainsi adapter les teintes.
        const nConf = _confNum(p.confiance);
        const clsConf = nConf >= 80 ? 'haute' : nConf >= 50 ? 'moyenne' : 'basse';
        const segs = clsConf === 'haute' ? 3 : clsConf === 'moyenne' ? 2 : 1;
        const cote = parseFloat(p.cote_estimee);
        return `<div class="pick">
          <div class="pick-ligne-haut">
            <span class="jauge ${clsConf}"><span class="jauge-segs">${[1, 2, 3].map(k => `<i class="${k <= segs ? 'on' : ''}"></i>`).join('')}</span>Confiance ${(p.confiance || '').toLowerCase()}</span>
            ${p.heure ? `<span class="pick-heure-puce">${p.heure}</span>` : ''}
          </div>
          <div class="affiche">
            <div class="affiche-equipe">${ecusson(p.equipe_a || '')}<span class="affiche-nom">${p.equipe_a || ''}</span></div>
            <div class="affiche-centre">VS</div>
            <div class="affiche-equipe ext">${ecusson(p.equipe_b || '')}<span class="affiche-nom">${p.equipe_b || ''}</span></div>
          </div>

          <div class="pick-pari">
            <span><span class="pick-pari-type">Le pari de Victor</span><span class="pick-pari-libelle">${p.pronostic_principal || ''}</span></span>
            ${Number.isFinite(cote) ? `<span class="cote-puce retenue"><span>${p.cote_confirmee ? 'Cote' : 'Cote est.'}</span><b>${cote.toFixed(2)}</b></span>` : ''}
          </div>

          <button class="bouton-jouer" onclick="jouerPari('victor', ${allPicks.indexOf(p)})">${icone('portefeuille', { taille: 16 })}Je joue ce pari</button>

          <div class="pick-lignes">
            ${p.value_bet && p.value_bet !== 'aucun' ? `<div class="pick-ligne value"><span>Value</span> ${p.value_bet}${p.cote_value ? ` · ${parseFloat(p.cote_value).toFixed(2)}` : ''}</div>` : ''}
            ${p.score_predit ? `<div class="pick-ligne"><span>Score envisagé</span> ${p.score_predit}</div>` : ''}
            ${p.enjeu ? `<div class="pick-ligne"><span>Enjeu</span> ${p.enjeu.slice(0, 90)}</div>` : ''}
            ${p.pari_a_eviter ? `<div class="pick-ligne eviter"><span>À éviter</span> ${p.pari_a_eviter}</div>` : ''}
          </div>

          ${p.phrase_signature ? `<div class="pick-mot">${p.phrase_signature}</div>` : ''}
        </div>`;
      }).join('');

      return `<div class="pick-groupe">
        <div class="pick-compet">${comp}</div>
        ${picksHtml}
      </div>`;
    }).join('');

    return `<div class="card">
      <div class="pick-sport">${iconeSport(label)} ${label} <span>${picks.length}</span></div>
      ${compsHtml}
    </div>`;
  }).join('');

  container.innerHTML = headerHtml + groupsHtml;
}

async function forceVictorRefresh() {
  // ⚠️ La clé était écrite en dur ici, donc servie à TOUS les visiteurs.
  // Elle protège /api/victor/refresh, /admin/queues ET toute l'API Nexus
  // (nexus/routes.js retombe sur VICTOR_API_KEY faute de NEXUS_API_KEY).
  // Elle vit désormais dans le localStorage de l'administrateur uniquement :
  //   localStorage.setItem('ps_admin_key', '<clé>')
  const apiKey = localStorage.getItem('ps_admin_key');
  if (!apiKey) {
    alert("Action réservée à l'administration.");
    return;
  }
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
  const dejaCharge = victorState.loaded;
  try {
    const [todayRes, statsRes, patternsRes, historyRes] = await Promise.all([
      fetch('/api/victor/today',        { signal }).then(r => r.json()),
      fetch('/api/victor/stats',        { signal }).then(r => r.json()),
      fetch('/api/victor/patterns',     { signal }).then(r => r.json()),
      fetch('/api/victor/history?days=30', { signal }).then(r => r.json())
    ]);
    // Textes écrits par l'IA et noms venus des API : échappés avant tout rendu.
    victorState.today       = assainir(todayRes);
    victorState.stats       = assainir(statsRes);
    victorState.patterns    = assainir(patternsRes);
    victorState.history     = assainir(historyRes);
    victorState.loaded      = true;
    victorState.lastUpdated = new Date();
    victorLastFetch         = Date.now();
    const newTotal = todayRes?.total || 0;
    // « Nouveaux » seulement s'ils arrivent pendant la visite, pas au premier chargement.
    if (dejaCharge && prevTotal === 0 && newTotal > 0) showVictorUpdateNotif(newTotal);
  } catch(e) {
    if (e.name !== 'AbortError') {
      console.warn('[Victor] Données indisponibles:', e.message);
      victorState.loadError = true;
    }
  } finally {
    victorState.loading = false;
  }
}

function showVictorUpdateNotif(count) {
  // Supprime une notif existante
  document.getElementById('victorNotif')?.remove();
  const notif = document.createElement('div');
  notif.id = 'victorNotif';
  notif.style.cssText = 'position:fixed;bottom:calc(92px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:var(--volt);color:var(--sur-volt);padding:11px 20px;border-radius:30px;font-size:14px;font-weight:800;font-family:var(--ui);z-index:9999;cursor:pointer;box-shadow:0 12px 30px -10px rgba(0,0,0,.7);white-space:nowrap';
  notif.textContent = `${count} nouveau${count > 1 ? "x" : ""} prono${count > 1 ? "s" : ""} de Victor disponible${count > 1 ? "s" : ""}`;
  notif.onclick = () => { switchNav('prono'); notif.remove(); };
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 8000);
}
window.showVictorUpdateNotif = showVictorUpdateNotif;


async function renderVictorView() {
  const el = document.getElementById('victorView');
  if (!el) return;
  const dessiner = () => {
    // victorState est échappé au chargement ; htmlVictor échappe lui-même :
    // on lui rend le texte brut pour ne pas l'échapper deux fois.
    const p = victorState.patterns || {};
    el.innerHTML = htmlVictor(desassainir({
      stats: victorState.stats, bilan: valeursState.bilan,
      patterns: p.forts?.length ? p.forts : (p.moyens || []),
      historique: victorState.history?.pronostics || [], aujourdhui: victorState.today?.total || 0,
    }));
  };
  dessiner();
  await Promise.all([loadVictorData(), loadValeurs()]);
  dessiner();
}

async function refreshVictorView() {
  victorLastFetch = 0; // force le prochain fetch
  await loadVictorData({ force: true });
  renderVictorView();
}
window.refreshVictorView = refreshVictorView;


// ══════════════════════════════════════════════
// QUICK PICK
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
// COMBOS AUTO
// ══════════════════════════════════════════════

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
window.switchNav = switchNav;
window.ouvrirPlus = ouvrirPlus;
window.fermerPlus = fermerPlus;
window.rechargerValeurs = rechargerValeurs;
window.analyserDepuisAccueil = analyserDepuisAccueil;
Object.assign(window, {
  filtrerAujourdhui, basculerFavori, activerNotifs, definirBankroll, filtrerParis, reglerPari, supprimerPari,
  effacerParis, exporterParis, ouvrirFormPari, fermerFormPari, enregistrerPari, choisirCompet, saisieLibre, jouerPari,
});
window.ouvrirAnalyseLibre = ouvrirAnalyseLibre;
window.switchPronoMode = switchPronoMode;
window.analyze = analyze;
window.resetToStart = resetToStart;
window.addParlayLeg = addParlayLeg;
window.calcParlay = calcParlay;
window.toggleTheme = toggleTheme;
window.installPWA = installPWA;

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


async function shareAnalysis() {
  // L'analyse affichée, telle quelle : pas l'historique, qui mélangeait les analyses.
  const d = state.chatCtx;
  if (!d) return;
  const t = (x) => brut(x);
  const W = 600, H = 340, dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0b1a12'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c8f31d'; ctx.fillRect(0, 0, W, 6);
  ctx.font = '800 22px "Barlow Condensed", sans-serif'; ctx.fillStyle = '#f2f5f1'; ctx.fillText('PRONO', 24, 40);
  ctx.fillStyle = '#c8f31d'; ctx.fillText('SIGHT', 24 + ctx.measureText('PRONO').width, 40);
  ctx.font = '700 14px Barlow, sans-serif'; ctx.fillStyle = '#9fb3a6'; ctx.fillText(t(d.league).toUpperCase(), 24, 66);
  ctx.font = '800 30px "Barlow Condensed", sans-serif'; ctx.fillStyle = '#ffffff'; ctx.fillText(`${t(d.team1)}  –  ${t(d.team2)}`.toUpperCase(), 24, 108);
  ctx.font = '700 13px Barlow, sans-serif'; ctx.fillStyle = '#9fb3a6'; ctx.fillText('LE VERDICT', 24, 148);
  ctx.font = '800 26px "Barlow Condensed", sans-serif'; ctx.fillStyle = '#c8f31d'; ctx.fillText(t(d.best_bet).toUpperCase(), 24, 178);
  if (d.proba_source === 'marche') {
    const issues = [['1', d.proba_home], ...(d.sport === 'basketball' ? [] : [['N', d.proba_draw]]), ['2', d.proba_away]];
    issues.forEach(([lib, p], i) => {
      const x = 24 + i * 120;
      ctx.font = '700 13px Barlow, sans-serif'; ctx.fillStyle = '#9fb3a6'; ctx.fillText(lib, x, 216);
      ctx.font = '800 30px "Barlow Condensed", sans-serif'; ctx.fillStyle = '#ffffff'; ctx.fillText(`${p} %`, x, 248);
      ctx.font = '600 12px Barlow, sans-serif'; ctx.fillStyle = '#9fb3a6'; ctx.fillText(`cote juste ${(100 / p).toFixed(2)}`, x, 266);
    });
    ctx.font = '600 12px Barlow, sans-serif'; ctx.fillStyle = '#9fb3a6';
    ctx.fillText('Probabilités tirées des cotes réelles, marge des bookmakers retirée.', 24, 296);
  }
  ctx.font = '600 11px Barlow, sans-serif'; ctx.fillStyle = '#6f8577';
  ctx.fillText(`${new Date().toLocaleDateString('fr-FR')} · ${location.host} · 18+ · Jouer comporte des risques : 09 74 75 13 13`, 24, 324);

  canvas.toBlob(async blob => {
    const file = new File([blob], 'pronosight-analyse.png', { type: 'image/png' });
    const donnees = { title: `PronoSight — ${t(d.team1)} – ${t(d.team2)}`, text: `${t(d.best_bet)} · PronoSight`, files: [file] };
    const telecharger = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'pronosight-analyse.png'; a.click();
      URL.revokeObjectURL(url);
    };
    try {
      if (navigator.canShare && navigator.canShare(donnees)) await navigator.share(donnees);
      else telecharger();
    } catch (e) { if (e.name !== 'AbortError') telecharger(); }
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
