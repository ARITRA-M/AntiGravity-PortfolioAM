// Tab IDs
const tabIds = ['overview', 'stocks', 'mfs', 'growth', 'fixed-income', 'nps', 'monthly', 'update-log'];

// App version for cache busting - bump this date when new portfolio data is uploaded
const APP_VERSION = '2026-06-07';

// Global state
let portfolioSummary = null;
let breakupSummary = null;
let latestEquity = null;
let latestMf = null;
let historicalHoldings = null;
let uploadedSnapshot = null;
// Use window.lastRefreshReport for cross-file consistency.
// api.js sets window.lastRefreshReport after a live price refresh.
// This let declaration ensures it's available in app.js's scope as well.
let lastRefreshReport = null;
// Also expose on window so api.js (which loads before app.js) can set it reliably
window.lastRefreshReport = null;

// Chart references
let allocationChart = null;
let componentXirrChart = null;
let allocationShiftChart = null;
let netWorthGrowthChart = null;
let capitalVsValuationChart = null;
let sectorChart = null;
let mfCategoryChart = null;
let mfValuationChart = null;
let stockHistoricalChart = null;
let mfHistoricalChart = null;
let benchmarkComparisonChart = null;
let rollingReturnsChart = null;
// Table sorting state
let stockSortColumn = -1;
let stockSortAsc = true;
let mfSortColumn = -1;
let mfSortAsc = true;
// Overview table sorting state — default sort by Gain (col 5) high-to-low
let dailyOverviewSortCol = 5;
let dailyOverviewSortAsc = false;
let monthlyOverviewSortCol = 5;
let monthlyOverviewSortAsc = false;

// Overview type filter state ('all', 'stock', 'mf')
let dailyTypeFilter = 'all';
let monthlyTypeFilter = 'all';

// Stock name lookup cache (for daily overview table)
let _stockNameLookup = null;

// Benchmark data (simulated historical data for comparison)
const benchmarkData = {
  nifty50: {
    name: 'Nifty 50 (simulated)',
    history: [] // Will be generated based on portfolio dates
  },
  sensex: {
    name: 'Sensex (simulated)',
    history: []
  },
  spx: {
    name: 'S&P 500 (simulated)',
    history: []
  },
  gold: {
    name: 'Gold (simulated)',
    history: []
  }
};

// Deterministic daily Sensex simulation (for overview KPI cards).
// Uses sine-based noise seeded by day-of-year so the same day always returns the same value.
function getSimulatedSensexDailyChangePct(forDate) {
  // Use the last completed trading day when called without arguments
  // (i.e. from renderDailyOverviewTable before market open).
  // When forDate is explicitly provided, use that date directly.
  const src = forDate || new Date();
  let targetDate;
  if (!forDate) {
    targetDate = new Date(src);
    const dow = targetDate.getDay();
    if (dow === 0) {          // Sunday   → previous Friday
      targetDate.setDate(targetDate.getDate() - 2);
    } else if (dow === 1) {   // Monday   → previous Friday
      targetDate.setDate(targetDate.getDate() - 3);
    } else if (dow === 6) {   // Saturday → previous Friday
      targetDate.setDate(targetDate.getDate() - 1);
    } else {                   // Tue–Fri  → previous calendar day
      targetDate.setDate(targetDate.getDate() - 1);
    }
  } else {
    targetDate = new Date(src);
  }
  const startOfYear = new Date(targetDate.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((targetDate - startOfYear) / (1000 * 60 * 60 * 24));
  const noise = Math.sin(dayOfYear * 0.7 + targetDate.getFullYear() * 1.3) * 0.5; // ±0.5% noise
  const drift = 0.047; // ~12% annual drift ≈ 0.047% per trading day
  return drift + noise;
}

// ── Real Sensex daily + monthly change (fetched from Yahoo Finance via server proxy) ──
let _sensexDailyPctReal = null;
// Pre-seed from localStorage snapshot so the first render has a value immediately
let _sensexMonthlyPctReal = (() => {
  try {
    const raw = localStorage.getItem('ag_portfolio_sensex_monthly_snapshot');
    const snap = raw ? JSON.parse(raw) : null;
    return snap?.monthlyChangePct ?? null;
  } catch { return null; }
})();

const SENSEX_SNAPSHOT_KEY = 'ag_portfolio_sensex_snapshot';
const SENSEX_MONTHLY_SNAPSHOT_KEY = 'ag_portfolio_sensex_monthly_snapshot';

function loadSensexSnapshot() {
  try {
    const raw = localStorage.getItem(SENSEX_SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSensexSnapshot(data) {
  try {
    localStorage.setItem(SENSEX_SNAPSHOT_KEY, JSON.stringify(data));
  } catch { /* localStorage may be full */ }
}

function loadSensexMonthlySnapshot() {
  try {
    const raw = localStorage.getItem(SENSEX_MONTHLY_SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSensexMonthlySnapshot(data) {
  try {
    localStorage.setItem(SENSEX_MONTHLY_SNAPSHOT_KEY, JSON.stringify(data));
  } catch { /* localStorage may be full */ }
}

async function fetchSensexDailyChange() {
  try {
    let data;
    if (window.__staticMode) {
      const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN';
      const res = await fetchViaCorsProxy(yahooUrl, {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const r = raw?.chart?.result?.[0];
      if (!r?.meta?.regularMarketPrice || !r?.meta?.chartPreviousClose) throw new Error('Incomplete data');
      const price = r.meta.regularMarketPrice;
      const prevClose = r.meta.chartPreviousClose;
      data = { dailyChangePct: ((price - prevClose) / prevClose) * 100, price, prevClose };
    } else {
      const res = await fetch('/api/sensex-daily-change');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    }
    if (data && data.dailyChangePct != null) {
      _sensexDailyPctReal = data.dailyChangePct;
      saveSensexSnapshot({ dailyChangePct: data.dailyChangePct, price: data.price, prevClose: data.prevClose, timestamp: Date.now() });
      return data.dailyChangePct;
    }
    throw new Error('Invalid response');
  } catch {
    const snap = loadSensexSnapshot();
    if (snap && snap.dailyChangePct != null) {
      _sensexDailyPctReal = snap.dailyChangePct;
      return snap.dailyChangePct;
    }
    return null;
  }
}

async function fetchSensexMonthlyChange() {
  try {
    let data;
    if (window.__staticMode) {
      const now = new Date();
      const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const period1 = Math.floor((monthStartMs - 15 * 24 * 60 * 60 * 1000) / 1000);
      const period2 = Math.floor(now.getTime() / 1000);
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?period1=${period1}&period2=${period2}&interval=1d`;
      const res = await fetchViaCorsProxy(yahooUrl, {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const r = raw?.chart?.result?.[0];
      const closes = r?.indicators?.quote?.[0]?.close;
      const timestamps = r?.timestamp;
      const currentPrice = r?.meta?.regularMarketPrice;
      if (!closes || !timestamps || !currentPrice) throw new Error('Incomplete data');
      let monthStartClose = null;
      for (let i = 0; i < timestamps.length; i++) {
        if (timestamps[i] * 1000 < monthStartMs && closes[i] != null) monthStartClose = closes[i];
      }
      if (!monthStartClose) throw new Error('No previous-month close found');
      data = { monthlyChangePct: ((currentPrice - monthStartClose) / monthStartClose) * 100 };
    } else {
      const res = await fetch('/api/sensex-monthly-change');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    }
    if (data && data.monthlyChangePct != null) {
      _sensexMonthlyPctReal = data.monthlyChangePct;
      saveSensexMonthlySnapshot({ monthlyChangePct: data.monthlyChangePct, timestamp: Date.now() });
      return data.monthlyChangePct;
    }
    throw new Error('Invalid response');
  } catch {
    const snap = loadSensexMonthlySnapshot();
    if (snap && snap.monthlyChangePct != null) {
      _sensexMonthlyPctReal = snap.monthlyChangePct;
      return snap.monthlyChangePct;
    }
    return null;
  }
}

const SECTOR_MAP = {
  AJANTPHARM: 'Pharmaceuticals', CIPLA: 'Pharmaceuticals', DRREDDY: 'Pharmaceuticals', ERIS: 'Pharmaceuticals',
  JBCHEPHARM: 'Pharmaceuticals', LALPATHLAB: 'Healthcare & Diagnostics', MANKIND: 'Pharmaceuticals',
  SUNPHARMA: 'Pharmaceuticals', SYNGENE: 'Biotechnology', ZYDUSLIFE: 'Pharmaceuticals',
  APOLLOTYRE: 'Automobile & Ancillaries', 'BAJAJ-AUTO': 'Automobile & Ancillaries',
  BALKRISIND: 'Automobile & Ancillaries', EICHERMOT: 'Automobile & Ancillaries',
  ENDURANCE: 'Automobile & Ancillaries', EXIDEIND: 'Automobile & Ancillaries',
  HEROMOTOCO: 'Automobile & Ancillaries', 'M&M': 'Automobile & Ancillaries',
  MOTHERSON: 'Automobile & Ancillaries', TVSMOTOR: 'Automobile & Ancillaries',
  UNOMINDA: 'Automobile & Ancillaries', AXISBANK: 'Banking & Financial Services',
  BAJFINANCE: 'Banking & Financial Services', BANKBARODA: 'Banking & Financial Services',
  BANKIETF: 'Banking & Financial Services (ETF)', FEDERALBNK: 'Banking & Financial Services',
  HDFCBANK: 'Banking & Financial Services', HDFCLIFE: 'Insurance', ICICIBANK: 'Banking & Financial Services',
  ICICIGI: 'Insurance', ICICIPRULI: 'Insurance', KARURVYSYA: 'Banking & Financial Services',
  KOTAKBANK: 'Banking & Financial Services', MFSL: 'Banking & Financial Services',
  SBILIFE: 'Insurance', SBIN: 'Banking & Financial Services', BRIGADE: 'Real Estate & Construction',
  DLF: 'Real Estate & Construction', 'EMBASSY-RR': 'Real Estate (REIT)', GODREJPROP: 'Real Estate & Construction',
  'MINDSPACE-RR': 'Real Estate (REIT)', 'NXST-RR': 'Real Estate (REIT)', OBEROIRLTY: 'Real Estate & Construction',
  PHOENIXLTD: 'Real Estate & Construction', PRESTIGE: 'Real Estate & Construction',
  BRITANNIA: 'Consumer Goods & FMCG', COLPAL: 'Consumer Goods & FMCG',
  FMCGIETF: 'Consumer Goods & FMCG (ETF)', ITC: 'Consumer Goods & FMCG', MARICO: 'Consumer Goods & FMCG',
  NESTLEIND: 'Consumer Goods & FMCG', TATACONSUM: 'Consumer Goods & FMCG', VBL: 'Consumer Goods & FMCG',
  COFORGE: 'IT & Software Services', HCLTECH: 'IT & Software Services', INFY: 'IT & Software Services',
  KPITTECH: 'IT & Software Services', MPHASIS: 'IT & Software Services', OFSS: 'IT & Software Services',
  PERSISTENT: 'IT & Software Services', TCS: 'IT & Software Services', BHARTIARTL: 'Telecommunication Services',
  CIEINDIA: 'Industrial Engineering', COALINDIA: 'Energy & Mining', LT: 'Engineering & Construction',
  ONGC: 'Energy & Mining', PIDILITIND: 'Chemicals & Adhesives', SIEMENS: 'Industrial Engineering',
  TATASTEEL: 'Metals & Mining', GOLDBEES: 'Gold Commodity (ETF)', SGBAUG28V: 'Sovereign Gold Bonds',
  'SGBJUL28IV-GB': 'Sovereign Gold Bonds', 'SGBSEP28VI-GB': 'Sovereign Gold Bonds',
  '716GS2050-GS': 'Government Bonds', '738REC27TF': 'Corporate Bonds', TVSMNCRPS: 'Debt Instrument',
  ENRIN: 'Industrial Engineering'
};

window.addEventListener('DOMContentLoaded', () => {
  initPortfolioUpload();
  // Kick off Sensex fetch; once resolved the overview tabs will re-render
  fetchSensexDailyChange().then(() => {
    const dailySummaryEl = document.getElementById('daily-summary-kpis');
    if (dailySummaryEl && dailySummaryEl.offsetParent !== null) {
      renderDailyOverviewTable();
    }
  });
  fetchSensexMonthlyChange().then(() => {
    if (latestEquity) renderMonthlyOverviewTable();
  });
});

// ── localStorage persistence helpers ────────────────────────────────────
const LS_PREFIX = 'ag_portfolio_';
// breakup_summary is intentionally excluded — it is always fetched fresh from the server
// to prevent baseline corruption from in-memory live-price mutations being persisted.
const LS_KEYS = ['portfolio_summary', 'latest_equity', 'latest_mf', 'historical_holdings'];

function saveToLocalStorage(summary, _breakup, equity, mf, hist) {
  try {
    localStorage.setItem(LS_PREFIX + 'portfolio_summary', JSON.stringify(summary));
    localStorage.setItem(LS_PREFIX + 'latest_equity', JSON.stringify(equity));
    localStorage.setItem(LS_PREFIX + 'latest_mf', JSON.stringify(mf));
    localStorage.setItem(LS_PREFIX + 'historical_holdings', JSON.stringify(hist));
    localStorage.setItem(LS_PREFIX + 'version', APP_VERSION);
    console.log('Portfolio data saved to localStorage (version:', APP_VERSION + ')');
  } catch (e) {
    console.warn('Failed to save portfolio data to localStorage:', e);
  }
}

// Called after a live price refresh — saves updated prices only.
function saveRefreshedPrices(equity, mf) {
  try {
    localStorage.setItem(LS_PREFIX + 'latest_equity', JSON.stringify(equity));
    localStorage.setItem(LS_PREFIX + 'latest_mf', JSON.stringify(mf));
    console.log('Refreshed prices saved to localStorage');
  } catch (e) {
    console.warn('Failed to save refreshed prices to localStorage:', e);
  }
}

function loadFromLocalStorage() {
  try {
    const version = localStorage.getItem(LS_PREFIX + 'version');
    if (!version) return null;
    const data = {};
    for (const key of LS_KEYS) {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (!raw) return null;
      data[key] = JSON.parse(raw);
    }
    console.log('Portfolio data loaded from localStorage (version:', version + ')');
    return {
      portfolioSummary: data['portfolio_summary'],
      latestEquity: data['latest_equity'],
      latestMf: data['latest_mf'],
      historicalHoldings: data['historical_holdings']
    };
  } catch (e) {
    console.warn('Failed to load portfolio data from localStorage:', e);
    return null;
  }
}

function clearLocalStorageData() {
  try {
    for (const key of LS_KEYS) {
      localStorage.removeItem(LS_PREFIX + key);
    }
    // Also clear any stale breakup_summary that may exist from before this fix
    localStorage.removeItem(LS_PREFIX + 'breakup_summary');
    localStorage.removeItem(LS_PREFIX + 'version');
    console.log('Portfolio data cleared from localStorage');
  } catch (e) {
    console.warn('Failed to clear localStorage:', e);
  }
}

// ── One-click "Commit" (saves data, bumps versions, git push) ──────────
async function commitData() {
  const btn = document.getElementById('commit-btn');
  const status = document.getElementById('upload-status');
  if (!portfolioSummary) {
    if (status) status.textContent = '⚠️ No data to commit. Upload an Excel file first.';
    return;
  }
  // Only works on localhost where server.js is running
  if (!window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1')) {
    if (status) status.textContent = '⚠️ Commit only works on the local machine (localhost).';
    return;
  }
  // Commit (git push) needs the backend; static mode has no /api endpoint.
  if (window.__staticMode) {
    if (status) status.textContent = '⚠️ Commit needs the backend — run "npm run dev" instead of "npm run static".';
    return;
  }
  try {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Committing...'; }
    if (status) status.textContent = 'Committing to GitHub...';

    // Encrypt every file before it touches disk / GitHub — the repo is
    // public, so plaintext must never be committed once encryption is on.
    const payload = {
      portfolio_summary: portfolioSummary,
      breakup_summary: breakupSummary,
      latest_equity: latestEquity,
      latest_mf: latestMf,
      historical_holdings: historicalHoldings
    };
    if (typeof PortfolioCrypto !== 'undefined' && await PortfolioCrypto.hasKey()) {
      for (const k of Object.keys(payload)) {
        payload[k] = await PortfolioCrypto.encryptObject(payload[k]);
      }
    }

    const res = await fetch('/api/commit-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (APP_VERSION !== todayStr) {
        console.log('APP_VERSION will be updated on next page load');
      }
      if (status) status.textContent = '✅ ' + data.message;
      if (data.details) console.log('Commit details:', data.details.join(' | '));
    } else if (res.status === 401) {
      if (status) status.textContent = '🔒 Session expired. Please unlock the portfolio first.';
    } else {
      if (status) status.textContent = '❌ ' + (data.error || 'Commit failed. Check server logs.');
    }
  } catch (e) {
    if (status) status.textContent = '❌ Commit failed: ' + e.message;
    console.error('commitData error:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Commit'; }
  }
}

// Parse a data-file response, transparently decrypting AES-GCM envelopes.
// Throws if the file is encrypted and no valid key is cached (the caller's
// error path sends the user back to the unlock screen).
async function parsePortfolioJson(resp) {
  const obj = await resp.json();
  if (typeof PortfolioCrypto === 'undefined' || !PortfolioCrypto.isEnvelope(obj)) return obj;
  const data = await PortfolioCrypto.decryptEnvelope(obj);
  if (data === null) {
    if (typeof clearAuthToken === 'function') clearAuthToken();
    if (typeof showLogin === 'function') {
      const appContainer = document.querySelector('.app-container');
      if (appContainer) appContainer.style.display = 'none';
      if (!document.getElementById('auth-overlay')) showLogin('Please unlock again to decrypt your data.');
    }
    throw new Error('Data is encrypted and no valid key is available.');
  }
  return data;
}

async function loadData() {
  try {
    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js could not be loaded. Check your network connection or bundle Chart.js locally.');
    }

    // Update badge to show loading is in progress
    document.getElementById('live-time-badge').innerText = "Loading portfolio data...";

    // ── Try localStorage first (persists uploaded data across refreshes) ──
    const cached = loadFromLocalStorage();
    if (cached) {
      portfolioSummary = cached.portfolioSummary;
      latestEquity = cached.latestEquity;
      latestMf = cached.latestMf;
      historicalHoldings = cached.historicalHoldings;

      // Always fetch breakup_summary fresh from server — never cache it — to prevent
      // baseline drift from in-memory live-price mutations being persisted across reloads.
      const _cb = APP_VERSION;
      try {
        const bsResp = await fetch(`data/breakup_summary.json?${_cb}`, { credentials: 'same-origin' });
        breakupSummary = await parsePortfolioJson(bsResp);
      } catch (e) {
        console.warn('Could not fetch fresh breakup_summary, falling back:', e);
        // Last resort: if server unavailable, derive a minimal snapshot from per-instrument data
        breakupSummary = null;
      }

      if (!breakupSummary) { /* fall through to full server load below */ }
      else {
      initializeLiveBaseline();
      generateBenchmarkData();

      const dates = breakupSummary.dates;
      const latestDate = dates[dates.length - 1];
      document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
      updateDataFreshness(`Uploaded snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);

      try { updateKpis(); } catch (e) { console.error('updateKpis failed:', e); }
      try { initOverviewTab(); } catch (e) { console.error('initOverviewTab failed:', e); }
      try { initStocksTab(); } catch (e) { console.error('initStocksTab failed:', e); }
      try { initMfsTab(); } catch (e) { console.error('initMfsTab failed:', e); }
      try { initGrowthTab(); } catch (e) { console.error('initGrowthTab failed:', e); }
      try { initFixedIncomeTab(); } catch (e) { console.error('initFixedIncomeTab failed:', e); }
      try { initNpsTab(); } catch (e) { console.error('initNpsTab failed:', e); }
      try { initMonthlyTab(); } catch (e) { console.error('initMonthlyTab failed:', e); }
      try { initUpdateLogTab(); } catch (e) { console.error('initUpdateLogTab failed:', e); }

      document.getElementById('upload-status').textContent = 'Using locally saved data';
      return;
      } // end else (breakupSummary fetched ok)
    }

    // ── No localStorage data (or breakup_summary fetch failed); fetch from server ──
    // Helper: fetch with timeout to prevent hanging
    async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
      } finally {
        clearTimeout(timeout);
      }
    }

    // Cache-busting: append version query param to bypass HTTP/CDN cache on stale responses
    const _cb = `v=${APP_VERSION}`;
    const [resSummary, resBreakup, resEquity, resMf, resHist] = await Promise.all([
      fetchWithTimeout('data/portfolio_summary.json?' + _cb, { credentials: 'same-origin' }),
      fetchWithTimeout('data/breakup_summary.json?' + _cb, { credentials: 'same-origin' }),
      fetchWithTimeout('data/latest_equity.json?' + _cb, { credentials: 'same-origin' }),
      fetchWithTimeout('data/latest_mf.json?' + _cb, { credentials: 'same-origin' }),
      fetchWithTimeout('data/historical_holdings.json?' + _cb, { credentials: 'same-origin' })
    ]);

    const responses = [resSummary, resBreakup, resEquity, resMf, resHist];
    if (responses.some(res => res.status === 401)) {
      if (typeof clearAuthToken === 'function') clearAuthToken();
      if (typeof showLogin === 'function') {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.style.display = 'none';
        if (!document.getElementById('auth-overlay')) showLogin();
      }
      throw new Error('Session expired. Please unlock the portfolio again.');
    }
    if (responses.some(res => !res.ok)) {
      throw new Error('One or more portfolio data files could not be loaded.');
    }

    portfolioSummary = await parsePortfolioJson(resSummary);
    breakupSummary = await parsePortfolioJson(resBreakup);
    latestEquity = await parsePortfolioJson(resEquity);
    latestMf = await parsePortfolioJson(resMf);
    historicalHoldings = await parsePortfolioJson(resHist);

    initializeLiveBaseline();

    // Generate benchmark data
    generateBenchmarkData();

    // Populate live badge
    const dates = breakupSummary.dates;
    const latestDate = dates[dates.length - 1];
    document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
    updateDataFreshness(`Uploaded snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);

    // Initialize UI elements — each wrapped in try-catch to isolate failures
    try { updateKpis(); } catch (e) { console.error('updateKpis failed:', e); }
    try { initOverviewTab(); } catch (e) { console.error('initOverviewTab failed:', e); }
    try { initStocksTab(); } catch (e) { console.error('initStocksTab failed:', e); }
    try { initMfsTab(); } catch (e) { console.error('initMfsTab failed:', e); }
    try { initGrowthTab(); } catch (e) { console.error('initGrowthTab failed:', e); }
    try { initFixedIncomeTab(); } catch (e) { console.error('initFixedIncomeTab failed:', e); }
    try { initNpsTab(); } catch (e) { console.error('initNpsTab failed:', e); }
    try { initMonthlyTab(); } catch (e) { console.error('initMonthlyTab failed:', e); }
    try { initUpdateLogTab(); } catch (e) { console.error('initUpdateLogTab failed:', e); }
  } catch (error) {
    console.error("Error loading portfolio data:", error);
    document.getElementById('live-time-badge').innerText = "Error loading data!";
    document.getElementById('live-time-badge').style.borderColor = "#ef4444";
  }
}

// ── MF Scheme Name → Scheme Code Mapping ────────────────────────────────────
// These codes are used with mfapi.in to fetch live NAVs.
// If a scheme is not found in this map, the app will attempt a dynamic search
// via the /api/search-mf-scheme endpoint (mfapi.in search API).
// Correct scheme codes verified against mfapi.in search API.
const MF_SCHEME_CODES = {
  "Axis Small Cap Fund Direct-Growth": 125354,
  "HDFC Small Cap Fund Direct- Growth": 130503,
  "UTI Nifty Next 50 Index Fund Direct - Growth": 143341,
  "Axis Midcap Direct Plan-Growth": 120505,
  "Parag Parikh Flexi Cap Fund Direct-Growth": 122639,
  "Motilal Oswal Nasdaq 100 FOF Direct - Growth": 145552,
  "Navi Nifty 50 Index Fund Direct - Growth": 149039,
  "Quant Mid Cap Fund Direct-Growth": 120841,
  "Canara Robeco Small Cap Fund Direct - Growth": 146130,
  "Navi Nifty Next 50 Index Fund Direct - Growth": 149447,
  "Axis Greater China Equity FoF Direct-Growth": 148699,
  "HDFC BSE Sensex Index Fund Direct-Growth": 119065,
  "Edelweiss US Technology Equity FoF Direct - Growth": 148063,
  "Quant Small Cap Fund Direct Plan-Growth": 120828,
  "Kotak Midcap Fund Direct-Growth": 119775,
  "PGIM India Global Equity Opportunities FoF Direct-Growth": 138528,
  "Navi Nasdaq100 US Specific Equity Passive FoF Direct - Growth": 149910,
  "Nippon India Nifty IT Index Fund Direct - Growth": 152392
};

// Cache for dynamically discovered MF scheme codes (persists across refreshes)
let dynamicMfSchemeCodes = {};

function recomputePortfolioFromLiveData() {
  if (!uploadedSnapshot) initializeLiveBaseline();

  // Recompute thisMonthGain for all stocks/MFs: (current price - uploaded price) * qty
  latestEquity.forEach(s => { s.thisMonthGain = (s.ltp - s.lastUploadedPrice) * s.qty; });
  latestMf.forEach(f => { f.thisMonthGain = (f.price - f.lastUploadedPrice) * f.qty; });

  // Use exact per-instrument delta on top of the Excel summary baseline to avoid
  // rounding discrepancies between the summary tab total and the per-row sum.
  const exactStockGain = latestEquity.reduce((sum, s) => sum + s.thisMonthGain, 0);
  const exactMfGain = latestMf.reduce((sum, f) => sum + f.thisMonthGain, 0);
  const exactDeltaLakhs = (exactStockGain + exactMfGain) / 100000;

  const liveStockLakhs = uploadedSnapshot.stockLakhs + (exactStockGain / 100000);
  const liveMfLakhs = uploadedSnapshot.mfLakhs + (exactMfGain / 100000);
  const liveTotalLakhs = uploadedSnapshot.totalLakhs + exactDeltaLakhs;

  portfolioSummary.total_net_worth_lakhs = liveTotalLakhs;
  portfolioSummary.equity_lakhs = liveStockLakhs + liveMfLakhs + uploadedSnapshot.npsELakhs;
  portfolioSummary.allocation_pct = recomputeAllocation(portfolioSummary);

  // Update latest breakupSummary data points for Growth tab chart display only —
  // this mutation is intentionally NOT saved to localStorage (see saveRefreshedPrices)
  setLatestSectionValue(breakupSummary.net_worth, 'Stocks (Equity)', liveStockLakhs);
  setLatestSectionValue(breakupSummary.net_worth, 'Mutual Funds (Equity)', liveMfLakhs);
  setLatestSectionValue(breakupSummary.net_worth, 'Total', liveTotalLakhs);
}

function initPortfolioUpload() {
  const input = document.getElementById('portfolio-upload');
  if (!input) return;

  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadWorkbookFile(file);
    input.value = '';
  });
}

async function loadWorkbookFile(file) {
  const status = document.getElementById('upload-status');
  try {
    if (typeof readXlsxFile !== 'function') {
      throw new Error('Excel parser could not be loaded. Check your network connection and retry.');
    }

    if (status) status.textContent = `Reading ${file.name}...`;
    const sheets = await readXlsxFile(file);
    const workbook = normalizeReadExcelWorkbook(sheets);
    const parsed = parsePortfolioWorkbook(workbook);

    portfolioSummary = parsed.portfolioSummary;
    breakupSummary = parsed.breakupSummary;
    latestEquity = parsed.latestEquity;
    latestMf = parsed.latestMf;
    historicalHoldings = parsed.historicalHoldings;

    // ── Persist to localStorage (survives page refresh) ──
    saveToLocalStorage(portfolioSummary, breakupSummary, latestEquity, latestMf, historicalHoldings);

    resetDerivedState();
    refreshAllTabs();

    const latestDate = breakupSummary.dates[breakupSummary.dates.length - 1];
    document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
    updateDataFreshness(`Uploaded snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);

    // Show Commit button after successful upload
    if (status) status.textContent = `✅ ${file.name} — saved locally. Hit "Commit" to deploy permanently.`;
    const commitBtn = document.getElementById('commit-btn');
    if (commitBtn) {
      commitBtn.style.display = 'inline-flex';
      commitBtn.disabled = false;
      commitBtn.textContent = '🚀 Commit';
    }
  } catch (error) {
    console.error('Failed to load uploaded workbook:', error);
    if (status) status.textContent = error.message || 'Upload failed';
  }
}

function normalizeReadExcelWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) {
    throw new Error('Workbook does not contain any readable sheets.');
  }

  return {
    SheetNames: sheets.map(sheet => sheet.sheet),
    Sheets: Object.fromEntries(sheets.map(sheet => [sheet.sheet, sheet.data || []]))
  };
}

function resetDerivedState() {
  benchmarkData.nifty50.history = [];
  benchmarkData.spx.history = [];
  benchmarkData.gold.history = [];
  uploadedSnapshot = null;
  lastRefreshReport = null;
  window.lastRefreshReport = null;
  window._stockNameMap = null;
  heatmapSelectedIndices.clear();
  initializeLiveBaseline();
  generateBenchmarkData();
}

function initializeLiveBaseline() {
  latestEquity.forEach(s => {
    // Preserve lastUploadedPrice if already set (restored from localStorage after a refresh)
    if (s.lastUploadedPrice === undefined) s.lastUploadedPrice = s.ltp;
    s.lastRefreshedPrice = s.ltp;
    if (s.thisMonthGain === undefined) s.thisMonthGain = 0;
    if (s.yesterdayClose === undefined) s.yesterdayClose = null;
  });
  latestMf.forEach(f => {
    if (f.lastUploadedPrice === undefined) f.lastUploadedPrice = f.price;
    f.lastRefreshedPrice = f.price;
    if (f.thisMonthGain === undefined) f.thisMonthGain = 0;
    if (f.previousNav === undefined) f.previousNav = null;
  });
  // Only derive from breakupSummary on a fresh upload; on reload, uploadedSnapshot
  // is restored from localStorage before this runs to preserve the true baseline.
  if (!uploadedSnapshot) {
    uploadedSnapshot = {
      totalLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Total'),
      stockLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Stocks (Equity)'),
      mfLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Mutual Funds (Equity)'),
      npsELakhs: getLatestSectionValue(breakupSummary.net_worth, 'NPS E (Equity)')
    };
  }
}

function getLatestSectionValue(section, key) {
  const values = section?.[key]?.values || [];
  return values.length ? values[values.length - 1] : 0;
}

function setLatestSectionValue(section, key, value) {
  const values = section?.[key]?.values;
  if (!values || !values.length) return;
  values[values.length - 1] = value;
}

function refreshAllTabs() {
  updateKpis();
  // Refresh real Sensex data (non-blocking)
  fetchSensexDailyChange().then(() => {
    const dailySummaryEl = document.getElementById('daily-summary-kpis');
    if (dailySummaryEl && dailySummaryEl.offsetParent !== null) {
      renderDailyOverviewTable();
    }
  });
  fetchSensexMonthlyChange().then(() => {
    if (latestEquity) renderMonthlyOverviewTable();
  });
  
  // Only initialize the currently visible tab (others load lazily on first visit)
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab) {
    const tabId = activeTab.id.replace('-tab', '');
    if (!initializedTabs.has(tabId)) {
      initializedTabs.add(tabId);
      const initFn = tabInitMap[tabId];
      if (initFn) initFn();
    }
  }

  // If lastRefreshReport exists, force-update the update-log content.
  // This handles the case where refreshPrices() just built a new report
  // and the user may already be on (or will navigate to) the update-log tab.
  // The report is synced to window.lastRefreshReport by api.js.
  const report = window.lastRefreshReport || lastRefreshReport;
  if (report) {
    const container = document.getElementById('update-log-content');
    if (container && container.parentElement.classList.contains('active')) {
      initUpdateLogTab();
    }
  }
}

function updateDataFreshness(message) {
  const el = document.getElementById('data-freshness');
  if (el) el.textContent = message;
}

// Helpers
function formatLakhs(value) {
  return '₹' + parseFloat(value).toFixed(2) + ' L';
}

// ── Responsive Chart.js config helpers ──
function isMobileView() {
  return window.innerWidth < 480;
}

function isSmallMobileView() {
  return window.innerWidth < 400;
}

/** Returns legend label config optimized for current viewport width */
function getResponsiveLegendLabels(baseFontSize = 9) {
  const mobile = isMobileView();
  const small = isSmallMobileView();
  return {
    color: '#f3f4f6',
    font: {
      family: 'Outfit',
      size: small ? 8 : (mobile ? 9 : baseFontSize)
    },
    boxWidth: small ? 8 : (mobile ? 10 : 14),
    padding: small ? 6 : (mobile ? 8 : 12)
  };
}

// Set mobile-optimized Chart.js global defaults once
(function setChartDefaults() {
  const mobile = isMobileView();
  if (mobile && typeof Chart !== 'undefined' && Chart.defaults) {
    Chart.defaults.plugins.tooltip.bodyFont = {
      family: 'Outfit',
      size: isSmallMobileView() ? 9 : 10
    };
    Chart.defaults.plugins.tooltip.titleFont = {
      family: 'Outfit',
      size: isSmallMobileView() ? 10 : 11
    };
    Chart.defaults.plugins.tooltip.padding = isSmallMobileView() ? 6 : 8;
  }
})();

function formatINR(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(value);
}

function formatNullableNumber(value, maximumFractionDigits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits })
    : 'N/A';
}

