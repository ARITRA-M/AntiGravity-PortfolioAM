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
let dividendData = null;
let uploadedSnapshot = null;
let lastRefreshReport = null;

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
let dividendHistoryChart = null;
let dividendSourceChart = null;
// Table sorting state
let stockSortColumn = -1;
let stockSortAsc = true;
let mfSortColumn = -1;
let mfSortAsc = true;
// Overview table sorting state
let dailyOverviewSortCol = -1;
let dailyOverviewSortAsc = true;
let monthlyOverviewSortCol = -1;
let monthlyOverviewSortAsc = true;

// Stock name lookup cache (for daily overview table)
let _stockNameLookup = null;

// Benchmark data (simulated historical data for comparison)
const benchmarkData = {
  nifty50: {
    name: 'Nifty 50 (simulated)',
    history: [] // Will be generated based on portfolio dates
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
});

// ── localStorage persistence helpers ────────────────────────────────────
const LS_PREFIX = 'ag_portfolio_';
const LS_KEYS = ['portfolio_summary', 'breakup_summary', 'latest_equity', 'latest_mf', 'historical_holdings'];

function saveToLocalStorage(summary, breakup, equity, mf, hist) {
  try {
    localStorage.setItem(LS_PREFIX + 'portfolio_summary', JSON.stringify(summary));
    localStorage.setItem(LS_PREFIX + 'breakup_summary', JSON.stringify(breakup));
    localStorage.setItem(LS_PREFIX + 'latest_equity', JSON.stringify(equity));
    localStorage.setItem(LS_PREFIX + 'latest_mf', JSON.stringify(mf));
    localStorage.setItem(LS_PREFIX + 'historical_holdings', JSON.stringify(hist));
    localStorage.setItem(LS_PREFIX + 'version', APP_VERSION);
    console.log('Portfolio data saved to localStorage (version:', APP_VERSION + ')');
  } catch (e) {
    console.warn('Failed to save portfolio data to localStorage:', e);
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
      data[key.replace(/_/g, '_')] = JSON.parse(raw);
    }
    console.log('Portfolio data loaded from localStorage (version:', version + ')');
    return {
      portfolioSummary: data['portfolio_summary'],
      breakupSummary: data['breakup_summary'],
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
    localStorage.removeItem(LS_PREFIX + 'version');
    console.log('Portfolio data cleared from localStorage');
  } catch (e) {
    console.warn('Failed to clear localStorage:', e);
  }
}

// ── Server-side save (works on localhost with server.js) ────────────────
async function saveDataToServer(summary, breakup, equity, mf, hist) {
  // Only attempt on localhost where server.js is running
  if (!window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1')) {
    console.log('Not on localhost; skipping server save. Use "Download JSON" for git commit.');
    return false;
  }
  try {
    const res = await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio_summary: summary, breakup_summary: breakup, latest_equity: equity, latest_mf: mf, historical_holdings: hist })
    });
    if (res.ok) {
      console.log('Portfolio data saved to server data/ directory');
      return true;
    } else {
      console.warn('Server save returned:', res.status);
      return false;
    }
  } catch (e) {
    console.warn('Server save failed (server.js may not be running):', e);
    return false;
  }
}

// ── Download all JSON data as individual files ──────────────────────────
function downloadAllJson(summary, breakup, equity, mf, hist) {
  const files = {
    'portfolio_summary.json': summary,
    'breakup_summary.json': breakup,
    'latest_equity.json': equity,
    'latest_mf.json': mf,
    'historical_holdings.json': hist
  };
  for (const [name, data] of Object.entries(files)) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  console.log('Downloaded all 5 JSON data files for git commit.');
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
      breakupSummary = cached.breakupSummary;
      latestEquity = cached.latestEquity;
      latestMf = cached.latestMf;
      historicalHoldings = cached.historicalHoldings;

      initializeLiveBaseline();
      generateDividendData();
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
    }

    // ── No localStorage data; fetch from server ──
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

    portfolioSummary = await resSummary.json();
    breakupSummary = await resBreakup.json();
    latestEquity = await resEquity.json();
    latestMf = await resMf.json();
    historicalHoldings = await resHist.json();

    initializeLiveBaseline();

    // Generate simulated dividend data
    generateDividendData();

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
  // Not available on mfapi.in; skip refresh to avoid wrong match
  "Nippon India Nifty IT Index Fund Direct - Growth": null
};

// Cache for dynamically discovered MF scheme codes (persists across refreshes)
let dynamicMfSchemeCodes = {};

