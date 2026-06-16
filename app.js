// Tab IDs
const tabIds = ['overview', 'stocks', 'mfs', 'growth', 'fixed-income', 'nps', 'monthly', 'update-log', 'manage'];

// App version for cache busting — auto-derived from today's date so JSON files
// are never served stale after a deploy. The server.js commit script no longer
// needs to touch this constant.
const APP_VERSION = new Date().toISOString().slice(0, 10);

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
let capChart = null;
let mfCategoryChart = null;
let mfValuationChart = null;
// stockHistoricalChart and mfHistoricalChart removed — history now shown inline per row
let benchmarkComparisonChart = null;
let rollingReturnsChart = null;
let stockPerfChart = null;
let mfPerfChart = null;
let periodicPerfChart = null;
let _periodicGran = 'Q'; // Q | H | Y | MAT
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



// ── Real Nifty 50 benchmark (fetched from Yahoo Finance ^NSEI via CORS proxy) ──
// A single 1-month daily series powers the overview KPI cards (daily + MTD
// change) AND the benchmark line on the Stock/MF performance charts.
let _niftyDailyPctReal = null;
let _niftySeries = null; // { dates: [ms], closes: [number] } — last ~1 month, daily
// Pre-seed monthly change from a saved snapshot so the first render isn't blank.
let _niftyMonthlyPctReal = (() => {
  try {
    const raw = localStorage.getItem('ag_portfolio_nifty_snapshot');
    const snap = raw ? JSON.parse(raw) : null;
    return snap?.monthlyChangePct ?? null;
  } catch { return null; }
})();

const NIFTY_SNAPSHOT_KEY = 'ag_portfolio_nifty_snapshot';

function loadNiftySnapshot() {
  try {
    const raw = localStorage.getItem(NIFTY_SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveNiftySnapshot(data) {
  try {
    localStorage.setItem(NIFTY_SNAPSHOT_KEY, JSON.stringify(data));
  } catch { /* localStorage may be full */ }
}

// Fetch the Nifty 50 (^NSEI) ~1-month daily series in a single request and
// derive both the daily change and the month-to-date change from it. The raw
// series is cached on _niftySeries for the performance charts. Falls back to
// the last saved snapshot (KPI values only) when offline.
async function fetchNiftySeries() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1mo&interval=1d';
    const res = await fetchViaCorsProxy(url, {}, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const r = raw?.chart?.result?.[0];
    const ts = r?.timestamp;
    const closes = r?.indicators?.quote?.[0]?.close;
    if (!ts || !closes) throw new Error('Incomplete data');

    // Keep only valid (timestamp, close) pairs, ascending by time.
    const pts = ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(p => p.c != null);
    if (pts.length < 2) throw new Error('Not enough Nifty data');
    _niftySeries = { dates: pts.map(p => p.t), closes: pts.map(p => p.c) };

    // Determine prevClose correctly depending on day:
    //   • Weekday, bar published today → pts[last] = today's close, prevClose = pts[last-1]
    //   • Weekday, market open/pre-pub → pts[last] = yesterday's close, prevClose = pts[last]
    //   • Weekend → market is closed; show last working day's change:
    //               live = pts[last] (Friday's close), prevClose = pts[last-1] (Thursday's close)
    // Do NOT use meta.chartPreviousClose on a range query — Yahoo returns a value
    // from ~1 month before the range start, not the prior trading day.
    const todayDow = new Date().getDay();
    const isWeekendToday = todayDow === 0 || todayDow === 6;
    let live, prevClose;
    if (isWeekendToday) {
      live     = pts[pts.length - 1].c;
      prevClose = pts[pts.length - 2].c;
    } else {
      live = r?.meta?.regularMarketPrice ?? pts[pts.length - 1].c;
      const lastBarIsToday = new Date(pts[pts.length - 1].t).toDateString() === new Date().toDateString();
      prevClose = lastBarIsToday ? pts[pts.length - 2].c : pts[pts.length - 1].c;
    }
    _niftyDailyPctReal = ((live - prevClose) / prevClose) * 100;

    // Month-to-date: last close strictly before the 1st of the current month.
    const now = new Date();
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let monthStartClose = null;
    for (const p of pts) if (p.t < monthStartMs) monthStartClose = p.c;
    if (monthStartClose) _niftyMonthlyPctReal = ((live - monthStartClose) / monthStartClose) * 100;

    saveNiftySnapshot({
      dailyChangePct: _niftyDailyPctReal,
      monthlyChangePct: _niftyMonthlyPctReal,
      series: _niftySeries,
      timestamp: Date.now()
    });
    return _niftySeries;
  } catch {
    const snap = loadNiftySnapshot();
    if (snap) {
      if (snap.dailyChangePct != null) _niftyDailyPctReal = snap.dailyChangePct;
      if (snap.monthlyChangePct != null) _niftyMonthlyPctReal = snap.monthlyChangePct;
      if (snap.series) _niftySeries = snap.series;
    }
    return _niftySeries;
  }
}

// ── Short-term (≈30 day) daily performance charts: holdings vs Nifty 50 ──────
// Both portfolio lines are computed on a CONSTANT-HOLDINGS basis: the current
// quantities valued at each day's historical price. This isolates price
// performance (what the portfolio you hold today would have done) rather than
// reconstructing past trades. Series are rebased to 100 for a clean,
// scale-free comparison against the Nifty 50.

const PERF_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — shorter TTL prevents stale bad-data persisting

// Fetch daily closes for many Yahoo symbols using the multi-symbol spark
// endpoint (≈15 per request). Returns Map<symbol, {dates:[ms], closes:[]}>.
async function fetchSparkCloses(symbols) {
  const out = new Map();
  const BATCH = 15;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=1mo&interval=1d`;
    try {
      const res = await fetchViaCorsProxy(url, {}, 12000);
      if (!res.ok) continue;
      const raw = await res.json();
      for (const r of (raw?.spark?.result || [])) {
        const resp = r?.response?.[0];
        const ts = resp?.timestamp;
        const cl = resp?.indicators?.quote?.[0]?.close;
        if (!ts || !cl) continue;
        const pts = ts.map((t, k) => ({ t: t * 1000, c: cl[k] })).filter(p => p.c != null);
        out.set(r.symbol, { dates: pts.map(p => p.t), closes: pts.map(p => p.c) });
      }
    } catch (_) { /* skip a failed batch; others still contribute */ }
  }
  return out;
}

// Value of `lookup` (sorted ascending {dates,closes}) on or before time `t`.
function closeAtOrBefore(series, t) {
  if (!series || !series.dates.length) return null;
  let val = null;
  for (let i = 0; i < series.dates.length; i++) {
    if (series.dates[i] <= t) val = series.closes[i]; else break;
  }
  return val;
}

// Build the stock performance series (current equity holdings vs Nifty 50).
async function buildStockPerfSeries() {
  if (!_niftySeries) await fetchNiftySeries();
  if (!_niftySeries || _niftySeries.dates.length < 2) return null;
  const axis = _niftySeries.dates; // trading-day timeline

  // Current equity holdings that have a live Yahoo price (exclude SGBs, bonds).
  const holdings = latestEquity.filter(s =>
    typeof hasLivePriceSource === 'function' && hasLivePriceSource(s.instrument) &&
    !s.instrument.startsWith('SGB') && s.qty > 0);
  if (!holdings.length) return null;

  const tickerOf = (instr) => instr.replace(/-RR$/, '') + '.NS';
  const symbols = holdings.map(h => tickerOf(h.instrument));
  const closesBySym = await fetchSparkCloses(symbols);

  // Portfolio value on each Nifty trading day = Σ qty × close(on/just-before day).
  const values = axis.map(t => {
    let v = 0;
    for (const h of holdings) {
      const series = closesBySym.get(tickerOf(h.instrument));
      const c = closeAtOrBefore(series, t);
      if (c != null) v += h.qty * c;
    }
    return v;
  });
  if (!values.some(v => v > 0)) return null;

  // Trim axis to start at the first date where every fetched holding has price data.
  // Without this, early days with partial coverage produce an understated portfolio
  // value which — after rebasing to 100 — makes the chart start below 0%.
  const coveredSymbols = [...closesBySym.keys()];
  let trimFrom = 0;
  for (let i = 0; i < axis.length; i++) {
    if (coveredSymbols.every(sym => closeAtOrBefore(closesBySym.get(sym), axis[i]) != null)) {
      trimFrom = i;
      break;
    }
  }
  return {
    axis: axis.slice(trimFrom),
    portfolio: values.slice(trimFrom),
    benchmark: _niftySeries.closes.slice(trimFrom),
    covered: closesBySym.size,
    total: holdings.length,
  };
}

// Build the MF performance series (current MF holdings vs Nifty 50).
async function buildMfPerfSeries() {
  if (!_niftySeries) await fetchNiftySeries();
  if (!_niftySeries || _niftySeries.dates.length < 2) return null;
  const axis = _niftySeries.dates;

  const holdings = latestMf.filter(f => f.qty > 0);
  if (!holdings.length) return null;

  // mfapi.in dates are "dd-mm-yyyy"; convert to ms.
  const parseMfDate = (s) => { const [d, m, y] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  // Fetch each scheme's full NAV history (one direct mfapi call each).
  const navBySchemeP = holdings.map(async (f) => {
    let code = (typeof MF_SCHEME_CODES !== 'undefined' && MF_SCHEME_CODES[f.scheme]) ||
               (typeof dynamicMfSchemeCodes !== 'undefined' && dynamicMfSchemeCodes[f.scheme]);
    if (!code) return [f.scheme, null];
    try {
      const res = await fetch(`https://api.mfapi.in/mf/${code}`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return [f.scheme, null];
      const j = await res.json();
      const pts = (j?.data || [])
        .map(e => ({ t: parseMfDate(e.date), c: parseFloat(e.nav) }))
        .filter(p => !isNaN(p.t) && p.c > 0)
        .sort((a, b) => a.t - b.t);
      return [f.scheme, { dates: pts.map(p => p.t), closes: pts.map(p => p.c) }];
    } catch (_) { return [f.scheme, null]; }
  });
  const navByScheme = new Map(await Promise.all(navBySchemeP));

  let covered = 0;
  navByScheme.forEach(v => { if (v) covered++; });
  const values = axis.map(t => {
    let v = 0;
    for (const f of holdings) {
      const series = navByScheme.get(f.scheme);
      const nav = closeAtOrBefore(series, t);
      if (nav != null) v += f.qty * nav;
    }
    return v;
  });
  if (!values.some(v => v > 0)) return null;

  // Trim to first date where all fetched schemes have NAV data (same logic as stock series).
  const coveredSchemes = [...navByScheme.entries()].filter(([, v]) => v).map(([k]) => k);
  let trimFrom = 0;
  for (let i = 0; i < axis.length; i++) {
    if (coveredSchemes.every(s => closeAtOrBefore(navByScheme.get(s), axis[i]) != null)) {
      trimFrom = i;
      break;
    }
  }
  return {
    axis: axis.slice(trimFrom),
    portfolio: values.slice(trimFrom),
    benchmark: _niftySeries.closes.slice(trimFrom),
    covered,
    total: holdings.length,
  };
}

// Rebase a numeric series to start at 100 (first non-zero value = 100).
function rebase100(arr) {
  const base = arr.find(v => v > 0) || 1;
  return arr.map(v => (v / base) * 100);
}