function sortNullableNumber(a, b, asc) {
  const aValid = Number.isFinite(a);
  const bValid = Number.isFinite(b);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return asc ? a - b : b - a;
}

function sumValue(rows, key) {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

function recomputeAllocation(summary) {
  const total = Number(summary.total_net_worth_lakhs) || 0;
  const allocation = {};
  ['Equity', 'Debt', 'Gold', 'Liquid', 'Alternate'].forEach(asset => {
    const key = asset.toLowerCase() + '_lakhs';
    allocation[asset] = total > 0 ? ((Number(summary[key]) || 0) / total) * 100 : 0;
  });
  return allocation;
}

function formatDateString(dateStr) {
  if (!dateStr || dateStr.startsWith('Period')) return dateStr;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cleanFloat(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value).trim().replace(/%/g, '').replace(/\n/g, '').replace(/\s/g, '').replace(/,/g, '');
  if (!normalized || normalized === '-' || normalized.toLowerCase() === 'nan') return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatWorkbookDate(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(epoch.getTime() + value * 24 * 60 * 60 * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  return sheet;
}

function rowsToObjects(rows) {
  const headers = (rows[0] || []).map(h => String(h ?? '').trim());
  return rows.slice(1).map(row => {
    const item = {};
    headers.forEach((header, index) => {
      if (header) item[header] = row[index];
    });
    return normalizeRow(item);
  });
}

function validateRowsHaveColumns(rows, sheetName, requiredColumns) {
  const normalizedHeaders = normalizeRow(Object.fromEntries((rows[0] || []).map(header => [header, true])));
  const missing = requiredColumns.filter(column => !normalizedHeaders[column]);
  if (missing.length) {
    throw new Error(`${sheetName} is missing required column(s): ${missing.join(', ')}`);
  }
}

function normalizeRow(row) {
  const mapping = {
    Company: 'Instrument',
    Quantity: 'Qty.',
    'Current Price': 'LTP',
    'Average Buy Price': 'Avg. cost',
    'Average Buy NAV': 'Avg. cost',
    'Amount Invested': 'Invested',
    'Total Investment': 'Invested',
    'Current Price ': 'LTP',
    'Current Valuation': 'Cur. val',
    'Gain/Loss': 'P&L',
    'Gain/ Loss': 'P&L',
    'Unrealised Gain/Loss': 'P&L',
    'Gain %': 'Gain %',
    'Gain/ Loss %': 'Gain %',
    Scheme: 'Instrument',
    'Scheme Type': 'Category'
  };

  const normalized = {};
  Object.entries(row).forEach(([key, value]) => {
    const cleanKey = String(key).trim();
    normalized[mapping[cleanKey] || cleanKey] = value;
  });
  return normalized;
}

function parsePortfolioWorkbook(workbook) {
  const eSheets = [];
  const mfSheets = [];
  workbook.SheetNames.forEach(name => {
    const eMatch = name.match(/^(\d{8})\s+E$/);
    const mfMatch = name.match(/^(\d{8})\s+MF$/);
    if (eMatch) eSheets.push([eMatch[1], name]);
    if (mfMatch) mfSheets.push([mfMatch[1], name]);
  });
  eSheets.sort((a, b) => a[0].localeCompare(b[0]));
  mfSheets.sort((a, b) => a[0].localeCompare(b[0]));

  if (!eSheets.length || !mfSheets.length) {
    throw new Error('Workbook must include dated equity and mutual fund sheets.');
  }
  if (!workbook.Sheets.Breakup) {
    throw new Error('Workbook must include a Breakup sheet.');
  }

  const breakupSummary = parseBreakupSheet(workbook);
  const historicalHoldings = parseHistoricalHoldings(workbook, eSheets, mfSheets);
  const latestEquity = buildLatestEquity(historicalHoldings, eSheets[eSheets.length - 1][0]);
  const latestMf = buildLatestMf(historicalHoldings, mfSheets[mfSheets.length - 1][0]);
  const portfolioSummary = buildPortfolioSummary(breakupSummary);

  return { breakupSummary, historicalHoldings, latestEquity, latestMf, portfolioSummary };
}

function parseBreakupSheet(workbook) {
  const rows = sheetRows(workbook, 'Breakup');
  const headerRow = rows[0] || [];
  const dateCols = [];
  for (let index = 2; index < headerRow.length; index++) {
    const val = headerRow[index];
    if (val === null || val === undefined || String(val).trim() === '') {
      break;
    }
    const valStr = String(val ?? '').trim().toLowerCase();
    if (valStr === 'total' || valStr === 'cagr' || valStr === 'average') {
      break;
    }
    dateCols.push([index, formatWorkbookDate(val, `Period_${index}`)]);
  }

  const sections = {
    net_worth: [3, 15],
    contribution: [17, 27],
    new_investment: [29, 41],
    returns: [43, 55],
    net_change: [57, 69],
    net_cashflows: [71, 83],
    xirr: [85, 97],
    pct_returns: [101, 113]
  };

  const data = {};
  Object.entries(sections).forEach(([name, [start, end]]) => {
    const section = {};
    for (let rowIndex = start; rowIndex < end; rowIndex++) {
      const row = rows[rowIndex] || [];
      const label = row[0] === null || row[0] === undefined || row[0] === '' ? 'Total' : String(row[0]).trim();
      const assetType = row[1] === null || row[1] === undefined || row[1] === '' ? null : String(row[1]).trim();
      const values = dateCols.map(([colIndex]) => cleanFloat(row[colIndex]));
      const key = assetType ? `${label} (${assetType})` : label;
      section[key] = { label, asset_type: assetType, values };
    }
    data[name] = section;
  });

  data.dates = dateCols.map(([, date]) => date);
  if (!data.dates.length) {
    throw new Error('Breakup sheet must include at least one dated portfolio column.');
  }
  return data;
}

function parseHistoricalHoldings(workbook, eSheets, mfSheets) {
  const historical = { stocks: {}, mfs: {} };

  eSheets.forEach(([dateStr, sheetName]) => {
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const rows = sheetRows(workbook, sheetName);
    validateRowsHaveColumns(rows, sheetName, ['Instrument', 'Qty.', 'LTP', 'Invested', 'Cur. val', 'P&L']);
    rowsToObjects(rows).forEach(row => {
      const instrument = String(row.Instrument ?? '').trim();
      if (!instrument || instrument === 'Total') return;
      const invested = cleanFloat(row.Invested);
      const pnl = cleanFloat(row['P&L']);
      const gainPct = invested > 0 ? (pnl / invested) * 100 : 0;
      const sector = SECTOR_MAP[instrument] || 'Other Equities';
      if (!historical.stocks[instrument]) {
        historical.stocks[instrument] = { instrument, sector, history: [] };
      }
      historical.stocks[instrument].history.push(buildHistoryPoint(row, date, gainPct));
    });
  });

  mfSheets.forEach(([dateStr, sheetName]) => {
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const rows = sheetRows(workbook, sheetName);
    validateRowsHaveColumns(rows, sheetName, ['Instrument', 'Qty.', 'LTP', 'Invested', 'Cur. val', 'P&L']);
    rowsToObjects(rows).forEach(row => {
      const instrument = String(row.Instrument ?? '').trim();
      if (!instrument || instrument === 'Total') return;
      const category = String(row.Category ?? 'Other').trim();
      const invested = cleanFloat(row.Invested);
      const pnl = cleanFloat(row['P&L']);
      const gainPct = invested > 0 ? (pnl / invested) * 100 : 0;
      if (!historical.mfs[instrument]) {
        historical.mfs[instrument] = { instrument, category, history: [] };
      }
      historical.mfs[instrument].history.push(buildHistoryPoint(row, date, gainPct));
    });
  });

  return historical;
}

function normalizeGainPct(value) {
  // Retained for compatibility, but gain_pct is now computed mathematically from pnl and invested
  return value;
}

function buildHistoryPoint(row, date, gainPct) {
  return {
    date,
    qty: cleanFloat(row['Qty.']),
    avg_cost: cleanFloat(row['Avg. cost']),
    ltp: cleanFloat(row.LTP),
    invested: cleanFloat(row.Invested),
    cur_val: cleanFloat(row['Cur. val']),
    pnl: cleanFloat(row['P&L']),
    gain_pct: gainPct
  };
}

function buildLatestEquity(historical, latestDateStr) {
  const latestDate = `${latestDateStr.slice(0, 4)}-${latestDateStr.slice(4, 6)}-${latestDateStr.slice(6, 8)}`;
  return Object.values(historical.stocks).flatMap(info => {
    const last = info.history[info.history.length - 1];
    if (!last || last.date !== latestDate || last.qty <= 0) return [];
    return [{
      instrument: info.instrument,
      sector: info.sector,
      qty: last.qty,
      avg_cost: last.avg_cost,
      ltp: last.ltp,
      invested: last.invested,
      cur_val: last.cur_val,
      pnl: last.pnl,
      gain_pct: last.gain_pct
    }];
  });
}

function buildLatestMf(historical, latestDateStr) {
  const latestDate = `${latestDateStr.slice(0, 4)}-${latestDateStr.slice(4, 6)}-${latestDateStr.slice(6, 8)}`;
  return Object.values(historical.mfs).flatMap(info => {
    const last = info.history[info.history.length - 1];
    if (!last || last.date !== latestDate || last.qty <= 0) return [];
    return [{
      scheme: info.instrument,
      scheme_type: info.category,
      qty: last.qty,
      price: last.ltp,
      avg_nav: last.avg_cost,
      invested: last.invested,
      cur_val: last.cur_val,
      pnl: last.pnl,
      gain_pct: last.gain_pct
    }];
  });
}

function buildPortfolioSummary(breakup) {
  const latest = -1;
  const nw = breakup.net_worth;
  const get = key => {
    const values = nw[key]?.values || [];
    return values[values.length - 1] || 0;
  };
  const total = get('Total');
  const equity = get('Stocks (Equity)') + get('Mutual Funds (Equity)') + get('NPS E (Equity)');
  const debt = get('NPS C (Debt)') + get('NPS G (Debt)') + get('PF (Debt)') + get('PPF (Debt)') + get('Bonds (Debt)');
  const gold = get('Gold (Gold)');
  const liquid = get('Cash (Liquid)');
  const alternate = get('Crypto (Alternate)');

  let running = 0;
  const investments = (breakup.new_investment['Total Investment']?.values || []).map(value => {
    running += value;
    return running;
  });

  const summary = {
    total_net_worth_lakhs: total,
    equity_lakhs: equity,
    debt_lakhs: debt,
    gold_lakhs: gold,
    liquid_lakhs: liquid,
    alternate_lakhs: alternate,
    cumulative_investment_history: investments
  };
  summary.allocation_pct = recomputeAllocation(summary);
  return summary;
}

function getAssetColor(label) {
  const colors = {
    'Stocks': '#3b82f6',
    'Mutual Funds': '#6366f1',
    'Gold': '#f59e0b',
    'NPS E': '#10b981',
    'NPS C': '#8b5cf6',
    'NPS G': '#ec4899',
    'PF': '#14b8a6',
    'PPF': '#f43f5e',
    'Cash': '#6b7280',
    'Crypto': '#f97316',
    'Bonds': '#06b6d4',
    'Equity': '#3b82f6',
    'Debt': '#8b5cf6',
    'Liquid': '#6b7280',
    'Alternate': '#f97316'
  };
  return colors[label] || '#6366f1';
}

// ── Tab initialization tracking (lazy init on mobile) ──
const initializedTabs = new Set();

const tabInitMap = {
  'overview': initOverviewTab,
  'stocks': initStocksTab,
  'mfs': initMfsTab,
  'growth': initGrowthTab,
  'fixed-income': initFixedIncomeTab,
  'nps': initNpsTab,
  'monthly': initMonthlyTab,
  'update-log': initUpdateLogTab
};

// Tab Switching
function switchTab(tabId) {
  tabIds.forEach(id => {
    const btn = document.querySelector(`.tab-btn[onclick="switchTab('${id}')"]`);
    const content = document.getElementById(`${id}-tab`);
    if (id === tabId) {
      btn.classList.add('active');
      content.classList.add('active');
    } else {
      btn.classList.remove('active');
      content.classList.remove('active');
    }
  });
  
  // Lazy-initialize charts for this tab on first visit
  if (!initializedTabs.has(tabId)) {
    initializedTabs.add(tabId);
    const initFn = tabInitMap[tabId];
    if (initFn) initFn();
  }
  
  // Always re-initialize update-log tab on every visit (data changes after refresh)
  if (tabId === 'update-log') {
    initUpdateLogTab();
  }
  
  // Re-render charts on visible tab to ensure proper sizing
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    
    // Re-render monthly charts (they need update on every visit)
    if (tabId === 'monthly') {
      renderMonthlyChangeChart();
      renderMonthlyActivityChart();
    }
  }, 100);
}

// Update KPI Values
function updateKpis() {
  document.getElementById('kpi-net-worth').innerText = formatLakhs(portfolioSummary.total_net_worth_lakhs);
  document.getElementById('kpi-equity-val').innerText = formatLakhs(portfolioSummary.equity_lakhs);
  document.getElementById('kpi-equity-pct').innerText = portfolioSummary.allocation_pct.Equity.toFixed(1) + '%';
  document.getElementById('kpi-debt-val').innerText = formatLakhs(portfolioSummary.debt_lakhs);
  document.getElementById('kpi-debt-pct').innerText = portfolioSummary.allocation_pct.Debt.toFixed(1) + '%';
  document.getElementById('kpi-gold-val').innerText = formatLakhs(portfolioSummary.gold_lakhs);
  document.getElementById('kpi-gold-pct').innerText = portfolioSummary.allocation_pct.Gold.toFixed(1) + '%';

  // Calculate last uploaded total value (sum of invested amounts across all holdings)
  // and this month's gain from breakup_summary net_worth values
  const nw = breakupSummary.net_worth;
  // Helper: get this month's change in lakhs for a category
  const getMonthlyChangeLakhs = (key) => {
    const vals = nw[key]?.values || [];
    if (vals.length >= 2) {
      return vals[vals.length - 1] - vals[vals.length - 2];
    }
    return 0;
  };

  // Stocks: current value, gain since the uploaded baseline price.
  const stocksCurrentLakhs = latestEquity.reduce((sum, s) => sum + s.cur_val, 0) / 100000;
  const stocksGainLakhs = latestEquity.reduce((sum, s) => sum + (s.thisMonthGain || 0), 0) / 100000;
  document.getElementById('kpi-stocks-uploaded').innerText = formatLakhs(stocksCurrentLakhs);
  document.getElementById('kpi-stocks-gain').innerText = (stocksGainLakhs >= 0 ? '+' : '') + stocksGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-stocks-gain').className = stocksGainLakhs >= 0 ? 'trend-up' : 'trend-down';

  // MFs: current value, gain since the uploaded baseline NAV.
  const mfCurrentLakhs = latestMf.reduce((sum, f) => sum + f.cur_val, 0) / 100000;
  const mfGainLakhs = latestMf.reduce((sum, f) => sum + (f.thisMonthGain || 0), 0) / 100000;
  document.getElementById('kpi-mfs-uploaded').innerText = formatLakhs(mfCurrentLakhs);
  document.getElementById('kpi-mfs-gain').innerText = (mfGainLakhs >= 0 ? '+' : '') + mfGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-mfs-gain').className = mfGainLakhs >= 0 ? 'trend-up' : 'trend-down';

  // PF: current value + this month's gain
  const pfCurrentLakhs = nw['PF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const pfGainLakhs = getMonthlyChangeLakhs('PF (Debt)');
  document.getElementById('kpi-pf-value').innerText = formatLakhs(pfCurrentLakhs);
  document.getElementById('kpi-pf-gain').innerText = (pfGainLakhs >= 0 ? '+' : '') + pfGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-pf-gain').className = pfGainLakhs >= 0 ? 'trend-up' : 'trend-down';

  // PPF: current value + this month's gain
  const ppfCurrentLakhs = nw['PPF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const ppfGainLakhs = getMonthlyChangeLakhs('PPF (Debt)');
  document.getElementById('kpi-ppf-value').innerText = formatLakhs(ppfCurrentLakhs);
  document.getElementById('kpi-ppf-gain').innerText = (ppfGainLakhs >= 0 ? '+' : '') + ppfGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-ppf-gain').className = ppfGainLakhs >= 0 ? 'trend-up' : 'trend-down';
}

// ── Overview Sub-tab Switching ──────────────────────────────────────────────
function switchOverviewSubtab(subtab, btn) {
  // Toggle button active state
  document.querySelectorAll('.overview-subtabs .subtab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Toggle content visibility
  document.querySelectorAll('.overview-subcontent').forEach(c => c.classList.remove('active'));
  document.getElementById(`overview-${subtab}`).classList.add('active');
}

// ── Daily Type Filter (Stocks / MFs / All) — click KPI cards ───────────────
function setDailyTypeFilter(filter) {
  dailyTypeFilter = filter;
  renderDailyOverviewTable();
}

// ── Monthly Type Filter (Stocks / MFs / All) — click KPI cards ─────────────
function setMonthlyTypeFilter(filter) {
  monthlyTypeFilter = filter;
  renderMonthlyOverviewTable();
}

// ── Daily Overview Table Sorting (column-header click) ─────────────────────
function sortDailyOverview(colIdx) {
  if (dailyOverviewSortCol === colIdx) {
    dailyOverviewSortAsc = !dailyOverviewSortAsc;
  } else {
    dailyOverviewSortCol = colIdx;
    dailyOverviewSortAsc = false; // Default descending for gains
  }
  // Update header classes
  const ths = document.querySelectorAll('#daily-overview-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(dailyOverviewSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });
  renderDailyOverviewTable();
}

// ── Stock History Key Lookup (maps ticker symbol to historical holdings key) ──
function getStockHistoryKey(symbol) {
  if (!historicalHoldings || !historicalHoldings.stocks) return null;
  // Direct match
  if (historicalHoldings.stocks[symbol]) return historicalHoldings.stocks[symbol];
  // Build lookup cache
  if (!_stockNameLookup) {
    _stockNameLookup = {};
    const stockKeys = Object.keys(historicalHoldings.stocks);
    stockKeys.forEach(key => {
      const upper = key.toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      _stockNameLookup[clean] = key;
      const withoutLtd = clean.replace(/LTD$/, '').replace(/LIMITED$/, '').trim();
      if (withoutLtd && withoutLtd !== clean) _stockNameLookup[withoutLtd] = key;
      const words = upper.split(/[^A-Z0-9]+/).filter(w => w.length > 2);
      if (words.length > 1) {
        if (!_stockNameLookup[words[0]]) _stockNameLookup[words[0]] = key;
      }
      if (upper.includes('&')) {
        upper.split('&').forEach(p => {
          const trimmed = p.replace(/[^A-Z0-9]/g, '').trim();
          if (trimmed.length >= 3 && !_stockNameLookup[trimmed]) _stockNameLookup[trimmed] = key;
        });
      }
    });
  }
  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const foundKey = _stockNameLookup[cleanSymbol] || null;
  return foundKey ? historicalHoldings.stocks[foundKey] : null;
}

// ── Daily Overview Table (top gainers across stocks & MFs by daily value) ──
function renderDailyOverviewTable() {
  const combined = [];
  let totalStockGain = 0;
  let totalMfGain = 0;

  // Suppress daily changes on weekends since the markets are closed.
  const istTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
  const isWeekend = istTime.getDay() === 0 || istTime.getDay() === 6;

  // Stocks: daily change = (current LTP - yesterday's close) * qty
  // yesterdayClose is fetched from Google Finance during price refresh
  latestEquity.forEach(s => {
    let prevClose = s.yesterdayClose || null;
    if (isWeekend) prevClose = s.ltp; // Zero out daily change on weekends

    const dailyGain = prevClose ? (s.ltp - prevClose) * s.qty : null;
    const dailyGainPct = prevClose ? ((s.ltp - prevClose) / prevClose) * 100 : null;
    combined.push({
      name: s.instrument,
      type: 'Stock',
      qty: s.qty,
      yesterdayClose: prevClose,
      currentLtp: s.ltp,
      change: dailyGain,
      changePct: dailyGainPct
    });
    if (dailyGain !== null) totalStockGain += dailyGain;
  });

  // MFs: daily change uses previous NAV when the NAV provider returns it.
  latestMf.forEach(f => {
    let previousNav = f.previousNav || null;
    if (isWeekend) previousNav = f.price; // Zero out daily change on weekends

    const gain = previousNav ? (f.price - previousNav) * f.qty : null;
    const gainPct = previousNav ? ((f.price - previousNav) / previousNav) * 100 : null;
    combined.push({
      name: f.scheme,
      type: 'MF',
      qty: f.qty,
      yesterdayClose: previousNav,
      currentLtp: f.price,
      change: gain,
      changePct: gainPct
    });
    if (gain !== null) totalMfGain += gain;
  });

  const totalGain = totalStockGain + totalMfGain;

  // ── Compute daily % change denominators ──
  let totalPrevStockValue = 0;
  let totalPrevMfValue = 0;
  latestEquity.forEach(s => {
    if (s.yesterdayClose && !isWeekend) totalPrevStockValue += s.yesterdayClose * s.qty;
  });
  latestMf.forEach(f => {
    if (f.previousNav && !isWeekend) totalPrevMfValue += f.previousNav * f.qty;
  });
  const dailyStockPct = totalPrevStockValue > 0 ? (totalStockGain / totalPrevStockValue) * 100 : 0;
  const dailyMfPct = totalPrevMfValue > 0 ? (totalMfGain / totalPrevMfValue) * 100 : 0;
  const dailyTotalPrev = totalPrevStockValue + totalPrevMfValue;
  const dailyTotalPct = dailyTotalPrev > 0 ? (totalGain / dailyTotalPrev) * 100 : 0;

  // ── Sensex daily change (real data if available, simulated fallback) ──
  const sensexDailyPct = _sensexDailyPctReal != null ? _sensexDailyPctReal : getSimulatedSensexDailyChangePct();

  // Apply daily type filter (All / Stocks / MFs)
  const filteredCombined = dailyTypeFilter === 'all'
    ? combined
    : combined.filter(item => item.type.toLowerCase() === dailyTypeFilter);

  // Render Daily Summaries — click cards to filter the table below
  const dailySummaryEl = document.getElementById('daily-summary-kpis');
  if (dailySummaryEl) {
    dailySummaryEl.innerHTML = `
      <div class="kpi-card${dailyTypeFilter === 'stock' ? ' filter-active' : ''}" style="--card-accent: #6366f1; cursor: pointer;" onclick="setDailyTypeFilter('stock')">
        <div>
          <div class="kpi-title">Total Daily Change (Stocks)</div>
          <div class="kpi-value ${totalStockGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalStockGain >= 0 ? '+' : ''}${formatINR(totalStockGain)}
            <span class="kpi-pct">(${dailyStockPct >= 0 ? '+' : ''}${dailyStockPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Since yesterday's close</div>
      </div>
      <div class="kpi-card${dailyTypeFilter === 'mf' ? ' filter-active' : ''}" style="--card-accent: #10b981; cursor: pointer;" onclick="setDailyTypeFilter('mf')">
        <div>
          <div class="kpi-title">Total Daily Change (MFs)</div>
          <div class="kpi-value ${totalMfGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMfGain >= 0 ? '+' : ''}${formatINR(totalMfGain)}
            <span class="kpi-pct">(${dailyMfPct >= 0 ? '+' : ''}${dailyMfPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Since previous NAV</div>
      </div>
      <div class="kpi-card total-card${dailyTypeFilter === 'all' ? ' filter-active' : ''}" style="cursor: pointer;" onclick="setDailyTypeFilter('all')">
        <div>
          <div class="kpi-title">Total Combined Change</div>
          <div class="kpi-value ${totalGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalGain >= 0 ? '+' : ''}${formatINR(totalGain)}
            <span class="kpi-pct">(${dailyTotalPct >= 0 ? '+' : ''}${dailyTotalPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Stocks + Mutual Funds</div>
      </div>
      <div class="kpi-card" style="--card-accent: #ef4444;">
        <div>
          <div class="kpi-title">Sensex (Ref)</div>
          <div class="kpi-value ${sensexDailyPct >= 0 ? 'trend-up' : 'trend-down'}">
            ${sensexDailyPct >= 0 ? '+' : ''}${sensexDailyPct.toFixed(2)}%
          </div>
        </div>
        <div class="kpi-sub">Daily change (BSE Sensex)</div>
      </div>
    `;
  }

  // Sort by selected column
  const col = dailyOverviewSortCol;
  const asc = dailyOverviewSortAsc;
  if (col === 1) {
    filteredCombined.sort((a, b) => sortNullableNumber(a.qty, b.qty, asc));
  } else if (col === 2) {
    filteredCombined.sort((a, b) => sortNullableNumber(a.yesterdayClose, b.yesterdayClose, asc));
  } else if (col === 3) {
    filteredCombined.sort((a, b) => asc ? a.currentLtp - b.currentLtp : b.currentLtp - a.currentLtp);
  } else if (col === 4) {
    filteredCombined.sort((a, b) => sortNullableNumber(a.change, b.change, asc));
  } else if (col === 5) {
    filteredCombined.sort((a, b) => sortNullableNumber(a.changePct, b.changePct, asc));
  } else {
    // Name column (0) or fallback: sort by instrument name
    filteredCombined.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }

  const tbody = document.getElementById('daily-overview-body');
  tbody.innerHTML = filteredCombined.map(item => `
    <tr>
      <td class="instrument-cell">${escapeHtml(item.name)}</td>
      <td style="text-align: right;">${item.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatNullableNumber(item.yesterdayClose, 2)}</td>
      <td style="text-align: right;">${item.currentLtp.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;" class="${item.change === null ? '' : item.change >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.change === null ? 'N/A' : `${item.change >= 0 ? '+' : ''}${formatINR(item.change)}`}
      </td>
      <td style="text-align: right;" class="${item.changePct === null ? '' : item.changePct >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.changePct === null ? 'N/A' : `${item.changePct >= 0 ? '+' : ''}${item.changePct.toFixed(2)}%`}
      </td>
    </tr>
  `).join('');
}

// ── Monthly Overview Table Sorting (column-header click) ───────────────────
function sortMonthlyOverview(colIdx) {
  if (monthlyOverviewSortCol === colIdx) {
    monthlyOverviewSortAsc = !monthlyOverviewSortAsc;
  } else {
    monthlyOverviewSortCol = colIdx;
    monthlyOverviewSortAsc = false; // Default descending for gains
  }
  // Update header classes
  const ths = document.querySelectorAll('#monthly-overview-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(monthlyOverviewSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });
  renderMonthlyOverviewTable();
}

// ── Monthly Overview Table (top gainers from last upload) ──────────────────
function renderMonthlyOverviewTable() {
  const combined = [];
  let totalStockMonthlyGain = 0;
  let totalMfMonthlyGain = 0;
  let totalStockUploadedVal = 0;
  let totalMfUploadedVal = 0;

  // Stocks: monthly gain = thisMonthGain
  latestEquity.forEach(s => {
    const gain = s.thisMonthGain || 0;
    const gainPct = s.lastUploadedPrice > 0 ? (gain / (s.lastUploadedPrice * s.qty)) * 100 : 0;
    const uploadedVal = (s.lastUploadedPrice ?? 0) * s.qty;
    combined.push({
      name: s.instrument,
      type: 'Stock',
      qty: s.qty,
      uploadedVal: uploadedVal,
      currentVal: s.cur_val,
      gain: gain,
      gainPct: gainPct
    });
    totalStockMonthlyGain += gain;
    totalStockUploadedVal += uploadedVal;
  });

  // MFs: monthly gain = thisMonthGain
  latestMf.forEach(f => {
    const gain = f.thisMonthGain || 0;
    const gainPct = f.lastUploadedPrice > 0 ? (gain / (f.lastUploadedPrice * f.qty)) * 100 : 0;
    const uploadedVal = (f.lastUploadedPrice ?? 0) * f.qty;
    combined.push({
      name: f.scheme,
      type: 'MF',
      qty: f.qty,
      uploadedVal: uploadedVal,
      currentVal: f.cur_val,
      gain: gain,
      gainPct: gainPct
    });
    totalMfMonthlyGain += gain;
    totalMfUploadedVal += uploadedVal;
  });

  const totalMonthlyGain = totalStockMonthlyGain + totalMfMonthlyGain;

  // ── Compute monthly % change denominators ──
  const monthlyStockPct = totalStockUploadedVal > 0 ? (totalStockMonthlyGain / totalStockUploadedVal) * 100 : 0;
  const monthlyMfPct = totalMfUploadedVal > 0 ? (totalMfMonthlyGain / totalMfUploadedVal) * 100 : 0;
  const totalUploadedVal = totalStockUploadedVal + totalMfUploadedVal;
  const monthlyTotalPct = totalUploadedVal > 0 ? (totalMonthlyGain / totalUploadedVal) * 100 : 0;

  // ── Real Sensex monthly change (falls back to 0 if not yet fetched) ──
  const sensexMonthlyPct = _sensexMonthlyPctReal ?? 0;
  const sensexMonthlyLabel = _sensexMonthlyPctReal != null ? 'Month-to-date change (BSE Sensex)' : 'Monthly change (loading…)';

  // Apply monthly type filter (All / Stocks / MFs)
  const filteredCombined = monthlyTypeFilter === 'all'
    ? combined
    : combined.filter(item => item.type.toLowerCase() === monthlyTypeFilter);

  // Render Monthly Summaries — click cards to filter the table below
  const monthlySummaryEl = document.getElementById('monthly-summary-kpis');
  if (monthlySummaryEl) {
    monthlySummaryEl.innerHTML = `
      <div class="kpi-card${monthlyTypeFilter === 'stock' ? ' filter-active' : ''}" style="--card-accent: #6366f1; cursor: pointer;" onclick="setMonthlyTypeFilter('stock')">
        <div>
          <div class="kpi-title">Total Gain (Stocks)</div>
          <div class="kpi-value ${totalStockMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalStockMonthlyGain >= 0 ? '+' : ''}${formatINR(totalStockMonthlyGain)}
            <span class="kpi-pct">(${monthlyStockPct >= 0 ? '+' : ''}${monthlyStockPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Since last upload</div>
      </div>
      <div class="kpi-card${monthlyTypeFilter === 'mf' ? ' filter-active' : ''}" style="--card-accent: #10b981; cursor: pointer;" onclick="setMonthlyTypeFilter('mf')">
        <div>
          <div class="kpi-title">Total Gain (MFs)</div>
          <div class="kpi-value ${totalMfMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMfMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMfMonthlyGain)}
            <span class="kpi-pct">(${monthlyMfPct >= 0 ? '+' : ''}${monthlyMfPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Since last upload</div>
      </div>
      <div class="kpi-card total-card${monthlyTypeFilter === 'all' ? ' filter-active' : ''}" style="cursor: pointer;" onclick="setMonthlyTypeFilter('all')">
        <div>
          <div class="kpi-title">Total Combined Gain</div>
          <div class="kpi-value ${totalMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMonthlyGain)}
            <span class="kpi-pct">(${monthlyTotalPct >= 0 ? '+' : ''}${monthlyTotalPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="kpi-sub">Stocks + Mutual Funds</div>
      </div>
      <div class="kpi-card" style="--card-accent: #ef4444;">
        <div>
          <div class="kpi-title">Sensex (Ref)</div>
          <div class="kpi-value ${sensexMonthlyPct >= 0 ? 'trend-up' : 'trend-down'}">
            ${sensexMonthlyPct >= 0 ? '+' : ''}${sensexMonthlyPct.toFixed(2)}%
          </div>
        </div>
        <div class="kpi-sub">${sensexMonthlyLabel}</div>
      </div>
    `;
  }

  // Sort by selected column
  const col = monthlyOverviewSortCol;
  const asc = monthlyOverviewSortAsc;
  if (col === 1) {
    filteredCombined.sort((a, b) => sortNullableNumber(a.qty, b.qty, asc));
  } else if (col === 2) {
    filteredCombined.sort((a, b) => asc ? a.uploadedVal - b.uploadedVal : b.uploadedVal - a.uploadedVal);
  } else if (col === 3) {
    filteredCombined.sort((a, b) => asc ? a.currentVal - b.currentVal : b.currentVal - a.currentVal);
  } else if (col === 4) {
    filteredCombined.sort((a, b) => asc ? a.gain - b.gain : b.gain - a.gain);
  } else if (col === 5) {
    filteredCombined.sort((a, b) => asc ? a.gainPct - b.gainPct : b.gainPct - a.gainPct);
  } else {
    // Name column (0) or fallback: sort by name
    filteredCombined.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }

  const tbody = document.getElementById('monthly-overview-body');
  tbody.innerHTML = filteredCombined.map(item => `
    <tr>
      <td class="instrument-cell">${escapeHtml(item.name)}</td>
      <td style="text-align: right;">${item.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatINR(item.uploadedVal)}</td>
      <td style="text-align: right;">${formatINR(item.currentVal)}</td>
      <td style="text-align: right;" class="${item.gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.gain >= 0 ? '+' : ''}${formatINR(item.gain)}
      </td>
      <td style="text-align: right;" class="${item.gainPct >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.gainPct >= 0 ? '+' : ''}${item.gainPct.toFixed(2)}%
      </td>
    </tr>
  `).join('');
}

// ==================== OVERVIEW TAB ====================
function initOverviewTab() {
  // Initial sort indicator on Gain column (col 5, descending = high to low)
  const dailyThs = document.querySelectorAll('#daily-overview-table th');
  dailyThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === dailyOverviewSortCol) {
      th.classList.add(dailyOverviewSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });
  const monthlyThs = document.querySelectorAll('#monthly-overview-table th');
  monthlyThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === monthlyOverviewSortCol) {
      th.classList.add(monthlyOverviewSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });
  // Render daily and monthly overview tables
  renderDailyOverviewTable();
  renderMonthlyOverviewTable();
}

function populateMonthlyOverviewSummary() {
  const container = document.getElementById('overview-monthly-summary');
  if (!container) return;
  
  const nw = breakupSummary.net_worth;
  const cumInvHist = portfolioSummary.cumulative_investment_history;

  // ── Since Last Upload: Calculate changes from uploaded prices to current refreshed prices ──

  // Total portfolio value (in lakhs) from breakup_summary
  const totalCurrent = nw['Total']?.values?.slice(-1)?.[0] || 0;
  
  // Total invested (cumulative) from portfolioSummary.cumulative_investment_history
  const totalInvested = cumInvHist?.length > 0 ? cumInvHist[cumInvHist.length - 1] : 0;
  const totalReturns = totalCurrent - totalInvested;
  const totalReturnsPct = totalInvested > 0 ? (totalReturns / totalInvested) * 100 : 0;

  // ── Stocks: Calculate gain since last upload using thisMonthGain ──
  const totalStockGain = latestEquity.reduce((sum, s) => sum + (s.thisMonthGain || 0), 0);
  const totalStockUploadedVal = latestEquity.reduce((sum, s) => sum + ((s.lastUploadedPrice ?? 0) * s.qty), 0);
  const totalStockCurrentVal = latestEquity.reduce((sum, s) => sum + s.cur_val, 0);
  const stockGainLakhs = totalStockGain / 100000;
  const stockGainPct = totalStockUploadedVal > 0 ? (totalStockGain / totalStockUploadedVal) * 100 : 0;

  // ── MFs: Calculate gain since last upload using thisMonthGain ──
  const totalMfGain = latestMf.reduce((sum, f) => sum + (f.thisMonthGain || 0), 0);
  const totalMfUploadedVal = latestMf.reduce((sum, f) => sum + ((f.lastUploadedPrice ?? 0) * f.qty), 0);
  const totalMfCurrentVal = latestMf.reduce((sum, f) => sum + f.cur_val, 0);
  const mfGainLakhs = totalMfGain / 100000;
  const mfGainPct = totalMfUploadedVal > 0 ? (totalMfGain / totalMfUploadedVal) * 100 : 0;

  // ── Debt (PF + PPF + Bonds): Use breakup_summary values (in lakhs) ──
  const pfVal = nw['PF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const ppfVal = nw['PPF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const bondsVal = nw['Bonds (Debt)']?.values?.slice(-1)?.[0] || 0;
  const debtCurrent = pfVal + ppfVal + bondsVal;

  // Debt change since last upload: use net_change section from breakupSummary
  const nc = breakupSummary.net_change;
  const debtChange = ((nc['PF (Debt)']?.values?.slice(-1)?.[0] || 0) +
                      (nc['PPF (Debt)']?.values?.slice(-1)?.[0] || 0) +
                      (nc['Bonds (Debt)']?.values?.slice(-1)?.[0] || 0));

  // Total equity gain (stocks + MFs) in lakhs
  const totalEquityGainLakhs = stockGainLakhs + mfGainLakhs;
  const totalEquityUploadedLakhs = (totalStockUploadedVal + totalMfUploadedVal) / 100000;
  const totalEquityGainPct = totalEquityUploadedLakhs > 0 ? (totalEquityGainLakhs / totalEquityUploadedLakhs) * 100 : 0;

  // Format uploaded values in lakhs for display
  const stockUploadedLakhs = totalStockUploadedVal / 100000;
  const mfUploadedLakhs = totalMfUploadedVal / 100000;
  const stockCurrentLakhs = totalStockCurrentVal / 100000;
  const mfCurrentLakhs = totalMfCurrentVal / 100000;

  container.innerHTML = `
    <div class="monthly-kpi-card" style="--kpi-accent: #10b981;">
      <div class="monthly-kpi-label">Total Portfolio Value</div>
      <div class="monthly-kpi-value">${formatLakhs(totalCurrent)}</div>
      <div class="monthly-kpi-sub">Invested: ${formatLakhs(totalInvested)}</div>
      <div class="monthly-kpi-sub ${totalReturns >= 0 ? 'trend-up' : 'trend-down'}">
        Returns: ${totalReturns >= 0 ? '+' : ''}${totalReturns.toFixed(2)} L (${totalReturnsPct >= 0 ? '+' : ''}${totalReturnsPct.toFixed(2)}%)
      </div>
    </div>
    <div class="monthly-kpi-card" style="--kpi-accent: #3b82f6;">
      <div class="monthly-kpi-label">Stocks (Since Last Upload)</div>
      <div class="monthly-kpi-value">${formatLakhs(stockCurrentLakhs)}</div>
      <div class="monthly-kpi-sub">Uploaded: ${formatLakhs(stockUploadedLakhs)}</div>
      <div class="monthly-kpi-sub ${stockGainLakhs >= 0 ? 'trend-up' : 'trend-down'}">
        Gain: ${stockGainLakhs >= 0 ? '+' : ''}${stockGainLakhs.toFixed(2)} L (${stockGainPct >= 0 ? '+' : ''}${stockGainPct.toFixed(2)}%)
      </div>
    </div>
    <div class="monthly-kpi-card" style="--kpi-accent: #8b5cf6;">
      <div class="monthly-kpi-label">Mutual Funds (Since Last Upload)</div>
      <div class="monthly-kpi-value">${formatLakhs(mfCurrentLakhs)}</div>
      <div class="monthly-kpi-sub">Uploaded: ${formatLakhs(mfUploadedLakhs)}</div>
      <div class="monthly-kpi-sub ${mfGainLakhs >= 0 ? 'trend-up' : 'trend-down'}">
        Gain: ${mfGainLakhs >= 0 ? '+' : ''}${mfGainLakhs.toFixed(2)} L (${mfGainPct >= 0 ? '+' : ''}${mfGainPct.toFixed(2)}%)
      </div>
    </div>
    <div class="monthly-kpi-card" style="--kpi-accent: #f59e0b;">
      <div class="monthly-kpi-label">Debt (PF + PPF + Bonds)</div>
      <div class="monthly-kpi-value">${formatLakhs(debtCurrent)}</div>
      <div class="monthly-kpi-sub ${debtChange >= 0 ? 'trend-up' : 'trend-down'}">
        ${debtChange >= 0 ? '+' : ''}${debtChange.toFixed(2)} L since last upload
      </div>
    </div>
  `;
}

// ==================== HISTORICAL GROWTH TAB ====================
function initGrowthTab() {
  // Destroy existing charts before re-creating
  if (netWorthGrowthChart) netWorthGrowthChart.destroy();
  if (capitalVsValuationChart) capitalVsValuationChart.destroy();
  if (benchmarkComparisonChart) benchmarkComparisonChart.destroy();
  if (rollingReturnsChart) rollingReturnsChart.destroy();
  if (allocationChart) allocationChart.destroy();
  if (componentXirrChart) componentXirrChart.destroy();
  if (allocationShiftChart) allocationShiftChart.destroy();

  const dates = breakupSummary.dates;
  const nwSec = breakupSummary.net_worth;
  const nwDatasets = [];
  
  Object.keys(nwSec).forEach(key => {
    if (key !== 'Total') {
      const label = nwSec[key].label;
      const vals = nwSec[key].values;
      
      nwDatasets.push({
        label: label,
        data: vals,
        backgroundColor: getAssetColor(label) + 'b3',
        borderColor: getAssetColor(label),
        borderWidth: 1.5,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4
      });
    }
  });
  
  const ctxGrowth = document.getElementById('net-worth-growth-chart').getContext('2d');
  netWorthGrowthChart = new Chart(ctxGrowth, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: nwDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => '₹' + value + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // Capital vs Valuation Line Chart
  const totalNw = nwSec["Total"].values;
  const rawCumInvested = portfolioSummary.cumulative_investment_history;
  // Offset cumulative investment to start at the same level as the initial portfolio valuation
  // This ensures the chart shows capital invested vs valuation on a comparable basis
  const offset = totalNw.length > 0 && rawCumInvested.length > 0 ? totalNw[0] - rawCumInvested[0] : 0;
  const cumInvested = rawCumInvested.map(v => v + offset);
  
  const ctxCap = document.getElementById('capital-vs-valuation-chart').getContext('2d');
  capitalVsValuationChart = new Chart(ctxCap, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Total Portfolio Valuation (Net Worth)',
          data: totalNw,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.05)',
          borderWidth: 3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'Cumulative Capital Invested',
          data: cumInvested,
          borderColor: '#6366f1',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => '₹' + value + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // ── Asset Allocation, XIRR, and Allocation Shift (moved from Overview tab) ──
  
  // 1. Asset Allocation Over Time (Stacked Bar, 100%)
  // Group net_worth keys into 5 asset categories
  const categoryMap = {
    'Equity':    ['Stocks (Equity)', 'Mutual Funds (Equity)', 'NPS E (Equity)'],
    'Debt':      ['NPS C (Debt)', 'NPS G (Debt)', 'PF (Debt)', 'PPF (Debt)', 'Bonds (Debt)'],
    'Gold':      ['Gold (Gold)'],
    'Liquid':    ['Cash (Liquid)'],
    'Alternate': ['Crypto (Alternate)']
  };
  
  // Compute category-level absolute values per time point
  const catValues = {};
  Object.keys(categoryMap).forEach(cat => {
    catValues[cat] = new Array(dates.length).fill(0);
    categoryMap[cat].forEach(key => {
      if (nwSec[key]) {
        nwSec[key].values.forEach((v, i) => { catValues[cat][i] += v; });
      }
    });
  });
  
  // Compute percentage per category (each date sums to 100%)
  const totalPerDate = dates.map((_, i) =>
    Object.keys(categoryMap).reduce((sum, cat) => sum + catValues[cat][i], 0)
  );
  
  const allocStackedDatasets = Object.keys(categoryMap).map(cat => ({
    label: cat,
    data: catValues[cat].map((v, i) => totalPerDate[i] > 0 ? (v / totalPerDate[i]) * 100 : 0),
    backgroundColor: getAssetColor(cat) + 'cc',
    borderColor: getAssetColor(cat),
    borderWidth: 0.5
  }));
  
  const ctxAlloc = document.getElementById('allocation-stacked-bar-chart').getContext('2d');
  
  allocationChart = new Chart(ctxAlloc, {
    type: 'bar',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: allocStackedDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: '#9ca3af', maxTicksLimit: 12, font: { family: 'Outfit' } }
        },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', font: { family: 'Outfit' }, callback: (value) => value + '%' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 11 } } },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${context.raw.toFixed(2)}%`
          }
        }
      }
    }
  });

  // 2. Component XIRR Over Time (Line Chart)
  // Start from Jan 2023 to avoid early outlier artifacts
  const xirrStartIdx = dates.findIndex(d => d >= '2023-01-01');
  const xirrDates = dates.slice(xirrStartIdx);
  
  const xirrSec = breakupSummary.xirr;
  const nwSecXirr = breakupSummary.net_worth;
  const xirrDatasets = [];
  
  Object.keys(xirrSec).forEach(key => {
    if (key !== 'Average' && key !== 'Total') {
      const label = xirrSec[key].label;
      const vals = xirrSec[key].values;
      // Skip components that are all zeros (never had XIRR data)
      const hasData = vals.some(v => v !== 0);
      if (!hasData) return;
      
      // Exclude components with current value < 5 lakhs (too small for meaningful XIRR)
      const currentVal = nwSecXirr[key] ? nwSecXirr[key].values[nwSecXirr[key].values.length - 1] : 0;
      if (currentVal < 5) return;
      
      xirrDatasets.push({
        label: label,
        data: vals.slice(xirrStartIdx).map(v => v * 100),
        borderColor: getAssetColor(label),
        backgroundColor: getAssetColor(label) + '33',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false
      });
    }
  });
  
  const ctxXirr = document.getElementById('component-xirr-chart').getContext('2d');
  componentXirrChart = new Chart(ctxXirr, {
    type: 'line',
    data: {
      labels: xirrDates.map(d => formatDateString(d)),
      datasets: xirrDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12, font: { family: 'Outfit' } } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', font: { family: 'Outfit' }, callback: (value) => value + '%' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 11 } } },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${context.raw.toFixed(2)}%`
          }
        }
      }
    }
  });

  // 3. Historical Allocation Shift Area Chart
  // dates already declared above
  const contribSec = breakupSummary.contribution;
  const contribDatasets = [];
  
  Object.keys(contribSec).forEach(key => {
    if (key !== 'Total') {
      const label = contribSec[key].label;
      const vals = contribSec[key].values.map(v => v * 100);
      
      contribDatasets.push({
        label: label,
        data: vals,
        backgroundColor: getAssetColor(label) + 'cc',
        borderColor: getAssetColor(label),
        borderWidth: 1,
        fill: true
      });
    }
  });
  
  const ctxShift = document.getElementById('allocation-shift-chart').getContext('2d');
  allocationShiftChart = new Chart(ctxShift, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: contribDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => value + '%' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // Initialize benchmark comparison chart (default: Nifty 50)
  renderBenchmarkComparisonChart('nifty50');
  renderRollingReturnsChart();
  updateBenchmarkStats('nifty50');
}

