// ══════════════════════════════════════════════
// state.js — Global State Management
// ══════════════════════════════════════════════

import { CACHE_TTL, ANALYSIS_CACHE_TTL } from './config.js';

// ── App State ──
export const state = {
  currentSport: 'football',
  selectedLeague: null,
  selectedMatch: null,
  currentCat: 'all',
  filterText: '',
  chatCtx: null,
  chatHistory: [],
  matches: [],        // current displayed matches
  todayData: [],
  todayFilter: 'all',
  todayLoaded: false,
  liveData: [],
  liveFilter: 'all',
  liveCountdown: 60,
  comboStore: {},      // combo legs cache
  parlayCount: 0,
  apiStatus: null      // from /api/status
};

// ── Match Cache (memory) ──
export const MATCH_CACHE = {};

// ── Analysis Cache (localStorage) ──
export function analysisCacheKey(t1, t2, league) {
  return 'ps_analysis_' + (t1 + t2 + league).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getCachedAnalysis(t1, t2, league) {
  try {
    const k = analysisCacheKey(t1, t2, league);
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > ANALYSIS_CACHE_TTL) { localStorage.removeItem(k); return null; }
    return obj.data;
  } catch { return null; }
}

export function setCachedAnalysis(t1, t2, league, data) {
  try {
    const k = analysisCacheKey(t1, t2, league);
    localStorage.setItem(k, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* storage full */ }
}

export function clearOldCaches() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('ps_analysis_'))
      .forEach(k => {
        try {
          const obj = JSON.parse(localStorage.getItem(k));
          if (Date.now() - obj.ts > ANALYSIS_CACHE_TTL) localStorage.removeItem(k);
        } catch { localStorage.removeItem(k); }
      });
  } catch { /* ignore */ }
}

// ── History ──
export function getHist() {
  try { return JSON.parse(localStorage.getItem('ps_hist') || '[]'); }
  catch { return []; }
}
export function saveHist(h) { localStorage.setItem('ps_hist', JSON.stringify(h)); }

// ── Favorites ──
export function getFavs() {
  try { return JSON.parse(localStorage.getItem('ps_favs') || '[]'); }
  catch { return []; }
}
export function saveFavs(f) { localStorage.setItem('ps_favs', JSON.stringify(f)); }

// ── Bankroll ──
export function getBankrollData() {
  try { return JSON.parse(localStorage.getItem('ps_bankroll_data') || '{}'); }
  catch { return {}; }
}
export function saveBankrollData(d) { localStorage.setItem('ps_bankroll_data', JSON.stringify(d)); }