// Render a "holdings vs Nifty 50" performance line chart into `canvasId`.
function renderPerfChart(canvasId, chartRef, series, label) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return chartRef;
  if (chartRef) { chartRef.destroy(); chartRef = null; }
  const ctx = canvas.getContext('2d');
  const labels = series.axis.map(t => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
  const pf = rebase100(series.portfolio);
  const bm = rebase100(series.benchmark);
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label, data: pf, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.10)', borderWidth: 2.5, fill: true, pointRadius: 0, pointHoverRadius: 5, tension: 0.25 },
        { label: 'Nifty 50', data: bm, borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.06)', borderWidth: 2, borderDash: [5, 5], fill: false, pointRadius: 0, pointHoverRadius: 5, tension: 0.25 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#f3f4f6' } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${(c.raw - 100).toFixed(2)}%` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 8 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', callback: (v) => (v - 100 >= 0 ? '+' : '') + (v - 100).toFixed(1) + '%' } }
      }
    }
  });
}

// Lazy-load + cache the perf series, then render. `kind` is 'stock' | 'mf'.
async function loadPerfChart(kind) {
  const canvasId = kind === 'stock' ? 'stock-perf-chart' : 'mf-perf-chart';
  const statusId = kind === 'stock' ? 'stock-perf-status' : 'mf-perf-status';
  const cacheKey = `ag_portfolio_perf_${kind}`;
  const statusEl = document.getElementById(statusId);
  const label = kind === 'stock' ? 'Stock Portfolio' : 'MF Portfolio';

  // Serve from a short-lived cache to avoid refetching on every tab visit.
  let series = null;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && Date.now() - cached.timestamp < PERF_CACHE_TTL_MS) series = cached.series;
  } catch (_) { /* ignore */ }

  if (!series) {
    if (statusEl) statusEl.textContent = 'Loading last 30 days…';
    try {
      series = kind === 'stock' ? await buildStockPerfSeries() : await buildMfPerfSeries();
      if (series) localStorage.setItem(cacheKey, JSON.stringify({ series, timestamp: Date.now() }));
    } catch (e) { console.warn(`Perf chart (${kind}) failed:`, e); }
  }

  if (!series) {
    if (statusEl) statusEl.textContent = 'Could not load 30-day data (price source unavailable). Try Refresh Prices.';
    return;
  }
  if (statusEl) {
    const cov = series.covered < series.total ? ` · ${series.covered}/${series.total} holdings with history` : '';
    statusEl.textContent = `Current holdings vs Nifty 50, rebased to 0% · last ${series.axis.length} trading days${cov}`;
  }
  if (kind === 'stock') stockPerfChart = renderPerfChart(canvasId, stockPerfChart, series, label);
  else mfPerfChart = renderPerfChart(canvasId, mfPerfChart, series, label);
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
  TATASTEEL: 'Metals & Mining', TITAN: 'Consumer Goods & FMCG', CASTROLIND: 'Energy & Mining',
  GOLDBEES: 'Gold Commodity (ETF)', SGBAUG28V: 'Sovereign Gold Bonds',
  SGBJUL28IV: 'Sovereign Gold Bonds', SGBSEP28VI: 'Sovereign Gold Bonds',
  'SGBJUL28IV-GB': 'Sovereign Gold Bonds', 'SGBSEP28VI-GB': 'Sovereign Gold Bonds',
  '716GS2050-GS': 'Government Bonds', '738REC27TF': 'Corporate Bonds', TVSMNCRPS: 'Debt Instrument',
  ENRIN: 'Industrial Engineering',

  // ── Legacy / exited holdings (major, confidently-classifiable) ──
  // Tagged so the sector-distribution chart resolves them instead of dumping
  // them in "Other Equities" once the pre-Aug-2022 floor is lifted. Both the
  // ticker and the old full-company-name forms are listed (harmless if one was
  // already stitched away). The long tail of micro-caps / bonds / ETFs / event
  // rows intentionally stays "Other Equities".
  'Infosys Ltd.': 'IT & Software Services',
  'Tata Consultancy Services Ltd.': 'IT & Software Services',
  'Wipro Ltd.': 'IT & Software Services', TECHM: 'IT & Software Services', LTIM: 'IT & Software Services',
  'Kotak Mahindra Bank Ltd.': 'Banking & Financial Services',
  'State Bank of India': 'Banking & Financial Services',
  'Bajaj Finance Ltd.': 'Banking & Financial Services',
  INDUSINDBK: 'Banking & Financial Services', AUBANK: 'Banking & Financial Services', CANBK: 'Banking & Financial Services',
  DIVISLAB: 'Pharmaceuticals', LUPIN: 'Pharmaceuticals', GLAND: 'Pharmaceuticals', GRANULES: 'Pharmaceuticals',
  'Hindustan Unilever Ltd.': 'Consumer Goods & FMCG', HINDUNILVR: 'Consumer Goods & FMCG',
  DABUR: 'Consumer Goods & FMCG', ASIANPAINT: 'Consumer Goods & FMCG',
  'Colgate-Palmolive (India) Ltd.': 'Consumer Goods & FMCG',
  'Avenue Supermarts Ltd.': 'Consumer Goods & FMCG', RELAXO: 'Consumer Goods & FMCG', ZYDUSWELL: 'Consumer Goods & FMCG',
  'Bharti Airtel Ltd.': 'Telecommunication Services',
  'Oil And Natural Gas Corporation Ltd.': 'Energy & Mining',
  'ICICI Prudential Life Insurance Company Ltd.': 'Insurance',
  'ICICI Lombard General Insurance Company Ltd.': 'Insurance', STARHEALTH: 'Insurance',
  TATAMOTORS: 'Automobile & Ancillaries', TATAMTRDVR: 'Automobile & Ancillaries',
  'Mahindra & Mahindra Ltd.': 'Automobile & Ancillaries',
  ASHOKLEY: 'Automobile & Ancillaries', SONACOMS: 'Automobile & Ancillaries', HYUNDAI: 'Automobile & Ancillaries',
  'Oberoi Realty Ltd.': 'Real Estate & Construction', SOBHA: 'Real Estate & Construction', SUNTECK: 'Real Estate & Construction',
  HINDALCO: 'Metals & Mining'
};

// SEBI classification: top 100 = Large Cap, 101–250 = Mid Cap, 251+ = Small Cap.
// ETFs, REITs, bonds, SGBs are excluded (shown as 'Other/ETF' in the cap chart).
const MARKET_CAP_MAP = {
  // Large Cap
  CIPLA: 'Large Cap', DRREDDY: 'Large Cap', MANKIND: 'Large Cap', SUNPHARMA: 'Large Cap',
  ZYDUSLIFE: 'Large Cap', 'BAJAJ-AUTO': 'Large Cap', EICHERMOT: 'Large Cap',
  HEROMOTOCO: 'Large Cap', 'M&M': 'Large Cap', MOTHERSON: 'Large Cap', TVSMOTOR: 'Large Cap',
  AXISBANK: 'Large Cap', BAJFINANCE: 'Large Cap', BANKBARODA: 'Large Cap',
  HDFCBANK: 'Large Cap', HDFCLIFE: 'Large Cap', ICICIBANK: 'Large Cap',
  ICICIGI: 'Large Cap', ICICIPRULI: 'Large Cap', KOTAKBANK: 'Large Cap',
  SBILIFE: 'Large Cap', SBIN: 'Large Cap', DLF: 'Large Cap', GODREJPROP: 'Large Cap',
  BRITANNIA: 'Large Cap', COLPAL: 'Large Cap', ITC: 'Large Cap', MARICO: 'Large Cap',
  NESTLEIND: 'Large Cap', TATACONSUM: 'Large Cap', VBL: 'Large Cap',
  HCLTECH: 'Large Cap', INFY: 'Large Cap', OFSS: 'Large Cap', TCS: 'Large Cap',
  BHARTIARTL: 'Large Cap', COALINDIA: 'Large Cap', LT: 'Large Cap',
  ONGC: 'Large Cap', PIDILITIND: 'Large Cap', SIEMENS: 'Large Cap', TATASTEEL: 'Large Cap',
  TITAN: 'Large Cap',
  // Mid Cap
  CASTROLIND: 'Mid Cap',
  AJANTPHARM: 'Mid Cap', ERIS: 'Mid Cap', JBCHEPHARM: 'Mid Cap', LALPATHLAB: 'Mid Cap',
  SYNGENE: 'Mid Cap', APOLLOTYRE: 'Mid Cap', BALKRISIND: 'Mid Cap', ENDURANCE: 'Mid Cap',
  EXIDEIND: 'Mid Cap', UNOMINDA: 'Mid Cap', FEDERALBNK: 'Mid Cap', KARURVYSYA: 'Mid Cap',
  MFSL: 'Mid Cap', BRIGADE: 'Mid Cap', OBEROIRLTY: 'Mid Cap', PHOENIXLTD: 'Mid Cap',
  PRESTIGE: 'Mid Cap', COFORGE: 'Mid Cap', KPITTECH: 'Mid Cap', MPHASIS: 'Mid Cap',
  PERSISTENT: 'Mid Cap', CIEINDIA: 'Mid Cap',
  // Small Cap
  ENRIN: 'Small Cap',

  // ── Legacy / exited holdings (major) — mirror of the SECTOR_MAP legacy block ──
  'Infosys Ltd.': 'Large Cap', 'Tata Consultancy Services Ltd.': 'Large Cap',
  'Wipro Ltd.': 'Large Cap', TECHM: 'Large Cap', LTIM: 'Large Cap',
  'Kotak Mahindra Bank Ltd.': 'Large Cap', 'State Bank of India': 'Large Cap',
  'Bajaj Finance Ltd.': 'Large Cap', INDUSINDBK: 'Large Cap', CANBK: 'Large Cap', AUBANK: 'Mid Cap',
  DIVISLAB: 'Large Cap', LUPIN: 'Large Cap', GLAND: 'Mid Cap', GRANULES: 'Mid Cap',
  'Hindustan Unilever Ltd.': 'Large Cap', HINDUNILVR: 'Large Cap', DABUR: 'Large Cap',
  ASIANPAINT: 'Large Cap', 'Colgate-Palmolive (India) Ltd.': 'Large Cap',
  'Avenue Supermarts Ltd.': 'Large Cap', RELAXO: 'Mid Cap', ZYDUSWELL: 'Mid Cap',
  'Bharti Airtel Ltd.': 'Large Cap', 'Oil And Natural Gas Corporation Ltd.': 'Large Cap',
  'ICICI Prudential Life Insurance Company Ltd.': 'Large Cap',
  'ICICI Lombard General Insurance Company Ltd.': 'Large Cap', STARHEALTH: 'Mid Cap',
  TATAMOTORS: 'Large Cap', TATAMTRDVR: 'Large Cap', 'Mahindra & Mahindra Ltd.': 'Large Cap',
  ASHOKLEY: 'Large Cap', SONACOMS: 'Mid Cap', HYUNDAI: 'Large Cap',
  'Oberoi Realty Ltd.': 'Mid Cap', SOBHA: 'Mid Cap', SUNTECK: 'Small Cap',
  HINDALCO: 'Large Cap',
};

// ── History fragment stitching ───────────────────────────────────────────────
// The source workbook changed naming conventions over time, splitting a single
// continuously-held instrument's history across multiple keys:
//   • Stocks: pre-Aug-2022 rows use FULL COMPANY NAMES ("Siemens Ltd."),
//     post-Aug-2022 rows use TICKERS ("SIEMENS").
//   • MFs: fund renames ("Kotak Emerging Equity" → "Kotak Midcap").
// Each map entry merges the OLD/orphaned key's history into the CANONICAL
// (current) key, so charts, the per-holding explorer and XIRR show the true
// inception date instead of starting mid-stream.
//
//   FORMAT:  'Old / orphaned key' : 'Canonical current key'
//   REVIEW:  Verify each pairing. Anything NOT listed here is never merged.
//            Intentionally OMITTED (genuinely different securities — do NOT add):
//              • 'GHCLTEXTIL'  — demerged textile entity, separate from GHCL
//              • corporate-action variant tickers (BAJAJ-AUTO*, BRITANNIA-N3,
//                ICICIBANKN, MOTHERSON#) — temporary event rows, left untouched
const HISTORY_STITCH_ALIASES = {
  stocks: {
    // Aug-2022 full-name → ticker cutover (true inception 2020-12-27 unless noted)
    'Alkem Laboratories Ltd.': 'ALKEM',
    'Apollo Tyres Ltd.': 'APOLLOTYRE',
    'Asian Paints Ltd.': 'ASIANPAINT',
    'Axis Bank Ltd.': 'AXISBANK',
    'Bajaj Auto Ltd.': 'BAJAJ-AUTO',
    'Brigade Enterprises Ltd.': 'BRIGADE',
    'Britannia Industries Ltd.': 'BRITANNIA',
    'Castrol India Ltd.': 'CASTROLIND',
    'Cipla Ltd.': 'CIPLA',
    'Coal India Ltd.': 'COALINDIA',
    'Coforge Ltd.': 'COFORGE',
    'DLF Ltd.': 'DLF',
    'Dabur India Ltd.': 'DABUR',
    "Divi's Laboratories Ltd.": 'DIVISLAB',
    'Dr. Lal Pathlabs Ltd.': 'LALPATHLAB',
    'Eicher Motors Ltd.': 'EICHERMOT',
    'Embassy Office Parks REIT': 'EMBASSY',
    'Endurance Technologies Ltd.': 'ENDURANCE',
    'Eris Lifesciences Ltd.': 'ERIS',
    'Exide Industries Ltd.': 'EXIDEIND',
    'GHCL Ltd.': 'GHCL',
    'Gland Pharma Ltd.': 'GLAND',
    'Godrej Properties Ltd.': 'GODREJPROP',
    'HCL Technologies Ltd.': 'HCLTECH',
    'HDFC Bank Ltd.': 'HDFCBANK',
    'HDFC Life Insurance Company Ltd.': 'HDFCLIFE',
    'HG Infra Engineering Ltd.': 'HGINFRA',
    'Hero MotoCorp Ltd.': 'HEROMOTOCO',
    'Hindalco Industries Ltd.': 'HINDALCO',
    'ICICI Bank Ltd.': 'ICICIBANK',
    'ITC Ltd.': 'ITC',
    'KPIT Technologies Ltd.': 'KPITTECH',
    'Larsen & Toubro Ltd.': 'LT',                  // L&T — NOT 'Larsen & Toubro Infotech'/LTI/LTIM (separate IT entity)
    'Marico Ltd.': 'MARICO',
    'MindTree Ltd.': 'MINDTREE',
    'Minda Industries Ltd.': 'UNOMINDA',         // Minda Industries → UNO Minda (renamed)
    'MINDAIND': 'UNOMINDA',                        // ...also the old ticker era
    'Mindspace Business Parks REIT': 'MINDSPACE',
    'Motherson Sumi Systems Ltd.': 'MOTHERSON',
    'Samvardhana Motherson International Ltd.': 'MOTHERSON',
    'MphasiS Ltd.': 'MPHASIS',
    'Oil India Ltd.': 'OIL',
    'Persistent Systems Ltd.': 'PERSISTENT',
    'Redington (India) Ltd.': 'REDINGTON',
    'Relaxo Footwears Ltd.': 'RELAXO',
    'SBI Life Insurance Company Ltd.': 'SBILIFE',
    'Siemens Ltd.': 'SIEMENS',
    'Sobha Ltd.': 'SOBHA',
    'Sun Pharmaceutical Industries Ltd.': 'SUNPHARMA',
    'Sunteck Realty Ltd.': 'SUNTECK',
    'Suprajit Engineering Ltd.': 'SUPRAJIT',
    'Syngene International Ltd.': 'SYNGENE',
    'Tata Consumer Products Ltd.': 'TATACONSUM',
    'Tata Motors Ltd. (DVR)': 'TATAMOTORS',
    'Tata Steel Ltd.': 'TATASTEEL',
    'Tech Mahindra Ltd.': 'TECHM',
    'Titan Company Ltd.': 'TITAN',
    'UPL Ltd.': 'UPL',
    'YES Bank Ltd.': 'YESBANK',
    'Zydus Wellness Ltd.': 'ZYDUSWELL',
    // Sovereign Gold Bonds — Zerodha re-spelled each tranche's symbol over time
    // (…-GB → bare → …V). Verified sequential (never two symbols on the same
    // month), so these are pure renames. Canonical = current symbol.
    'SGBAUG28V-GB': 'SGBAUG28V', 'SGBAUG28': 'SGBAUG28V',
    'SGBSEP28VI-GB': 'SGBSEP28VI', 'SGBSEP28': 'SGBSEP28VI',
    'SGBJUL28IV-GB': 'SGBJUL28IV', 'SGBJULY28': 'SGBJUL28IV',
  },
  mfs: {
    'Kotak Emerging Equity Fund Direct-Growth': 'Kotak Midcap Fund Direct-Growth',
    'Parag Parikh Long Term Equity Fund Direct-Growth': 'Parag Parikh Flexi Cap Fund Direct-Growth',
    'PGIM India Global Equity Opportunities Fund Direct-Growth': 'PGIM India Global Equity Opportunities FoF Direct-Growth',
    'Canara Robeco Small Cap Fund Direct-Growth': 'Canara Robeco Small Cap Fund Direct - Growth',
    // Navi NASDAQ-100 renamed twice — both predecessors fold into the latest name
    'Navi NASDAQ 100 FoF Direct - Growth': 'Navi Nasdaq100 US Specific Equity Passive FoF Direct - Growth',
    'Navi US NASDAQ 100 FoF Direct - Growth': 'Navi Nasdaq100 US Specific Equity Passive FoF Direct - Growth',
    // HDFC Sensex index renamed 3 times — all fold into the latest name
    'HDFC Index Sensex Direct Plan-Growth': 'HDFC BSE Sensex Index Fund Direct-Growth',
    'HDFC Index S&P BSE Sensex Direct Plan-Growth': 'HDFC BSE Sensex Index Fund Direct-Growth',
    'HDFC Index Fund - BSE Sensex Plan Direct-Growth': 'HDFC BSE Sensex Index Fund Direct-Growth',
    'Tata Index Sensex Direct': 'Tata S&P BSE Sensex Index Direct',
  },
};

// Merge orphaned history fragments into their canonical keys (idempotent —
// safe to re-run on localStorage-cached, already-stitched data).
function stitchHistoryFragments(hh) {
  if (!hh) return hh;
  let mergedCount = 0;
  for (const section of ['stocks', 'mfs']) {
    const bucket = hh[section];
    const aliases = HISTORY_STITCH_ALIASES[section];
    if (!bucket || !aliases) continue;
    for (const [oldKey, canonKey] of Object.entries(aliases)) {
      const oldEntry = bucket[oldKey];
      const canonEntry = bucket[canonKey];
      if (!oldEntry || !canonEntry) continue; // nothing to merge / canonical absent → safe skip
      // Canonical (current) values win on any same-date collision; fragments don't overlap in practice.
      const byDate = {};
      [...(oldEntry.history || []), ...(canonEntry.history || [])].forEach(h => { byDate[h.date] = h; });
      canonEntry.history = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
      delete bucket[oldKey]; // drop orphan so per-holding charts don't list/double-count it
      mergedCount++;
    }
  }
  if (mergedCount) console.log(`[stitch] merged ${mergedCount} orphaned history fragment(s) into canonical holdings`);
  return hh;
}

window.addEventListener('DOMContentLoaded', () => {
  // Show the Commit button on localhost — it now persists ledger edits / closed
  // periods (the Excel-upload flow that used to reveal it has been removed).
  const _isLocal = location.hostname.includes('localhost') || location.hostname.includes('127.0.0.1');
  const _commitBtn = document.getElementById('commit-btn');
  if (_commitBtn && _isLocal && !window.__staticMode) _commitBtn.style.display = 'inline-flex';
  // Kick off the Nifty 50 fetch; once resolved, re-render the overview cards/tables.
  fetchNiftySeries().then(() => {
    const dailySummaryEl = document.getElementById('daily-summary-kpis');
    if (dailySummaryEl && dailySummaryEl.offsetParent !== null) {
      renderDailyOverviewTable();
    }
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
    // A fresh upload invalidates any prior refresh report — drop it so a later
    // reload doesn't apply stale live deltas onto the new upload's baseline.
    localStorage.removeItem(LS_PREFIX + 'refresh_report');
    console.log('Portfolio data saved to localStorage (version:', APP_VERSION + ')');
  } catch (e) {
    console.warn('Failed to save portfolio data to localStorage:', e);
  }
}

// Called after a live price refresh — persists the refreshed prices so they
// survive a page reload.
//
// IMPORTANT: this writes a COMPLETE, loadable set (version + all LS_KEYS) so
// loadFromLocalStorage() will actually return it on reload — even when using
// bundled data with no manual upload (the upload path was previously the only
// thing that set `version`, which is why refreshed prices used to vanish).
//
// It deliberately does NOT persist breakup_summary. That file stays
// server-fetched and pristine so the `uploadedSnapshot` baseline can never
// drift — the root cause of the old "portfolio value decremented on every
// refresh" bug. On reload, live totals are recomputed from that clean
// baseline plus the per-instrument deltas instead.
function saveRefreshedPrices(equity, mf) {
  try {
    localStorage.setItem(LS_PREFIX + 'latest_equity', JSON.stringify(equity));
    localStorage.setItem(LS_PREFIX + 'latest_mf', JSON.stringify(mf));
    localStorage.setItem(LS_PREFIX + 'portfolio_summary', JSON.stringify(portfolioSummary));
    localStorage.setItem(LS_PREFIX + 'historical_holdings', JSON.stringify(historicalHoldings));
    localStorage.setItem(LS_PREFIX + 'version', APP_VERSION);
    if (window.lastRefreshReport) {
      localStorage.setItem(LS_PREFIX + 'refresh_report', JSON.stringify(window.lastRefreshReport));
    }
    console.log('Refreshed prices + report saved to localStorage');
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
    localStorage.removeItem(LS_PREFIX + 'refresh_report');
    localStorage.removeItem(LS_PREFIX + 'version');
    localStorage.removeItem(BENCHMARK_MONTHLY_CACHE_KEY);
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
      historical_holdings: historicalHoldings,
      // Ledger blobs (new transaction-entry model). Persisting them makes the
      // committed files the source of truth, so the local breakup override can
      // be cleared after a successful commit.
      ledger_transactions: (typeof transactions !== 'undefined' && transactions) || [],
      ledger_balances: (typeof balances !== 'undefined' && balances) || [],
      ledger_frozen_base: (typeof frozenBase !== 'undefined' && frozenBase) || null,
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
      // Committed files now hold the appended periods — drop the local override.
      if (typeof clearBreakupOverride === 'function') clearBreakupOverride();
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
      historicalHoldings = stitchHistoryFragments(cached.historicalHoldings);

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
      try { if (typeof integrateLedger === 'function') integrateLedger(); } catch (e) { console.error('integrateLedger failed:', e); }

      // Restore the persisted refresh report (Update Log + per-stock refresh
      // times) and, if a refresh has happened, recompute live totals from the
      // pristine server baseline + preserved per-instrument deltas. Because
      // breakupSummary is always fetched fresh (never persisted), uploadedSnapshot
      // stays at the true upload-time baseline, so this cannot drift downward.
      let hadRefresh = false;
      try {
        const savedReport = localStorage.getItem(LS_PREFIX + 'refresh_report');
        if (savedReport) {
          window.lastRefreshReport = JSON.parse(savedReport);
          lastRefreshReport = window.lastRefreshReport;
          hadRefresh = true;
        }
      } catch (_) { /* ignore a corrupt report */ }
      if (hadRefresh) {
        recomputePortfolioFromLiveData();
      }

      generateBenchmarkData();
      fetchBenchmarkData(); // async; re-renders Growth tab benchmarks when resolved

      const dates = breakupSummary.dates;
      const latestDate = dates[dates.length - 1];
      if (hadRefresh) {
        document.getElementById('live-time-badge').innerText = `Live: ${window.lastRefreshReport.refreshedAt}`;
        updateDataFreshness(`Live refresh: ${window.lastRefreshReport.refreshedAt} (restored). Showing last refreshed prices.`);
      } else {
        document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
        updateDataFreshness(`Uploaded snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);
      }

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
      if (typeof startAutoRefresh === 'function') startAutoRefresh();
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
    historicalHoldings = stitchHistoryFragments(await parsePortfolioJson(resHist));

    initializeLiveBaseline();
    if (typeof integrateLedger === 'function') integrateLedger();

    // Generate benchmark data (simulated immediately; real data fetched async below)
    generateBenchmarkData();
    fetchBenchmarkData(); // async; re-renders Growth tab benchmarks when resolved

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
    if (typeof startAutoRefresh === 'function') startAutoRefresh();
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
    historicalHoldings = stitchHistoryFragments(parsed.historicalHoldings);

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
  benchmarkData.sensex.history = [];
  // Reset names to "(simulated)" so stale real-data labels don't persist.
  for (const [key, { label }] of Object.entries(BENCHMARK_SOURCES)) {
    benchmarkData[key].name = `${label} (simulated)`;
  }
  uploadedSnapshot = null;
  lastRefreshReport = null;
  window.lastRefreshReport = null;
  _stockNameLookup = null; // invalidate shared stock name lookup on new upload
  heatmapSelectedIndices.clear();
  // Holdings changed → drop the cached 30-day performance series AND the
  // benchmark monthly cache (date alignment may differ after a new upload).
  try {
    localStorage.removeItem('ag_portfolio_perf_stock');
    localStorage.removeItem('ag_portfolio_perf_mf');
    localStorage.removeItem(BENCHMARK_MONTHLY_CACHE_KEY);
  } catch (_) { /* ignore */ }
  initializeLiveBaseline();
  generateBenchmarkData();
  fetchBenchmarkData(); // re-fetch real data aligned to new portfolio dates
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
  // Re-render stock/MF price data immediately — don't wait for Nifty fetch.
  if (latestEquity) renderDailyOverviewTable();
  if (latestEquity) renderMonthlyOverviewTable();
  // Then refresh Nifty 50 and re-render again once it resolves.
  fetchNiftySeries().then(() => {
    if (latestEquity) renderDailyOverviewTable();
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
  'update-log': initUpdateLogTab,
  'manage': initManageTab
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

    // Monthly tab re-initialises fully on every visit so heatmap, movers,
    // and charts all stay consistent after a price refresh mid-session.
    if (tabId === 'monthly') {
      initMonthlyTab();
    }

    // Always re-render overview on visit — prices may have refreshed
    // while user was on another tab, so stale data needs flushing.
    if (tabId === 'overview' && latestEquity) {
      renderDailyOverviewTable();
      renderMonthlyOverviewTable();
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

  // Helper: last non-zero value from a breakupSummary.xirr series
  const lastNonZeroXirr = (vals) => {
    if (!vals) return null;
    for (let i = vals.length - 1; i >= 0; i--) {
      if (vals[i] != null && vals[i] !== 0) return vals[i];
    }
    return null;
  };
  // Resolve overall stocks / MF XIRR from breakupSummary (same source as XIRR table)
  const xirrSec = breakupSummary.xirr || {};
  const findXirrKey = (...needles) => {
    const keys = Object.keys(xirrSec);
    for (const n of needles) {
      const re = new RegExp(n, 'i');
      const k = keys.find(k => re.test(k) || re.test(xirrSec[k]?.label || ''));
      if (k) return k;
    }
    return null;
  };
  const stocksXirrKey = findXirrKey('stock');
  const mfXirrKey     = findXirrKey('^mf', 'mutual.fund');
  const debtXirrKey   = findXirrKey('^debt', 'bond', '^pf', '^ppf', 'fixed.income');

  // Helper: extract history from a stock instrument (getStockHistoryKey returns the object, not the key)
  const getHoldingHistory = (inst) => {
    if (!historicalHoldings) return null;
    const obj = (typeof getStockHistoryKey === 'function' && getStockHistoryKey(inst))
      || historicalHoldings.stocks[inst];
    return obj?.history || null;
  };

  // Helper: merge cashflows from multiple histories into arrays for computeXIRR
  const mergedXirr = (instruments) => {
    const allCf = [], allDt = [];
    for (const inst of instruments) {
      const history = getHoldingHistory(inst);
      if (!history) continue;
      let prevInv = 0;
      for (const row of history) {
        const delta = (row.invested || 0) - prevInv;
        if (Math.abs(delta) > 1) { allCf.push(-delta); allDt.push(new Date(row.date)); }
        prevInv = row.invested || 0;
      }
      const last = history[history.length - 1];
      if (last?.cur_val) { allCf.push(last.cur_val); allDt.push(new Date(last.date)); }
    }
    const xirr = allCf.length >= 2 ? computeXIRR(allCf, allDt) : null;
    return (xirr != null && isFinite(xirr)) ? xirr : null;
  };

  // Equity XIRR: weighted average of stocks + MF XIRR by current value
  const stocksXirrVal = stocksXirrKey ? lastNonZeroXirr(xirrSec[stocksXirrKey].values) : null;
  const mfXirrVal     = mfXirrKey     ? lastNonZeroXirr(xirrSec[mfXirrKey].values)     : null;
  const stocksVal = latestEquity.reduce((s, e) => s + e.cur_val, 0);
  const mfVal     = latestMf.reduce((s, f) => s + f.cur_val, 0);
  let equityXirr = null;
  if (stocksXirrVal != null && mfXirrVal != null && (stocksVal + mfVal) > 0) {
    equityXirr = (stocksXirrVal * stocksVal + mfXirrVal * mfVal) / (stocksVal + mfVal);
  } else {
    equityXirr = stocksXirrVal ?? mfXirrVal;
  }
  const equityXirrEl = document.getElementById('kpi-equity-xirr');
  if (equityXirrEl && equityXirr != null) {
    equityXirrEl.innerText = (equityXirr * 100).toFixed(1) + '%';
  }

  // Debt XIRR: from breakupSummary.xirr if a matching key exists
  const debtXirrVal = debtXirrKey ? lastNonZeroXirr(xirrSec[debtXirrKey].values) : null;
  const debtXirrEl = document.getElementById('kpi-debt-xirr');
  if (debtXirrEl && debtXirrVal != null) {
    debtXirrEl.innerText = (debtXirrVal * 100).toFixed(1) + '%';
  }

  // Gold XIRR: merge cashflows across all SGB + Gold ETF holdings
  const goldSectors = new Set(['Sovereign Gold Bonds', 'Gold Commodity (ETF)']);
  const goldInstruments = latestEquity.filter(s => goldSectors.has(s.sector)).map(s => s.instrument);
  const goldXirr = mergedXirr(goldInstruments);
  const goldXirrEl = document.getElementById('kpi-gold-xirr');
  if (goldXirrEl && goldXirr != null) {
    goldXirrEl.innerText = (goldXirr * 100).toFixed(1) + '%';
  }

  // Stocks: current value + overall gain (absolute + %)
  const stocksCurrentLakhs = latestEquity.reduce((sum, s) => sum + s.cur_val, 0) / 100000;
  const stocksInvestedLakhs = latestEquity.reduce((sum, s) => sum + s.invested, 0) / 100000;
  const stocksGainLakhs = stocksCurrentLakhs - stocksInvestedLakhs;
  const stocksGainPct = stocksInvestedLakhs > 0 ? (stocksGainLakhs / stocksInvestedLakhs) * 100 : 0;
  document.getElementById('kpi-stocks-uploaded').innerText = formatLakhs(stocksCurrentLakhs);
  document.getElementById('kpi-stocks-gain').innerText = (stocksGainLakhs >= 0 ? '+' : '') + stocksGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-stocks-gain').className = stocksGainLakhs >= 0 ? 'trend-up' : 'trend-down';
  document.getElementById('kpi-stocks-gain-pct').innerText = (stocksGainPct >= 0 ? '+' : '') + stocksGainPct.toFixed(1) + '%';
  document.getElementById('kpi-stocks-gain-pct').className = stocksGainPct >= 0 ? 'trend-up' : 'trend-down';

  // Stocks: active count + overall XIRR
  const stocksActiveCount = latestEquity.filter(s => s.qty > 0).length;
  document.getElementById('kpi-stocks-active-count').innerText = stocksActiveCount;
  const stocksOverallXirr = stocksXirrKey ? lastNonZeroXirr(xirrSec[stocksXirrKey].values) : null;
  if (stocksOverallXirr != null) {
    document.getElementById('kpi-stocks-best-xirr').innerText = (stocksOverallXirr * 100).toFixed(1) + '%';
  }

  // MFs: current value + overall gain (absolute + %)
  const mfCurrentLakhs = latestMf.reduce((sum, f) => sum + f.cur_val, 0) / 100000;
  const mfInvestedLakhs = latestMf.reduce((sum, f) => sum + f.invested, 0) / 100000;
  const mfGainLakhs = mfCurrentLakhs - mfInvestedLakhs;
  const mfGainPct = mfInvestedLakhs > 0 ? (mfGainLakhs / mfInvestedLakhs) * 100 : 0;
  document.getElementById('kpi-mfs-uploaded').innerText = formatLakhs(mfCurrentLakhs);
  document.getElementById('kpi-mfs-gain').innerText = (mfGainLakhs >= 0 ? '+' : '') + mfGainLakhs.toFixed(2) + ' L';
  document.getElementById('kpi-mfs-gain').className = mfGainLakhs >= 0 ? 'trend-up' : 'trend-down';
  document.getElementById('kpi-mfs-gain-pct').innerText = (mfGainPct >= 0 ? '+' : '') + mfGainPct.toFixed(1) + '%';
  document.getElementById('kpi-mfs-gain-pct').className = mfGainPct >= 0 ? 'trend-up' : 'trend-down';

  // MFs: active count + overall XIRR (latestMf uses qty, not units)
  const mfsActiveCount = latestMf.filter(f => f.qty > 0).length;
  document.getElementById('kpi-mfs-active-count').innerText = mfsActiveCount;
  const mfOverallXirr = mfXirrKey ? lastNonZeroXirr(xirrSec[mfXirrKey].values) : null;
  if (mfOverallXirr != null) {
    document.getElementById('kpi-mfs-best-xirr').innerText = (mfOverallXirr * 100).toFixed(1) + '%';
  }

  // PF / PPF values now only rendered in Fixed Income tab (fi-pf-value / fi-ppf-value).
  // The global KPI bar no longer has these cards; initFixedIncomeTab() handles them.
}

// ── Overview Sub-tab Switching ──────────────────────────────────────────────
function switchOverviewSubtab(subtab, btn) {
  // Toggle button active state
  document.querySelectorAll('.overview-subtabs .subtab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Toggle content visibility
  document.querySelectorAll('.overview-subcontent').forEach(c => c.classList.remove('active'));
  document.getElementById(`overview-${subtab}`).classList.add('active');
  // Always re-render on visit — prices may have refreshed while on another subtab
  if (latestEquity) {
    if (subtab === 'daily') renderDailyOverviewTable();
    if (subtab === 'monthly') renderMonthlyOverviewTable();
  }
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

  // Stocks: daily change = (current LTP - yesterday's close) * qty
  // On weekends ltp = Friday's close and yesterdayClose = Thursday's close → shows last working day's change.
  // yesterdayClose is fetched from Google Finance during price refresh
  latestEquity.forEach(s => {
    let prevClose = s.yesterdayClose || null;

    const noLivePrice = typeof hasLivePriceSource === 'function' && !hasLivePriceSource(s.instrument);
    const dailyGain = prevClose ? (s.ltp - prevClose) * s.qty : null;
    const dailyGainPct = prevClose ? ((s.ltp - prevClose) / prevClose) * 100 : null;
    combined.push({
      name: s.instrument,
      type: 'Stock',
      qty: s.qty,
      yesterdayClose: prevClose,
      currentLtp: s.ltp,
      change: dailyGain,
      changePct: dailyGainPct,
      stale: noLivePrice
    });
    if (dailyGain !== null) totalStockGain += dailyGain;
  });

  // MFs: daily change uses previous NAV when the NAV provider returns it.
  latestMf.forEach(f => {
    let previousNav = f.previousNav || null;
    // On weekends: price = Friday's NAV, previousNav = Thursday's NAV → shows Friday's change.

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
    if (s.yesterdayClose) totalPrevStockValue += s.yesterdayClose * s.qty;
  });
  latestMf.forEach(f => {
    if (f.previousNav) totalPrevMfValue += f.previousNav * f.qty;
  });
  const dailyStockPct = totalPrevStockValue > 0 ? (totalStockGain / totalPrevStockValue) * 100 : 0;
  const dailyMfPct = totalPrevMfValue > 0 ? (totalMfGain / totalPrevMfValue) * 100 : 0;
  const dailyTotalPrev = totalPrevStockValue + totalPrevMfValue;
  const dailyTotalPct = dailyTotalPrev > 0 ? (totalGain / dailyTotalPrev) * 100 : 0;

  // ── Nifty 50 daily change (real data from Yahoo Finance ^NSEI) ──
  const niftyDailyPct = _niftyDailyPctReal != null ? _niftyDailyPctReal : 0;
  const niftyDailyLabel = _niftyDailyPctReal != null ? 'Daily change (Nifty 50)' : 'Daily change (loading…)';

  // Apply daily type filter (All / Stocks / MFs)
  const filteredCombined = dailyTypeFilter === 'all'
    ? combined
    : combined.filter(item => item.type.toLowerCase() === dailyTypeFilter);

  // Render Daily Summaries — click cards to filter the table below
  const dailySummaryEl = document.getElementById('daily-summary-kpis');
  if (dailySummaryEl) {
    const G = '#10b981', R = '#ef4444';
    dailySummaryEl.className = 'tab-kpi-bar';
    dailySummaryEl.innerHTML = `
      <div class="tab-kpi-card${dailyTypeFilter === 'stock' ? ' filter-active' : ''}" style="--card-accent:${totalStockGain >= 0 ? G : R}; cursor:pointer;" onclick="setDailyTypeFilter('stock')">
        <div class="tab-kpi-label">Daily Change — Stocks</div>
        <div class="tab-kpi-value ${totalStockGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalStockGain >= 0 ? '+' : ''}${formatINR(totalStockGain)} <span class="tab-kpi-inline-pct">(${dailyStockPct >= 0 ? '+' : ''}${dailyStockPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">vs previous market close</div>
      </div>
      <div class="tab-kpi-card${dailyTypeFilter === 'mf' ? ' filter-active' : ''}" style="--card-accent:${totalMfGain >= 0 ? G : R}; cursor:pointer;" onclick="setDailyTypeFilter('mf')">
        <div class="tab-kpi-label">Daily Change — MFs</div>
        <div class="tab-kpi-value ${totalMfGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalMfGain >= 0 ? '+' : ''}${formatINR(totalMfGain)} <span class="tab-kpi-inline-pct">(${dailyMfPct >= 0 ? '+' : ''}${dailyMfPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">since previous NAV</div>
      </div>
      <div class="tab-kpi-card${dailyTypeFilter === 'all' ? ' filter-active' : ''}" style="--card-accent:${totalGain >= 0 ? G : R}; cursor:pointer;" onclick="setDailyTypeFilter('all')">
        <div class="tab-kpi-label">Combined Change</div>
        <div class="tab-kpi-value ${totalGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalGain >= 0 ? '+' : ''}${formatINR(totalGain)} <span class="tab-kpi-inline-pct">(${dailyTotalPct >= 0 ? '+' : ''}${dailyTotalPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">Stocks + MFs</div>
      </div>
      <div class="tab-kpi-card" style="--card-accent:${niftyDailyPct >= 0 ? G : R};">
        <div class="tab-kpi-label">Nifty 50 (Ref)</div>
        <div class="tab-kpi-value ${niftyDailyPct >= 0 ? 'trend-up' : 'trend-down'}">
          ${niftyDailyPct >= 0 ? '+' : ''}${niftyDailyPct.toFixed(2)}%
        </div>
        <div class="tab-kpi-sub">${niftyDailyLabel}</div>
      </div>
    `;
  }

  // Baseline caption — makes the "daily change" comparison window explicit so a
  // refresh that re-pulls a rolled-forward previous close looks like information,
  // not a glitch. The previous-close *date* isn't stored (Yahoo gives only a
  // price), so we anchor on when prices were last captured.
  const noteEl = document.getElementById('daily-baseline-note');
  if (noteEl) {
    const refreshedAt = (window.lastRefreshReport && window.lastRefreshReport.refreshedAt) || null;
    const asOf = refreshedAt
      ? `prices as of ${refreshedAt}`
      : 'prices not yet refreshed this session';
    noteEl.innerHTML = `ⓘ Baseline = each holding's <b>previous market close</b> from Yahoo, ` +
      `which rolls forward at the end of every trading session — so this figure can change ` +
      `between refreshes even with no trades. Currently comparing against the last close known when ${escapeHtml(asOf)}.`;
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
  tbody.innerHTML = filteredCombined.map(item => {
    const rowClass = item.change === null ? '' : item.change >= 0 ? 'row-gain' : 'row-loss';
    const staleAttr = item.stale ? ' style="opacity:0.6;"' : '';
    return `
    <tr class="${rowClass}"${staleAttr}>
      <td class="instrument-cell">
        ${escapeHtml(item.name)}
        ${item.stale ? '<span title="No live price — showing upload-time value" style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">(stale)</span>' : ''}
      </td>
      <td style="text-align: right;">${item.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatNullableNumber(item.yesterdayClose, 2)}</td>
      <td style="text-align: right;">${item.currentLtp.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;" class="${item.change === null ? '' : item.change >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.stale ? '—' : item.change === null ? 'N/A' : `${item.change >= 0 ? '+' : ''}${formatINR(item.change)}`}
      </td>
      <td style="text-align: right;" class="${item.changePct === null ? '' : item.changePct >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.stale ? '—' : item.changePct === null ? 'N/A' : `${item.changePct >= 0 ? '+' : ''}${item.changePct.toFixed(2)}%`}
      </td>
    </tr>
  `;
  }).join('');
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
  const niftyMonthlyPct = _niftyMonthlyPctReal ?? 0;
  const niftyMonthlyLabel = _niftyMonthlyPctReal != null ? 'Month-to-date change (Nifty 50)' : 'Monthly change (loading…)';

  // Apply monthly type filter (All / Stocks / MFs)
  const filteredCombined = monthlyTypeFilter === 'all'
    ? combined
    : combined.filter(item => item.type.toLowerCase() === monthlyTypeFilter);

  // Render Monthly Summaries — click cards to filter the table below
  const G = '#10b981', R = '#ef4444';
  const monthlySummaryEl = document.getElementById('monthly-summary-kpis');
  if (monthlySummaryEl) {
    monthlySummaryEl.className = 'tab-kpi-bar';
    monthlySummaryEl.innerHTML = `
      <div class="tab-kpi-card${monthlyTypeFilter === 'stock' ? ' filter-active' : ''}" style="--card-accent:${totalStockMonthlyGain >= 0 ? G : R}; cursor:pointer;" onclick="setMonthlyTypeFilter('stock')">
        <div class="tab-kpi-label">Period Gain — Stocks</div>
        <div class="tab-kpi-value ${totalStockMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalStockMonthlyGain >= 0 ? '+' : ''}${formatINR(totalStockMonthlyGain)} <span class="tab-kpi-inline-pct">(${monthlyStockPct >= 0 ? '+' : ''}${monthlyStockPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">since last upload</div>
      </div>
      <div class="tab-kpi-card${monthlyTypeFilter === 'mf' ? ' filter-active' : ''}" style="--card-accent:${totalMfMonthlyGain >= 0 ? G : R}; cursor:pointer;" onclick="setMonthlyTypeFilter('mf')">
        <div class="tab-kpi-label">Period Gain — MFs</div>
        <div class="tab-kpi-value ${totalMfMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalMfMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMfMonthlyGain)} <span class="tab-kpi-inline-pct">(${monthlyMfPct >= 0 ? '+' : ''}${monthlyMfPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">since last upload</div>
      </div>
      <div class="tab-kpi-card${monthlyTypeFilter === 'all' ? ' filter-active' : ''}" style="--card-accent:${totalMonthlyGain >= 0 ? G : R}; cursor:pointer;" onclick="setMonthlyTypeFilter('all')">
        <div class="tab-kpi-label">Combined Gain</div>
        <div class="tab-kpi-value ${totalMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMonthlyGain)} <span class="tab-kpi-inline-pct">(${monthlyTotalPct >= 0 ? '+' : ''}${monthlyTotalPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">Stocks + MFs</div>
      </div>
      <div class="tab-kpi-card" style="--card-accent:${niftyMonthlyPct >= 0 ? G : R};">
        <div class="tab-kpi-label">Nifty 50 (Ref)</div>
        <div class="tab-kpi-value ${niftyMonthlyPct >= 0 ? 'trend-up' : 'trend-down'}">
          ${niftyMonthlyPct >= 0 ? '+' : ''}${niftyMonthlyPct.toFixed(2)}%
        </div>
        <div class="tab-kpi-sub">${niftyMonthlyLabel}</div>
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
    <tr class="${item.gain >= 0 ? 'row-gain' : 'row-loss'}">
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
  renderXirrComparisonTable();
}

function filterGrowthChart() {
  const filter = document.getElementById('growth-time-filter').value;
  const dates = breakupSummary.dates;
  const len = dates.length;

  let sliceIdx = 0;
  if (filter === '3Y') sliceIdx = Math.max(0, len - 36);
  else if (filter === '1Y') sliceIdx = Math.max(0, len - 12);

  const filteredLabels = dates.slice(sliceIdx).map(d => formatDateString(d));

  // Net Worth stacked area
  netWorthGrowthChart.data.labels = filteredLabels;
  netWorthGrowthChart.data.datasets.forEach((dataset, idx) => {
    const key = Object.keys(breakupSummary.net_worth).filter(k => k !== 'Total')[idx];
    dataset.data = breakupSummary.net_worth[key].values.slice(sliceIdx);
  });
  netWorthGrowthChart.update();

  // Capital vs Valuation
  capitalVsValuationChart.data.labels = filteredLabels;
  capitalVsValuationChart.data.datasets[0].data = breakupSummary.net_worth['Total'].values.slice(sliceIdx);
  capitalVsValuationChart.data.datasets[1].data = portfolioSummary.cumulative_investment_history.slice(sliceIdx);
  capitalVsValuationChart.update();

  // Asset Allocation % stacked bar
  if (allocationChart) {
    const nwSec = breakupSummary.net_worth;
    const categoryMap = {
      'Equity':    ['Stocks (Equity)', 'Mutual Funds (Equity)', 'NPS E (Equity)'],
      'Debt':      ['NPS C (Debt)', 'NPS G (Debt)', 'PF (Debt)', 'PPF (Debt)', 'Bonds (Debt)'],
      'Gold':      ['Gold (Gold)'],
      'Liquid':    ['Cash (Liquid)'],
      'Alternate': ['Crypto (Alternate)']
    };
    const slicedDates = dates.slice(sliceIdx);
    const totalPerDate = slicedDates.map((_, i) => {
      const absI = sliceIdx + i;
      return Object.values(categoryMap).flat().reduce((s, k) => s + (nwSec[k]?.values[absI] || 0), 0);
    });
    allocationChart.data.labels = slicedDates.map(d => formatDateString(d));
    allocationChart.data.datasets.forEach((ds, di) => {
      const cat = Object.keys(categoryMap)[di];
      ds.data = slicedDates.map((_, i) => {
        const absI = sliceIdx + i;
        const catVal = categoryMap[cat].reduce((s, k) => s + (nwSec[k]?.values[absI] || 0), 0);
        return totalPerDate[i] > 0 ? (catVal / totalPerDate[i]) * 100 : 0;
      });
    });
    allocationChart.update();
  }

  // XIRR line — respect the Jan-2023 floor so early outliers stay hidden
  if (componentXirrChart) {
    const xirrFloor = dates.findIndex(d => d >= '2023-01-01');
    const effectiveIdx = Math.max(sliceIdx, xirrFloor < 0 ? 0 : xirrFloor);
    const xirrLabels = dates.slice(effectiveIdx).map(d => formatDateString(d));
    componentXirrChart.data.labels = xirrLabels;
    componentXirrChart.data.datasets.forEach(ds => {
      const allVals = breakupSummary.xirr[
        Object.keys(breakupSummary.xirr).find(k => breakupSummary.xirr[k].label === ds.label)
      ]?.values || [];
      ds.data = allVals.slice(effectiveIdx).map(v => v * 100);
    });
    componentXirrChart.update();
  }

  // Allocation Shift area
  if (allocationShiftChart) {
    allocationShiftChart.data.labels = filteredLabels;
    allocationShiftChart.data.datasets.forEach(ds => {
      const key = Object.keys(breakupSummary.contribution).find(
        k => breakupSummary.contribution[k].label === ds.label
      );
      if (key) ds.data = breakupSummary.contribution[key].values.slice(sliceIdx).map(v => v * 100);
    });
    allocationShiftChart.update();
  }
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
  // Short-term performance vs Nifty 50 (lazy + cached; doesn't block the tab)
  loadPerfChart('stock');

  // Destroy existing chart before re-creating
  if (sectorChart) sectorChart.destroy();
  if (capChart) capChart.destroy();
  _collapseStockHistory();

  // Normalize gain_pct: compute from pnl/invested if missing or zero
  latestEquity.forEach(s => {
    if (!s.gain_pct || s.gain_pct === 0) {
      s.gain_pct = s.invested > 0 ? (s.pnl / s.invested) * 100 : 0;
    }
  });

  // 2. Stacked Bar Chart — Equity Portfolio Sector Distribution over Time
  const stockHistory = historicalHoldings.stocks;

  // Collect all unique dates from all stock histories. Floor lowered to
  // inception now that legacy/exited holdings are stitched + sector-tagged
  // (pre-Aug-2022 fragments resolve instead of falling into "Other Equities").
  const allStockDates = new Set();
  Object.values(stockHistory).forEach(stock => {
    stock.history.forEach(h => {
      if (h.date >= '2020-01-01') allStockDates.add(h.date);
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

  // 3. Market Cap Distribution Over Time (stacked % bar — value or count)
  const CAP_ORDER = ['Large Cap', 'Mid Cap', 'Small Cap', 'Other/ETF'];
  const CAP_COLORS = { 'Large Cap': '#3b82f6', 'Mid Cap': '#10b981', 'Small Cap': '#f59e0b', 'Other/ETF': '#64748b' };

  // Build date → cap → { value (₹), count (# stocks) }
  const dateCapMap = {};
  sortedStockDates.forEach(date => {
    dateCapMap[date] = {};
    CAP_ORDER.forEach(c => { dateCapMap[date][c] = { value: 0, count: 0 }; });
    Object.entries(stockHistory).forEach(([ticker, stock]) => {
      const entry = stock.history.find(h => h.date === date);
      if (!entry) return;
      const cap = MARKET_CAP_MAP[ticker] || 'Other/ETF';
      dateCapMap[date][cap].value += entry.cur_val;
      dateCapMap[date][cap].count += 1;
    });
  });

  const capChartLabels = sortedStockDates.map(d => {
    const parts = d.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  });

  function _buildCapDatasets(mode) {
    return CAP_ORDER.map(cap => ({
      label: cap,
      data: sortedStockDates.map(d => {
        const total = CAP_ORDER.reduce((s, c) => s + dateCapMap[d][c][mode], 0);
        return total > 0 ? (dateCapMap[d][cap][mode] / total) * 100 : 0;
      }),
      rawValue: sortedStockDates.map(d => dateCapMap[d][cap].value / 100000),
      rawCount: sortedStockDates.map(d => dateCapMap[d][cap].count),
      backgroundColor: CAP_COLORS[cap],
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.06)'
    }));
  }

  const ctxCap = document.getElementById('stock-cap-chart').getContext('2d');
  capChart = new Chart(ctxCap, {
    type: 'bar',
    data: { labels: capChartLabels, datasets: _buildCapDatasets('value') },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', font: { family: 'Outfit', size: 9 }, maxRotation: 45, minRotation: 30, autoSkip: true, maxTicksLimit: 20 }
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', font: { family: 'Outfit', size: 10 }, callback: val => val.toFixed(0) + '%' },
          min: 0, max: 100
        }
      },
      plugins: {
        legend: { position: 'bottom', labels: getResponsiveLegendLabels(10) },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const pct = ctx.parsed.y.toFixed(1);
              const ds = ctx.dataset;
              const i = ctx.dataIndex;
              const detail = capChart._capMode === 'count'
                ? `${ds.rawCount[i]} stock${ds.rawCount[i] !== 1 ? 's' : ''}`
                : `₹${ds.rawValue[i].toFixed(2)} L`;
              return ` ${ds.label}: ${pct}% (${detail})`;
            }
          }
        }
      },
      interaction: { mode: 'index', intersect: false }
    }
  });
  capChart._capMode = 'value';
  capChart._buildCapDatasets = _buildCapDatasets;

  // Populate Stock Sector Dropdown
  const sectors = [...new Set(latestEquity.map(s => s.sector))].sort();
  const sectorDropdown = document.getElementById('stock-sector-filter');
  sectorDropdown.innerHTML = '<option value="ALL">All Sectors</option>' + 
    sectors.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');

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

// ── Inline row history expansion (Stocks) ────────────────────────────────────
let _inlineStockChart = null;
let _expandedStockSymbol = null;

function _inlineChartOptions(title) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      title: { display: true, text: title, color: '#f3f4f6', font: { family: 'Outfit', size: 13 } },
      legend: { position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 }, padding: 10 } }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10, font: { size: 10 } } },
      y: { position: 'left', grid: { color: 'rgba(255,255,255,0.04)' },
           ticks: { color: '#9ca3af', font: { size: 10 }, callback: v => '₹' + v.toFixed(1) + 'L' } },
      yPrice: { position: 'right', grid: { drawOnChartArea: false },
                ticks: { color: '#9ca3af', font: { size: 10 }, callback: v => '₹' + v.toLocaleString(undefined, {maximumFractionDigits: 0}) } }
    }
  };
}

function _buildExpansionHTML(canvasId, tbodyId, qtyLabel, priceLabel) {
  return `
    <div class="history-chart-side">
      <canvas id="${canvasId}"></canvas>
    </div>
    <div class="history-table-side">
      <table class="history-inline-table">
        <thead><tr>
          <th>Date</th>
          <th>Action</th>
          <th style="text-align:right;">Δ ${qtyLabel}</th>
          <th style="text-align:right;">${qtyLabel}</th>
          <th style="text-align:right;">${priceLabel} (₹)</th>
          <th style="text-align:right;">Δ Invested</th>
        </tr></thead>
        <tbody id="${tbodyId}"></tbody>
      </table>
    </div>`;
}

function _pinExpansionWidth(expRow, tr) {
  const wrapper = tr.closest('.table-wrapper');
  if (wrapper) {
    const panel = expRow.querySelector('.history-panel');
    if (panel) panel.style.width = wrapper.clientWidth + 'px';
  }
}

function toggleStockRowHistory(tr, symbol) {
  if (_expandedStockSymbol === symbol) { _collapseStockHistory(); return; }
  _collapseStockHistory();

  const stock = getStockHistoryKey(symbol) || historicalHoldings.stocks[symbol];
  if (!stock?.history?.length) return;

  _expandedStockSymbol = symbol;
  tr.classList.add('history-row-active');

  const expRow = document.createElement('tr');
  expRow.className = 'history-expansion-row';
  expRow.innerHTML = `<td colspan="${tr.cells.length}"><div class="history-panel">
    ${_buildExpansionHTML('inline-stock-canvas', 'inline-stock-tbody', 'Qty', 'Price')}
  </div></td>`;
  tr.after(expRow);
  _pinExpansionWidth(expRow, tr);

  const history = stock.history;
  _inlineStockChart = new Chart(
    document.getElementById('inline-stock-canvas').getContext('2d'),
    { type: 'line', data: {
        labels: history.map(h => formatDateString(h.date)),
        datasets: [
          { label: 'Valuation (₹ L)', data: history.map(h => h.cur_val / 100000),
            borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: true, borderWidth: 2, yAxisID: 'y' },
          { label: 'Invested (₹ L)', data: history.map(h => h.invested / 100000),
            borderColor: '#10b981', borderWidth: 1.5, borderDash: [5,5], fill: false, yAxisID: 'y' },
          { label: 'LTP (₹)', data: history.map(h => h.ltp),
            borderColor: '#f59e0b', borderWidth: 1.5, fill: false, yAxisID: 'yPrice' }
        ]
      }, options: _inlineChartOptions(`${symbol} — History`) }
  );
  _renderInlineTransactions(history, document.getElementById('inline-stock-tbody'), 2);
}

function _collapseStockHistory() {
  if (_inlineStockChart) { _inlineStockChart.destroy(); _inlineStockChart = null; }
  document.querySelectorAll('#stocks-table-body .history-expansion-row').forEach(r => r.remove());
  document.querySelectorAll('#stocks-table-body .history-row-active').forEach(r => r.classList.remove('history-row-active'));
  _expandedStockSymbol = null;
}

function _renderInlineTransactions(history, tbody, pricePrecision) {
  const deltaRows = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (i === 0) {
      if (h.qty > 0) {
        // invested from first snapshot; fall back to qty × avg_cost if 0
        const dInv = h.invested || (h.avg_cost ? h.qty * h.avg_cost : 0);
        deltaRows.push({ date: h.date, dQty: h.qty, qty: h.qty, price: h.ltp, dInv, action: 'Buy' });
      }
    } else {
      const p = history[i - 1];
      const dQty = h.qty - p.qty;
      if (Math.abs(dQty) > 0.001) {
        let dInv = h.invested - p.invested;
        // Fallback when workbook invested field didn't update: estimate from avg_cost
        if (dInv === 0 && h.avg_cost) dInv = dQty * h.avg_cost;
        deltaRows.push({ date: h.date, dQty, qty: h.qty, price: h.ltp, dInv, action: dQty > 0 ? 'Buy' : 'Sell' });
      }
    }
  }
  tbody.innerHTML = deltaRows.map(r => {
    const isBuy = r.action === 'Buy';
    const aStyle = isBuy ? 'background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)' : 'background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3)';
    return `<tr>
      <td style="white-space:nowrap;">${formatDateString(r.date)}</td>
      <td><span class="history-action-tag" style="${aStyle}">${r.action}</span></td>
      <td style="text-align:right;" class="${r.dQty > 0 ? 'trend-up' : 'trend-down'}">${r.dQty > 0 ? '+' : ''}${r.dQty.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;">${r.qty.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;">₹${r.price.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;" class="${r.dInv >= 0 ? 'trend-up' : 'trend-down'}">${r.dInv >= 0 ? '+' : '−'}${formatINR(Math.abs(r.dInv))}</td>
    </tr>`;
  }).join('');
}

function renderStocksTable(data) {
  const body = document.getElementById('stocks-table-body');
  body.innerHTML = data.map(s => {
    const uploadedPrice = s.lastUploadedPrice !== undefined ? `₹${s.lastUploadedPrice.toLocaleString(undefined, {maximumFractionDigits:2})}` : '—';
    const gain = s.thisMonthGain || 0;
    const noLive = typeof hasLivePriceSource === 'function' && !hasLivePriceSource(s.instrument);
    const xirr = holdingXIRR(s, 'stock');
    const hasHistory = !!(getStockHistoryKey(s.instrument) || historicalHoldings.stocks?.[s.instrument]);
    return `
    <tr class="holdings-row${noLive ? ' stale-row' : ''}"${hasHistory ? ` onclick="toggleStockRowHistory(this,'${escapeAttr(s.instrument)}')" title="Click to view history"` : ''} style="${noLive ? 'opacity:0.65;' : ''}${hasHistory ? 'cursor:pointer;' : ''}">
      <td class="instrument-cell">
        ${hasHistory ? '<span class="row-expand-icon">▶</span>' : ''}${escapeHtml(s.instrument)}
        ${noLive ? '<span title="No live price source — price shown is from upload" style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">(stale)</span>' : ''}
      </td>
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
      <td style="text-align: right;" class="${xirr == null ? '' : (xirr >= 0 ? 'trend-up' : 'trend-down')}">
        ${xirr == null ? '—' : (xirr >= 0 ? '+' : '') + (xirr * 100).toFixed(2) + '%'}
      </td>
      <td style="text-align: right;" class="${gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${gain >= 0 ? '+' : ''}${formatINR(gain)}
      </td>
    </tr>
  `}).join('');
}

function filterStocksTable() {
  _collapseStockHistory();
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
      case 10: valA = holdingXIRR(a, 'stock') ?? -Infinity; valB = holdingXIRR(b, 'stock') ?? -Infinity; break;
      case 11: valA = a.thisMonthGain ?? 0; valB = b.thisMonthGain ?? 0; break;
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
  // Short-term performance vs Nifty 50 (lazy + cached; doesn't block the tab)
  loadPerfChart('mf');

  // Destroy existing charts before re-creating
  if (mfCategoryChart) mfCategoryChart.destroy();
  _collapseMfHistory();

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

  // Populate MF Category dropdown filter
  const categories = [...new Set(latestMf.map(f => f.scheme_type))].sort();
  const typeDropdown = document.getElementById('mf-type-filter');
  typeDropdown.innerHTML = '<option value="ALL">All Categories</option>' + 
    categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

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

// ── Inline row history expansion (MFs) ───────────────────────────────────────
let _inlineMfChart = null;
let _expandedMfScheme = null;

function toggleMfRowHistory(tr, scheme) {
  if (_expandedMfScheme === scheme) { _collapseMfHistory(); return; }
  _collapseMfHistory();

  const mf = historicalHoldings.mfs[scheme];
  if (!mf?.history?.length) return;

  _expandedMfScheme = scheme;
  tr.classList.add('history-row-active');

  const expRow = document.createElement('tr');
  expRow.className = 'history-expansion-row';
  expRow.innerHTML = `<td colspan="${tr.cells.length}"><div class="history-panel">
    ${_buildExpansionHTML('inline-mf-canvas', 'inline-mf-tbody', 'Units', 'NAV')}
  </div></td>`;
  tr.after(expRow);
  _pinExpansionWidth(expRow, tr);

  const history = mf.history;
  const shortName = scheme.length > 42 ? scheme.substring(0, 40) + '…' : scheme;
  _inlineMfChart = new Chart(
    document.getElementById('inline-mf-canvas').getContext('2d'),
    { type: 'line', data: {
        labels: history.map(h => formatDateString(h.date)),
        datasets: [
          { label: 'Valuation (₹ L)', data: history.map(h => h.cur_val / 100000),
            borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: true, borderWidth: 2, yAxisID: 'y' },
          { label: 'Invested (₹ L)', data: history.map(h => h.invested / 100000),
            borderColor: '#10b981', borderWidth: 1.5, borderDash: [5,5], fill: false, yAxisID: 'y' },
          { label: 'NAV (₹)', data: history.map(h => h.ltp),
            borderColor: '#ec4899', borderWidth: 1.5, fill: false, yAxisID: 'yPrice' }
        ]
      }, options: _inlineChartOptions(shortName) }
  );
  _renderInlineTransactions(history, document.getElementById('inline-mf-tbody'), 4);
}

function _collapseMfHistory() {
  if (_inlineMfChart) { _inlineMfChart.destroy(); _inlineMfChart = null; }
  document.querySelectorAll('#mfs-table-body .history-expansion-row').forEach(r => r.remove());
  document.querySelectorAll('#mfs-table-body .history-row-active').forEach(r => r.classList.remove('history-row-active'));
  _expandedMfScheme = null;
}

function renderMfsTable(data) {
  const body = document.getElementById('mfs-table-body');
  body.innerHTML = data.map(f => {
    const uploadedPrice = f.lastUploadedPrice !== undefined ? `₹${f.lastUploadedPrice.toLocaleString(undefined, {maximumFractionDigits:4})}` : '—';
    const gain = f.thisMonthGain || 0;
    const lastRefreshed = f.lastRefreshDate || '—';
    const xirr = holdingXIRR(f, 'mf');
    const hasHistory = !!historicalHoldings.mfs?.[f.scheme];
    return `
    <tr class="holdings-row"${hasHistory ? ` onclick="toggleMfRowHistory(this,'${escapeAttr(f.scheme)}')" title="Click to view history" style="cursor:pointer;"` : ''}>
      <td class="instrument-cell" title="${escapeAttr(f.scheme)}">${hasHistory ? '<span class="row-expand-icon">▶</span>' : ''}${escapeHtml(f.scheme)}</td>
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
      <td style="text-align: right;" class="${xirr == null ? '' : (xirr >= 0 ? 'trend-up' : 'trend-down')}">
        ${xirr == null ? '—' : (xirr >= 0 ? '+' : '') + (xirr * 100).toFixed(2) + '%'}
      </td>
      <td style="text-align: right;" class="${gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${gain >= 0 ? '+' : ''}${formatINR(gain)}
      </td>
    </tr>
  `}).join('');
}

function filterMfsTable() {
  _collapseMfHistory();
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

  // Simulated fallback — replaced by fetchBenchmarkData() when network is available.
  benchmarkData.nifty50.history = dates.map((d, i) => {
    const growth = Math.pow(1.01, i);
    const noise = 1 + (Math.sin(i * 0.3) * 0.05);
    return { date: d, value: firstValue * growth * noise };
  });
  benchmarkData.spx.history = dates.map((d, i) => {
    const growth = Math.pow(1.0083, i);
    const noise = 1 + (Math.sin(i * 0.25 + 1) * 0.04);
    return { date: d, value: firstValue * growth * noise };
  });
  benchmarkData.sensex.history = dates.map((d, i) => {
    const growth = Math.pow(1.01, i);
    const noise = 1 + (Math.sin(i * 0.28 + 0.5) * 0.045);
    return { date: d, value: firstValue * growth * noise };
  });
  benchmarkData.gold.history = dates.map((d, i) => {
    const growth = Math.pow(1.005, i);
    const noise = 1 + (Math.sin(i * 0.15 + 2) * 0.03);
    return { date: d, value: firstValue * growth * noise };
  });
}

// ── Real benchmark data (Yahoo Finance monthly series) ────────────────────────
// Fetches actual monthly closes for Nifty 50, Sensex, S&P 500 and Gold, aligns
// them to the portfolio's date spine, and caches for 24 h. Falls back silently
// to the simulated curves if the network call fails.

const BENCHMARK_MONTHLY_CACHE_KEY = 'ag_portfolio_benchmark_monthly';
const BENCHMARK_MONTHLY_CACHE_TTL = 24 * 60 * 60 * 1000;

const BENCHMARK_SOURCES = {
  nifty50: { symbol: '^NSEI',  label: 'Nifty 50' },
  sensex:  { symbol: '^BSESN', label: 'Sensex' },
  spx:     { symbol: '^GSPC',  label: 'S&P 500' },
  gold:    { symbol: 'GC=F',   label: 'Gold Futures' }
};

// Apply a cache payload (array of {date, value} per key) to benchmarkData.
function _applyBenchmarkPayload(payload) {
  for (const [key, { label }] of Object.entries(BENCHMARK_SOURCES)) {
    if (Array.isArray(payload[key]) && payload[key].length) {
      benchmarkData[key].history = payload[key];
      benchmarkData[key].name   = label;
    }
  }
}

// Re-render the benchmark chart and stats if the Growth tab has been opened.
function _rerenderBenchmarkCharts() {
  if (!benchmarkComparisonChart) return;
  const sel = document.getElementById('benchmark-select');
  const key = sel ? sel.value : 'nifty50';
  try { renderBenchmarkComparisonChart(key); } catch (_) {}
  try { renderXirrComparisonTable(); } catch (_) {}
}

// ── XIRR via Newton-Raphson ─────────────────────────────────────────────────
// cashflows: array of ₹ amounts (negative = money out / investment,
//            positive = money in / liquidation value at end)
// dates: array of Date objects matching cashflows
function computeXIRR(cashflows, dates, guess = 0.1) {
  if (cashflows.length < 2) return null;
  const hasNeg = cashflows.some(c => c < 0);
  const hasPos = cashflows.some(c => c > 0);
  if (!hasNeg || !hasPos) return null;

  const t0 = dates[0].getTime();
  const yearFrac = i => (dates[i].getTime() - t0) / (365.25 * 86400 * 1000);

  const npv = r => cashflows.reduce((s, cf, i) => s + cf / Math.pow(1 + r, yearFrac(i)), 0);
  const dnpv = r => cashflows.reduce((s, cf, i) => {
    const t = yearFrac(i);
    return s - (t * cf) / Math.pow(1 + r, t + 1);
  }, 0);

  let r = guess;
  for (let iter = 0; iter < 100; iter++) {
    const f = npv(r);
    if (!Number.isFinite(f) || Math.abs(f) < 1e-6) return r;
    const df = dnpv(r);
    if (!Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next < -0.99 ? -0.99 : next; // keep above -100%
  }
  return Number.isFinite(r) ? r : null;
}

// Per-holding money-weighted XIRR from its month-by-month history.
// Cashflows: each increase in `invested` is a buy (cash out), each decrease is
// a sell (cash in, valued at cost basis); the final `cur_val` is the terminal
// liquidation value. Consistent with the portfolio/benchmark XIRR table.
// Returns a decimal fraction (e.g. 0.18 = 18%) or null if not computable.
function computeHoldingXIRR(history) {
  if (!history || history.length < 1) return null;
  const cf = [], dt = [];
  let prevInv = 0;
  for (let i = 0; i < history.length; i++) {
    const inv = history[i].invested || 0;
    const delta = inv - prevInv;
    if (Math.abs(delta) > 1) {           // ignore sub-₹1 rounding noise
      cf.push(-delta);
      dt.push(new Date(history[i].date));
    }
    prevInv = inv;
  }
  const last = history[history.length - 1];
  const terminal = last.cur_val || 0;
  if (terminal !== 0) {
    cf.push(terminal);
    dt.push(new Date(last.date));
  }
  return computeXIRR(cf, dt);
}

// Resolve a holding's history and cache its XIRR on the object so render and
// sort share one computation. `type` is 'stock' or 'mf'.
function holdingXIRR(obj, type) {
  if (obj._xirr !== undefined) return obj._xirr;
  let history = null;
  if (type === 'stock') {
    const h = (typeof getStockHistoryKey === 'function' && getStockHistoryKey(obj.instrument))
      || historicalHoldings.stocks[obj.instrument];
    history = h && h.history;
  } else {
    const h = historicalHoldings.mfs[obj.scheme];
    history = h && h.history;
  }
  obj._xirr = computeHoldingXIRR(history);
  return obj._xirr;
}

// Simulate investing the same monthly contributions into the benchmark and
// compute XIRR. Returns { xirr, invested, currentValue, gain } in lakhs.
function simulateBenchmarkXIRR(benchmarkKey, newMoneyLakhs) {
  const bench = benchmarkData[benchmarkKey];
  if (!bench || !bench.history || !bench.history.length) return null;

  const cashflows = [];
  const dates     = [];
  let units = 0;

  for (let i = 0; i < newMoneyLakhs.length; i++) {
    const amount = (newMoneyLakhs[i] || 0) * 100000; // back to ₹
    if (amount === 0) continue;
    const price = bench.history[i] && bench.history[i].value;
    if (!price || price <= 0) continue;
    // Mirror both directions: positive = buy units (cash out), negative =
    // redeem units (cash in). Keeps the benchmark a true mirror of the
    // portfolio's net contributions so "Invested" is comparable.
    const newUnits = amount / price;
    if (units + newUnits < 0) continue; // guard: can't redeem more than held
    units += newUnits;
    cashflows.push(-amount);
    dates.push(new Date(bench.history[i].date));
  }

  const lastIdx = bench.history.length - 1;
  const finalPrice = bench.history[lastIdx].value;
  const currentValue = units * finalPrice;
  if (currentValue <= 0 || !cashflows.length) return null;

  cashflows.push(currentValue);
  dates.push(new Date(bench.history[lastIdx].date));

  const invested = -cashflows.slice(0, -1).reduce((s, v) => s + v, 0);
  return {
    xirr: computeXIRR(cashflows, dates),
    invested: invested / 100000,
    currentValue: currentValue / 100000,
    gain: (currentValue - invested) / 100000,
  };
}

function renderXirrComparisonTable() {
  const tbody = document.getElementById('xirr-comparison-body');
  if (!tbody || !breakupSummary) return;

  const newSec  = breakupSummary.new_investment || {};
  const nwSec   = breakupSummary.net_worth || {};
  const xirrSec = breakupSummary.xirr || {};

  // One-time debug — lists actual keys so it's easy to spot label mismatches.
  if (!window._xirrKeysLogged) {
    console.log('[xirr-table] xirr keys:', Object.keys(xirrSec));
    console.log('[xirr-table] new_investment keys:', Object.keys(newSec));
    console.log('[xirr-table] net_worth keys:', Object.keys(nwSec));
    window._xirrKeysLogged = true;
  }

  // Robust key finder — case-insensitive substring match against both the
  // section key AND the row's label, since Excel sheets word their "Totals"
  // row differently across sections ("Total" vs "Total Investment" vs ...).
  const findKey = (section, ...needles) => {
    const haystack = Object.keys(section);
    for (const n of needles) {
      const re = new RegExp(n, 'i');
      const k  = haystack.find(k =>
        re.test(k) || (section[k] && re.test(section[k].label || ''))
      );
      if (k) return k;
    }
    return null;
  };

  const lastNonZero = vals => {
    if (!vals) return null;
    for (let i = vals.length - 1; i >= 0; i--) {
      if (vals[i] !== 0 && Number.isFinite(vals[i])) return vals[i];
    }
    return null;
  };
  const sumVals  = vals => vals ? vals.reduce((s, v) => s + (v || 0), 0) : null;
  const lastVal  = vals => vals ? vals[vals.length - 1] : null;

  // Try several spellings — Excel can be inconsistent across sections.
  // NOTE: the workbook labels the portfolio-wide XIRR row "Average", not "Total".
  const totalXirrKey   = findKey(xirrSec, '^total$', '^average$', 'overall', 'portfolio');
  const stocksXirrKey  = findKey(xirrSec, 'stock');
  const mfXirrKey      = findKey(xirrSec, '^mf', 'mutual.fund');

  const totalInvKey    = findKey(newSec,  'total.investment', '^total$');
  const stocksInvKey   = findKey(newSec,  'stock');
  const mfInvKey       = findKey(newSec,  '^mf', 'mutual.fund');

  const totalNwKey     = findKey(nwSec,   '^total$', 'overall');
  const stocksNwKey    = findKey(nwSec,   'stock');
  const mfNwKey        = findKey(nwSec,   '^mf', 'mutual.fund');

  // Fallback for newMoneyTotal — same series the benchmark TWR uses.
  const newMoneyTotal = totalInvKey ? newSec[totalInvKey].values : [];

  // ── Time-weighted annualized return (CAGR) helpers ──
  // Merged in from the old "Performance Comparison" panel: time-weighted return
  // strips out contribution timing, complementing the money-weighted XIRR.
  const dates = breakupSummary.dates || [];
  const years = dates.length >= 2
    ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 86400 * 1000)
    : 0;
  const twrAnnualized = (nwArr, newMoneyArr) => {
    if (!nwArr || !newMoneyArr || years <= 0) return null;
    const idx = computeTWRIndex(nwArr, newMoneyArr);
    const start = idx[0], end = idx[idx.length - 1];
    if (!(start > 0)) return null;
    return Math.pow(end / start, 1 / years) - 1;
  };
  const benchAnnualized = key => {
    const h = benchmarkData[key] && benchmarkData[key].history;
    if (!h || h.length < 2 || years <= 0) return null;
    const f = h[0].value, l = h[h.length - 1].value;
    if (!(f > 0)) return null;
    return Math.pow(l / f, 1 / years) - 1;
  };

  const rows = [
    { label: 'Portfolio (Overall)', type: 'portfolio', emphasis: true,
      xirr:     totalXirrKey ? lastNonZero(xirrSec[totalXirrKey].values) : null,
      ann:      (totalNwKey && totalInvKey) ? twrAnnualized(nwSec[totalNwKey].values, newSec[totalInvKey].values) : null,
      invested: totalInvKey  ? sumVals(newSec[totalInvKey].values)       : null,
      value:    totalNwKey   ? lastVal(nwSec[totalNwKey].values)         : null },
    { label: 'Stocks (Equity)', type: 'portfolio',
      xirr:     stocksXirrKey ? lastNonZero(xirrSec[stocksXirrKey].values) : null,
      ann:      (stocksNwKey && stocksInvKey) ? twrAnnualized(nwSec[stocksNwKey].values, newSec[stocksInvKey].values) : null,
      invested: stocksInvKey  ? sumVals(newSec[stocksInvKey].values)       : null,
      value:    stocksNwKey   ? lastVal(nwSec[stocksNwKey].values)         : null },
    { label: 'Mutual Funds (Equity)', type: 'portfolio',
      xirr:     mfXirrKey ? lastNonZero(xirrSec[mfXirrKey].values) : null,
      ann:      (mfNwKey && mfInvKey) ? twrAnnualized(nwSec[mfNwKey].values, newSec[mfInvKey].values) : null,
      invested: mfInvKey  ? sumVals(newSec[mfInvKey].values)       : null,
      value:    mfNwKey   ? lastVal(nwSec[mfNwKey].values)         : null },
  ];

  // Benchmarks — simulate same cashflows.
  for (const [key, { label }] of Object.entries(BENCHMARK_SOURCES)) {
    const sim = simulateBenchmarkXIRR(key, newMoneyTotal);
    // Reflect actual data source: benchmarkData[key].name carries "(simulated)"
    // only when the real Yahoo fetch failed and we fell back to sine-wave data.
    const isSimulated = !!(benchmarkData[key] && (benchmarkData[key].name || '').includes('(simulated)'));
    rows.push({
      label, type: 'benchmark', simulated: isSimulated,
      xirr: sim ? sim.xirr : null,
      ann:  benchAnnualized(key),
      invested: sim ? sim.invested : null,
      value:    sim ? sim.currentValue : null,
    });
  }

  const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const fmtL   = v => v == null ? '—' : '₹' + v.toFixed(2) + ' L';
  const cls    = v => v == null ? '' : (v >= 0 ? 'trend-up' : 'trend-down');

  tbody.innerHTML = rows.map(r => {
    const gain = (r.invested != null && r.value != null) ? (r.value - r.invested) : null;
    const style = r.emphasis ? 'font-weight:700;background:rgba(99,102,241,0.06)' : '';
    const typeBadge = (r.type === 'benchmark' && r.simulated)
      ? '<span style="font-size:0.7rem;color:var(--text-muted);font-weight:400;margin-left:0.4rem">(simulated)</span>'
      : '';
    return `<tr style="${style}">
      <td>${escapeHtml(r.label)}${typeBadge}</td>
      <td style="text-align:right" class="${cls(r.xirr)}">${fmtPct(r.xirr)}</td>
      <td style="text-align:right" class="${cls(r.ann)}">${fmtPct(r.ann)}</td>
      <td style="text-align:right">${fmtL(r.invested)}</td>
      <td style="text-align:right">${fmtL(r.value)}</td>
      <td style="text-align:right" class="${cls(gain)}">${fmtL(gain)}</td>
    </tr>`;
  }).join('');
}

async function fetchBenchmarkData() {
  const dates = breakupSummary?.dates;
  if (!dates || !dates.length) return;

  // Serve from 24-hour cache so the user isn't waiting on every page load.
  try {
    const raw = localStorage.getItem(BENCHMARK_MONTHLY_CACHE_KEY);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - (cached.timestamp || 0) < BENCHMARK_MONTHLY_CACHE_TTL) {
      _applyBenchmarkPayload(cached);
      _rerenderBenchmarkCharts();
      return;
    }
  } catch (_) {}

  const payload = { timestamp: Date.now() };
  let anyOk = false;

  for (const [key, { symbol, label }] of Object.entries(BENCHMARK_SOURCES)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6y&interval=1mo`;
      const res = await fetchViaCorsProxy(url, {}, 15000);
      if (!res.ok) continue;
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      const ts = r?.timestamp;
      // Prefer adjusted closes; fall back to raw closes.
      const closes = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close;
      if (!ts || !closes) continue;

      // Build year-month → close map (timestamp is first trading day of month).
      const ymMap = new Map();
      ts.forEach((t, i) => {
        if (closes[i] == null) return;
        const d = new Date(t * 1000);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        ymMap.set(ym, closes[i]);
      });
      if (!ymMap.size) continue;

      // Align to portfolio date spine with forward-fill for any missing months.
      let lastVal = null;
      const aligned = dates.map(dateStr => {
        const ym = dateStr.slice(0, 7); // 'YYYY-MM'
        const v = ymMap.get(ym);
        if (v != null) lastVal = v;
        return { date: dateStr, value: lastVal };
      });

      // Back-fill any leading nulls from the first valid value.
      const firstValid = aligned.find(h => h.value != null)?.value ?? null;
      if (firstValid == null) continue;
      aligned.forEach(h => { if (h.value == null) h.value = firstValid; });

      benchmarkData[key].history = aligned;
      benchmarkData[key].name   = label;
      payload[key] = aligned;
      anyOk = true;
    } catch (e) {
      console.warn(`fetchBenchmarkData: ${key} (${symbol}) failed —`, e.message);
    }
  }

  if (anyOk) {
    try { localStorage.setItem(BENCHMARK_MONTHLY_CACHE_KEY, JSON.stringify(payload)); } catch (_) {}
    _rerenderBenchmarkCharts();
  }
}

// ==================== BENCHMARK TAB ====================

function initBenchmarkTab() {
  // Destroy existing charts before re-creating
  if (benchmarkComparisonChart) benchmarkComparisonChart.destroy();
  if (rollingReturnsChart) rollingReturnsChart.destroy();

  renderBenchmarkComparisonChart('nifty50');
  renderRollingReturnsChart();
  renderXirrComparisonTable();
}

function switchCapMode(mode, btn) {
  if (!capChart) return;
  capChart._capMode = mode;
  const newDatasets = capChart._buildCapDatasets(mode);
  capChart.data.datasets.forEach((ds, i) => {
    ds.data = newDatasets[i].data;
    ds.rawValue = newDatasets[i].rawValue;
    ds.rawCount = newDatasets[i].rawCount;
  });
  capChart.update();
  document.querySelectorAll('#cap-mode-value, #cap-mode-count').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function updateBenchmarkChart() {
  const benchmark = document.getElementById('benchmark-select').value;
  renderBenchmarkComparisonChart(benchmark);
}

// Compute a Time-Weighted Return index array (starts at 1.0).
// Each sub-period return = nw[i] / (nw[i-1] + newMoney[i])
// so that fresh cash inflows don't distort the performance line.
//
// newMoneyArr should be the per-period ₹ inflow (i.e. monthly capital added),
// NOT a cumulative series and NOT a % share — use
// breakupSummary.new_investment["Total Investment"].values.
function computeTWRIndex(nwArr, newMoneyArr) {
  const idx = [1];
  for (let i = 1; i < nwArr.length; i++) {
    const newMoney = newMoneyArr[i] || 0;
    // Include withdrawals (newMoney < 0) in the denominator so they aren't
    // misread as market losses. Guard base > 0 to avoid division by zero.
    const base = nwArr[i - 1] + newMoney;
    idx.push(idx[idx.length - 1] * (base > 0 ? nwArr[i] / base : 1));
  }
  return idx;
}

function renderBenchmarkComparisonChart(benchmarkKey) {
  const benchmark = benchmarkData[benchmarkKey];
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const newMoneyTotal = breakupSummary.new_investment["Total Investment"].values;

  // Update heading to reflect real vs simulated data source.
  const isSimulated = benchmark.name.includes('(simulated)');
  const headingEl = document.getElementById('benchmark-chart-heading');
  if (headingEl) {
    headingEl.textContent = isSimulated
      ? 'Portfolio vs Benchmark Comparison (Simulated — network unavailable)'
      : 'Portfolio vs Benchmark Comparison';
  }

  const ctx = document.getElementById('benchmark-comparison-chart').getContext('2d');

  if (benchmarkComparisonChart) {
    benchmarkComparisonChart.destroy();
  }

  // ── Time-Weighted Return (TWR) Index for Portfolio ──
  // Uses computeTWRIndex() so fresh cash inflows don't distort the line.
  // Normalised to 100 for direct side-by-side comparison with benchmark.
  const twrIdx = computeTWRIndex(nwTotal, newMoneyTotal);
  const portfolioNormalized = twrIdx.map(v => (v / twrIdx[0]) * 100);

  // Normalise benchmark to start at 100 at the same date as the portfolio.
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

function renderRollingReturnsChart() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const newMoneyTotal = breakupSummary.new_investment["Total Investment"].values;
  
  // Calculate 12-month rolling returns (cash-flow adjusted)
  // Using total-return-index values to strip out new-investment effects
  const rollingReturns = [];
  const labels = [];
  
  const twrIdx = computeTWRIndex(nwTotal, newMoneyTotal);
  for (let i = 12; i < nwTotal.length; i++) {
    const ret = twrIdx[i - 12] > 0 ? ((twrIdx[i] / twrIdx[i - 12]) - 1) * 100 : 0;
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

// ── Periodic Performance ────────────────────────────────────────────────────

function _buildPeriodBuckets(gran) {
  const dates   = breakupSummary.dates;                              // YYYY-MM-DD
  const nwVals  = breakupSummary.net_worth["Total"].values;
  const invVals = breakupSummary.new_investment["Total Investment"].values;
  const n       = dates.length;
  if (!n) return [];

  // Return the bucket key for a given date string
  function bucketOf(d) {
    const yr = +d.slice(0, 4);
    const mo = +d.slice(5, 7);   // 1-12
    if (gran === 'Q')   return `${yr} Q${Math.ceil(mo / 3)}`;
    if (gran === 'H')   return `${yr} H${mo <= 6 ? 1 : 2}`;
    if (gran === 'Y')   return `${yr}`;
    if (gran === 'MAT') return null; // handled separately
    return `${yr}`;
  }

  if (gran === 'MAT') {
    // Rolling 12-month windows, aligned to the last data point
    const buckets = [];
    // Each bucket: ending at index i, spanning 12 months back
    for (let e = n - 1; e >= 1; e--) {
      const endDate   = dates[e];
      const endYr     = +endDate.slice(0, 4);
      const endMo     = +endDate.slice(5, 7);
      // Target start: 12 months before endDate
      const startYr   = endMo === 12 ? endYr - 1 : endYr - 1;
      const startMo   = endMo === 12 ? 12 : endMo;
      const targetStart = `${(endYr - 1).toString().padStart(4,'0')}-${endMo.toString().padStart(2,'0')}`;
      // Find the closest index at or before targetStart
      let s = -1;
      for (let j = e - 1; j >= 0; j--) {
        if (dates[j] <= targetStart) { s = j; break; }
      }
      if (s < 0) break; // not enough history for a full year

      const openNW    = nwVals[s];
      const closeNW   = nwVals[e];
      const deltaNW   = closeNW - openNW;
      let   newInv    = 0;
      for (let k = s + 1; k <= e; k++) newInv += invVals[k];
      const mktRet    = deltaNW - newInv;
      buckets.unshift({
        label:    `MAT ${endDate.slice(0, 7)}`,
        shortLbl: endDate.slice(0, 7),
        openNW, closeNW, deltaNW,
        newInv, mktRet,
        deltaNWPct:  openNW ? (deltaNW / openNW) * 100 : 0,
        mktRetPct:   openNW ? (mktRet / openNW) * 100 : 0,
      });
      if (buckets.length >= 8) break; // show last 8 MAT windows
    }
    return buckets;
  }

  // Group indices by bucket key (keep last index per bucket as "close")
  const byBucket = new Map();
  for (let i = 0; i < n; i++) {
    const k = bucketOf(dates[i]);
    if (!byBucket.has(k)) byBucket.set(k, { indices: [] });
    byBucket.get(k).indices.push(i);
  }

  const buckets = [];
  const keys    = [...byBucket.keys()].sort();
  for (let bi = 0; bi < keys.length; bi++) {
    const key   = keys[bi];
    const idxs  = byBucket.get(key).indices;
    const closeIdx = idxs[idxs.length - 1];

    // Opening NW = last snapshot of previous bucket (or first snapshot of this bucket)
    let openIdx;
    if (bi === 0) {
      openIdx = idxs[0];
    } else {
      const prevIdxs = byBucket.get(keys[bi - 1]).indices;
      openIdx = prevIdxs[prevIdxs.length - 1];
    }

    const openNW  = nwVals[openIdx];
    const closeNW = nwVals[closeIdx];
    const deltaNW = closeNW - openNW;
    let   newInv  = 0;
    const sumFrom = bi === 0 ? idxs[0] : openIdx + 1;
    for (let k = sumFrom; k <= closeIdx; k++) newInv += invVals[k];
    const mktRet  = deltaNW - newInv;

    buckets.push({
      label:    key,
      shortLbl: key,
      openNW, closeNW, deltaNW,
      newInv, mktRet,
      deltaNWPct: openNW ? (deltaNW / openNW) * 100 : 0,
      mktRetPct:  openNW ? (mktRet / openNW) * 100 : 0,
      isPartial:  idxs[idxs.length - 1] === n - 1, // last bucket may be incomplete
    });
  }
  return buckets;
}

function _buildComparisons(buckets, gran) {
  const n   = buckets.length;
  if (n < 1) return [];
  const cur = buckets[n - 1];
  const pairs = [];

  // Current vs Previous period (CQ vs LQ / CH vs LH / CY vs LY)
  const prevLabels = { Q: 'LQ', H: 'LH', Y: 'LY', MAT: 'Prev MAT' };
  const curLabels  = { Q: 'CQ', H: 'CH', Y: 'CYTD', MAT: 'MAT' };
  if (n >= 2) {
    pairs.push({ label: `${curLabels[gran]} vs ${prevLabels[gran]}`, a: cur, aLbl: curLabels[gran], b: buckets[n - 2], bLbl: prevLabels[gran] });
  }

  // Current period vs same period last year
  if (gran === 'Q' || gran === 'H') {
    const curPeriodSuffix = cur.label.split(' ')[1]; // e.g. "Q3" or "H2"
    const lycMatch = buckets.slice(0, n - 1).filter(b => b.label.endsWith(curPeriodSuffix));
    if (lycMatch.length) {
      const lyc = lycMatch[lycMatch.length - 1];
      const lyLabel = gran === 'Q' ? 'LYCQ' : 'LYCH';
      pairs.push({ label: `${curLabels[gran]} vs ${lyLabel}`, a: cur, aLbl: curLabels[gran], b: lyc, bLbl: lyLabel });
    }
  }

  // For Y, the CY vs LY comparison is already covered by the first pair above

  return pairs;
}

function renderPeriodicPerformance(gran) {
  _periodicGran = gran || _periodicGran;
  if (!breakupSummary) return;

  // Update toggle buttons
  document.querySelectorAll('.periodic-gran-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.gran === _periodicGran);
  });

  const buckets = _buildPeriodBuckets(_periodicGran);
  if (!buckets.length) return;

  const comparisons = _buildComparisons(buckets, _periodicGran);

  // ── Comparison Cards ──
  // breakupSummary values are already in lakhs — use formatLakhs, not formatINR
  const cardsFmt = (v, isPct) => isPct
    ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
    : `${v >= 0 ? '+' : '−'}${formatLakhs(Math.abs(v))}`;

  const deltaClass = v => v >= 0 ? 'trend-up' : 'trend-down';

  const compHTML = comparisons.map(({ label, a, aLbl, b, bLbl }) => {
    const nwDelta   = a.deltaNWPct - b.deltaNWPct;
    const mktDelta  = a.mktRetPct  - b.mktRetPct;
    const invDelta  = a.newInv     - b.newInv;
    return `
    <div class="periodic-comp-card">
      <div class="periodic-comp-title">${label}</div>
      <table class="periodic-comp-table">
        <thead><tr><th>Metric</th><th>${aLbl}${a.isPartial ? '*' : ''}</th><th>${bLbl}${b.isPartial ? '*' : ''}</th><th>Δ</th></tr></thead>
        <tbody>
          <tr>
            <td>NW Change</td>
            <td class="${deltaClass(a.deltaNW)}">${cardsFmt(a.deltaNW, false)}</td>
            <td class="${deltaClass(b.deltaNW)}">${cardsFmt(b.deltaNW, false)}</td>
            <td class="${deltaClass(a.deltaNW - b.deltaNW)}">${cardsFmt(a.deltaNW - b.deltaNW, false)}</td>
          </tr>
          <tr>
            <td>NW Change %</td>
            <td class="${deltaClass(a.deltaNWPct)}">${cardsFmt(a.deltaNWPct, true)}</td>
            <td class="${deltaClass(b.deltaNWPct)}">${cardsFmt(b.deltaNWPct, true)}</td>
            <td class="${deltaClass(nwDelta)}">${nwDelta >= 0 ? '+' : ''}${nwDelta.toFixed(2)}pp</td>
          </tr>
          <tr>
            <td>Market Return</td>
            <td class="${deltaClass(a.mktRet)}">${cardsFmt(a.mktRet, false)}</td>
            <td class="${deltaClass(b.mktRet)}">${cardsFmt(b.mktRet, false)}</td>
            <td class="${deltaClass(a.mktRet - b.mktRet)}">${cardsFmt(a.mktRet - b.mktRet, false)}</td>
          </tr>
          <tr>
            <td>Market Return %</td>
            <td class="${deltaClass(a.mktRetPct)}">${cardsFmt(a.mktRetPct, true)}</td>
            <td class="${deltaClass(b.mktRetPct)}">${cardsFmt(b.mktRetPct, true)}</td>
            <td class="${deltaClass(mktDelta)}">${mktDelta >= 0 ? '+' : ''}${mktDelta.toFixed(2)}pp</td>
          </tr>
          <tr>
            <td>New Investment</td>
            <td>${formatLakhs(a.newInv)}</td>
            <td>${formatLakhs(b.newInv)}</td>
            <td class="${deltaClass(invDelta)}">${cardsFmt(invDelta, false)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
  }).join('');

  document.getElementById('periodic-comparisons').innerHTML = compHTML ||
    '<div style="color:var(--text-muted);padding:1rem">Not enough data for comparison</div>';

  // ── Bar Chart ──
  // breakupSummary stores values in lakhs already — no conversion needed
  const labels   = buckets.map(b => b.shortLbl);
  const nwChange = buckets.map(b => +b.deltaNW.toFixed(2));
  const mktRet   = buckets.map(b => +b.mktRet.toFixed(2));
  const newInvL  = buckets.map(b => +b.newInv.toFixed(2));

  const ctx = document.getElementById('periodic-perf-chart').getContext('2d');
  if (periodicPerfChart) periodicPerfChart.destroy();
  periodicPerfChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'NW Change (₹ L)', data: nwChange,
          borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)',
          fill: true, borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#6366f1', tension: 0.3 },
        { label: 'Market Return (₹ L)', data: mktRet,
          borderColor: '#10b981', backgroundColor: 'transparent',
          fill: false, borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#10b981',
          borderDash: [5, 3], tension: 0.3 },
        { label: 'New Investment (₹ L)', data: newInvL,
          borderColor: '#f59e0b', backgroundColor: 'transparent',
          fill: false, borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#f59e0b',
          borderDash: [2, 3], tension: 0.3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { color: '#9ca3af', boxWidth: 20, usePointStyle: true, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ₹${c.parsed.y.toFixed(2)} L` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxRotation: 45 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' },
             ticks: { color: '#9ca3af', callback: v => '₹' + v.toFixed(1) + 'L' } }
      }
    }
  });
}

function initMonthlyTab() {
  // Destroy existing charts before re-creating
  if (monthlyChangeChart) monthlyChangeChart.destroy();
  if (monthlyActivityChart) monthlyActivityChart.destroy();
  if (periodicPerfChart) { periodicPerfChart.destroy(); periodicPerfChart = null; }

  renderPeriodicPerformance(_periodicGran);

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
    html += '<thead><tr><th>Instrument</th><th>Status</th><th>Price (₹)</th><th>Prev Close (₹)</th><th>Change %</th><th>Last Refreshed</th><th>Error</th></tr></thead><tbody>';
    for (const s of report.stockDetails) {
      const statusClass = s.status === 'success' ? 'status-ok' : s.status === 'stale' ? 'status-stale' : (s.status === 'skipped' || s.status === 'stable') ? 'status-skip' : 'status-fail';
      const statusText = s.status === 'success' ? '✅ OK' : s.status === 'stale' ? '⚠️ Stale' : s.status === 'stable' ? '🔒 Stable' : s.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
      const price = s.price != null ? s.price.toFixed(2) : '—';
      const prevClose = s.prevClose != null ? s.prevClose.toFixed(2) : '—';
      const rawChangePct = (s.price != null && s.prevClose != null && s.prevClose > 0)
        ? (s.price - s.prevClose) / s.prevClose * 100 : null;
      const changePctCell = rawChangePct != null
        ? `<td class="${rawChangePct >= 0 ? 'change-up' : 'change-down'}">${rawChangePct >= 0 ? '+' : ''}${rawChangePct.toFixed(2)}%</td>`
        : '<td>—</td>';
      const lastRefresh = s.lastRefresh ? escapeHtml(s.lastRefresh) : '—';
      const error = s.error ? escapeHtml(s.error) : '—';
      html += `<tr class="${statusClass}"><td>${escapeHtml(s.instrument)}</td><td>${statusText}</td><td>${price}</td><td>${prevClose}</td>${changePctCell}<td>${lastRefresh}</td><td class="error-cell">${error}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  // ── Per-MF Details Table ──
  if (report.mfDetails && report.mfDetails.length > 0) {
    html += '<h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem;">📊 Mutual Fund NAV Details</h3>';
    html += '<div class="table-wrapper"><table class="update-log-table">';
    html += '<thead><tr><th>Scheme</th><th>Status</th><th>NAV (₹)</th><th>Prev NAV (₹)</th><th>Change %</th><th>Last Refreshed</th><th>Error</th></tr></thead><tbody>';
    for (const m of report.mfDetails) {
      const statusClass = m.status === 'success' ? 'status-ok' : m.status === 'stale' ? 'status-stale' : m.status === 'skipped' ? 'status-skip' : 'status-fail';
      const statusText = m.status === 'success' ? '✅ OK' : m.status === 'stale' ? '⚠️ Stale' : m.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
      const nav = m.nav != null ? m.nav.toFixed(4) : '—';
      const prevNav = m.prevNav != null ? m.prevNav.toFixed(4) : '—';
      const rawChangePct = (m.nav != null && m.prevNav != null && m.prevNav > 0)
        ? (m.nav - m.prevNav) / m.prevNav * 100 : null;
      const changePctCell = rawChangePct != null
        ? `<td class="${rawChangePct >= 0 ? 'change-up' : 'change-down'}">${rawChangePct >= 0 ? '+' : ''}${rawChangePct.toFixed(2)}%</td>`
        : '<td>—</td>';
      const lastRefresh = m.lastRefresh ? escapeHtml(m.lastRefresh) : '—';
      const error = m.error ? escapeHtml(m.error) : '—';
      html += `<tr class="${statusClass}"><td>${escapeHtml(m.scheme)}</td><td>${statusText}</td><td>${nav}</td><td>${prevNav}</td>${changePctCell}<td>${lastRefresh}</td><td class="error-cell">${error}</td></tr>`;
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

// Cached mover results — reused by switchMoversMode without re-querying history
let _lastMoversData = [];
let _moversMode = 'pct'; // 'pct' | 'abs'

function renderMonthlyMovers(count = 1, startIndex = 0, endIndex = null) {
  const dates  = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  if (endIndex === null) endIndex = nwTotal.length - 1;

  const selectedStartDate = dates[startIndex];
  const selectedEndDate   = dates[endIndex];

  // Build stock-key lookup map once per session
  if (!window._stockNameMap) {
    window._stockNameMap = {};
    Object.keys(historicalHoldings.stocks).forEach(key => {
      const upper = key.toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      window._stockNameMap[clean] = key;
      const withoutLtd = clean.replace(/LTD$/, '').replace(/LIMITED$/, '').trim();
      if (withoutLtd && withoutLtd !== clean) window._stockNameMap[withoutLtd] = key;
      const words = upper.split(/[^A-Z0-9]+/).filter(w => w.length > 2);
      if (words.length > 1 && !window._stockNameMap[words[0]]) window._stockNameMap[words[0]] = key;
      if (upper.includes('&')) {
        upper.split('&').forEach(p => {
          const t = p.replace(/[^A-Z0-9]/g, '').trim();
          if (t.length >= 3 && !window._stockNameMap[t]) window._stockNameMap[t] = key;
        });
      }
    });
  }

  _lastMoversData = [];
  const isFiltered = heatmapSelectedIndices.size > 0;

  // Movers measure price-only return on the position you held at the start of
  // the period — equivalent to what the Stock Analytics LTP chart would show
  // for that span, with corporate actions (splits / bonus issues) neutralised.
  //
  // pctGain = (endLtp × splitFactor − startLtp) / startLtp  × 100
  // absGain = startQty × (endLtp × splitFactor − startLtp)
  //
  // where splitFactor is the cumulative product of qty-jump ratios across
  // any split/bonus events between start and end. A "split/bonus" is detected
  // when qty grows ≥ 1.5× between consecutive history entries AND invested
  // is virtually unchanged (within 5%). New purchases inflate `invested` and
  // therefore never trigger this rule, so accumulated holdings like GOLDBEES
  // are unaffected; only true corporate actions are scaled.
  latestEquity.forEach(stock => {
    const clean    = stock.instrument.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const stockKey = window._stockNameMap[clean] || stock.instrument;
    const hist     = historicalHoldings.stocks[stockKey];
    if (!hist) return;

    const history = hist.history;
    let startIdx, endIdx;
    if (!isFiltered) {
      startIdx = 0;
      endIdx   = history.length - 1;
    } else {
      startIdx = history.findIndex(h => h.date >= selectedStartDate);
      if (startIdx === -1) startIdx = 0;
      endIdx = -1;
      for (let h = history.length - 1; h >= 0; h--) {
        if (history[h].date <= selectedEndDate) { endIdx = h; break; }
      }
    }
    if (startIdx < 0 || endIdx <= startIdx) return;

    const startEntry = history[startIdx];
    const endEntry   = history[endIdx];
    const startLtp   = startEntry.ltp || 0;
    const endLtp     = endEntry.ltp   || 0;
    if (startLtp <= 0 || endLtp <= 0) return;

    // Detect splits/bonuses within (startIdx, endIdx].
    let splitFactor = 1;
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const prev = history[i - 1];
      const cur  = history[i];
      if (prev.qty <= 0) continue;
      const qtyRatio = cur.qty / prev.qty;
      const invRatio = prev.invested > 0 ? cur.invested / prev.invested : 1;
      if (qtyRatio >= 1.5 && Math.abs(invRatio - 1) < 0.05) {
        splitFactor *= qtyRatio;
      }
    }

    const adjEndLtp = endLtp * splitFactor;
    const pctGain   = ((adjEndLtp - startLtp) / startLtp) * 100;
    const absGain   = startEntry.qty * (adjEndLtp - startLtp);

    _lastMoversData.push({
      name: stock.instrument,
      sector: stock.sector,
      qty: startEntry.qty,
      pctGain,
      absGain,
      source: isFiltered ? 'period' : 'full history',
    });
  });

  _applyMoversMode(_moversMode);
}

function _applyMoversMode(mode) {
  const sorted  = [..._lastMoversData].sort((a, b) =>
    mode === 'abs' ? b.absGain - a.absGain : b.pctGain - a.pctGain
  );
  const winners = sorted.filter(d => (mode === 'abs' ? d.absGain : d.pctGain) >= 0);
  const losers  = [..._lastMoversData].sort((a, b) =>
    mode === 'abs' ? a.absGain - b.absGain : a.pctGain - b.pctGain
  ).filter(d => (mode === 'abs' ? d.absGain : d.pctGain) < 0);

  // Update period label to clarify the metric source
  const isCumulative = _lastMoversData.length > 0 && _lastMoversData[0].source === 'cumulative';
  const modeLabel    = mode === 'abs' ? 'by absolute ₹' : 'by % return';
  const sourceLabel  = isCumulative ? 'cumulative since purchase' : 'for selected period';
  const periodEl = document.getElementById('movers-period-label');
  if (periodEl) periodEl.textContent = `— ${modeLabel}, ${sourceLabel}`;

  const fmtAbs = v => (v >= 0 ? '+' : '−') + formatINR(Math.abs(v));
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const empty  = '<div class="mover-item" style="color:var(--text-muted);padding:0.5rem 1rem">No data for selected period</div>';

  const makeRow = (d, isWinner) => {
    const primary   = mode === 'abs' ? fmtAbs(d.absGain) : fmtPct(d.pctGain);
    const secondary = mode === 'abs' ? fmtPct(d.pctGain) : fmtAbs(d.absGain);
    const cls       = isWinner ? 'trend-up' : 'trend-down';
    return `
      <div class="mover-item">
        <div class="mover-info">
          <div class="mover-name">${escapeHtml(d.name)}</div>
          <div class="mover-sector">${escapeHtml(d.sector)}</div>
        </div>
        <div class="mover-detail">
          <span class="mover-change ${cls}">${primary}</span>
          <span class="mover-qty">${secondary}</span>
        </div>
      </div>`;
  };

  document.getElementById('monthly-gainers-list').innerHTML =
    winners.slice(0, 5).map(d => makeRow(d, true)).join('') || empty;
  document.getElementById('monthly-losers-list').innerHTML =
    losers.slice(0, 5).map(d => makeRow(d, false)).join('') || empty;

  const wh = document.getElementById('movers-winners-heading');
  const lh = document.getElementById('movers-losers-heading');
  if (wh) wh.textContent = `Top Winners — ${modeLabel}`;
  if (lh) lh.textContent = `Top Losers — ${modeLabel}`;
}

function switchMoversMode(mode, btn) {
  _moversMode = mode;
  _applyMoversMode(mode);
  document.querySelectorAll('#movers-mode-pct, #movers-mode-abs')
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
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
      case 10: valA = holdingXIRR(a, 'mf') ?? -Infinity; valB = holdingXIRR(b, 'mf') ?? -Infinity; break;
      case 11: valA = a.thisMonthGain ?? 0; valB = b.thisMonthGain ?? 0; break;
    }

    if (typeof valA === 'string') {
      return mfSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return mfSortAsc ? valA - valB : valB - valA;
    }
  });

  renderMfsTable(filtered);
}

// ════════════════════════════════════════════════════════════════════════
// MANAGE PORTFOLIO TAB — incremental transaction & balance entry
// Backed by js/ledger.js (deriveHoldings, closeMonth) + js/export.js.
// ════════════════════════════════════════════════════════════════════════

function initManageTab() {
  const today = new Date().toISOString().slice(0, 10);
  ['txn-date', 'bal-date', 'close-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = today;
  });
  onTxnAssetClassChange();
  renderLedger();
}

// Populate the instrument autocomplete from current holdings for the chosen class.
function populateInstrumentDatalist() {
  const dl = document.getElementById('txn-instrument-list');
  if (!dl) return;
  const cls = document.getElementById('txn-assetClass').value;
  const names = cls === 'mf'
    ? (latestMf || []).map(f => f.scheme)
    : (latestEquity || []).map(s => s.instrument);
  dl.innerHTML = names.sort().map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function onTxnAssetClassChange() {
  const cls = document.getElementById('txn-assetClass').value;
  document.getElementById('txn-category-wrap').style.display = cls === 'mf' ? '' : 'none';
  populateInstrumentDatalist();
}

function onTxnAmountInputs() {
  const qty = parseFloat(document.getElementById('txn-qty').value);
  const price = parseFloat(document.getElementById('txn-price').value);
  const amtEl = document.getElementById('txn-amount');
  if (!amtEl.dataset.touched && isFinite(qty) && isFinite(price)) {
    amtEl.value = +(qty * price).toFixed(2);
  }
}

function handleTxnSubmit(e) {
  e.preventDefault();
  if (typeof addTransaction !== 'function') { alert('Ledger module not loaded.'); return false; }
  const editId = document.getElementById('txn-edit-id').value;
  const payload = {
    assetClass: document.getElementById('txn-assetClass').value,
    type: document.getElementById('txn-type').value,
    instrument: document.getElementById('txn-instrument').value.trim(),
    category: document.getElementById('txn-category').value.trim() || null,
    date: document.getElementById('txn-date').value,
    qty: parseFloat(document.getElementById('txn-qty').value),
    price: parseFloat(document.getElementById('txn-price').value),
    amount: document.getElementById('txn-amount').value ? parseFloat(document.getElementById('txn-amount').value) : null,
    note: document.getElementById('txn-note').value.trim(),
  };
  if (!payload.instrument || !isFinite(payload.qty) || !isFinite(payload.price)) {
    alert('Instrument, quantity and price are required.'); return false;
  }
  if (editId) updateTransaction(editId, payload);
  else addTransaction(payload);
  resetTxnForm();
  refreshAfterLedgerChange();
  renderLedger();
  return false;
}

function resetTxnForm() {
  const f = document.getElementById('txn-form');
  if (f) f.reset();
  document.getElementById('txn-edit-id').value = '';
  document.getElementById('txn-amount').dataset.touched = '';
  document.getElementById('txn-submit-btn').textContent = 'Add Transaction';
  document.getElementById('txn-cancel-btn').style.display = 'none';
  document.getElementById('txn-date').value = new Date().toISOString().slice(0, 10);
  onTxnAssetClassChange();
}

function editTxn(id) {
  const t = (transactions || []).find(x => x.id === id);
  if (!t) return;
  document.getElementById('txn-edit-id').value = t.id;
  document.getElementById('txn-assetClass').value = t.assetClass;
  document.getElementById('txn-type').value = t.type;
  document.getElementById('txn-instrument').value = t.instrument;
  document.getElementById('txn-category').value = t.category || '';
  document.getElementById('txn-date').value = t.date;
  document.getElementById('txn-qty').value = t.qty;
  document.getElementById('txn-price').value = t.price;
  const amt = document.getElementById('txn-amount');
  amt.value = t.amount; amt.dataset.touched = '1';
  document.getElementById('txn-note').value = t.note || '';
  document.getElementById('txn-submit-btn').textContent = 'Update Transaction';
  document.getElementById('txn-cancel-btn').style.display = '';
  onTxnAssetClassChange();
  document.getElementById('txn-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeTxn(id) {
  if (!confirm('Delete this transaction?')) return;
  deleteTransaction(id);
  refreshAfterLedgerChange();
  renderLedger();
}

function handleBalSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('bal-edit-id').value;
  const payload = {
    component: document.getElementById('bal-component').value,
    date: document.getElementById('bal-date').value,
    value: parseFloat(document.getElementById('bal-value').value),
    contribution: parseFloat(document.getElementById('bal-contribution').value) || 0,
    note: document.getElementById('bal-note').value.trim(),
  };
  if (!isFinite(payload.value)) { alert('Current value is required.'); return false; }
  if (editId) updateBalance(editId, payload);
  else addBalance(payload);
  resetBalForm();
  renderLedger();
  return false;
}

function resetBalForm() {
  const f = document.getElementById('bal-form');
  if (f) f.reset();
  document.getElementById('bal-edit-id').value = '';
  document.getElementById('bal-submit-btn').textContent = 'Save Balance';
  document.getElementById('bal-cancel-btn').style.display = 'none';
  document.getElementById('bal-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('bal-contribution').value = '0';
}

function editBal(id) {
  const b = (balances || []).find(x => x.id === id);
  if (!b) return;
  document.getElementById('bal-edit-id').value = b.id;
  document.getElementById('bal-component').value = b.component;
  document.getElementById('bal-date').value = b.date;
  document.getElementById('bal-value').value = b.value;
  document.getElementById('bal-contribution').value = b.contribution;
  document.getElementById('bal-note').value = b.note || '';
  document.getElementById('bal-submit-btn').textContent = 'Update Balance';
  document.getElementById('bal-cancel-btn').style.display = '';
  document.getElementById('bal-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeBal(id) {
  if (!confirm('Delete this balance entry?')) return;
  deleteBalance(id);
  renderLedger();
}

// Re-derive holdings from the ledger and re-render every analytics view,
// including Periodic Performance.
function refreshAfterLedgerChange() {
  if (typeof applyLedgerToHoldings === 'function') applyLedgerToHoldings();
  if (typeof initializeLiveBaseline === 'function') initializeLiveBaseline();
  try { updateKpis(); } catch (e) { console.error(e); }
  try { renderDailyOverviewTable(); renderMonthlyOverviewTable(); } catch (e) {}
  try { initStocksTab(); } catch (e) {}
  try { initMfsTab(); } catch (e) {}
  try { initGrowthTab(); } catch (e) {}
  try { initFixedIncomeTab(); } catch (e) {}
  try { initNpsTab(); } catch (e) {}
  try { initMonthlyTab(); } catch (e) {}   // Periodic Performance
  try { saveRefreshedPrices(latestEquity, latestMf); } catch (e) {}
}

function handleCloseMonth() {
  const date = document.getElementById('close-date').value;
  const preview = document.getElementById('close-preview');
  if (!date) { preview.textContent = 'Pick a close date first.'; return; }
  try {
    const res = closeMonth(date);
    refreshAfterLedgerChange();
    renderLedger();
    const xirr = res.portfolioXirr != null ? (res.portfolioXirr * 100).toFixed(2) + '%' : '—';
    preview.innerHTML = `<span class="trend-up">✓ Period ${res.date} closed.</span><br>` +
      `Net worth: <b>${formatLakhs(res.totalValue)}</b> · Change: <b>${formatLakhs(res.netChange)}</b> · ` +
      `New investment: <b>${formatLakhs(res.newInvestment)}</b> · Portfolio XIRR: <b>${xirr}</b><br>` +
      `<span style="color:var(--text-muted)">Click 🚀 Commit (top bar) to save permanently.</span>`;
  } catch (err) {
    preview.innerHTML = `<span class="trend-down">⚠️ ${escapeHtml(err.message)}</span>`;
  }
}

async function handleImportBackup(e) {
  const file = e.target.files && e.target.files[0];
  const status = document.getElementById('backup-status');
  if (!file) return;
  if (!confirm('Importing will REPLACE all current in-memory data. Continue?')) { e.target.value = ''; return; }
  try {
    const data = await importBackupJson(file);
    portfolioSummary = data.portfolio_summary || portfolioSummary;
    breakupSummary = data.breakup_summary || breakupSummary;
    latestEquity = data.latest_equity || latestEquity;
    latestMf = data.latest_mf || latestMf;
    historicalHoldings = data.historical_holdings || historicalHoldings;
    if (typeof stitchHistoryFragments === 'function') historicalHoldings = stitchHistoryFragments(historicalHoldings);
    transactions = data.transactions || [];
    balances = data.balances || [];
    frozenBase = data.frozen_base || null;
    saveLedger();
    saveBreakupOverride();
    initializeLiveBaseline();
    refreshAfterLedgerChange();
    renderLedger();
    status.innerHTML = `<span class="trend-up">✓ Imported backup from ${escapeHtml((data._backup_meta || {}).exported_at || 'file')}. Commit to persist.</span>`;
  } catch (err) {
    status.innerHTML = `<span class="trend-down">⚠️ ${escapeHtml(err.message)}</span>`;
  } finally {
    e.target.value = '';
  }
}

// Combined chronological ledger of transactions + balances with edit/delete.
function renderLedger() {
  const el = document.getElementById('ledger-content');
  if (!el) return;
  const txns = (transactions || []).map(t => ({ kind: 'txn', ...t }));
  const bals = (balances || []).map(b => ({ kind: 'bal', ...b }));
  const rows = [...txns, ...bals].sort((a, b) => b.date.localeCompare(a.date));

  if (!rows.length) {
    el.innerHTML = '<p class="manage-hint">No transactions or balance entries yet. Add some above, then “Close Period” to snapshot a new data point.</p>';
    return;
  }

  const body = rows.map(r => {
    if (r.kind === 'txn') {
      const cls = r.type === 'buy' ? 'trend-up' : 'trend-down';
      return `<tr>
        <td>${r.date}</td>
        <td><span class="ledger-tag">${r.assetClass === 'mf' ? 'MF' : 'Stock'}</span></td>
        <td>${escapeHtml(r.instrument)}</td>
        <td class="${cls}">${r.type.toUpperCase()}</td>
        <td style="text-align:right;">${(+r.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
        <td style="text-align:right;">${formatINR(r.price)}</td>
        <td style="text-align:right;">${formatINR(r.amount)}</td>
        <td>${escapeHtml(r.note || '')}</td>
        <td style="white-space:nowrap;">
          <button class="ledger-btn" onclick="editTxn('${r.id}')">✏️</button>
          <button class="ledger-btn" onclick="removeTxn('${r.id}')">🗑️</button>
        </td></tr>`;
    }
    return `<tr>
      <td>${r.date}</td>
      <td><span class="ledger-tag bal">Balance</span></td>
      <td>${escapeHtml(r.component)}</td>
      <td>UPDATE</td>
      <td style="text-align:right;">—</td>
      <td style="text-align:right;">—</td>
      <td style="text-align:right;">${formatINR(r.value)}${r.contribution ? ` <span style="color:var(--text-muted)">(+${formatINR(r.contribution)})</span>` : ''}</td>
      <td>${escapeHtml(r.note || '')}</td>
      <td style="white-space:nowrap;">
        <button class="ledger-btn" onclick="editBal('${r.id}')">✏️</button>
        <button class="ledger-btn" onclick="removeBal('${r.id}')">🗑️</button>
      </td></tr>`;
  }).join('');

  el.innerHTML = `<div class="table-wrapper"><table class="ledger-table">
    <thead><tr>
      <th>Date</th><th>Kind</th><th>Instrument / Component</th><th>Action</th>
      <th style="text-align:right;">Qty</th><th style="text-align:right;">Price/NAV</th>
      <th style="text-align:right;">Amount / Value</th><th>Note</th><th></th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}