function filterGrowthChart() {
  const filter = document.getElementById('growth-time-filter').value;
  const dates = breakupSummary.dates;
  let len = dates.length;
  
  let sliceIdx = 0;
  if (filter === '3Y') {
    sliceIdx = Math.max(0, len - 36);
  } else if (filter === '1Y') {
    sliceIdx = Math.max(0, len - 12);
  }
  
  const filteredLabels = dates.slice(sliceIdx).map(d => formatDateString(d));
  
  // Update Net Worth chart
  netWorthGrowthChart.data.labels = filteredLabels;
  netWorthGrowthChart.data.datasets.forEach((dataset, idx) => {
    const key = Object.keys(breakupSummary.net_worth).filter(k => k !== 'Total')[idx];
    dataset.data = breakupSummary.net_worth[key].values.slice(sliceIdx);
  });
  netWorthGrowthChart.update();
  
  // Update Capital vs Valuation chart
  capitalVsValuationChart.data.labels = filteredLabels;
  capitalVsValuationChart.data.datasets[0].data = breakupSummary.net_worth["Total"].values.slice(sliceIdx);
  capitalVsValuationChart.data.datasets[1].data = portfolioSummary.cumulative_investment_history.slice(sliceIdx);
  capitalVsValuationChart.update();
}

// ==================== FIXED INCOME TAB (PF / PPF / Bonds) ====================
function initFixedIncomeTab() {
  // Destroy existing charts before re-creating
  if (window.pfGrowthChart) window.pfGrowthChart.destroy();
  if (window.ppfGrowthChart) window.ppfGrowthChart.destroy();
  if (window.bondsGrowthChart) window.bondsGrowthChart.destroy();

  const nw = breakupSummary.net_worth;
  const dates = breakupSummary.dates;
  const contrib = breakupSummary.contribution;

  // Helper: get monthly change in lakhs
  const getMonthlyChangeLakhs = (key) => {
    const vals = nw[key]?.values || [];
    if (vals.length >= 2) {
      return vals[vals.length - 1] - vals[vals.length - 2];
    }
    return 0;
  };

  // Helper: get total invested (sum of new_investment values, which are actual monthly amounts in lakhs)
  const getTotalInvested = (key) => {
    const vals = breakupSummary.new_investment?.[key]?.values || [];
    // Sum all monthly investment amounts to get total invested
    return vals.reduce((sum, v) => sum + v, 0);
  };

  // Helper: get total returns (nwKey for net_worth, newInvKey for new_investment)
  const getTotalReturns = (nwKey, newInvKey) => {
    const vals = nw[nwKey]?.values || [];
    const invVals = breakupSummary.new_investment?.[newInvKey]?.values || [];
    if (vals.length > 0) {
      const totalInvested = invVals.reduce((sum, v) => sum + v, 0);
      return vals[vals.length - 1] - totalInvested;
    }
    return 0;
  };

  // Update KPIs
  const pfCurrent = nw['PF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const pfGain = getMonthlyChangeLakhs('PF (Debt)');
  document.getElementById('fi-pf-value').innerText = formatLakhs(pfCurrent);
  document.getElementById('fi-pf-gain').innerText = (pfGain >= 0 ? '+' : '') + pfGain.toFixed(2) + ' L';
  document.getElementById('fi-pf-gain').className = pfGain >= 0 ? 'trend-up' : 'trend-down';

  const ppfCurrent = nw['PPF (Debt)']?.values?.slice(-1)?.[0] || 0;
  const ppfGain = getMonthlyChangeLakhs('PPF (Debt)');
  document.getElementById('fi-ppf-value').innerText = formatLakhs(ppfCurrent);
  document.getElementById('fi-ppf-gain').innerText = (ppfGain >= 0 ? '+' : '') + ppfGain.toFixed(2) + ' L';
  document.getElementById('fi-ppf-gain').className = ppfGain >= 0 ? 'trend-up' : 'trend-down';

  const bondsCurrent = nw['Bonds (Debt)']?.values?.slice(-1)?.[0] || 0;
  const bondsGain = getMonthlyChangeLakhs('Bonds (Debt)');
  document.getElementById('fi-bonds-value').innerText = formatLakhs(bondsCurrent);
  document.getElementById('fi-bonds-gain').innerText = (bondsGain >= 0 ? '+' : '') + bondsGain.toFixed(2) + ' L';
  document.getElementById('fi-bonds-gain').className = bondsGain >= 0 ? 'trend-up' : 'trend-down';

  // 1. PF Growth Chart
  const pfVals = nw['PF (Debt)']?.values || [];
  const pfNewInvVals = breakupSummary.new_investment?.['PF (Debt)']?.values || [];
  // Cumulative investment starts from initial portfolio value (Jan 2021)
  // so the investment line begins at the same point as the value line
  const pfInitialVal = pfVals.length > 0 ? pfVals[0] : 0;
  let pfCumulative = pfInitialVal;
  const pfCumulVals = pfNewInvVals.map(v => { pfCumulative += v; return pfCumulative; });
  const ctxPf = document.getElementById('pf-growth-chart').getContext('2d');
  window.pfGrowthChart = new Chart(ctxPf, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'PF Current Value (₹ L)',
          data: pfVals,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'PF Cumulative Investment (₹ L)',
          data: pfCumulVals,
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // 2. PPF Growth Chart
  const ppfVals = nw['PPF (Debt)']?.values || [];
  const ppfNewInvVals = breakupSummary.new_investment?.['PPF (Debt)']?.values || [];
  const ppfInitialVal = ppfVals.length > 0 ? ppfVals[0] : 0;
  let ppfCumulative = ppfInitialVal;
  const ppfCumulVals = ppfNewInvVals.map(v => { ppfCumulative += v; return ppfCumulative; });
  const ctxPpf = document.getElementById('ppf-growth-chart').getContext('2d');
  window.ppfGrowthChart = new Chart(ctxPpf, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'PPF Current Value (₹ L)',
          data: ppfVals,
          borderColor: '#ec4899',
          backgroundColor: 'rgba(236, 72, 153, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'PPF Cumulative Investment (₹ L)',
          data: ppfCumulVals,
          borderColor: '#ec4899',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // 3. Bonds Growth Chart
  const bondsVals = nw['Bonds (Debt)']?.values || [];
  const bondsNewInvVals = breakupSummary.new_investment?.['Bonds (Debt)']?.values || [];
  const bondsInitialVal = bondsVals.length > 0 ? bondsVals[0] : 0;
  let bondsCumulative = bondsInitialVal;
  const bondsCumulVals = bondsNewInvVals.map(v => { bondsCumulative += v; return bondsCumulative; });
  const ctxBonds = document.getElementById('bonds-growth-chart').getContext('2d');
  window.bondsGrowthChart = new Chart(ctxBonds, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Bonds Current Value (₹ L)',
          data: bondsVals,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'Bonds Cumulative Investment (₹ L)',
          data: bondsCumulVals,
          borderColor: '#8b5cf6',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // 4. Fixed Income Summary Table
  const fiItems = [
    { name: 'PF (Debt)', nwKey: 'PF (Debt)', newInvKey: 'PF (Debt)' },
    { name: 'PPF (Debt)', nwKey: 'PPF (Debt)', newInvKey: 'PPF (Debt)' },
    { name: 'Bonds (Debt)', nwKey: 'Bonds (Debt)', newInvKey: 'Bonds (Debt)' }
  ];

  const tbody = document.getElementById('fixed-income-body');
  tbody.innerHTML = fiItems.map(item => {
    const currentVal = nw[item.nwKey]?.values?.slice(-1)?.[0] || 0;
    const prevVal = nw[item.nwKey]?.values?.length >= 2 ? nw[item.nwKey].values[nw[item.nwKey].values.length - 2] : currentVal;
    const monthChange = currentVal - prevVal;
    const monthChangePct = prevVal > 0 ? (monthChange / prevVal) * 100 : 0;
    const totalInvested = getTotalInvested(item.newInvKey);
    const totalReturns = getTotalReturns(item.nwKey, item.newInvKey);

    return `
    <tr>
      <td style="font-weight: 600;">${escapeHtml(item.name)}</td>
      <td style="text-align: right;">${currentVal.toFixed(2)} L</td>
      <td style="text-align: right;" class="${monthChange >= 0 ? 'trend-up' : 'trend-down'}">
        ${monthChange >= 0 ? '+' : ''}${monthChange.toFixed(2)} L
      </td>
      <td style="text-align: right;" class="${monthChangePct >= 0 ? 'trend-up' : 'trend-down'}">
        ${monthChangePct >= 0 ? '+' : ''}${monthChangePct.toFixed(2)}%
      </td>
      <td style="text-align: right;">${totalInvested.toFixed(2)} L</td>
      <td style="text-align: right;" class="${totalReturns >= 0 ? 'trend-up' : 'trend-down'}">
        ${totalReturns >= 0 ? '+' : ''}${totalReturns.toFixed(2)} L
      </td>
    </tr>
    `;
  }).join('');
}

// ==================== NPS TAB ====================
function initNpsTab() {
  // Destroy existing charts before re-creating
  if (window.npsGrowthChart) window.npsGrowthChart.destroy();
  if (window.npsAllocationChart) window.npsAllocationChart.destroy();
  if (window.npsVsChart) window.npsVsChart.destroy();

  const nw = breakupSummary.net_worth;
  const dates = breakupSummary.dates;

  // Helper: get monthly change in lakhs
  const getMonthlyChangeLakhs = (key) => {
    const vals = nw[key]?.values || [];
    if (vals.length >= 2) {
      return vals[vals.length - 1] - vals[vals.length - 2];
    }
    return 0;
  };

  // NPS E (Equity)
  const npsEVal = nw['NPS E (Equity)']?.values?.slice(-1)?.[0] || 0;
  const npsEGain = getMonthlyChangeLakhs('NPS E (Equity)');
  document.getElementById('nps-e-value').innerText = formatLakhs(npsEVal);
  document.getElementById('nps-e-gain').innerText = (npsEGain >= 0 ? '+' : '') + npsEGain.toFixed(2) + ' L';
  document.getElementById('nps-e-gain').className = npsEGain >= 0 ? 'trend-up' : 'trend-down';

  // NPS C (Debt)
  const npsCVal = nw['NPS C (Debt)']?.values?.slice(-1)?.[0] || 0;
  const npsCGain = getMonthlyChangeLakhs('NPS C (Debt)');
  document.getElementById('nps-c-value').innerText = formatLakhs(npsCVal);
  document.getElementById('nps-c-gain').innerText = (npsCGain >= 0 ? '+' : '') + npsCGain.toFixed(2) + ' L';
  document.getElementById('nps-c-gain').className = npsCGain >= 0 ? 'trend-up' : 'trend-down';

  // NPS G (Debt)
  const npsGVal = nw['NPS G (Debt)']?.values?.slice(-1)?.[0] || 0;
  const npsGGain = getMonthlyChangeLakhs('NPS G (Debt)');
  document.getElementById('nps-g-value').innerText = formatLakhs(npsGVal);
  document.getElementById('nps-g-gain').innerText = (npsGGain >= 0 ? '+' : '') + npsGGain.toFixed(2) + ' L';
  document.getElementById('nps-g-gain').className = npsGGain >= 0 ? 'trend-up' : 'trend-down';

  // Total NPS
  const npsTotal = npsEVal + npsCVal + npsGVal;
  const npsTotalGain = npsEGain + npsCGain + npsGGain;
  document.getElementById('nps-total-value').innerText = formatLakhs(npsTotal);
  document.getElementById('nps-total-gain').innerText = (npsTotalGain >= 0 ? '+' : '') + npsTotalGain.toFixed(2) + ' L';
  document.getElementById('nps-total-gain').className = npsTotalGain >= 0 ? 'trend-up' : 'trend-down';

  // 1. NPS Component Growth Chart
  const npsEVals = nw['NPS E (Equity)']?.values || [];
  const npsCVals = nw['NPS C (Debt)']?.values || [];
  const npsGVals = nw['NPS G (Debt)']?.values || [];

  const ctxNps = document.getElementById('nps-growth-chart').getContext('2d');
  window.npsGrowthChart = new Chart(ctxNps, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'NPS E (Equity)',
          data: npsEVals,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'NPS C (Debt)',
          data: npsCVals,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'NPS G (Debt)',
          data: npsGVals,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // 2. NPS Valuation vs Cumulative Investment Chart
  // Build total NPS valuation per date (E + C + G)
  const npsTotalVals = npsEVals.map((_, i) => {
    return (npsEVals[i] || 0) + (npsCVals[i] || 0) + (npsGVals[i] || 0);
  });
  // Build cumulative NPS investment per date from new_investment data
  const npsNewInvE = breakupSummary.new_investment?.['NPS E (Equity)']?.values || [];
  const npsNewInvC = breakupSummary.new_investment?.['NPS C (Debt)']?.values || [];
  const npsNewInvG = breakupSummary.new_investment?.['NPS G (Debt)']?.values || [];
  let cumInvRunning = 0;
  const npsCumInv = npsNewInvE.map((_, i) => {
    cumInvRunning += (npsNewInvE[i] || 0) + (npsNewInvC[i] || 0) + (npsNewInvG[i] || 0);
    return cumInvRunning;
  });
  // Offset cumulative investment to start at same level as initial valuation
  const npsInvOffset = npsTotalVals.length > 0 && npsCumInv.length > 0
    ? npsTotalVals[0] - npsCumInv[0] : 0;
  const npsCumInvOffset = npsCumInv.map(v => v + npsInvOffset);

  const ctxNpsVs = document.getElementById('nps-vs-chart').getContext('2d');
  window.npsVsChart = new Chart(ctxNpsVs, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Total NPS Valuation',
          data: npsTotalVals,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.05)',
          borderWidth: 3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'Cumulative NPS Investment',
          data: npsCumInvOffset,
          borderColor: '#6366f1',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const label = ctx.dataset.label || '';
              const val = ctx.parsed.y;
              return ` ${label}: ₹${val.toFixed(2)} L`;
            }
          }
        }
      }
    }
  });

  // 3. NPS Investment Summary Table (showing invested & returns per component)
  const npsInvE = npsNewInvE.reduce((s, v) => s + v, 0);
  const npsInvC = npsNewInvC.reduce((s, v) => s + v, 0);
  const npsInvG = npsNewInvG.reduce((s, v) => s + v, 0);
  const npsTotalInv = npsInvE + npsInvC + npsInvG;
  const npsReturnsE = npsEVal - npsInvE;
  const npsReturnsC = npsCVal - npsInvC;
  const npsReturnsG = npsGVal - npsInvG;
  const npsTotalReturns = npsReturnsE + npsReturnsC + npsReturnsG;

  const summaryContainer = document.getElementById('nps-summary');
  summaryContainer.innerHTML = `
    <div class="table-wrapper">
      <table class="nps-summary-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>Current Value</th>
            <th>Total Invested</th>
            <th>Total Returns</th>
            <th>Returns %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight: 600;">NPS E (Equity)</td>
            <td style="text-align: right;">${formatLakhs(npsEVal)}</td>
            <td style="text-align: right;">${npsInvE.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsE >= 0 ? 'trend-up' : 'trend-down'}">${npsReturnsE >= 0 ? '+' : ''}${npsReturnsE.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsE >= 0 ? 'trend-up' : 'trend-down'}">${npsInvE > 0 ? ((npsReturnsE / npsInvE) * 100).toFixed(1) : 0}%</td>
          </tr>
          <tr>
            <td style="font-weight: 600;">NPS C (Debt)</td>
            <td style="text-align: right;">${formatLakhs(npsCVal)}</td>
            <td style="text-align: right;">${npsInvC.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsC >= 0 ? 'trend-up' : 'trend-down'}">${npsReturnsC >= 0 ? '+' : ''}${npsReturnsC.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsC >= 0 ? 'trend-up' : 'trend-down'}">${npsInvC > 0 ? ((npsReturnsC / npsInvC) * 100).toFixed(1) : 0}%</td>
          </tr>
          <tr>
            <td style="font-weight: 600;">NPS G (Debt)</td>
            <td style="text-align: right;">${formatLakhs(npsGVal)}</td>
            <td style="text-align: right;">${npsInvG.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsG >= 0 ? 'trend-up' : 'trend-down'}">${npsReturnsG >= 0 ? '+' : ''}${npsReturnsG.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsReturnsG >= 0 ? 'trend-up' : 'trend-down'}">${npsInvG > 0 ? ((npsReturnsG / npsInvG) * 100).toFixed(1) : 0}%</td>
          </tr>
          <tr style="border-top: 1px solid rgba(255,255,255,0.06); font-weight: 700;">
            <td>Total NPS</td>
            <td style="text-align: right; color: var(--accent-indigo);">${formatLakhs(npsTotal)}</td>
            <td style="text-align: right;">${npsTotalInv.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsTotalReturns >= 0 ? 'trend-up' : 'trend-down'}">${npsTotalReturns >= 0 ? '+' : ''}${npsTotalReturns.toFixed(2)} L</td>
            <td style="text-align: right;" class="${npsTotalReturns >= 0 ? 'trend-up' : 'trend-down'}">${npsTotalInv > 0 ? ((npsTotalReturns / npsTotalInv) * 100).toFixed(1) : 0}%</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.06); font-size: 0.85rem; color: var(--text-secondary);">
      This Month Change: <span class="${npsTotalGain >= 0 ? 'trend-up' : 'trend-down'}">${npsTotalGain >= 0 ? '+' : ''}${npsTotalGain.toFixed(2)} L</span>
    </div>
  `;
}