function recomputePortfolioFromLiveData() {
  if (!uploadedSnapshot) initializeLiveBaseline();

  // Recompute thisMonthGain for all stocks: (current LTP - uploaded LTP) * qty
  latestEquity.forEach(s => {
    s.thisMonthGain = (s.ltp - s.lastUploadedPrice) * s.qty;
  });

  // Recompute thisMonthGain for all MFs: (current NAV - uploaded NAV) * qty
  latestMf.forEach(f => {
    f.thisMonthGain = (f.price - f.lastUploadedPrice) * f.qty;
  });

  // Recompute total equity value from live stock + MF data
  const totalStockVal = latestEquity.reduce((sum, s) => sum + s.cur_val, 0);
  const totalMfVal = latestMf.reduce((sum, f) => sum + f.cur_val, 0);

  // USE EXACT GAIN DIRECTLY TO AVOID EXCEL SUMMARY TAB VS HOLDINGS TAB INCONSISTENCIES
  const exactStockGain = latestEquity.reduce((sum, s) => sum + s.thisMonthGain, 0);
  const exactMfGain = latestMf.reduce((sum, f) => sum + f.thisMonthGain, 0);
  const exactDeltaLakhs = (exactStockGain + exactMfGain) / 100000;

  const liveStockLakhs = uploadedSnapshot.stockLakhs + (exactStockGain / 100000);
  const liveMfLakhs = uploadedSnapshot.mfLakhs + (exactMfGain / 100000);
  const liveTotalLakhs = uploadedSnapshot.totalLakhs + exactDeltaLakhs;

  portfolioSummary.total_net_worth_lakhs = liveTotalLakhs;
  portfolioSummary.equity_lakhs = liveStockLakhs + liveMfLakhs + uploadedSnapshot.npsELakhs;
  portfolioSummary.allocation_pct = recomputeAllocation(portfolioSummary);

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
  const saveBtn = document.getElementById('save-data-btn');
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

    // ── Attempt server save (on localhost, writes JSON to data/ directory) ──
    const serverSaved = await saveDataToServer(portfolioSummary, breakupSummary, latestEquity, latestMf, historicalHoldings);

    resetDerivedState();
    refreshAllTabs();

    const latestDate = breakupSummary.dates[breakupSummary.dates.length - 1];
    document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
    updateDataFreshness(`Uploaded snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);

    if (serverSaved) {
      if (status) status.textContent = `✅ ${file.name} — saved to server & local storage`;
    } else if (!window.__isGitHubPages) {
      if (status) status.textContent = `✅ ${file.name} — saved locally. ${window.location.hostname.includes('localhost') ? 'Server save failed — is server.js running?' : 'Use "Download JSON" to export for git commit.'}`;
    } else {
      if (status) status.textContent = `✅ ${file.name} — saved locally. Download JSON and commit to git for permanent sync.`;
    }
    if (saveBtn) saveBtn.style.display = 'inline-block';
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
  dividendData = null;
  benchmarkData.nifty50.history = [];
  benchmarkData.spx.history = [];
  benchmarkData.gold.history = [];
  uploadedSnapshot = null;
  lastRefreshReport = null;
  window._stockNameMap = null;
  heatmapSelectedIndices.clear();
  initializeLiveBaseline();
  generateDividendData();
  generateBenchmarkData();
}

function initializeLiveBaseline() {
  latestEquity.forEach(s => {
    s.lastUploadedPrice = s.ltp;
    s.lastRefreshedPrice = s.ltp;
    s.thisMonthGain = 0;
    s.yesterdayClose = null;
  });
  latestMf.forEach(f => {
    f.lastUploadedPrice = f.price;
    f.lastRefreshedPrice = f.price;
    f.thisMonthGain = 0;
    f.previousNav = null;
  });
  uploadedSnapshot = {
    totalLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Total'),
    stockLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Stocks (Equity)'),
    mfLakhs: getLatestSectionValue(breakupSummary.net_worth, 'Mutual Funds (Equity)'),
    npsELakhs: getLatestSectionValue(breakupSummary.net_worth, 'NPS E (Equity)')
  };
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
  initOverviewTab();
  initStocksTab();
  initMfsTab();
  initGrowthTab();
  initFixedIncomeTab();
  initNpsTab();
  initMonthlyTab();
  initUpdateLogTab();
}

function updateDataFreshness(message) {
  const el = document.getElementById('data-freshness');
  if (el) el.textContent = message;
}

// Helpers
function formatLakhs(value) {
  return '₹' + parseFloat(value).toFixed(2) + ' L';
}

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
  
  // Re-render charts on visible tab to ensure proper sizing
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    
    // Re-initialize monthly tab charts if switching to it
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

  // Render Daily Summaries
  const dailySummaryEl = document.getElementById('daily-summary-kpis');
  if (dailySummaryEl) {
    dailySummaryEl.innerHTML = `
      <div class="kpi-card" style="--card-accent: #6366f1;">
        <div>
          <div class="kpi-title">Total Daily Change (Stocks)</div>
          <div class="kpi-value ${totalStockGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalStockGain >= 0 ? '+' : ''}${formatINR(totalStockGain)}
          </div>
        </div>
        <div class="kpi-sub">Since yesterday's close</div>
      </div>
      <div class="kpi-card" style="--card-accent: #10b981;">
        <div>
          <div class="kpi-title">Total Daily Change (MFs)</div>
          <div class="kpi-value ${totalMfGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMfGain >= 0 ? '+' : ''}${formatINR(totalMfGain)}
          </div>
        </div>
        <div class="kpi-sub">Since previous NAV</div>
      </div>
      <div class="kpi-card total-card">
        <div>
          <div class="kpi-title">Total Combined Change</div>
          <div class="kpi-value ${totalGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalGain >= 0 ? '+' : ''}${formatINR(totalGain)}
          </div>
        </div>
        <div class="kpi-sub">Stocks + Mutual Funds</div>
      </div>
    `;
  }

  // Sort by selected column
  const col = dailyOverviewSortCol;
  const asc = dailyOverviewSortAsc;
  if (col === 2) {
    combined.sort((a, b) => sortNullableNumber(a.qty, b.qty, asc));
  } else if (col === 3) {
    combined.sort((a, b) => sortNullableNumber(a.yesterdayClose, b.yesterdayClose, asc));
  } else if (col === 4) {
    combined.sort((a, b) => asc ? a.currentLtp - b.currentLtp : b.currentLtp - a.currentLtp);
  } else if (col === 5) {
    combined.sort((a, b) => sortNullableNumber(a.change, b.change, asc));
  } else if (col === 6) {
    combined.sort((a, b) => sortNullableNumber(a.changePct, b.changePct, asc));
  } else {
    // Default: sort by name
    combined.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }

  const tbody = document.getElementById('daily-overview-body');
  tbody.innerHTML = combined.map(item => `
    <tr>
      <td class="instrument-cell">${escapeHtml(item.name)}</td>
      <td><span class="sector-tag">${item.type === 'Stock' ? '📊 Stock' : '📁 MF'}</span></td>
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

  // Stocks: monthly gain = thisMonthGain
  latestEquity.forEach(s => {
    const gain = s.thisMonthGain || 0;
    const gainPct = s.lastUploadedPrice > 0 ? (gain / (s.lastUploadedPrice * s.qty)) * 100 : 0;
    combined.push({
      name: s.instrument,
      type: 'Stock',
      qty: s.qty,
      uploadedVal: (s.lastUploadedPrice ?? 0) * s.qty,
      currentVal: s.cur_val,
      gain: gain,
      gainPct: gainPct
    });
    totalStockMonthlyGain += gain;
  });

  // MFs: monthly gain = thisMonthGain
  latestMf.forEach(f => {
    const gain = f.thisMonthGain || 0;
    const gainPct = f.lastUploadedPrice > 0 ? (gain / (f.lastUploadedPrice * f.qty)) * 100 : 0;
    combined.push({
      name: f.scheme,
      type: 'MF',
      qty: f.qty,
      uploadedVal: (f.lastUploadedPrice ?? 0) * f.qty,
      currentVal: f.cur_val,
      gain: gain,
      gainPct: gainPct
    });
    totalMfMonthlyGain += gain;
  });

  const totalMonthlyGain = totalStockMonthlyGain + totalMfMonthlyGain;

  // Render Monthly Summaries
  const monthlySummaryEl = document.getElementById('monthly-summary-kpis');
  if (monthlySummaryEl) {
    monthlySummaryEl.innerHTML = `
      <div class="kpi-card" style="--card-accent: #6366f1;">
        <div>
          <div class="kpi-title">Total Gain (Stocks)</div>
          <div class="kpi-value ${totalStockMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalStockMonthlyGain >= 0 ? '+' : ''}${formatINR(totalStockMonthlyGain)}
          </div>
        </div>
        <div class="kpi-sub">Since last upload</div>
      </div>
      <div class="kpi-card" style="--card-accent: #10b981;">
        <div>
          <div class="kpi-title">Total Gain (MFs)</div>
          <div class="kpi-value ${totalMfMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMfMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMfMonthlyGain)}
          </div>
        </div>
        <div class="kpi-sub">Since last upload</div>
      </div>
      <div class="kpi-card total-card">
        <div>
          <div class="kpi-title">Total Combined Gain</div>
          <div class="kpi-value ${totalMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
            ${totalMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMonthlyGain)}
          </div>
        </div>
        <div class="kpi-sub">Stocks + Mutual Funds</div>
      </div>
    `;
  }

  // Sort by selected column
  const col = monthlyOverviewSortCol;
  const asc = monthlyOverviewSortAsc;
  if (col === 2) {
    combined.sort((a, b) => sortNullableNumber(a.qty, b.qty, asc));
  } else if (col === 3) {
    combined.sort((a, b) => asc ? a.uploadedVal - b.uploadedVal : b.uploadedVal - a.uploadedVal);
  } else if (col === 4) {
    combined.sort((a, b) => asc ? a.currentVal - b.currentVal : b.currentVal - a.currentVal);
  } else if (col === 5) {
    combined.sort((a, b) => asc ? a.gain - b.gain : b.gain - a.gain);
  } else if (col === 6) {
    combined.sort((a, b) => asc ? a.gainPct - b.gainPct : b.gainPct - a.gainPct);
  } else {
    // Default: sort by name
    combined.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }

  const tbody = document.getElementById('monthly-overview-body');
  tbody.innerHTML = combined.map(item => `
    <tr>
      <td class="instrument-cell">${escapeHtml(item.name)}</td>
      <td><span class="sector-tag">${item.type === 'Stock' ? '📊 Stock' : '📁 MF'}</span></td>
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
  const cumInvested = portfolioSummary.cumulative_investment_history;
  
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
  
  // 1. Current Asset Allocation Donut
  const allocData = portfolioSummary.allocation_pct;
  const ctxAlloc = document.getElementById('allocation-donut-chart').getContext('2d');
  
  allocationChart = new Chart(ctxAlloc, {
    type: 'doughnut',
    data: {
      labels: ['Equity', 'Debt', 'Gold', 'Liquid', 'Alternate'],
      datasets: [{
        data: [allocData.Equity, allocData.Debt, allocData.Gold, allocData.Liquid, allocData.Alternate],
        backgroundColor: [
          getAssetColor('Equity'),
          getAssetColor('Debt'),
          getAssetColor('Gold'),
          getAssetColor('Liquid'),
          getAssetColor('Alternate')
        ],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.label}: ${context.raw.toFixed(2)}%`
          }
        }
      }
    }
  });

  // 2. Component XIRR Bar Chart
  const xirrSec = breakupSummary.xirr;
  const xirrLabels = [];
  const xirrValues = [];
  const xirrColors = [];
  
  Object.keys(xirrSec).forEach(key => {
    if (key !== 'Average' && key !== 'Total') {
      const label = xirrSec[key].label;
      const vals = xirrSec[key].values;
      const latestVal = vals[vals.length - 1];
      if (latestVal > 0) {
        xirrLabels.push(label);
        xirrValues.push(latestVal * 100);
        xirrColors.push(getAssetColor(label));
      }
    }
  });
  
  const ctxXirr = document.getElementById('component-xirr-chart').getContext('2d');
  componentXirrChart = new Chart(ctxXirr, {
    type: 'bar',
    data: {
      labels: xirrLabels,
      datasets: [{
        label: 'Annualized Return (XIRR) %',
        data: xirrValues,
        backgroundColor: xirrColors,
        borderRadius: 6,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', font: { family: 'Outfit' }, callback: (value) => value + '%' }
        }
      },
      plugins: {
        legend: { display: false }
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

  // 2. NPS Allocation Donut
  const ctxNpsAlloc = document.getElementById('nps-allocation-chart').getContext('2d');
  window.npsAllocationChart = new Chart(ctxNpsAlloc, {
    type: 'doughnut',
    data: {
      labels: ['NPS E (Equity)', 'NPS C (Debt)', 'NPS G (Debt)'],
      datasets: [{
        data: [npsEVal, npsCVal, npsGVal],
        backgroundColor: ['#3b82f6', '#10b981', '#f59e0b'],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.label}: ${formatLakhs(context.raw)}`
          }
        }
      }
    }
  });

  // 3. NPS Summary
  const summaryContainer = document.getElementById('nps-summary');
  summaryContainer.innerHTML = `
    <div class="nps-summary-item">
      <div class="nps-summary-label">NPS E (Equity) Allocation</div>
      <div class="nps-summary-value">${npsTotal > 0 ? ((npsEVal / npsTotal) * 100).toFixed(1) : 0}%</div>
      <div class="nps-summary-sub">${formatLakhs(npsEVal)}</div>
    </div>
    <div class="nps-summary-item">
      <div class="nps-summary-label">NPS C (Debt) Allocation</div>
      <div class="nps-summary-value">${npsTotal > 0 ? ((npsCVal / npsTotal) * 100).toFixed(1) : 0}%</div>
      <div class="nps-summary-sub">${formatLakhs(npsCVal)}</div>
    </div>
    <div class="nps-summary-item">
      <div class="nps-summary-label">NPS G (Debt) Allocation</div>
      <div class="nps-summary-value">${npsTotal > 0 ? ((npsGVal / npsTotal) * 100).toFixed(1) : 0}%</div>
      <div class="nps-summary-sub">${formatLakhs(npsGVal)}</div>
    </div>
    <div class="nps-summary-item" style="border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.75rem; margin-top: 0.5rem;">
      <div class="nps-summary-label" style="font-weight: 700;">Total NPS</div>
      <div class="nps-summary-value" style="color: var(--accent-indigo);">${formatLakhs(npsTotal)}</div>
      <div class="nps-summary-sub">This month: ${npsTotalGain >= 0 ? '+' : ''}${npsTotalGain.toFixed(2)} L</div>
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

  // 2. Sector Chart
  const sectorSums = {};
  latestEquity.forEach(s => {
    sectorSums[s.sector] = (sectorSums[s.sector] || 0) + s.cur_val;
  });
  
  const sortedSectors = Object.keys(sectorSums).map(sec => ({
    name: sec,
    val: sectorSums[sec]
  })).sort((a, b) => b.val - a.val);

  const ctxSec = document.getElementById('stock-sector-chart').getContext('2d');
  sectorChart = new Chart(ctxSec, {
    type: 'bar',
    data: {
      labels: sortedSectors.map(s => s.name),
      datasets: [{
        label: 'Current Valuation (INR)',
        data: sortedSectors.map(s => s.val),
        backgroundColor: 'rgba(99, 102, 241, 0.7)',
        borderColor: '#6366f1',
        borderWidth: 1,
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 10 } } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => formatINR(value) }
        }
      },
      plugins: { legend: { display: false } }
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

  // ── Dividend Section (merged into Stocks tab) ──
  if (dividendData) {
    // Update dividend KPIs
    const ttmEl = document.getElementById('div-ttm-value');
    const yieldEl = document.getElementById('div-yield-value');
    const growthEl = document.getElementById('div-growth-value');
    if (ttmEl) ttmEl.innerText = formatLakhs(dividendData.ttm / 100000);
    if (yieldEl) yieldEl.innerText = dividendData.yield.toFixed(2) + '%';
    if (growthEl) growthEl.innerText = '+' + dividendData.growth.toFixed(1) + '%';

    // Dividend History Chart
    if (dividendHistoryChart) dividendHistoryChart.destroy();
    const ctxHistEl = document.getElementById('dividend-history-chart');
    if (ctxHistEl) {
      const ctxHist = ctxHistEl.getContext('2d');
      dividendHistoryChart = new Chart(ctxHist, {
        type: 'bar',
        data: {
          labels: dividendData.history.map(h => formatDateString(h.date)),
          datasets: [{
            label: 'Dividend Received (₹)',
            data: dividendData.history.map(h => h.amount),
            backgroundColor: 'rgba(16, 185, 129, 0.6)',
            borderRadius: 6
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
              ticks: { color: '#9ca3af', callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K' }
            }
          }
        }
      });
    }

    // Dividend by Source Chart
    if (dividendSourceChart) dividendSourceChart.destroy();
    const ctxSourceEl = document.getElementById('dividend-source-chart');
    if (ctxSourceEl) {
      const ctxSource = ctxSourceEl.getContext('2d');
      dividendSourceChart = new Chart(ctxSource, {
        type: 'doughnut',
        data: {
          labels: ['Stocks', 'Mutual Funds'],
          datasets: [{
            data: [dividendData.byType.stocks, dividendData.byType.mfs],
            backgroundColor: ['#3b82f6', '#6366f1'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#f3f4f6' } }
          }
        }
      });
    }

    // Upcoming dividends (hidden container for reference)
    const upcomingContainer = document.getElementById('upcoming-dividends-list');
    if (upcomingContainer) {
      const upcomingDividends = [
        { name: 'Infosys Ltd', amount: 17500, date: 'Jun 15, 2026' },
        { name: 'HDFC Bank', amount: 9500, date: 'Jun 28, 2026' },
        { name: 'ITC Ltd', amount: 6800, date: 'Jul 5, 2026' },
        { name: 'Parag Parikh Flexi Cap', amount: 4200, date: 'Jul 15, 2026' }
      ];
      upcomingContainer.innerHTML = upcomingDividends.map(d => `
        <div class="upcoming-div-item">
          <span class="upcoming-div-name">${escapeHtml(d.name)}</span>
          <div class="upcoming-div-info">
            <div class="upcoming-div-amount">₹${d.amount.toLocaleString()}</div>
            <div class="upcoming-div-date">${d.date}</div>
          </div>
        </div>
      `).join('');
    }
  }
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
  const valuations = history.map(h => h.cur_val);
  const investments = history.map(h => h.invested);
  const ltps = history.map(h => h.ltp);
  
  const ctxStockHist = document.getElementById('stock-historical-chart').getContext('2d');
  
  stockHistoricalChart = new Chart(ctxStockHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (INR)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (INR)',
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
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
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
  // Build dividend lookup map from dividendData.holdings
  const divMap = {};
  if (dividendData && dividendData.holdings) {
    dividendData.holdings.forEach(h => {
      divMap[h.instrument] = h;
    });
  }
  body.innerHTML = data.map(s => {
    const uploadedPrice = s.lastUploadedPrice !== undefined ? `₹${s.lastUploadedPrice.toLocaleString(undefined, {maximumFractionDigits:2})}` : '—';
    const gain = s.thisMonthGain || 0;
    const divInfo = divMap[s.instrument];
    const annualDiv = divInfo ? divInfo.annualDiv : 0;
    const divYield = divInfo ? divInfo.yield : 0;
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
      <td style="text-align: right; color: var(--accent-green);">${annualDiv > 0 ? '₹' + annualDiv.toLocaleString(undefined, {maximumFractionDigits:0}) : '—'}</td>
      <td style="text-align: right; color: var(--accent-green);">${divYield > 0 ? divYield.toFixed(2) + '%' : '—'}</td>
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

  // Build dividend lookup map
  const divMap = {};
  if (dividendData && dividendData.holdings) {
    dividendData.holdings.forEach(h => {
      divMap[h.instrument] = h;
    });
  }

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
      case 11: {
        const dA = divMap[a.instrument];
        const dB = divMap[b.instrument];
        valA = dA ? dA.annualDiv : 0;
        valB = dB ? dB.annualDiv : 0;
        break;
      }
      case 12: {
        const dA = divMap[a.instrument];
        const dB = divMap[b.instrument];
        valA = dA ? dA.yield : 0;
        valB = dB ? dB.yield : 0;
        break;
      }
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
  if (mfValuationChart) mfValuationChart.destroy();
  if (mfHistoricalChart) mfHistoricalChart.destroy();

  // 1. Category Donut
  const catSums = {};
  latestMf.forEach(f => {
    catSums[f.scheme_type] = (catSums[f.scheme_type] || 0) + f.cur_val;
  });
  
  const sortedCategories = Object.keys(catSums).map(c => ({
    name: c,
    val: catSums[c]
  })).sort((a, b) => b.val - a.val);

  const ctxMF = document.getElementById('mf-category-chart').getContext('2d');
  mfCategoryChart = new Chart(ctxMF, {
    type: 'doughnut',
    data: {
      labels: sortedCategories.map(c => c.name.replace('Equity : ', '')),
      datasets: [{
        data: sortedCategories.map(c => c.val),
        backgroundColor: [
          '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#14b8a6'
        ],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 10 } }
        }
      }
    }
  });

  // 2. Bar Chart of Top schemes by valuation
  const topMfs = [...latestMf].sort((a, b) => b.cur_val - a.cur_val).slice(0, 10);
  
  const ctxMfVal = document.getElementById('mf-valuation-bar-chart').getContext('2d');
  mfValuationChart = new Chart(ctxMfVal, {
    type: 'bar',
    data: {
      labels: topMfs.map(f => f.scheme.substring(0, 20) + '...'),
      datasets: [{
        label: 'Current Valuation (INR)',
        data: topMfs.map(f => f.cur_val),
        backgroundColor: 'rgba(99, 102, 241, 0.65)',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
        },
        y: { grid: { display: false }, ticks: { color: '#f3f4f6', font: { size: 9 } } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 3. Scheme Selector for Explorer
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
  const valuations = history.map(h => h.cur_val);
  const investments = history.map(h => h.invested);
  const navs = history.map(h => h.ltp);
  
  const ctxMfHist = document.getElementById('mf-historical-chart').getContext('2d');
  
  mfHistoricalChart = new Chart(ctxMfHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (INR)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (INR)',
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
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
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
  
  // Gold - simulated with ~6% annual growth
  benchmarkData.gold.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.005, months); // ~6% annual
    const noise = 1 + (Math.sin(i * 0.15 + 2) * 0.03);
    return { date: d, value: firstValue * growth * noise };
  });
}

function generateDividendData() {
  // Generate deterministic dividend data based on holdings
  const dividendHistory = [];
  const dividendByType = { stocks: 0, mfs: 0 };
  const dividendHoldings = [];
  
  // Simulate dividend history (monthly for the past 2 years)
  const dates = breakupSummary.dates;
  const portfolioValue = portfolioSummary.total_net_worth_lakhs * 100000;
  
  dates.forEach((d, i) => {
    // Simulate ~1.5% annual dividend yield, paid quarterly
    if (i % 3 === 0) {
      const monthlyDiv = portfolioValue * 0.015 / 4;
      dividendHistory.push({
        date: d,
        amount: monthlyDiv * (1 + i * 0.02) // Growing over time
      });
    }
  });
  
  // Generate dividend-paying holdings (deterministic - based on PnL performance)
  // Stocks with positive PnL are more likely to pay dividends
  latestEquity.slice(0, 15).forEach((stock, idx) => {
    // Deterministic: use stock name hash and PnL to decide if dividend-paying
    const nameHash = stock.instrument.length + stock.pnl;
    const paysDividend = (nameHash % 10) > 2; // ~70% pay dividends, deterministic
    if (paysDividend) {
      // Yield based on sector: stable sectors get higher yield
      const baseYield = stock.sector.includes('Bank') || stock.sector.includes('Oil') ? 2.5 : 1.5;
      const yield_ = baseYield + (idx % 3) * 0.5; // Deterministic variation
      dividendHoldings.push({
        instrument: stock.instrument,
        type: 'Stock',
        annualDiv: stock.cur_val * yield_ / 100,
        yield: yield_,
        lastDiv: formatDateString(dates[dates.length - 1])
      });
    }
  });
  
  latestMf.slice(0, 10).forEach((fund, idx) => {
    // Deterministic: use scheme name hash
    const nameHash = fund.scheme.length + fund.pnl;
    const paysDividend = (nameHash % 10) > 3; // ~60% pay dividends, deterministic
    if (paysDividend) {
      const yield_ = 1.0 + (idx % 4) * 0.5; // Deterministic: 1.0%, 1.5%, 2.0%, 2.5%
      dividendHoldings.push({
        instrument: fund.scheme.substring(0, 30),
        type: 'Mutual Fund',
        annualDiv: fund.cur_val * yield_ / 100,
        yield: yield_,
        lastDiv: formatDateString(dates[dates.length - 1])
      });
    }
  });
  
  const totalAnnualDiv = dividendHoldings.reduce((sum, h) => sum + h.annualDiv, 0);
  
  dividendData = {
    history: dividendHistory,
    byType: {
      stocks: totalAnnualDiv * 0.65,
      mfs: totalAnnualDiv * 0.35
    },
    holdings: dividendHoldings,
    totalAnnual: totalAnnualDiv,
    ttm: totalAnnualDiv * 0.9, // Trailing 12 months
    yield: (totalAnnualDiv / portfolioValue) * 100,
    growth: 12.5 // YoY growth
  };
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
  
  const ctx = document.getElementById('benchmark-comparison-chart').getContext('2d');
  
  if (benchmarkComparisonChart) {
    benchmarkComparisonChart.destroy();
  }
  
  // Normalize both to start at 100 for comparison
  const portfolioNormalized = nwTotal.map(v => (v / nwTotal[0]) * 100);
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
            label: (context) => `${context.dataset.label}: ${context.raw.toFixed(1)} (normalized)`
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
  const firstVal = nwTotal[0];
  const lastVal = nwTotal[nwTotal.length - 1];
  const benchFirst = benchmark.history[0].value;
  const benchLast = benchmark.history[benchmark.history.length - 1].value;
  
  const portfolioReturn = ((lastVal - firstVal) / firstVal) * 100;
  const benchmarkReturn = ((benchLast - benchFirst) / benchFirst) * 100;
  const outperformance = portfolioReturn - benchmarkReturn;
  
  // Calculate annualized returns
  const years = nwTotal.length / 12;
  const portfolioAnn = (Math.pow(lastVal / firstVal, 1 / years) - 1) * 100;
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
  
  // Calculate 12-month rolling returns
  const rollingReturns = [];
  const labels = [];
  
  for (let i = 12; i < nwTotal.length; i++) {
    const ret = ((nwTotal[i] - nwTotal[i - 12]) / nwTotal[i - 12]) * 100;
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

function initDividendTab() {
  // Destroy existing charts before re-creating
  if (dividendHistoryChart) dividendHistoryChart.destroy();
  if (dividendSourceChart) dividendSourceChart.destroy();

  // Update KPIs
  document.getElementById('div-ttm-value').innerText = formatLakhs(dividendData.ttm / 100000);
  document.getElementById('div-yield-value').innerText = dividendData.yield.toFixed(2) + '%';
  document.getElementById('div-growth-value').innerText = '+' + dividendData.growth.toFixed(1) + '%';
  
  // Dividend History Chart
  const ctxHist = document.getElementById('dividend-history-chart').getContext('2d');
  dividendHistoryChart = new Chart(ctxHist, {
    type: 'bar',
    data: {
      labels: dividendData.history.map(h => formatDateString(h.date)),
      datasets: [{
        label: 'Dividend Received (₹)',
        data: dividendData.history.map(h => h.amount),
        backgroundColor: 'rgba(16, 185, 129, 0.6)',
        borderRadius: 6
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
          ticks: { color: '#9ca3af', callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K' }
        }
      }
    }
  });
  
  // Dividend by Source
  const ctxSource = document.getElementById('dividend-source-chart').getContext('2d');
  dividendSourceChart = new Chart(ctxSource, {
    type: 'doughnut',
    data: {
      labels: ['Stocks', 'Mutual Funds'],
      datasets: [{
        data: [dividendData.byType.stocks, dividendData.byType.mfs],
        backgroundColor: ['#3b82f6', '#6366f1'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#f3f4f6' } }
      }
    }
  });
  
  // Upcoming dividends (simulated)
  const upcomingContainer = document.getElementById('upcoming-dividends-list');
  const upcomingDividends = [
    { name: 'Infosys Ltd', amount: 17500, date: 'Jun 15, 2026' },
    { name: 'HDFC Bank', amount: 9500, date: 'Jun 28, 2026' },
    { name: 'ITC Ltd', amount: 6800, date: 'Jul 5, 2026' },
    { name: 'Parag Parikh Flexi Cap', amount: 4200, date: 'Jul 15, 2026' }
  ];
  
  upcomingContainer.innerHTML = upcomingDividends.map(d => `
    <div class="upcoming-div-item">
      <span class="upcoming-div-name">${escapeHtml(d.name)}</span>
      <div class="upcoming-div-info">
        <div class="upcoming-div-amount">₹${d.amount.toLocaleString()}</div>
        <div class="upcoming-div-date">${d.date}</div>
      </div>
    </div>
  `).join('');
  
  // Dividend Holdings Table
  const tableBody = document.getElementById('dividend-table-body');
  tableBody.innerHTML = dividendData.holdings.map(h => `
    <tr>
      <td style="font-weight: 600;">${escapeHtml(h.instrument)}</td>
      <td><span class="sector-tag">${escapeHtml(h.type)}</span></td>
      <td style="text-align: right;">₹${h.annualDiv.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
      <td style="text-align: right; color: var(--accent-green);">${h.yield.toFixed(2)}%</td>
      <td style="text-align: right; color: var(--text-secondary);">${escapeHtml(h.lastDiv)}</td>
    </tr>
  `).join('');
}


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

  const report = lastRefreshReport;
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
      const statusClass = s.status === 'success' ? 'status-ok' : 'status-fail';
      const statusText = s.status === 'success' ? '✅ OK' : (s.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed');
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
      const statusClass = m.status === 'success' ? 'status-ok' : 'status-fail';
      const statusText = m.status === 'success' ? '✅ OK' : '❌ Failed';
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
          ${monthChange >= 0 ? '+' : ''}${formatINR(monthChange)}
        </div>
        <div class="monthly-kpi-sub">${monthChangePct >= 0 ? '+' : ''}${monthChangePct.toFixed(2)}%</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon positive">💰</div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">New Investments</div>
        <div class="monthly-kpi-value">+${formatINR(newInvestment)}</div>
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
          ${returns >= 0 ? '+' : ''}${formatINR(returns)}
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
        label: 'Monthly Change (₹)',
        data: changes,
        backgroundColor: colors,
        borderRadius: 6
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
          ticks: { color: '#9ca3af', callback: (v) => formatINR(v) }
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
        label: 'Monthly Investment (₹)',
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
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => formatINR(v) }
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
    }
    
    if (typeof valA === 'string') {
      return mfSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return mfSortAsc ? valA - valB : valB - valA;
    }
  });

  renderMfsTable(filtered);
}