// ==================== STOCKS TAB ====================
function initStocksTab() {
  // Destroy existing chart before re-creating
  if (sectorChart) sectorChart.destroy();
  if (stockHistoricalChart) stockHistoricalChart.destroy();

  // Normalize gain_pct: compute from pnl/invested if missing or zero
  latestEquity.forEach(s => {
    if (!s.gain_pct || s.gain_pct === 0) {
      s.gain_pct = s.invested > 0 ? (s.pnl / s.invested) * 100 : 0;
    }
  });

  // 1. Winners & Losers lists
  const sortedEq = [...latestEquity];
  const winners = sortedEq.sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  const losers = sortedEq.sort((a, b) => a.pnl - b.pnl).slice(0, 5); // sorted ascending, first ones are biggest losses

  const winContainer = document.getElementById('stock-winners-list');
  winContainer.innerHTML = winners.map(w => `
    <div class="performer-item">
      <span class="performer-name">${escapeHtml(w.instrument)} <span style="font-weight:normal; font-size:0.75rem; color:var(--text-muted)">(${escapeHtml(w.sector)})</span></span>
      <span class="performer-pnl trend-up">+${formatINR(w.pnl)} (+${w.gain_pct.toFixed(1)}%)</span>
    </div>
  `).join('');

  const loseContainer = document.getElementById('stock-losers-list');
  loseContainer.innerHTML = losers.map(l => `
    <div class="performer-item">
      <span class="performer-name">${escapeHtml(l.instrument)} <span style="font-weight:normal; font-size:0.75rem; color:var(--text-muted)">(${escapeHtml(l.sector)})</span></span>
      <span class="performer-pnl trend-down">${formatINR(l.pnl)} (${l.gain_pct.toFixed(1)}%)</span>
    </div>
  `).join('');

  // 2. Stacked Bar Chart — Equity Portfolio Sector Distribution over Time
  const stockHistory = historicalHoldings.stocks;

  // Collect all unique dates from all stock histories
  // Filter to start from Aug 2022 when sector mapping (ticker-based) became available
  const allStockDates = new Set();
  Object.values(stockHistory).forEach(stock => {
    stock.history.forEach(h => {
      if (h.date >= '2022-08-01') allStockDates.add(h.date);
    });
  });
  const sortedStockDates = [...allStockDates].sort();

  // For each date, sum cur_val by sector across all stocks
  const dateSectorMap = {};
  sortedStockDates.forEach(date => {
    dateSectorMap[date] = {};
    Object.values(stockHistory).forEach(stock => {
      const entry = stock.history.find(h => h.date === date);
      if (entry) {
        const sec = stock.sector;
        dateSectorMap[date][sec] = (dateSectorMap[date][sec] || 0) + entry.cur_val;
      }
    });
  });

  // Collect all sectors across all dates, sorted by latest total value desc
  const latestStockDate = sortedStockDates[sortedStockDates.length - 1];
  const allSectorsSet = new Set();
  sortedStockDates.forEach(d => Object.keys(dateSectorMap[d] || {}).forEach(s => allSectorsSet.add(s)));
  const allSectorsSorted = [...allSectorsSet]
    .sort((a, b) => (dateSectorMap[latestStockDate][b] || 0) - (dateSectorMap[latestStockDate][a] || 0));

  // Show top 12 sectors, group the rest as "Others"
  const TOP_SECTORS = 12;
  const topSectors = allSectorsSorted.slice(0, TOP_SECTORS);
  const hasOtherSectors = allSectorsSorted.length > TOP_SECTORS;

  // Color palette for sectors (12 colors + 1 for Others)
  const sectorColors = [
    '#3b82f6', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
    '#a855f7', '#e11d48', '#64748b'
  ];

  const ctxSec = document.getElementById('stock-sector-chart').getContext('2d');
  sectorChart = new Chart(ctxSec, {
    type: 'bar',
    data: {
      labels: sortedStockDates.map(d => {
        const parts = d.split('-');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
      }),
      datasets: [
        ...topSectors.map((sec, idx) => ({
          label: sec,
          data: sortedStockDates.map(d => ((dateSectorMap[d][sec] || 0) / 100000)),
          backgroundColor: sectorColors[idx % sectorColors.length],
          borderWidth: 1,
          borderColor: 'rgba(255, 255, 255, 0.06)'
        })),
        ...(hasOtherSectors ? [{
          label: 'Others',
          data: sortedStockDates.map(d => {
            return allSectorsSorted.slice(TOP_SECTORS).reduce((sum, s) => sum + (dateSectorMap[d][s] || 0), 0) / 100000;
          }),
          backgroundColor: '#64748b',
          borderWidth: 1,
          borderColor: 'rgba(255, 255, 255, 0.06)'
        }] : [])
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit', size: 9 },
            maxRotation: 45,
            minRotation: 30,
            autoSkip: true,
            maxTicksLimit: 20
          }
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit', size: 10 },
            callback: (val) => '₹' + val.toFixed(2) + ' L'
          },
          beginAtZero: true
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: getResponsiveLegendLabels(9)
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const label = ctx.dataset.label || '';
              const val = ctx.parsed.y;
              return ` ${label}: ₹${val.toFixed(2)} L`;
            },
            footer: (items) => {
              const total = items.reduce((sum, item) => sum + item.parsed.y, 0);
              return ` Total: ₹${total.toFixed(2)} L`;
            }
          }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      }
    }
  });

  // 3. Stock Selector List for Historical Explorer
  const sortedByVal = [...latestEquity].sort((a, b) => b.cur_val - a.cur_val);
  const explorerList = document.getElementById('explorer-stock-list');
  
  explorerList.innerHTML = sortedByVal.map((s, idx) => `
    <div class="explorer-item ${idx === 0 ? 'active' : ''}" data-symbol="${escapeAttr(s.instrument)}">
      <span class="name">${escapeHtml(s.instrument)}</span>
      <span class="val">${formatINR(s.cur_val)}</span>
    </div>
  `).join('');

  explorerList.querySelectorAll('.explorer-item').forEach(item => {
    item.addEventListener('click', () => selectStockExplorer(item.dataset.symbol, item));
  });

  // Populate Stock Sector Dropdown
  const sectors = [...new Set(latestEquity.map(s => s.sector))].sort();
  const sectorDropdown = document.getElementById('stock-sector-filter');
  sectorDropdown.innerHTML = '<option value="ALL">All Sectors</option>' + 
    sectors.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');

  // Load first stock history
  if (sortedByVal.length > 0) {
    renderStockHistoricalChart(sortedByVal[0].instrument);
  }

  // Populate Table - default sort by This Month Gain (col 10) descending
  stockSortColumn = 10;
  stockSortAsc = false;
  const stockThs = document.querySelectorAll('#stocks-table th');
  stockThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === 10) th.classList.add('sort-desc');
  });
  const sortedStocks = [...latestEquity].sort((a, b) => (b.thisMonthGain ?? 0) - (a.thisMonthGain ?? 0));
  renderStocksTable(sortedStocks);
}

function selectStockExplorer(symbol, element) {
  document.querySelectorAll('#explorer-stock-list .explorer-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');
  renderStockHistoricalChart(symbol);
}

function renderStockHistoricalChart(symbol) {
  // Build a lookup map from ticker symbols to historical holdings names
  // historical_holdings uses full names (e.g. "Ajanta Pharma Ltd.") while
  // latest_equity uses ticker symbols (e.g. "AJANTPHARM")
  // Build the mapping once and cache it
  if (!window._stockNameMap) {
    window._stockNameMap = {};
    const stockKeys = Object.keys(historicalHoldings.stocks);
    stockKeys.forEach(key => {
      const upper = key.toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      // Exact clean match (e.g., "SUNPHARMA" -> "SUNPHARMA")
      window._stockNameMap[clean] = key;
      // Without "LTD" or "LIMITED" suffix (e.g., "HDFCBANK" -> "HDFC Bank Ltd.")
      const withoutLtd = clean.replace(/LTD$/, '').replace(/LIMITED$/, '').trim();
      if (withoutLtd && withoutLtd !== clean) window._stockNameMap[withoutLtd] = key;
      // First significant word of multi-word names (e.g., "APOLLO" -> "Apollo Tyres Ltd.")
      const words = upper.split(/[^A-Z0-9]+/).filter(w => w.length > 2);
      if (words.length > 1) {
        if (!window._stockNameMap[words[0]]) {
          window._stockNameMap[words[0]] = key;
        }
      }
      // For names with "&", map each part (e.g., "M&M" -> "Mahindra & Mahindra Ltd.")
      if (upper.includes('&')) {
        upper.split('&').forEach(p => {
          const trimmed = p.replace(/[^A-Z0-9]/g, '').trim();
          if (trimmed.length >= 3 && !window._stockNameMap[trimmed]) {
            window._stockNameMap[trimmed] = key;
          }
        });
      }
    });
  }
  
  if (stockHistoricalChart) {
    stockHistoricalChart.destroy();
    stockHistoricalChart = null;
  }
  
  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stockKey = window._stockNameMap[cleanSymbol] || symbol;
  const stock = historicalHoldings.stocks[stockKey];
  if (!stock) return;
  
  const history = stock.history;
  
  // Build chart data arrays from history
  const labels = history.map(h => formatDateString(h.date));
  const valuations = history.map(h => h.cur_val / 100000);
  const investments = history.map(h => h.invested / 100000);
  const ltps = history.map(h => h.ltp);
  
  const ctxStockHist = document.getElementById('stock-historical-chart').getContext('2d');
  
  stockHistoricalChart = new Chart(ctxStockHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (₹ L)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (₹ L)',
          data: investments,
          borderColor: '#10b981',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          yAxisID: 'y'
        },
        {
          label: 'LTP (Price in ₹)',
          data: ltps,
          borderColor: '#f59e0b',
          borderWidth: 2,
          fill: false,
          yAxisID: 'yPrice'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: true,
          text: `${symbol} Performance History`,
          color: '#fff',
          font: { family: 'Outfit', size: 16 }
        },
        legend: { labels: { color: '#f3f4f6' } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10 } },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val.toFixed(2) + ' L' }
        },
        yPrice: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val }
        }
      }
    }
  });
  
  // Populate historical data table below the chart (shows incremental changes — only rows where qty changed)
  const tableContainer = document.getElementById('stock-historical-data-table');
  if (tableContainer) {
    const tbody = document.getElementById('stock-historical-data-body');
    if (!tbody) return;
    // Build incremental rows: for each row where qty changed, show the delta from previous row
    const deltaRows = [];
    for (let idx = 0; idx < history.length; idx++) {
      const h = history[idx];
      if (idx === 0) {
        // First row: show initial position
        if (h.qty > 0) {
          deltaRows.push({
            date: h.date,
            deltaQty: h.qty,
            price: h.ltp,
            deltaInvested: h.invested,
            deltaValuation: h.cur_val,
            action: 'Buy'
          });
        }
      } else {
        const prev = history[idx - 1];
        const dQty = h.qty - prev.qty;
        if (Math.abs(dQty) > 0.001) {
          deltaRows.push({
            date: h.date,
            deltaQty: dQty,
            price: h.ltp,
            deltaInvested: h.invested - prev.invested,
            deltaValuation: h.cur_val - prev.cur_val,
            action: dQty > 0 ? 'Buy' : 'Sell'
          });
        }
      }
    }
    tbody.innerHTML = deltaRows.map(r => {
      const actionStyle = r.action === 'Buy' ? 'background:rgba(16,185,129,0.2);color:#34d399' : 'background:rgba(239,68,68,0.2);color:#f87171';
      return `
      <tr>
        <td>${formatDateString(r.date)}</td>
        <td style="text-align: right;" class="${r.deltaQty > 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaQty > 0 ? '+' : ''}${r.deltaQty.toLocaleString(undefined, {maximumFractionDigits:2})}
        </td>
        <td style="text-align: right;">${'₹' + r.price.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
        <td style="text-align: right;" class="${r.deltaInvested >= 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaInvested >= 0 ? '+' : ''}${formatINR(Math.abs(r.deltaInvested))}
        </td>
        <td style="text-align: right;" class="${r.deltaValuation >= 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaValuation >= 0 ? '+' : ''}${formatINR(Math.abs(r.deltaValuation))}
        </td>
        <td><span class="sector-tag" style="${actionStyle}">${r.action}</span></td>
      </tr>`;
    }).join('');
    tableContainer.style.display = 'block';
  }
}

function renderStocksTable(data) {
  const body = document.getElementById('stocks-table-body');
  body.innerHTML = data.map(s => {
    const uploadedPrice = s.lastUploadedPrice !== undefined ? `₹${s.lastUploadedPrice.toLocaleString(undefined, {maximumFractionDigits:2})}` : '—';
    const gain = s.thisMonthGain || 0;
    return `
    <tr>
      <td class="instrument-cell">${escapeHtml(s.instrument)}</td>
      <td><span class="sector-tag">${escapeHtml(s.sector)}</span></td>
      <td style="text-align: right;">${s.qty.toLocaleString()}</td>
      <td style="text-align: right;">₹${s.ltp.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${uploadedPrice}</td>
      <td style="text-align: right;">₹${s.avg_cost.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatINR(s.invested)}</td>
      <td style="text-align: right;">${formatINR(s.cur_val)}</td>
      <td style="text-align: right;" class="${s.pnl >= 0 ? 'trend-up' : 'trend-down'}">
        ${s.pnl >= 0 ? '+' : ''}${formatINR(s.pnl)}
      </td>
      <td style="text-align: right;" class="${s.gain_pct >= 0 ? 'trend-up' : 'trend-down'}">
        ${s.gain_pct >= 0 ? '+' : ''}${s.gain_pct.toFixed(2)}%
      </td>
      <td style="text-align: right;" class="${gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${gain >= 0 ? '+' : ''}${formatINR(gain)}
      </td>
      <td style="text-align: right;">${s.lastRefreshDate || '—'}</td>
    </tr>
  `}).join('');
}

function filterStocksTable() {
  const query = document.getElementById('stock-search').value.toLowerCase().trim();
  const sector = document.getElementById('stock-sector-filter').value;
  
  const filtered = latestEquity.filter(s => {
    const matchesQuery = s.instrument.toLowerCase().includes(query) || s.sector.toLowerCase().includes(query);
    const matchesSector = (sector === 'ALL') || (s.sector === sector);
    return matchesQuery && matchesSector;
  });
  
  renderStocksTable(filtered);
}

function sortStocks(colIdx) {
  if (stockSortColumn === colIdx) {
    stockSortAsc = !stockSortAsc;
  } else {
    stockSortColumn = colIdx;
    stockSortAsc = true;
  }

  // Update classes on headers
  const ths = document.querySelectorAll('#stocks-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(stockSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  const query = document.getElementById('stock-search').value.toLowerCase().trim();
  const sector = document.getElementById('stock-sector-filter').value;
  
  const filtered = latestEquity.filter(s => {
    const matchesQuery = s.instrument.toLowerCase().includes(query) || s.sector.toLowerCase().includes(query);
    const matchesSector = (sector === 'ALL') || (s.sector === sector);
    return matchesQuery && matchesSector;
  });

  filtered.sort((a, b) => {
    let valA, valB;
    switch(colIdx) {
      case 0: valA = a.instrument; valB = b.instrument; break;
      case 1: valA = a.sector; valB = b.sector; break;
      case 2: valA = a.qty; valB = b.qty; break;
      case 3: valA = a.ltp; valB = b.ltp; break;
      case 4: valA = a.lastUploadedPrice ?? 0; valB = b.lastUploadedPrice ?? 0; break;
      case 5: valA = a.avg_cost; valB = b.avg_cost; break;
      case 6: valA = a.invested; valB = b.invested; break;
      case 7: valA = a.cur_val; valB = b.cur_val; break;
      case 8: valA = a.pnl; valB = b.pnl; break;
      case 9: valA = a.gain_pct; valB = b.gain_pct; break;
      case 10: valA = a.thisMonthGain ?? 0; valB = b.thisMonthGain ?? 0; break;
      case 11: valA = a.lastRefreshDate || ''; valB = b.lastRefreshDate || ''; break;
    }
    
    if (typeof valA === 'string') {
      return stockSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return stockSortAsc ? valA - valB : valB - valA;
    }
  });

  renderStocksTable(filtered);
}

// ==================== MUTUAL FUNDS TAB ====================
function initMfsTab() {
  // Destroy existing charts before re-creating
  if (mfCategoryChart) mfCategoryChart.destroy();
  if (mfHistoricalChart) mfHistoricalChart.destroy();

  // 1. Stacked Bar Chart — MF Category Allocation over Time
  // Aggregate cur_val by category per date from historical MF data
  const mfHistory = historicalHoldings.mfs;
  const dateCategoryMap = {};

  // Collect all unique dates from all MF histories
  const allMfDates = new Set();
  Object.values(mfHistory).forEach(mf => {
    mf.history.forEach(h => allMfDates.add(h.date));
  });
  const sortedDates = [...allMfDates].sort();

  // For each date, sum cur_val by category across all MFs
  sortedDates.forEach(date => {
    dateCategoryMap[date] = {};
    Object.values(mfHistory).forEach(mf => {
      const entry = mf.history.find(h => h.date === date);
      if (entry) {
        const cat = mf.category;
        dateCategoryMap[date][cat] = (dateCategoryMap[date][cat] || 0) + entry.cur_val;
      }
    });
  });

  // Collect all categories that ever appear (across all dates), sorted by latest total value desc
  const latestDate = sortedDates[sortedDates.length - 1];
  const allCategories = new Set();
  sortedDates.forEach(d => Object.keys(dateCategoryMap[d] || {}).forEach(cat => allCategories.add(cat)));
  const catOrder = [...allCategories]
    .sort((a, b) => (dateCategoryMap[latestDate][b] || 0) - (dateCategoryMap[latestDate][a] || 0));

  // Color palette for categories
  const categoryColors = {
    'Equity : Small Cap': '#10b981',
    'Equity : Large Cap': '#3b82f6',
    'Equity : Mid Cap': '#8b5cf6',
    'Equity : Multi Cap': '#ec4899',
    'Equity : International': '#f59e0b',
    'Debt : Liquid': '#14b8a6',
    'Equity : Flexi Cap': '#f97316',
    'Equity : Sectoral-Technology': '#06b6d4'
  };

  const ctxMF = document.getElementById('mf-category-chart').getContext('2d');
  mfCategoryChart = new Chart(ctxMF, {
    type: 'bar',
    data: {
      labels: sortedDates.map(d => {
        // Format date for display: "MMM YYYY" or "YYYY-MM"
        const parts = d.split('-');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
      }),
      datasets: catOrder.map((cat, idx) => ({
        label: cat.replace('Equity : ', ''),
        data: sortedDates.map(d => ((dateCategoryMap[d][cat] || 0) / 100000)),
        backgroundColor: categoryColors[cat] || `hsla(${idx * 45}, 70%, 60%, 0.8)`,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.06)'
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit', size: 9 },
            maxRotation: 45,
            minRotation: 30,
            autoSkip: true,
            maxTicksLimit: 20
          }
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit', size: 10 },
            callback: (val) => '₹' + val.toFixed(2) + ' L'
          },
          beginAtZero: true
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: getResponsiveLegendLabels(9)
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const label = ctx.dataset.label || '';
              const val = ctx.parsed.y;
              return ` ${label}: ₹${val.toFixed(2)} L`;
            },
            footer: (items) => {
              const total = items.reduce((sum, item) => sum + item.parsed.y, 0);
              return ` Total: ₹${total.toFixed(2)} L`;
            }
          }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      }
    }
  });

  // 2. Scheme Selector for Explorer
  const sortedMFsByVal = [...latestMf].sort((a, b) => b.cur_val - a.cur_val);
  const explorerList = document.getElementById('explorer-mf-list');
  
  explorerList.innerHTML = sortedMFsByVal.map((f, idx) => `
    <div class="explorer-item ${idx === 0 ? 'active' : ''}" data-scheme="${escapeAttr(f.scheme)}">
      <span class="name">${escapeHtml(f.scheme.substring(0, 25) + '...')}</span>
      <span class="val">${formatINR(f.cur_val)}</span>
    </div>
  `).join('');

  explorerList.querySelectorAll('.explorer-item').forEach(item => {
    item.addEventListener('click', () => selectMfExplorer(item.dataset.scheme, item));
  });

  // Populate MF Category dropdown filter
  const categories = [...new Set(latestMf.map(f => f.scheme_type))].sort();
  const typeDropdown = document.getElementById('mf-type-filter');
  typeDropdown.innerHTML = '<option value="ALL">All Categories</option>' + 
    categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

  // Load first MF history
  if (sortedMFsByVal.length > 0) {
    renderMfHistoricalChart(sortedMFsByVal[0].scheme);
  }

  // Populate table - default sort by This Month Gain (col 10) descending
  mfSortColumn = 10;
  mfSortAsc = false;
  const mfThs = document.querySelectorAll('#mfs-table th');
  mfThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === 10) th.classList.add('sort-desc');
  });
  const sortedMfs = [...latestMf].sort((a, b) => (b.thisMonthGain ?? 0) - (a.thisMonthGain ?? 0));
  renderMfsTable(sortedMfs);
}

function selectMfExplorer(scheme, element) {
  document.querySelectorAll('#explorer-mf-list .explorer-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');
  renderMfHistoricalChart(scheme);
}

function renderMfHistoricalChart(scheme) {
  if (mfHistoricalChart) {
    mfHistoricalChart.destroy();
    mfHistoricalChart = null;
  }

  const mf = historicalHoldings.mfs[scheme];
  if (!mf) return;
  
  const history = mf.history;
  
  // Build chart data arrays from history
  const labels = history.map(h => formatDateString(h.date));
  const valuations = history.map(h => h.cur_val / 100000);
  const investments = history.map(h => h.invested / 100000);
  const navs = history.map(h => h.ltp);
  
  const ctxMfHist = document.getElementById('mf-historical-chart').getContext('2d');
  
  mfHistoricalChart = new Chart(ctxMfHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (₹ L)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (₹ L)',
          data: investments,
          borderColor: '#10b981',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          yAxisID: 'y'
        },
        {
          label: 'NAV Price (₹)',
          data: navs,
          borderColor: '#ec4899',
          borderWidth: 2,
          fill: false,
          yAxisID: 'yPrice'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: true,
          text: `${scheme.substring(0, 45)}... History`,
          color: '#fff',
          font: { family: 'Outfit', size: 14 }
        },
        legend: { labels: { color: '#f3f4f6' } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10 } },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val.toFixed(2) + ' L' }
        },
        yPrice: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val }
        }
      }
    }
  });
  
  // Populate historical data table below the chart (shows incremental changes — only rows where qty changed)
  const tableContainer = document.getElementById('mf-historical-data-table');
  if (tableContainer) {
    const tbody = document.getElementById('mf-historical-data-body');
    if (!tbody) return;
    // Build incremental rows: for each row where qty changed, show the delta from previous row
    const deltaRows = [];
    for (let idx = 0; idx < history.length; idx++) {
      const h = history[idx];
      if (idx === 0) {
        // First row: show initial position
        if (h.qty > 0) {
          deltaRows.push({
            date: h.date,
            deltaQty: h.qty,
            price: h.ltp,
            deltaInvested: h.invested,
            deltaValuation: h.cur_val,
            action: 'Buy'
          });
        }
      } else {
        const prev = history[idx - 1];
        const dQty = h.qty - prev.qty;
        if (Math.abs(dQty) > 0.001) {
          deltaRows.push({
            date: h.date,
            deltaQty: dQty,
            price: h.ltp,
            deltaInvested: h.invested - prev.invested,
            deltaValuation: h.cur_val - prev.cur_val,
            action: dQty > 0 ? 'Buy' : 'Sell'
          });
        }
      }
    }
    tbody.innerHTML = deltaRows.map(r => {
      const actionStyle = r.action === 'Buy' ? 'background:rgba(16,185,129,0.2);color:#34d399' : 'background:rgba(239,68,68,0.2);color:#f87171';
      return `
      <tr>
        <td>${formatDateString(r.date)}</td>
        <td style="text-align: right;" class="${r.deltaQty > 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaQty > 0 ? '+' : ''}${r.deltaQty.toLocaleString(undefined, {maximumFractionDigits:4})}
        </td>
        <td style="text-align: right;">${'₹' + r.price.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
        <td style="text-align: right;" class="${r.deltaInvested >= 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaInvested >= 0 ? '+' : ''}${formatINR(Math.abs(r.deltaInvested))}
        </td>
        <td style="text-align: right;" class="${r.deltaValuation >= 0 ? 'trend-up' : 'trend-down'}">
          ${r.deltaValuation >= 0 ? '+' : ''}${formatINR(Math.abs(r.deltaValuation))}
        </td>
        <td><span class="sector-tag" style="${actionStyle}">${r.action}</span></td>
      </tr>`;
    }).join('');
    tableContainer.style.display = 'block';
  }
}

function renderMfsTable(data) {
  const body = document.getElementById('mfs-table-body');
  body.innerHTML = data.map(f => {
    const uploadedPrice = f.lastUploadedPrice !== undefined ? `₹${f.lastUploadedPrice.toLocaleString(undefined, {maximumFractionDigits:4})}` : '—';
    const gain = f.thisMonthGain || 0;
    const lastRefreshed = f.lastRefreshDate || '—';
    return `
    <tr>
      <td class="instrument-cell" title="${escapeAttr(f.scheme)}">${escapeHtml(f.scheme)}</td>
      <td><span class="category-tag">${escapeHtml(f.scheme_type.replace('Equity : ', ''))}</span></td>
      <td style="text-align: right;">${f.qty.toLocaleString()}</td>
      <td style="text-align: right;">₹${f.price.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
      <td style="text-align: right;">${uploadedPrice}</td>
      <td style="text-align: right;">₹${f.avg_nav.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
      <td style="text-align: right;">${formatINR(f.invested)}</td>
      <td style="text-align: right;">${formatINR(f.cur_val)}</td>
      <td style="text-align: right;" class="${f.pnl >= 0 ? 'trend-up' : 'trend-down'}">
        ${f.pnl >= 0 ? '+' : ''}${formatINR(f.pnl)}
      </td>
      <td style="text-align: right;" class="${f.gain_pct >= 0 ? 'trend-up' : 'trend-down'}">
        ${f.gain_pct >= 0 ? '+' : ''}${f.gain_pct.toFixed(2)}%
      </td>
      <td style="text-align: right;" class="${gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${gain >= 0 ? '+' : ''}${formatINR(gain)}
      </td>
      <td style="text-align: right;">${escapeHtml(lastRefreshed)}</td>
    </tr>
  `}).join('');
}

function filterMfsTable() {
  const query = document.getElementById('mf-search').value.toLowerCase().trim();
  const cat = document.getElementById('mf-type-filter').value;
  
  const filtered = latestMf.filter(f => {
    const matchesQuery = f.scheme.toLowerCase().includes(query) || f.scheme_type.toLowerCase().includes(query);
    const matchesCat = (cat === 'ALL') || (f.scheme_type === cat);
    return matchesQuery && matchesCat;
  });
  
  renderMfsTable(filtered);
}

// ==================== DATA GENERATORS ====================

function generateBenchmarkData() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const firstValue = nwTotal[0];
  
  // Generate simulated benchmark data based on portfolio performance
  // In a real app, this would fetch actual benchmark data from an API
  
  // Nifty 50 - simulated with ~12% annual growth
  benchmarkData.nifty50.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.01, months); // ~12% annual
    const noise = 1 + (Math.sin(i * 0.3) * 0.05); // Some volatility
    return { date: d, value: firstValue * growth * noise };
  });
  
  // S&P 500 - simulated with ~10% annual growth
  benchmarkData.spx.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.0083, months); // ~10% annual
    const noise = 1 + (Math.sin(i * 0.25 + 1) * 0.04);
    return { date: d, value: firstValue * growth * noise };
  });
  
  // Sensex - simulated with ~12% annual growth (similar to Nifty 50)
  benchmarkData.sensex.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.01, months); // ~12% annual
    const noise = 1 + (Math.sin(i * 0.28 + 0.5) * 0.045); // Slightly different phase/volatility
    return { date: d, value: firstValue * growth * noise };
  });

  // Gold - simulated with ~6% annual growth
  benchmarkData.gold.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.005, months); // ~6% annual
    const noise = 1 + (Math.sin(i * 0.15 + 2) * 0.03);
    return { date: d, value: firstValue * growth * noise };
  });
}

// ==================== BENCHMARK TAB ====================

function initBenchmarkTab() {
  // Destroy existing charts before re-creating
  if (benchmarkComparisonChart) benchmarkComparisonChart.destroy();
  if (rollingReturnsChart) rollingReturnsChart.destroy();

  renderBenchmarkComparisonChart('nifty50');
  renderRollingReturnsChart();
  updateBenchmarkStats('nifty50');
}

function updateBenchmarkChart() {
  const benchmark = document.getElementById('benchmark-select').value;
  renderBenchmarkComparisonChart(benchmark);
  updateBenchmarkStats(benchmark);
}

function renderBenchmarkComparisonChart(benchmarkKey) {
  const benchmark = benchmarkData[benchmarkKey];
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const contribTotal = breakupSummary.contribution["Total"].values;
  
  const ctx = document.getElementById('benchmark-comparison-chart').getContext('2d');
  
  if (benchmarkComparisonChart) {
    benchmarkComparisonChart.destroy();
  }
  
  // ── Total Return Index for Portfolio ──
  // Adjust for new investments: index[i] = nwTotal[i] / contribution[i]
  // This shows what ₹1 invested at inception would be worth today,
  // isolating organic portfolio returns from cash-flow effects.
  // Normalised to start at 100 for direct side-by-side comparison.
  const portfolioIndex = nwTotal.map((v, i) => {
    const c = contribTotal[i];
    return c > 0 ? (v / c) * 100 : 100;
  });
  const portfolioNormalized = portfolioIndex.map(v => (v / portfolioIndex[0]) * 100);

  // Normalise benchmark to start at 100
  const benchmarkNormalized = benchmark.history.map(h => (h.value / benchmark.history[0].value) * 100);
  
  benchmarkComparisonChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Portfolio',
          data: portfolioNormalized,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2.5,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: benchmark.name,
          data: benchmarkNormalized,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#f3f4f6' } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${context.raw.toFixed(1)} (total return index, start=100)`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => v.toFixed(0) }
        }
      }
    }
  });
}

function updateBenchmarkStats(benchmarkKey) {
  const benchmark = benchmarkData[benchmarkKey];
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const contribTotal = breakupSummary.contribution["Total"].values;
  const lastIdx = nwTotal.length - 1;
  
  const lastVal = nwTotal[lastIdx];
  const lastContrib = contribTotal[lastIdx];
  const firstContrib = contribTotal[0];
  const benchFirst = benchmark.history[0].value;
  const benchLast = benchmark.history[benchmark.history.length - 1].value;
  
  // Portfolio total return = (current_value / total_contribution - 1) * 100
  const portfolioReturn = lastContrib > 0 ? ((lastVal / lastContrib) - 1) * 100 : 0;
  const benchmarkReturn = ((benchLast / benchFirst) - 1) * 100;
  const outperformance = portfolioReturn - benchmarkReturn;
  
  // Annualized returns using total-return-index values
  const years = nwTotal.length / 12;
  const portfolioIdxStart = firstContrib > 0 ? nwTotal[0] / firstContrib : 1;
  const portfolioIdxEnd = lastContrib > 0 ? lastVal / lastContrib : 1;
  const portfolioAnn = years > 0 && portfolioIdxStart > 0
    ? (Math.pow(portfolioIdxEnd / portfolioIdxStart, 1 / years) - 1) * 100
    : 0;
  const benchmarkAnn = (Math.pow(benchLast / benchFirst, 1 / years) - 1) * 100;
  
  const statsContainer = document.getElementById('benchmark-stats');
  statsContainer.innerHTML = `
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Portfolio Total Return</span>
      <span class="benchmark-stat-value trend-up">+${portfolioReturn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">${escapeHtml(benchmark.name)} Total Return</span>
      <span class="benchmark-stat-value">+${benchmarkReturn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Outperformance</span>
      <span class="benchmark-stat-value ${outperformance >= 0 ? 'trend-up' : 'trend-down'}">
        ${outperformance >= 0 ? '+' : ''}${outperformance.toFixed(1)}%
      </span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Portfolio Annualized</span>
      <span class="benchmark-stat-value trend-up">${portfolioAnn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">${escapeHtml(benchmark.name)} Annualized</span>
      <span class="benchmark-stat-value">${benchmarkAnn.toFixed(1)}%</span>
    </div>
  `;
}

function renderRollingReturnsChart() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const contribTotal = breakupSummary.contribution["Total"].values;
  
  // Calculate 12-month rolling returns (cash-flow adjusted)
  // Using total-return-index values to strip out new-investment effects
  const rollingReturns = [];
  const labels = [];
  
  for (let i = 12; i < nwTotal.length; i++) {
    const idxNow = contribTotal[i] > 0 ? nwTotal[i] / contribTotal[i] : 1;
    const idxPrev = contribTotal[i - 12] > 0 ? nwTotal[i - 12] / contribTotal[i - 12] : 1;
    const ret = idxPrev > 0 ? ((idxNow / idxPrev) - 1) * 100 : 0;
    rollingReturns.push(ret);
    labels.push(formatDateString(dates[i]));
  }
  
  const ctx = document.getElementById('rolling-returns-chart').getContext('2d');
  
  rollingReturnsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '12M Rolling Return (%)',
        data: rollingReturns,
        backgroundColor: rollingReturns.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => v + '%' }
        }
      }
    }
  });
}

// ==================== DIVIDEND TAB ====================

// ==================== MONTHLY CHANGES TAB ====================

let monthlyChangeChart = null;
let monthlyActivityChart = null;

// Heatmap selection state: stores indices of selected heatmap cells
let heatmapSelectedIndices = new Set();
let heatmapMonthData = []; // Stores the full month data for the heatmap
let rangeStartIdx = null;
let rangeEndIdx = null;

function initMonthlyTab() {
  // Destroy existing charts before re-creating
  if (monthlyChangeChart) monthlyChangeChart.destroy();
  if (monthlyActivityChart) monthlyActivityChart.destroy();

  // Build heatmap data first (needed for selection state)
  buildHeatmapData();
  renderMonthlyHeatmap();
  // Render all sections with default (no filter = all data)
  renderMonthlySummary();
  renderMonthlyChangeChart();
  renderMonthlyMovers();
  renderMonthlyActivityChart();
  renderTradingActivityLog();
}

// ── Update Log Tab ──────────────────────────────────────────────────────────
function initUpdateLogTab() {
  const container = document.getElementById('update-log-content');
  if (!container) {
    console.warn('initUpdateLogTab: #update-log-content not found');
    return;
  }

  // Read from window.lastRefreshReport (set by api.js) with fallback to local scope.
  // This ensures cross-file consistency, especially important when api.js loads
  // before app.js on GitHub Pages (Service Worker may serve cached versions).
  const report = window.lastRefreshReport || lastRefreshReport;
  // Sync local scope for any other code that references lastRefreshReport directly
  lastRefreshReport = report;
  console.log('initUpdateLogTab: report =', report);
  if (!report) {
    container.innerHTML = '<div class="update-log-empty"><p>No refresh has been performed yet. Click the <strong>Refresh Prices</strong> button to fetch live data.</p></div>';
    return;
  }

  let html = '';

  // ── Summary Cards ──
  html += '<div class="update-log-summary">';
  html += `<div class="update-log-card total"><span class="log-label">Refreshed At</span><span class="log-value">${escapeHtml(report.refreshedAt)}</span></div>`;
  html += `<div class="update-log-card success"><span class="log-label">Stocks OK</span><span class="log-value">${report.stockSuccess}/${report.totalStocks}</span></div>`;
  html += `<div class="update-log-card error"><span class="log-label">Stocks Failed</span><span class="log-value">${report.stockFail}</span></div>`;
  html += `<div class="update-log-card success"><span class="log-label">MFs OK</span><span class="log-value">${report.mfSuccess}/${report.mappedMfs}</span></div>`;
  html += `<div class="update-log-card error"><span class="log-label">MFs Failed</span><span class="log-value">${report.mfFail}</span></div>`;
  html += `<div class="update-log-card warn"><span class="log-label">Skipped</span><span class="log-value">${report.skippedStocks} bonds</span></div>`;
  if (report.missingMfs > 0) {
    html += `<div class="update-log-card warn"><span class="log-label">MFs Not Found</span><span class="log-value">${report.missingMfs}</span></div>`;
  }
  html += '</div>';

  // ── Per-Stock Details Table ──
  if (report.stockDetails && report.stockDetails.length > 0) {
    html += '<h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem;">📈 Stock Refresh Details</h3>';
    html += '<div class="table-wrapper"><table class="update-log-table">';
    html += '<thead><tr><th>Instrument</th><th>Status</th><th>Price (₹)</th><th>Prev Close (₹)</th><th>Change %</th><th>Error</th></tr></thead><tbody>';
    for (const s of report.stockDetails) {
      const statusClass = s.status === 'success' ? 'status-ok' : s.status === 'stale' ? 'status-stale' : (s.status === 'skipped' || s.status === 'stable') ? 'status-skip' : 'status-fail';
      const statusText = s.status === 'success' ? '✅ OK' : s.status === 'stale' ? '⚠️ Stale' : s.status === 'stable' ? '🔒 Stable' : s.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
      const price = s.price != null ? s.price.toFixed(2) : '—';
      const prevClose = s.prevClose != null ? s.prevClose.toFixed(2) : '—';
      const changePct = (s.price != null && s.prevClose != null && s.prevClose > 0)
        ? ((s.price - s.prevClose) / s.prevClose * 100).toFixed(2) + '%'
        : '—';
      const error = s.error ? escapeHtml(s.error) : '—';
      html += `<tr class="${statusClass}"><td>${escapeHtml(s.instrument)}</td><td>${statusText}</td><td>${price}</td><td>${prevClose}</td><td>${changePct}</td><td class="error-cell">${error}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  // ── Per-MF Details Table ──
  if (report.mfDetails && report.mfDetails.length > 0) {
    html += '<h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem;">📊 Mutual Fund NAV Details</h3>';
    html += '<div class="table-wrapper"><table class="update-log-table">';
    html += '<thead><tr><th>Scheme</th><th>Status</th><th>NAV (₹)</th><th>Prev NAV (₹)</th><th>Change %</th><th>Error</th></tr></thead><tbody>';
    for (const m of report.mfDetails) {
      const statusClass = m.status === 'success' ? 'status-ok' : m.status === 'stale' ? 'status-stale' : m.status === 'skipped' ? 'status-skip' : 'status-fail';
      const statusText = m.status === 'success' ? '✅ OK' : m.status === 'stale' ? '⚠️ Stale' : m.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
      const nav = m.nav != null ? m.nav.toFixed(4) : '—';
      const prevNav = m.prevNav != null ? m.prevNav.toFixed(4) : '—';
      const changePct = (m.nav != null && m.prevNav != null && m.prevNav > 0)
        ? ((m.nav - m.prevNav) / m.prevNav * 100).toFixed(2) + '%'
        : '—';
      const error = m.error ? escapeHtml(m.error) : '—';
      html += `<tr class="${statusClass}"><td>${escapeHtml(m.scheme)}</td><td>${statusText}</td><td>${nav}</td><td>${prevNav}</td><td>${changePct}</td><td class="error-cell">${error}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  container.innerHTML = html;
}

// Build the heatmap month data array (used for selection and filtering)
function buildHeatmapData() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  heatmapMonthData = [];
  
  for (let i = 0; i < nwTotal.length; i++) {
    const change = i > 0 ? ((nwTotal[i] - nwTotal[i-1]) / nwTotal[i-1]) * 100 : 0;
    heatmapMonthData.push({
      label: formatDateString(dates[i]),
      change: change,
      value: nwTotal[i],
      index: i,
      date: dates[i]
    });
  }
}

// Get the selected range from heatmap selection
function getSelectedRange() {
  if (heatmapSelectedIndices.size === 0) {
    return { startIndex: 0, endIndex: heatmapMonthData.length - 1, isFiltered: false };
  }
  
  const sorted = [...heatmapSelectedIndices].sort((a, b) => a - b);
  return {
    startIndex: sorted[0],
    endIndex: sorted[sorted.length - 1],
    isFiltered: true
  };
}

// Set a continuous range of selected heatmap cells (start and end click)
function selectHeatmapRange(index) {
  if (rangeStartIdx === null || (rangeStartIdx !== null && rangeEndIdx !== null)) {
    rangeStartIdx = index;
    rangeEndIdx = null;
    heatmapSelectedIndices.clear();
    heatmapSelectedIndices.add(index);
  } else {
    rangeEndIdx = index;
    const start = Math.min(rangeStartIdx, rangeEndIdx);
    const end = Math.max(rangeStartIdx, rangeEndIdx);
    heatmapSelectedIndices.clear();
    for (let i = start; i <= end; i++) {
      heatmapSelectedIndices.add(i);
    }
  }
  
  // Re-render heatmap with updated selection
  renderMonthlyHeatmap();
  
  // Update all sections based on selection
  updateAllSections();
}

// Clear all heatmap selections
function clearHeatmapSelection() {
  rangeStartIdx = null;
  rangeEndIdx = null;
  heatmapSelectedIndices.clear();
  renderMonthlyHeatmap();
  updateAllSections();
}

// Select all heatmap cells
function selectAllHeatmap() {
  rangeStartIdx = 0;
  rangeEndIdx = heatmapMonthData.length - 1;
  heatmapSelectedIndices = new Set(heatmapMonthData.map(d => d.index));
  renderMonthlyHeatmap();
  updateAllSections();
}

// Update all sections based on current heatmap selection
function updateAllSections() {
  const range = getSelectedRange();
  const startIndex = range.startIndex;
  const endIndex = range.endIndex;
  const count = endIndex - startIndex + 1;
  
  renderMonthlySummary(count, startIndex, endIndex);
  renderMonthlyChangeChart(count, startIndex, endIndex);
  renderMonthlyMovers(count, startIndex, endIndex);
  renderMonthlyActivityChart(count, startIndex, endIndex);
  renderTradingActivityLog(count, startIndex, endIndex);
}

function renderMonthlySummary(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const newInvTotal = breakupSummary.new_investment["Total Investment"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  const currentValue = nwTotal[endIndex];
  const periodStartValue = nwTotal[startIndex];
  const monthChange = currentValue - periodStartValue;
  const monthChangePct = (monthChange / periodStartValue) * 100;
  
  // Calculate new investments (sum of monthly investments in the selected range)
  let newInvestment = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    newInvestment += newInvTotal[i];
  }
  
  // Calculate returns (change - new investment)
  const returns = monthChange - newInvestment;
  const returnsPct = (returns / periodStartValue) * 100;
  
  const container = document.getElementById('monthly-summary-cards');
  container.innerHTML = `
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon ${monthChange >= 0 ? 'positive' : 'negative'}">
        ${monthChange >= 0 ? '📈' : '📉'}
      </div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Net Worth Change</div>
        <div class="monthly-kpi-value ${monthChange >= 0 ? 'trend-up' : 'trend-down'}">
          ${monthChange >= 0 ? '+' : ''}${formatLakhs(monthChange)}
        </div>
        <div class="monthly-kpi-sub">${monthChangePct >= 0 ? '+' : ''}${monthChangePct.toFixed(2)}%</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon positive">💰</div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">New Investments</div>
        <div class="monthly-kpi-value">+${formatLakhs(newInvestment)}</div>
        <div class="monthly-kpi-sub">Added capital</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon ${returns >= 0 ? 'positive' : 'negative'}">
        ${returns >= 0 ? '📊' : '⚠️'}
      </div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Market Returns</div>
        <div class="monthly-kpi-value ${returns >= 0 ? 'trend-up' : 'trend-down'}">
          ${returns >= 0 ? '+' : ''}${formatLakhs(returns)}
        </div>
        <div class="monthly-kpi-sub">${returnsPct >= 0 ? '+' : ''}${returnsPct.toFixed(2)}%</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon positive">🎯</div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Current Net Worth</div>
        <div class="monthly-kpi-value">${formatLakhs(currentValue)}</div>
        <div class="monthly-kpi-sub">Total portfolio value</div>
      </div>
    </div>
  `;
}

function renderMonthlyChangeChart(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  // Calculate month-over-month changes
  const labels = [];
  const changes = [];
  const colors = [];
  
  // Need at least one prior month for change calculation, so start from startIndex + 1
  for (let i = Math.max(startIndex + 1, 1); i <= endIndex; i++) {
    const change = nwTotal[i] - nwTotal[i - 1];
    changes.push(change);
    labels.push(formatDateString(dates[i]));
    colors.push(change >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)');
  }
  
  const ctx = document.getElementById('monthly-change-chart').getContext('2d');
  
  if (monthlyChangeChart) monthlyChangeChart.destroy();
  
  monthlyChangeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Monthly Change (₹ L)',
        data: changes,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ₹${ctx.parsed.y.toFixed(2)} L`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v.toFixed(2) + ' L' }
        }
      }
    }
  });
}

function renderMonthlyMovers(count = 1, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  // Calculate total change over the entire selected period for each holding
  const gainers = [];
  const losers = [];
  
  // Determine the start and end dates for the selected period
  const selectedStartDate = dates[startIndex];
  const selectedEndDate = dates[endIndex];
  
  // Build a cached name-to-key map for faster lookups (reuse if already built)
  if (!window._stockNameMap) {
    window._stockNameMap = {};
    const stockKeys = Object.keys(historicalHoldings.stocks);
    stockKeys.forEach(key => {
      const upper = key.toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      window._stockNameMap[clean] = key;
      const withoutLtd = clean.replace(/LTD$/, '').replace(/LIMITED$/, '').trim();
      if (withoutLtd && withoutLtd !== clean) window._stockNameMap[withoutLtd] = key;
      const words = upper.split(/[^A-Z0-9]+/).filter(w => w.length > 2);
      if (words.length > 1) {
        if (!window._stockNameMap[words[0]]) {
          window._stockNameMap[words[0]] = key;
        }
      }
      if (upper.includes('&')) {
        upper.split('&').forEach(p => {
          const trimmed = p.replace(/[^A-Z0-9]/g, '').trim();
          if (trimmed.length >= 3 && !window._stockNameMap[trimmed]) {
            window._stockNameMap[trimmed] = key;
          }
        });
      }
    });
  }
  
  latestEquity.forEach(stock => {
    // Use the cached name map for fast lookup
    const cleanSymbol = stock.instrument.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const stockKey = window._stockNameMap[cleanSymbol] || stock.instrument;
    const histStock = historicalHoldings.stocks[stockKey];
    
    let periodChange = 0;
    if (histStock) {
      const history = histStock.history;
      
      // Find the entry closest to the selected start date (first entry at or after start)
      let startEntry = null;
      for (let h = 0; h < history.length; h++) {
        if (history[h].date >= selectedStartDate) {
          startEntry = history[h];
          break;
        }
      }
      // If no entry at or after start, use the first available entry
      if (!startEntry && history.length > 0) {
        startEntry = history[0];
      }
      
      // Find the entry closest to the selected end date (last entry at or before end)
      let endEntry = null;
      for (let h = history.length - 1; h >= 0; h--) {
        if (history[h].date <= selectedEndDate) {
          endEntry = history[h];
          break;
        }
      }
      
      // Calculate total percentage change over the selected period
      if (startEntry && endEntry && startEntry !== endEntry) {
        periodChange = startEntry.cur_val > 0
          ? ((endEntry.cur_val - startEntry.cur_val) / startEntry.cur_val) * 100
          : 0;
      } else if (startEntry && endEntry && startEntry === endEntry) {
        // Only one data point in range — change is 0
        periodChange = 0;
      }
    }
    
    const changeObj = {
      name: stock.instrument,
      sector: stock.sector,
      qty: stock.qty,
      change: periodChange,
      value: stock.cur_val
    };
    
    if (periodChange >= 0) {
      gainers.push(changeObj);
    } else {
      losers.push(changeObj);
    }
  });
  
  gainers.sort((a, b) => b.change - a.change);
  losers.sort((a, b) => a.change - b.change);
  
  // Render gainers
  const gainersContainer = document.getElementById('monthly-gainers-list');
  gainersContainer.innerHTML = gainers.slice(0, 5).map(g => `
    <div class="mover-item">
      <div class="mover-info">
        <div class="mover-name">${escapeHtml(g.name)}</div>
        <div class="mover-sector">${escapeHtml(g.sector)}</div>
      </div>
      <div class="mover-detail">
        <span class="mover-qty">Qty: ${g.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</span>
        <span class="mover-change trend-up">+${g.change.toFixed(2)}%</span>
      </div>
    </div>
  `).join('');

  // Render losers
  const losersContainer = document.getElementById('monthly-losers-list');
  losersContainer.innerHTML = losers.slice(0, 5).map(l => `
    <div class="mover-item">
      <div class="mover-info">
        <div class="mover-name">${escapeHtml(l.name)}</div>
        <div class="mover-sector">${escapeHtml(l.sector)}</div>
      </div>
      <div class="mover-detail">
        <span class="mover-qty">Qty: ${l.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</span>
        <span class="mover-change trend-down">${l.change.toFixed(2)}%</span>
      </div>
    </div>
  `).join('');
}

function renderMonthlyHeatmap() {
  const container = document.getElementById('monthly-heatmap');
  const infoBar = document.getElementById('heatmap-selection-info');
  
  if (heatmapMonthData.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">No data available</div>';
    return;
  }
  
  container.innerHTML = `
    <div class="heatmap-grid">
      ${heatmapMonthData.map(m => {
        const change = Number.isFinite(m.change) ? m.change : 0;
        const intensity = Math.min(Math.abs(change) / 5, 1); // Normalize to 0-1
        const color = change >= 0
          ? `rgba(16, 185, 129, ${0.3 + intensity * 0.7})`
          : `rgba(239, 68, 68, ${0.3 + intensity * 0.7})`;
        
        const isSelected = heatmapSelectedIndices.has(m.index);
        const selectedClass = isSelected ? 'selected' : '';
        
        return `
          <div class="heatmap-cell ${selectedClass}" style="background: ${color}"
               onclick="selectHeatmapRange(${m.index})"
               title="${m.label}: ${change >= 0 ? '+' : ''}${change.toFixed(1)}% — Click to select range">
            <div class="heatmap-month">${m.label.split(' ')[0]}</div>
            <div class="heatmap-change">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="heatmap-legend">
      <span class="legend-label">Negative</span>
      <div class="legend-gradient">
        <div class="legend-bar"></div>
      </div>
      <span class="legend-label">Positive</span>
    </div>
  `;
  
  // Update selection info bar
  if (infoBar) {
    if (heatmapSelectedIndices.size === 0) {
      infoBar.innerHTML = '<span>No period selected — showing <strong class="selected-range">all data</strong></span>';
    } else {
      const sorted = [...heatmapSelectedIndices].sort((a, b) => a - b);
      const startLabel = escapeHtml(heatmapMonthData[sorted[0]]?.label || 'N/A');
      const endLabel = escapeHtml(heatmapMonthData[sorted[sorted.length - 1]]?.label || 'N/A');
      const monthCount = sorted.length;
      infoBar.innerHTML = `<span>Selected: <strong class="selected-range">${startLabel} — ${endLabel}</strong> (${monthCount} month${monthCount > 1 ? 's' : ''})</span>`;
    }
  }
}

function renderMonthlyActivityChart(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const newInvSection = breakupSummary.new_investment;
  const newInvTotal = newInvSection["Total Investment"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = newInvTotal.length - 1;
  
  const labels = [];
  const investments = [];
  
  for (let i = startIndex; i <= endIndex; i++) {
    labels.push(formatDateString(dates[i]));
    investments.push(newInvTotal[i]);
  }
  
  const ctx = document.getElementById('monthly-activity-chart').getContext('2d');
  
  if (monthlyActivityChart) monthlyActivityChart.destroy();
  
  monthlyActivityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Monthly Investment (₹ L)',
        data: investments,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: '#3b82f6'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ₹${ctx.parsed.y.toFixed(2)} L`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + v.toFixed(2) + ' L' }
        }
      }
    }
  });
}

// Generate Trading Activity Log
function renderTradingActivityLog(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = dates.length - 1;
  
  const trades = [];
  
  // Generate simulated trading activity from historical holdings data
  const stockHistory = historicalHoldings.stocks;
  const mfHistory = historicalHoldings.mfs;
  
  // Process stock transactions
  Object.keys(stockHistory).forEach(symbol => {
    const stock = stockHistory[symbol];
    const history = stock.history;
    
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      
      // Detect buys (invested increased)
      if (curr.invested > prev.invested) {
        const buyAmount = curr.invested - prev.invested;
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date,
            instrument: symbol,
            type: 'BUY',
            quantity: qty,
            price: curr.ltp,
            total: buyAmount,
            category: stock.sector || 'Equity'
          });
        }
      }
      
      // Detect sells (qty decreased)
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        const sellAmount = sellQty * curr.ltp;
        trades.push({
          date: curr.date,
          instrument: symbol,
          type: 'SELL',
          quantity: sellQty,
          price: curr.ltp,
          total: sellAmount,
          category: stock.sector || 'Equity'
        });
      }
    }
  });
  
  // Process MF transactions
  Object.keys(mfHistory).forEach(scheme => {
    const mf = mfHistory[scheme];
    const history = mf.history;
    
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      
      // Detect buys
      if (curr.invested > prev.invested) {
        const buyAmount = curr.invested - prev.invested;
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date,
            instrument: scheme.length > 30 ? scheme.substring(0, 30) + '...' : scheme,
            type: 'BUY',
            quantity: qty,
            price: curr.ltp,
            total: buyAmount,
            category: 'Mutual Fund'
          });
        }
      }
      
      // Detect sells
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        const sellAmount = sellQty * curr.ltp;
        trades.push({
          date: curr.date,
          instrument: scheme.length > 30 ? scheme.substring(0, 30) + '...' : scheme,
          type: 'SELL',
          quantity: sellQty,
          price: curr.ltp,
          total: sellAmount,
          category: 'Mutual Fund'
        });
      }
    }
  });
  
  // Sort by date (newest first)
  trades.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Filter by selected date range
  const startDate = dates[startIndex];
  const endDate = dates[endIndex];
  const filteredTrades = trades.filter(t => t.date >= startDate && t.date <= endDate);
  
  // Render table
  const tbody = document.getElementById('trading-activity-body');
  tbody.innerHTML = filteredTrades.map(trade => `
    <tr>
      <td>${formatDateString(trade.date)}</td>
      <td style="font-weight: 600;">${escapeHtml(trade.instrument)}</td>
      <td>
        <span class="trade-type ${trade.type.toLowerCase()}">${trade.type}</span>
      </td>
      <td style="text-align: right;">${trade.quantity.toLocaleString(undefined, {maximumFractionDigits: 4})}</td>
      <td style="text-align: right;">₹${trade.price.toLocaleString(undefined, {maximumFractionDigits: 2})}</td>
      <td style="text-align: right; font-weight: 600;">${formatINR(trade.total)}</td>
      <td><span class="sector-tag">${escapeHtml(trade.category)}</span></td>
    </tr>
  `).join('');
  
  // Show message if no trades
  if (filteredTrades.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          No trading activity found for the selected period
        </td>
      </tr>
    `;
  }
}

function sortMfs(colIdx) {
  if (mfSortColumn === colIdx) {
    mfSortAsc = !mfSortAsc;
  } else {
    mfSortColumn = colIdx;
    mfSortAsc = true;
  }

  // Update classes on headers
  const ths = document.querySelectorAll('#mfs-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(mfSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  const query = document.getElementById('mf-search').value.toLowerCase().trim();
  const cat = document.getElementById('mf-type-filter').value;
  
  const filtered = latestMf.filter(f => {
    const matchesQuery = f.scheme.toLowerCase().includes(query) || f.scheme_type.toLowerCase().includes(query);
    const matchesCat = (cat === 'ALL') || (f.scheme_type === cat);
    return matchesQuery && matchesCat;
  });

  filtered.sort((a, b) => {
    let valA, valB;
    switch(colIdx) {
      case 0: valA = a.scheme; valB = b.scheme; break;
      case 1: valA = a.scheme_type; valB = b.scheme_type; break;
      case 2: valA = a.qty; valB = b.qty; break;
      case 3: valA = a.price; valB = b.price; break;
      case 4: valA = a.lastUploadedPrice ?? 0; valB = b.lastUploadedPrice ?? 0; break;
      case 5: valA = a.avg_nav; valB = b.avg_nav; break;
      case 6: valA = a.invested; valB = b.invested; break;
      case 7: valA = a.cur_val; valB = b.cur_val; break;
      case 8: valA = a.pnl; valB = b.pnl; break;
      case 9: valA = a.gain_pct; valB = b.gain_pct; break;
      case 10: valA = a.thisMonthGain ?? 0; valB = b.thisMonthGain ?? 0; break;
      case 11: valA = a.lastRefreshDate || ''; valB = b.lastRefreshDate || ''; break;
    }
    
    if (typeof valA === 'string') {
      return mfSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return mfSortAsc ? valA - valB : valB - valA;
    }
  });

  renderMfsTable(filtered);
}
