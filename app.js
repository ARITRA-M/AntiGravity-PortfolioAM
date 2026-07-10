// Tab IDs
const tabIds = ['overview', 'stocks', 'mfs', 'growth', 'fixed-income', 'monthly', 'manage'];

// App version for cache busting — auto-derived from today's date so JSON files
// are never served stale after a deploy. The server.js commit script no longer
// needs to touch this constant.
const APP_VERSION = localDateStr();

// Global state
let portfolioSummary = null;
let breakupSummary = null;
let latestEquity = null;
let latestMf = null;
let historicalHoldings = null;
let uploadedSnapshot = null;
let transactionHistory = null;
// Use window.lastRefreshReport for cross-file consistency.
// api.js sets window.lastRefreshReport after a live price refresh.
// This let declaration ensures it's available in app.js's scope as well.
let lastRefreshReport = null;
// Also expose on window so api.js (which loads before app.js) can set it reliably
window.lastRefreshReport = null;

// Gold is tracked as regular stock holdings (SGB / GOLDBEES) so live prices refresh
// them like any other stock, but their value belongs to the "Gold" net-worth bucket,
// not "Stocks (Equity)" — split out anywhere the two are computed from latestEquity.
const GOLD_SECTORS = new Set(['Sovereign Gold Bonds', 'Gold Commodity (ETF)']);
// Also match by instrument name — some SGB tranches carry a stale/incorrect
// `sector` tag (seen as "Other Equities" for a couple of tranches), which would
// otherwise silently exclude them from gold-specific handling (net-worth split,
// calendar-MTD pricing, etc.).
function isGoldHolding(stock) {
  if (!stock) return false;
  if (GOLD_SECTORS.has(stock.sector)) return true;
  return /^SGB/i.test(stock.instrument || '') || stock.instrument === 'GOLDBEES';
}

// Chart references
let allocationChart = null;
let componentXirrChart = null;
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
let _periodicGran = 'Q'; // M | Q | H | Y | MAT
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

// Benchmark series (populated by fetchBenchmarkData; empty until real data lands)
const benchmarkData = {
  nifty50: {
    name: 'Nifty 50',
    history: [] // Will be generated based on portfolio dates
  },
  sensex: {
    name: 'Sensex',
    history: []
  },
  spx: {
    name: 'S&P 500',
    history: []
  },
  gold: {
    name: 'Gold',
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
  let live = null;
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
    live = r?.meta?.regularMarketPrice ?? pts[pts.length - 1].c;

    // Series-based daily change — FALLBACK ONLY. The 1-month daily series can
    // carry a NULL/missing close for a recent session (Yahoo publishes the index
    // bar late), which gets filtered out and makes this skip a day (e.g. compare
    // Tue vs Fri instead of Tue vs Mon). The authoritative value is computed from
    // the range=1d meta below.
    const lastBarIsToday = new Date(pts[pts.length - 1].t).toDateString() === new Date().toDateString();
    const prevClose = lastBarIsToday ? pts[pts.length - 2].c : pts[pts.length - 1].c;
    const liveForDaily = lastBarIsToday ? live : pts[pts.length - 1].c;
    _niftyDailyPctReal = ((liveForDaily - prevClose) / prevClose) * 100;

    // Month-to-date: last close strictly before the 1st of the current month.
    const now = new Date();
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let monthStartClose = null;
    for (const p of pts) if (p.t < monthStartMs) monthStartClose = p.c;
    if (monthStartClose) _niftyMonthlyPctReal = ((live - monthStartClose) / monthStartClose) * 100;
  } catch {
    const snap = loadNiftySnapshot();
    if (snap) {
      if (snap.dailyChangePct != null) _niftyDailyPctReal = snap.dailyChangePct;
      if (snap.monthlyChangePct != null) _niftyMonthlyPctReal = snap.monthlyChangePct;
      if (snap.series) _niftySeries = snap.series;
    }
    return _niftySeries;
  }

  // Authoritative daily change: the range=1d (default) chart meta exposes
  // chartPreviousClose as the TRUE prior-session close — unlike the long-range
  // series, which can be missing a recent bar. This is what fixes a daily change
  // computed against the wrong session (e.g. showing +1.55% Tue-vs-Fri when the
  // real move is +0.56% Tue-vs-Mon, because Yahoo's Monday index bar was null).
  try {
    const dres = await fetchViaCorsProxy('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI', {}, 10000);
    if (dres.ok) {
      const dm = (await dres.json())?.chart?.result?.[0]?.meta;
      if (dm && dm.regularMarketPrice > 0 && dm.chartPreviousClose > 0) {
        _niftyDailyPctReal = ((dm.regularMarketPrice - dm.chartPreviousClose) / dm.chartPreviousClose) * 100;
      }
    }
  } catch { /* keep the series-derived value */ }

  saveNiftySnapshot({
    dailyChangePct: _niftyDailyPctReal,
    monthlyChangePct: _niftyMonthlyPctReal,
    series: _niftySeries,
    timestamp: Date.now()
  });
  return _niftySeries;
}

// ── Short-term (≈30 day) daily performance charts: holdings vs Nifty 50 ──────
// Both portfolio lines are computed on a CONSTANT-HOLDINGS basis: the current
// quantities valued at each day's historical price. This isolates price
// performance (what the portfolio you hold today would have done) rather than
// reconstructing past trades. Series are rebased to 100 for a clean,
// scale-free comparison against the Nifty 50.

const PERF_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — shorter TTL prevents stale bad-data persisting

// Fetch closes for many Yahoo symbols using the multi-symbol spark endpoint
// (≈15 per request). Returns Map<symbol, {dates:[ms], closes:[]}>.
async function fetchSparkCloses(symbols, range = '1mo', interval = '1d') {
  const out = new Map();
  const BATCH = 15;
  const batches = [];
  for (let i = 0; i < symbols.length; i += BATCH) batches.push(symbols.slice(i, i + BATCH));

  // Fire every batch concurrently — with >15 symbols (e.g. Market Overview's ~19)
  // this used to await each batch in turn, roughly doubling wall-clock time on
  // networks where each proxied request already carries real latency.
  await Promise.all(batches.map(async (batch) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=${range}&interval=${interval}`;
    try {
      const res = await fetchViaCorsProxy(url, {}, 12000);
      if (!res.ok) return;
      const raw = await res.json();
      for (const r of (raw?.spark?.result || [])) {
        const resp = r?.response?.[0];
        const ts = resp?.timestamp;
        const cl = resp?.indicators?.quote?.[0]?.close;
        if (!ts || !cl) continue;
        const pts = ts.map((t, k) => ({ t: t * 1000, c: cl[k] })).filter(p => p.c != null);
        // The spark endpoint's own `meta` already carries a live price + true
        // previous close (same fields the dedicated chart endpoint exposes) —
        // capture it so callers needing "right now" data don't have to fire a
        // second per-symbol request. BUT: some thinly-quoted symbols (seen on
        // Nifty Midcap 100) have a `regularMarketPrice` frozen years in the past
        // while `chartPreviousClose`/the close series stay current — mixing a
        // stale price with a fresh previous-close produces a nonsense ±60%+
        // "daily change". Guard with `regularMarketTime`: only trust the live
        // price if it's from the last few days: otherwise fall back to the
        // (mutually consistent) close series below.
        const meta = resp?.meta;
        const isRecent = meta?.regularMarketTime > 0 && (Date.now() / 1000 - meta.regularMarketTime) < 5 * 86400;
        const live = (isRecent && meta.regularMarketPrice > 0)
          ? { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose > 0 ? meta.chartPreviousClose : null }
          : null;
        out.set(r.symbol, { dates: pts.map(p => p.t), closes: pts.map(p => p.c), live });
      }
    } catch (_) { /* skip a failed batch; others still contribute */ }
  }));
  return out;
}

// NSE's own index API — always returns a complete daily/30-day/365-day change
// for every Nifty index in one call, unlike Yahoo whose close series has
// multi-day gaps for several sectoral indices (Realty, FMCG, Smallcap...).
// Requires the Cloudflare Worker proxy (adds a browser User-Agent NSE demands);
// the public CORS proxies can't reach nseindia.com, so this silently returns an
// empty Map when only they're available — callers already have a Yahoo fallback.
async function fetchNseIndices() {
  const out = new Map(); // key: NSE "index" name → raw record
  try {
    const res = await fetchViaCorsProxy('https://www.nseindia.com/api/allIndices', {}, 10000);
    if (!res.ok) return out;
    const raw = await res.json();
    for (const rec of (raw?.data || [])) {
      if (rec?.index) out.set(rec.index, rec);
    }
  } catch (_) { /* NSE unreachable this session — Yahoo fallback below covers it */ }
  return out;
}

// Daily close series for an NSE index from Groww's public charting API — the
// only free source with COMPLETE history for every Nifty index (verified: full
// 5y dailies even for Nifty Smallcap 100, which Yahoo has no history for).
// Candle format: [epochSeconds, open, high, low, close, ...].
async function fetchGrowwCandles(code, days = 365 * 5 + 30) {
  const end = Date.now();
  const start = end - days * 86400000;
  const url = `https://groww.in/v1/api/charting_service/v4/chart/exchange/NSE/segment/CASH/${encodeURIComponent(code)}` +
    `?endTimeInMillis=${end}&intervalInMinutes=1440&startTimeInMillis=${start}`;
  const res = await fetchViaCorsProxy(url, {}, 12000);
  if (!res.ok) throw new Error('Groww HTTP ' + res.status);
  const raw = await res.json();
  const candles = (raw?.candles || []).filter(c => c && c[4] > 0);
  return { dates: candles.map(c => c[0] * 1000), closes: candles.map(c => c[4]) };
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
  // Show on any local run (both `npm run dev` and `npm run static` now expose
  // the /api/commit-data endpoint). Hidden only on the hosted GitHub Pages site.
  if (_commitBtn && _isLocal) _commitBtn.style.display = 'inline-flex';
  // Kick off the Nifty 50 fetch; once resolved, re-render the overview cards/tables.
  fetchNiftySeries().then(() => {
    const dailySummaryEl = document.getElementById('daily-summary-kpis');
    if (dailySummaryEl && dailySummaryEl.offsetParent !== null) {
      renderDailyOverviewTable();
    }
    if (latestEquity) renderMonthlyOverviewTable();
  });

  // Refresh-on-visibility — the single fix for "stale / windows disagree".
  // Background tabs (especially mobile) freeze their timers, so the in-hours
  // auto-refresh never fires while a window is hidden, and different windows end
  // up showing data from whenever each last refreshed. Whenever a window becomes
  // visible (or is restored from bfcache), pull fresh prices + Nifty if it's been
  // more than 60s — so every window converges to current data the moment you look
  // at it. refreshPrices() self-guards against concurrent runs.
  const _refreshIfStale = () => {
    if (document.visibilityState !== 'visible') return;
    const since = Date.now() - (window.__lastRefreshMs || 0);
    if (since < 60000) return;
    if (typeof refreshPrices === 'function') {
      refreshPrices(false).catch(e => console.warn('visibility refresh failed:', e));
    } else if (typeof fetchNiftySeries === 'function') {
      fetchNiftySeries();
    }
  };
  document.addEventListener('visibilitychange', _refreshIfStale);
  window.addEventListener('pageshow', _refreshIfStale);
  window.addEventListener('focus', _refreshIfStale);
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
  // Both `npm run dev` and `npm run static` expose /api/commit-data locally,
  // so no static-mode gate here — the fetch below surfaces any real failure.
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
      const todayStr = localDateStr();
      if (APP_VERSION !== todayStr) {
        console.log('APP_VERSION will be updated on next page load');
      }
      if (status) status.textContent = '✅ ' + data.message;
      if (data.details) console.log('Commit details:', data.details.join(' | '));
      // Committed files now hold the appended periods — drop the local override.
      if (typeof clearBreakupOverride === 'function') clearBreakupOverride();
      // Local ledger == committed now, so clear the dirty flag. The next reload will
      // adopt the committed ledger files (keeping all devices in sync).
      if (typeof clearLedgerDirty === 'function') clearLedgerDirty();
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

// Fetch the committed ledger files (frozen base + transactions + balances) so the
// ledger has a device-independent source of truth. Stored on window._committedLedger;
// loadLedger() adopts it unless there are uncommitted local edits (dirty flag). This
// fixes cross-device divergence where one device showed base-only net worth (empty
// localStorage ledger) while another showed base + transactions.
async function fetchCommittedLedger() {
  const _cb = APP_VERSION;
  const out = {};
  const files = [
    ['transactions', 'ledger_transactions'],
    ['balances', 'ledger_balances'],
    ['frozenBase', 'ledger_frozen_base'],
  ];
  for (const [key, file] of files) {
    try {
      const r = await fetch(`data/${file}.json?${_cb}`, { credentials: 'same-origin' });
      if (r.ok) out[key] = await parsePortfolioJson(r);
    } catch (_) { /* file may not exist yet — fall back to localStorage */ }
  }
  window._committedLedger = out;
  return out;
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
      try { await fetchCommittedLedger(); } catch (e) { console.warn('fetchCommittedLedger failed:', e); }
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
      // Always recompute net worth from the freshly re-derived live holdings +
      // frozenBase baseline. The persisted portfolio_summary.total_net_worth_lakhs
      // can be stale (e.g. inflated by a previous buggy session that wrote a phantom
      // total to localStorage/disk). Recomputing here makes the displayed total a
      // pure function of the current ledger + prices, regardless of refresh state.
      // With no live fetch, holdings sit at base-date prices so this reproduces the
      // breakup baseline plus the ledger's new-investment deltas.
      recomputePortfolioFromLiveData();

      fetchBenchmarkData(); // async; re-renders Growth tab benchmarks when resolved

      const dates = breakupSummary.dates;
      const latestDate = dates[dates.length - 1];
      if (hadRefresh) {
        document.getElementById('live-time-badge').innerText = `Live: ${window.lastRefreshReport.refreshedAt}`;
        updateDataFreshness(`Live refresh: ${window.lastRefreshReport.refreshedAt} (restored). Showing last refreshed prices.`);
      } else {
        document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
        updateDataFreshness(`Portfolio snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);
      }
      try { applyStaleDataFlag(); } catch (_) {}

      try { if (typeof repairLastXirrColumn === 'function') repairLastXirrColumn(); } catch (e) { console.warn('repairLastXirrColumn:', e); }
      try { updateKpis(); } catch (e) { console.error('updateKpis failed:', e); }
      try { initActiveTabOnly(); } catch (e) { console.error('initActiveTabOnly failed:', e); }
      try { autoCloseMonthIfNeeded(); } catch (e) { console.warn('autoCloseMonthIfNeeded:', e); }
      loadTransactionHistory(); // portfolio XIRR + dividends (was missing on cached loads)

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
    try { await fetchCommittedLedger(); } catch (e) { console.warn('fetchCommittedLedger failed:', e); }
    if (typeof integrateLedger === 'function') integrateLedger();

    // Recompute net worth from the re-derived live holdings + frozenBase baseline so
    // the displayed total reflects the current ledger rather than a possibly-stale
    // portfolio_summary.total_net_worth_lakhs loaded from disk (which a prior buggy
    // session may have inflated with a phantom holding).
    try { recomputePortfolioFromLiveData(); } catch (e) { console.error('recompute on load failed:', e); }

    // Load transaction history non-critically (dividends + pre-base flows for XIRR)
    loadTransactionHistory();

    // Real benchmark series fetched async; charts/tables show a loading state
    // until it lands (no more simulated placeholder curves).
    fetchBenchmarkData();

    // Populate live badge
    const dates = breakupSummary.dates;
    const latestDate = dates[dates.length - 1];
    document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;
    updateDataFreshness(`Portfolio snapshot: ${formatDateString(latestDate)}. Live prices not refreshed.`);
    try { applyStaleDataFlag(); } catch (_) {}

    // Initialize UI elements — each wrapped in try-catch to isolate failures
    try { if (typeof repairLastXirrColumn === 'function') repairLastXirrColumn(); } catch (e) { console.warn('repairLastXirrColumn:', e); }
    try { updateKpis(); } catch (e) { console.error('updateKpis failed:', e); }
    try { initActiveTabOnly(); } catch (e) { console.error('initActiveTabOnly failed:', e); }
    try { autoCloseMonthIfNeeded(); } catch (e) { console.warn('autoCloseMonthIfNeeded:', e); }
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

  // Recompute thisMonthGain for all stocks/MFs: (current price - uploaded price) * qty.
  // For new holdings (added via ledger), basePrice=0 so gain = full market value.
  latestEquity.forEach(s => { s.thisMonthGain = (s.ltp   - (s.basePrice ?? 0)) * s.qty; });
  latestMf.forEach(f =>    { f.thisMonthGain = (f.price - (f.basePrice ?? 0)) * f.qty; });

  // Net worth = Σ(qty × ltp) across ALL current holdings + a fixed reconciliation gap.
  // Gap = breakup-summary baseline − Σ(frozenQty × frozenPrice): a historical constant
  // that keeps the running total anchored to the uploaded breakup sheet while letting
  // individual row sums add up correctly to the displayed total. With no transactions
  // this is identical to the old baseline + price-gain formula.
  const nonGoldEquity = latestEquity.filter(s => !isGoldHolding(s));
  const goldEquity    = latestEquity.filter(isGoldHolding);

  let liveStockLakhs, liveMfLakhs, liveGoldLakhs;
  if (typeof frozenBase !== 'undefined' && frozenBase) {
    // basePrice is the freeze-date price; fall back to old ltp/price field for
    // existing saved frozenBase data that predates the rename.
    const frozenEquity = frozenBase.equity || [];
    const frozenStockVal = frozenEquity.filter(h => !isGoldHolding(h)).reduce((s, h) => s + h.qty * (h.basePrice ?? h.ltp ?? 0), 0);
    const frozenMfVal   = (frozenBase.mf || []).reduce((s, h) => s + h.qty * (h.basePrice ?? h.price ?? 0), 0);
    const stockReconcGap = uploadedSnapshot.stockLakhs - frozenStockVal / 100000;
    const mfReconcGap    = uploadedSnapshot.mfLakhs   - frozenMfVal   / 100000;
    liveStockLakhs = nonGoldEquity.reduce((s, h) => s + h.qty * h.ltp, 0) / 100000 + stockReconcGap;
    // Gold carries NO reconciliation gap: every gold asset (SGB tranches +
    // GOLDBEES) is fully tracked and now priced at its own real market quote,
    // so the bucket is exactly Σ qty×ltp. The old gap existed only because the
    // GOLDBEES×100 proxy understated SGBs vs the Excel-era valuations — keeping
    // it after switching to real quotes would double-count the correction.
    liveGoldLakhs  = goldEquity.reduce(   (s, h) => s + h.qty * h.ltp, 0) / 100000;
    liveMfLakhs    = latestMf.reduce(   (s, h) => s + h.qty * h.price,  0) / 100000 + mfReconcGap;
  } else {
    const exactStockGain = nonGoldEquity.reduce((sum, s) => sum + s.thisMonthGain, 0);
    const exactGoldGain  = goldEquity.reduce(   (sum, s) => sum + s.thisMonthGain, 0);
    const exactMfGain    = latestMf.reduce(   (sum, f) => sum + f.thisMonthGain, 0);
    liveStockLakhs = uploadedSnapshot.stockLakhs + exactStockGain / 100000;
    liveGoldLakhs  = (uploadedSnapshot.goldLakhs ?? 0) + exactGoldGain / 100000;
    liveMfLakhs    = uploadedSnapshot.mfLakhs    + exactMfGain    / 100000;
  }
  // Live-override opaque (non-tradeable, non-gold) components from balance entries
  // recorded after the frozen base but not yet folded in via Close Period — so a
  // new PF/NPS/PPF/Bonds/Cash/Crypto entry shows up immediately instead of waiting
  // for a month close (closeMonth() already reads these the same way).
  const _fbBaseDate = (typeof frozenBase !== 'undefined' && frozenBase) ? frozenBase.baseDate : '';
  const _todayStr = localDateStr();
  function _liveOpaqueLakhs(comp) {
    const meta = (typeof COMPONENT_BREAKUP !== 'undefined') ? COMPONENT_BREAKUP[comp] : null;
    const baseVal = meta ? getLatestSectionValue(breakupSummary.net_worth, meta.key) : 0;
    const bal = (typeof latestBalanceFor === 'function') ? latestBalanceFor(comp, _todayStr) : null;
    return (bal && (!_fbBaseDate || bal.date > _fbBaseDate)) ? bal.value / 100000 : baseVal;
  }
  const liveNpsE  = _liveOpaqueLakhs('NPS-E');
  const liveNpsC  = _liveOpaqueLakhs('NPS-C');
  const liveNpsG  = _liveOpaqueLakhs('NPS-G');
  const livePf    = _liveOpaqueLakhs('PF');
  const livePpf   = _liveOpaqueLakhs('PPF');
  const liveBonds = _liveOpaqueLakhs('Bonds');
  const liveCash  = _liveOpaqueLakhs('Cash');
  const liveCrypto = _liveOpaqueLakhs('Crypto');

  const liveTotalLakhs = liveStockLakhs + liveMfLakhs + liveGoldLakhs +
    liveNpsE + liveNpsC + liveNpsG + livePf + livePpf + liveBonds + liveCash + liveCrypto;

  portfolioSummary.total_net_worth_lakhs = liveTotalLakhs;
  portfolioSummary.equity_lakhs = liveStockLakhs + liveMfLakhs + liveNpsE;
  portfolioSummary.debt_lakhs = liveNpsC + liveNpsG + livePf + livePpf + liveBonds;
  portfolioSummary.gold_lakhs = liveGoldLakhs;
  portfolioSummary.liquid_lakhs = liveCash;
  portfolioSummary.alternate_lakhs = liveCrypto;
  portfolioSummary.allocation_pct = recomputeAllocation(portfolioSummary);
  // Resync cumulative_investment_history from the CURRENT breakupSummary. The
  // committed data/portfolio_summary.json is a point-in-time snapshot — after any
  // Close Period (e.g. the July auto-close), breakupSummary.dates grows but this
  // file isn't regenerated until the next commit, leaving the array one entry
  // short. The Growth tab's "Total Portfolio" cap-vs-valuation chart reads this
  // array directly, so a stale/shorter series silently drops the newest point
  // (a value/month gap in what should be a continuous line).
  {
    let running = 0;
    portfolioSummary.cumulative_investment_history =
      (breakupSummary.new_investment?.['Total Investment']?.values || []).map(v => (running += Number(v) || 0));
  }

  // Update latest breakupSummary data points for Growth/Fixed-Income/NPS tab display.
  // GUARD: never overwrite the immutable frozen-base column. When no month has been
  // closed since the base date, the LAST breakup column IS the opening snapshot —
  // writing live values there corrupts the base (Stocks/MF/Total), and a subsequent
  // commit persists that corruption, desyncing breakup from frozenBase. Only mutate
  // a genuine post-base (closed-period) column. The live net worth is always shown
  // via portfolioSummary.total_net_worth_lakhs (set above), independent of this.
  const _lastBreakupDate = (breakupSummary.dates || []).slice(-1)[0] || '';
  if (!_fbBaseDate || _lastBreakupDate > _fbBaseDate) {
    setLatestSectionValue(breakupSummary.net_worth, 'Stocks (Equity)', liveStockLakhs);
    setLatestSectionValue(breakupSummary.net_worth, 'Mutual Funds (Equity)', liveMfLakhs);
    setLatestSectionValue(breakupSummary.net_worth, 'Gold (Gold)', liveGoldLakhs);
    setLatestSectionValue(breakupSummary.net_worth, 'NPS E (Equity)', liveNpsE);
    setLatestSectionValue(breakupSummary.net_worth, 'NPS C (Debt)', liveNpsC);
    setLatestSectionValue(breakupSummary.net_worth, 'NPS G (Debt)', liveNpsG);
    setLatestSectionValue(breakupSummary.net_worth, 'PF (Debt)', livePf);
    setLatestSectionValue(breakupSummary.net_worth, 'PPF (Debt)', livePpf);
    setLatestSectionValue(breakupSummary.net_worth, 'Bonds (Debt)', liveBonds);
    setLatestSectionValue(breakupSummary.net_worth, 'Cash (Liquid)', liveCash);
    setLatestSectionValue(breakupSummary.net_worth, 'Crypto (Alternate)', liveCrypto);
    setLatestSectionValue(breakupSummary.net_worth, 'Total', liveTotalLakhs);
  }
  // autoCloseMonthIfNeeded is intentionally NOT called here — recomputePortfolioFromLiveData
  // is a pure computation function that runs multiple times per session. Side-effecting a
  // month-close from inside it corrupts prevVal lookups and drops the reconciliation gap.
  // Auto-close is triggered only once, in loadData(), after prices are settled.
}

function resetDerivedState() {
  benchmarkData.nifty50.history = [];
  benchmarkData.spx.history = [];
  benchmarkData.gold.history = [];
  benchmarkData.sensex.history = [];
  for (const [key, { label }] of Object.entries(BENCHMARK_SOURCES)) {
    benchmarkData[key].name = label;
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
  fetchBenchmarkData(); // re-fetch real data aligned to new portfolio dates
}

function initializeLiveBaseline() {
  // Build frozen-base price lookup (supports old saved data using ltp/price field names).
  const fb = (typeof frozenBase !== 'undefined') ? frozenBase : null;
  const frozenEqPriceMap = new Map((fb?.equity || []).map(s => [s.instrument, s.basePrice ?? s.ltp ?? 0]));
  const frozenMfPriceMap = new Map((fb?.mf || []).map(f => [f.scheme, f.basePrice ?? f.price ?? 0]));

  latestEquity.forEach(s => {
    // basePrice = market price at the frozen base date (not purchase cost).
    // Always override from frozenBase for known instruments — this corrects the case
    // where the first initializeLiveBaseline() call set basePrice=ltp because frozenBase
    // was null (it gets loaded by integrateLedger → loadLedger(), which runs after us).
    if (frozenEqPriceMap.has(s.instrument)) {
      s.basePrice = frozenEqPriceMap.get(s.instrument);
    } else if (s.basePrice === undefined) {
      s.basePrice = s.ltp; // brand-new holding not yet in frozenBase
    }
    s.lastRefreshedPrice = s.ltp;
    if (s.thisMonthGain === undefined) s.thisMonthGain = 0;
    if (s.yesterdayClose === undefined) s.yesterdayClose = null;
  });
  latestMf.forEach(f => {
    if (frozenMfPriceMap.has(f.scheme)) {
      f.basePrice = frozenMfPriceMap.get(f.scheme);
    } else if (f.basePrice === undefined) {
      f.basePrice = f.price;
    }
    f.lastRefreshedPrice = f.price;
    if (f.thisMonthGain === undefined) f.thisMonthGain = 0;
    if (f.previousNav === undefined) f.previousNav = null;
  });

  // uploadedSnapshot anchors the net-worth computation to the frozen-base values.
  // Prefer frozenBase.stockLakhs (captured at freeze time, stable across month closes)
  // over re-reading the breakup summary (its latest column changes as months are closed).
  if (!uploadedSnapshot) {
    uploadedSnapshot = {
      stockLakhs: fb?.stockLakhs ?? getLatestSectionValue(breakupSummary.net_worth, 'Stocks (Equity)'),
      mfLakhs:    fb?.mfLakhs   ?? getLatestSectionValue(breakupSummary.net_worth, 'Mutual Funds (Equity)'),
      goldLakhs:  fb?.goldLakhs ?? getLatestSectionValue(breakupSummary.net_worth, 'Gold (Gold)'),
      npsELakhs:  fb?.npsELakhs ?? getLatestSectionValue(breakupSummary.net_worth, 'NPS E (Equity)'),
      totalLakhs: fb?.totalLakhs ?? getLatestSectionValue(breakupSummary.net_worth, 'Total'),
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

  // Re-render the currently visible tab so refreshed prices actually show.
  // First visit → lazy-init. Already initialized → re-render its live-data view
  // (previously this was skipped, so prices updated in memory but the on-screen
  // table stayed stale until the user switched tabs).
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab) {
    const tabId = activeTab.id.replace('-tab', '');
    if (!initializedTabs.has(tabId)) {
      initializedTabs.add(tabId);
      const initFn = tabInitMap[tabId];
      if (initFn) initFn();
    } else {
      // Only the live-price tabs re-render here; chart/history tabs (growth,
      // monthly, nps, fixed-income) don't show live-ticking prices and would
      // just flicker — they re-render on tab switch.
      try {
        if (tabId === 'stocks') reapplyStocksView();
        else if (tabId === 'mfs') reapplyMfsView();
        else if (tabId === 'overview') { renderDailyOverviewTable(); renderMonthlyOverviewTable(); }
      } catch (e) { console.error('refreshAllTabs re-render failed:', e); }
    }
  }

  // Re-render the update log (now a collapsible card in Manage) if it's open.
  const report = window.lastRefreshReport || lastRefreshReport;
  if (report) {
    const wrap = document.getElementById('update-log-wrap');
    if (wrap && wrap.style.display !== 'none') {
      try { initUpdateLogTab(); } catch (_) {}
    }
  }
}

function updateDataFreshness(message) {
  const el = document.getElementById('data-freshness');
  if (el) el.textContent = message;
}

// Flag prices that are more than STALE_HOURS old (e.g. mobile showing yesterday's
// data because a refresh silently failed via a dead public proxy). Adds an amber
// "⚠ stale" marker to the live badge and a note to the freshness line so the
// numbers are never trusted blindly. Cleared automatically by a fresh refresh.
const STALE_HOURS = 24;
function applyStaleDataFlag() {
  const badge = document.getElementById('live-time-badge');
  if (!badge) return;
  let lastMs = window.__lastRefreshMs || 0;
  if (!lastMs) {
    try {
      const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
      lastMs = parseInt(localStorage.getItem(P + 'last_refresh_ms') || '0', 10) || 0;
    } catch (_) { /* ignore */ }
  }
  // No refresh ever recorded → showing the committed snapshot, not "stale live data".
  if (!lastMs) { badge.removeAttribute('data-stale'); return; }
  const ageH = (Date.now() - lastMs) / 3600000;
  const el = document.getElementById('data-freshness');
  if (ageH > STALE_HOURS) {
    badge.setAttribute('data-stale', '1');
    badge.style.borderColor = 'rgba(245, 158, 11, 0.7)';
    if (!/⚠/.test(badge.innerText)) badge.innerText = '⚠ ' + badge.innerText + ' · stale';
    const days = Math.floor(ageH / 24);
    const ageStr = days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : `${Math.round(ageH)}h`;
    if (el) el.textContent = `⚠ Prices are ${ageStr} old — last refresh failed or hasn't run. Tap "Update Prices" to refresh.`;
  } else {
    badge.removeAttribute('data-stale');
  }
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

// Full day-level date (e.g. "01 Jun 2026") — used where the exact date matters,
// such as the Trading Activity Log.
function formatFullDate(dateStr) {
  if (!dateStr || dateStr.startsWith('Period')) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
    running += Number(value) || 0; // a null/NaN month must not poison the whole cumulative series
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

// Initialize only the tab currently visible — the rest lazy-init via
// switchTab()/tabInitMap on first visit. Eagerly building every tab's
// charts/tables on load roughly quadrupled time-to-interactive on mobile.
function initActiveTabOnly() {
  // Restore the last-viewed tab (mobile habit: users return to the same view).
  let saved = null;
  try { saved = localStorage.getItem(LS_PREFIX + 'last_tab'); } catch (_) {}
  if (saved && tabInitMap[saved]) { switchTab(saved); return; }
  const active = document.querySelector('.tab-content.active');
  const tabId = active ? active.id.replace('-tab', '') : 'overview';
  initializedTabs.add(tabId);
  const initFn = tabInitMap[tabId];
  if (initFn) initFn();
}

const tabInitMap = {
  'overview': initOverviewTab,
  'stocks': initStocksTab,
  'mfs': initMfsTab,
  'growth': initGrowthTab,
  'fixed-income': initFixedIncomeTab,
  'monthly': initMonthlyTab,
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

  // Mobile bottom nav: highlight the matching item, remember the tab across visits.
  document.querySelectorAll('.bottom-nav-btn[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId));
  try { localStorage.setItem(LS_PREFIX + 'last_tab', tabId); } catch (_) {}

  // The calculator FAB is only useful while filling in the Manage tab's forms;
  // hide it (and its panel) everywhere else.
  const calcFab = document.getElementById('calc-fab');
  if (calcFab) calcFab.style.display = tabId === 'manage' ? '' : 'none';
  if (tabId !== 'manage') {
    const calcPanel = document.getElementById('calculator-panel');
    if (calcPanel) calcPanel.style.display = 'none';
  }

  // Lazy-initialize charts for this tab on first visit
  if (!initializedTabs.has(tabId)) {
    initializedTabs.add(tabId);
    const initFn = tabInitMap[tabId];
    if (initFn) initFn();
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

  // Portfolio (whole) XIRR — same source as the Performance Comparison table's
  // "Portfolio (Overall)" row, so the two always agree.
  const portfolioXirrEl = document.getElementById('kpi-portfolio-xirr');
  const portfolioXirrVal = computePortfolioXirr();
  if (portfolioXirrEl && portfolioXirrVal != null) {
    portfolioXirrEl.innerText = (portfolioXirrVal * 100).toFixed(1) + '%';
  }

  // Debt XIRR: from breakupSummary.xirr if a matching key exists
  const debtXirrVal = debtXirrKey ? lastNonZeroXirr(xirrSec[debtXirrKey].values) : null;
  const debtXirrEl = document.getElementById('kpi-debt-xirr');
  if (debtXirrEl && debtXirrVal != null) {
    debtXirrEl.innerText = (debtXirrVal * 100).toFixed(1) + '%';
  }
  const computedDebtXirr = computeDebtXirr();
  if (debtXirrEl && computedDebtXirr != null && isFinite(computedDebtXirr)) {
    debtXirrEl.innerText = (computedDebtXirr * 100).toFixed(1) + '%';
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
  if (subtab === 'market') initMarketOverviewTab();
}

// ── Market Overview: national/sectoral/global index cards with Daily/MTD toggle ──
// Pinned indices always show; a few extra "top movers" from the sectoral pool are
// surfaced dynamically based on whichever moved the most that day.
// `nse` = the exact "index" name NSE's own allIndices API uses for this
// index. When present it is the PRIMARY source (always-complete daily/30d/365d
// change, unlike Yahoo's gap-prone series for several NSE sectoral indices);
// Yahoo (`symbol`) is used for anything NSE doesn't cover (Sensex is a BSE
// index, plus the global indices) and as a fallback if the NSE fetch fails.
// `groww` = the scrip code Groww's public charting API uses for this index —
// the repair source for MTD/3M/6M/1Y/5Y where Yahoo's series has holes or (as
// with Nifty Smallcap 100) no history at all. Each code was verified against
// NSE's official last-close before being trusted here.
const MARKET_PINNED_INDICES = [
  { symbol: '^NSEI',    label: 'Nifty 50',        group: 'National', nse: 'NIFTY 50', groww: 'NIFTY' },
  { symbol: 'NIFTY_MIDCAP_100.NS', label: 'Nifty Midcap 100', group: 'Market Cap', nse: 'NIFTY MIDCAP 100', groww: 'NIFTYMIDCAP' },
  { symbol: '^CNXSC',   label: 'Nifty Smallcap 100', group: 'Market Cap', nse: 'NIFTY SMALLCAP 100', groww: 'NIFTYSMALL' },
  { symbol: '^NSEBANK', label: 'Bank Nifty',      group: 'Sectoral', nse: 'NIFTY BANK', groww: 'BANKNIFTY' },
  { symbol: '^CNXIT',   label: 'Nifty IT',        group: 'Sectoral', nse: 'NIFTY IT', groww: 'NIFTYIT' },
  { symbol: '^CNXFMCG', label: 'Nifty FMCG',      group: 'Sectoral', nse: 'NIFTY FMCG', groww: 'NIFTYFMCG' },
  // ^CNXPHARMA is Nifty PHARMA, a different NSE index from "NIFTY HEALTHCARE
  // INDEX" (mixing the two — same label, different underlying values — is what
  // produced a nonsense -35% MTD figure: NSE's Healthcare `last` combined with
  // Yahoo's Pharma month-start close).
  { symbol: '^CNXPHARMA', label: 'Nifty Pharma', group: 'Sectoral', nse: 'NIFTY PHARMA', groww: 'NIFTYPHARMA' },
  { symbol: '^IXIC',    label: 'Nasdaq',          group: 'Global' },
  { symbol: '000001.SS', label: 'Shanghai Composite', group: 'Global' },
  { symbol: 'GC=F',     label: 'Gold',            group: 'Commodity' },
];
const MARKET_MOVER_POOL = [
  { symbol: '^CNXAUTO',   label: 'Nifty Auto', nse: 'NIFTY AUTO', groww: 'NIFTYAUTO' },
  { symbol: '^CNXMETAL',  label: 'Nifty Metal', nse: 'NIFTY METAL', groww: 'NIFTYMETAL' },
  { symbol: '^CNXREALTY', label: 'Nifty Realty', nse: 'NIFTY REALTY', groww: 'NIFTYREALTY' },
  { symbol: '^CNXENERGY', label: 'Nifty Energy', nse: 'NIFTY ENERGY', groww: 'NIFTYENERGY' },
  { symbol: '^CNXFIN',    label: 'Nifty Fin Services', nse: 'NIFTY FINANCIAL SERVICES', groww: 'FINNIFTY' },
  { symbol: '^CNXPSUBANK', label: 'Nifty PSU Bank', nse: 'NIFTY PSU BANK', groww: 'NIFTYPSUBANK' },
  { symbol: '^CNXMEDIA',  label: 'Nifty Media', nse: 'NIFTY MEDIA', groww: 'NIFTYMEDIA' },
  { symbol: '^CNXINFRA',  label: 'Nifty Infra', nse: 'NIFTY INFRASTRUCTURE', groww: 'NIFTYINFRAST' },
];
const MARKET_OVERVIEW_TTL_MS = 15 * 60 * 1000; // 15 min — index levels don't need to be second-fresh
// v2: cached entries gained pct.y3 — a v1 cache would show "—" for 3Y until TTL expiry.
const MARKET_OVERVIEW_CACHE_KEY = 'ag_market_overview_cache_v2';
let marketOverviewData = null; // Map<symbol, {label, group, last, pct:{daily,mtd,m1,m3,m6,y1,y3,y5}}>
let marketOverviewFetchedAt = 0;

// Persist the computed overview across reloads: the tab used to refetch three
// network round-trips (Yahoo ×2 + NSE) before painting ANYTHING on every page
// load. With the cache, a revisit paints instantly from localStorage; if the
// data is older than the TTL the normal fetch still runs and repaints.
function _saveMarketOverviewCache() {
  try {
    localStorage.setItem(MARKET_OVERVIEW_CACHE_KEY, JSON.stringify({
      fetchedAt: marketOverviewFetchedAt,
      longFetchedAt: marketOverviewLongFetchedAt,
      entries: [...marketOverviewData.entries()],
    }));
  } catch (_) { /* quota/private mode — cache is best-effort */ }
}

function _restoreMarketOverviewCache() {
  try {
    const raw = localStorage.getItem(MARKET_OVERVIEW_CACHE_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    if (!c?.entries?.length) return false;
    marketOverviewData = new Map(c.entries);
    marketOverviewFetchedAt = c.fetchedAt || 0;
    marketOverviewLongFetchedAt = c.longFetchedAt || 0;
    return true;
  } catch (_) { return false; }
}
let marketOverviewMode = (() => {
  try {
    const m = localStorage.getItem(LS_PREFIX + 'market_period');
    if (['daily', 'mtd', 'm1', 'm3', 'm6', 'y1', 'y3', 'y5'].includes(m)) return m;
  } catch (_) {}
  return 'daily';
})(); // 'daily' | 'mtd' | 'm1' | 'm3' | 'm6' | 'y1' | 'y3' | 'y5'

// ── Segmented pill controls (shared) ────────────────────────────────────────
// Any .seg-filter gets its .seg-thumb slid under whichever button has .active.
// Existing click handlers keep managing the .active class; a delegated listener
// re-positions the thumb one frame later, after those handlers have run.
function syncSegThumb(seg) {
  const thumb = seg.querySelector('.seg-thumb');
  const active = seg.querySelector('button.active');
  if (thumb && active && active.offsetWidth) {
    thumb.style.left = active.offsetLeft + 'px';
    thumb.style.width = active.offsetWidth + 'px';
  }
}
function syncAllSegThumbs() {
  document.querySelectorAll('.seg-filter').forEach(syncSegThumb);
}
document.addEventListener('click', (e) => {
  const seg = e.target.closest('.seg-filter');
  if (seg) requestAnimationFrame(() => syncSegThumb(seg));
});
window.addEventListener('resize', syncAllSegThumbs);

// Market period seg also derives .active from the (persisted) mode.
function _syncMarketPeriodSeg() {
  const seg = document.getElementById('market-period-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === marketOverviewMode));
  syncSegThumb(seg);
}

function setMarketOverviewMode(mode) {
  marketOverviewMode = mode;
  try { localStorage.setItem(LS_PREFIX + 'market_period', mode); } catch (_) {}
  _syncMarketPeriodSeg();
  renderMarketOverviewCards();
  // mtd included: the long-range pass also repairs approximate/missing MTD
  // figures from Groww's complete daily series.
  if (['mtd', 'm1', 'm3', 'm6', 'y1', 'y3', 'y5'].includes(mode)) _ensureMarketOverviewLongRange();
}

// TIMESTAMP SEMANTICS (verified against NSE's official last/previousClose and
// the count of trading sessions in the month): BOTH sources stamp a daily bar
// within its own trading day — Yahoo at market open (09:15 IST), Groww at the
// day's 00:00 IST. So a strict "< monthStart" comparison is correct for both:
// the prior month's final close is the last bar before the boundary, and the
// new month's first bar (Groww: exactly ON the boundary) is excluded. Do NOT
// shift the boundary to "capture" Groww's boundary bar — that bar is the NEW
// month's first close, and treating it as the month-end reference understates
// MTD (it once turned Realty's true +7.38% into +3.67%).

// Reference close on/before a given timestamp from an ascending {dates,closes} series.
function _closeBefore(series, ms) {
  if (!series) return null;
  let val = null;
  for (let i = 0; i < series.dates.length; i++) if (series.dates[i] < ms) val = series.closes[i];
  return val;
}

let marketOverviewLongFetchedAt = 0; // separate TTL for the (larger, rarer-needed) 5y series

async function initMarketOverviewTab() {
  // Reflect the restored period filter in the segmented control; kick off the
  // long-range fetch right away if the remembered period needs it.
  _syncMarketPeriodSeg();
  // No in-memory data yet (fresh page load)? Restore the last computed overview
  // from localStorage and paint it immediately — the slow part of this tab was
  // never the rendering, it's the three proxied network round-trips.
  if (!marketOverviewData && _restoreMarketOverviewCache()) renderMarketOverviewCards();
  const fresh = marketOverviewData && (Date.now() - marketOverviewFetchedAt) < MARKET_OVERVIEW_TTL_MS;
  if (fresh) { renderMarketOverviewCards(); _ensureMarketOverviewLongRange(); return; }
  const statusEl = document.getElementById('market-overview-status');
  if (statusEl) statusEl.textContent = marketOverviewData ? 'Refreshing market data…' : 'Loading market data…';
  try {
    const all = [...MARKET_PINNED_INDICES, ...MARKET_MOVER_POOL];
    const symbols = all.map(i => i.symbol);
    // ONE batched request covers Daily + MTD for every index — the spark
    // endpoint's own `meta` already carries a live price + true previous close,
    // so no per-symbol follow-up call is needed (this used to fire 16 separate
    // requests, the main reason the tab was slow on mobile networks).
    // Two batched requests in parallel:
    //  - 1mo/1d closes for MTD (and the long-range merge later)
    //  - 1d/1d for the DAILY change: with range=1d, Yahoo's chartPreviousClose is
    //    by definition the last close BEFORE today, i.e. the true previous trading
    //    day — immune to the multi-day holes the 1mo close series has for NSE
    //    sectoral indices (Realty/FMCG were missing a whole week of bars).
    const [shortBySym, dailyBySym, nseBySym] = await Promise.all([
      fetchSparkCloses(symbols, '1mo', '1d'),
      fetchSparkCloses(symbols, '1d', '1d').catch(() => new Map()),
      fetchNseIndices(),
    ]);
    const now = new Date();
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const data = new Map();
    all.forEach(({ symbol, label, group, nse }) => {
      const series = shortBySym.get(symbol);
      const daily1d = dailyBySym.get(symbol)?.live; // { price, prevClose } — recency-guarded
      const nseRec = nse ? nseBySym.get(nse) : null;
      if ((!series || !series.closes.length) && !daily1d && !nseRec) return;

      const arrLast = series?.closes?.length ? series.closes[series.closes.length - 1] : null;
      const last = nseRec?.last ?? daily1d?.price ?? series?.live?.price ?? arrLast;

      // Sanity check: if NSE's `last` and the Yahoo series's own last close disagree
      // by more than ~2% they're almost certainly two different indices under the
      // same label (this is exactly how "Nifty Pharma"/"Nifty Healthcare Index"
      // got cross-wired into a nonsense -35% MTD) — don't mix the two series below.
      const seriesUsable = !(nseRec?.last != null && arrLast != null && Math.abs(nseRec.last - arrLast) / arrLast > 0.02);

      // DAILY: NSE's own feed always has an accurate previous-close for every
      // index it covers — no gap-guard needed. Falls back to the 1d-range Yahoo
      // quote, then to consecutive (gap-checked) bars of the 1mo series.
      let daily = null;
      if (nseRec?.percentChange != null) {
        daily = nseRec.percentChange;
      } else if (daily1d?.price > 0 && daily1d?.prevClose > 0) {
        daily = ((daily1d.price - daily1d.prevClose) / daily1d.prevClose) * 100;
      } else if (series && series.closes.length >= 2) {
        const lastTs = series.dates[series.dates.length - 1];
        const prevTs = series.dates[series.dates.length - 2];
        const liveAheadOfArray = series.live?.price != null && Math.abs(series.live.price - arrLast) > 1e-6;
        if (liveAheadOfArray && (Date.now() - lastTs) <= 4 * 86400000) {
          daily = ((series.live.price - arrLast) / arrLast) * 100;
        } else if (!liveAheadOfArray && (lastTs - prevTs) <= 4 * 86400000) {
          const prev = series.closes[series.closes.length - 2];
          daily = prev ? ((arrLast - prev) / prev) * 100 : null;
        }
      }

      // MTD: last close strictly before calendar month-start. This is the exact
      // CALENDAR month-to-date figure — never a rolling-30-day stand-in (mixing
      // the two is what made Nifty Realty read +7.38% when the true Jul-MTD was
      // ~half that: its 1mo Yahoo series has a month-start hole, so the old code
      // silently substituted NSE's rolling perChange30d). If the exact close
      // isn't available, MTD is left blank here and the Groww repair pass fills
      // it precisely; the rolling-30-day move now has its own explicit "1M" card.
      let mtd = null;
      if (series && last != null && seriesUsable) {
        let refIdx = -1;
        for (let i = 0; i < series.dates.length; i++) if (series.dates[i] < monthStartMs) refIdx = i;
        if (refIdx >= 0 && (monthStartMs - series.dates[refIdx]) <= 5 * 86400000) {
          const ref = series.closes[refIdx];
          if (ref) mtd = ((last - ref) / ref) * 100;
        }
      }

      // 1M: rolling ~30-day change. NSE's perChange30d is exactly this; else
      // derive from the series close ~30 calendar days back.
      let m1 = null;
      if (nseRec?.perChange30d != null) {
        m1 = nseRec.perChange30d;
      } else if (series && last != null && seriesUsable) {
        const ref30 = _closeBefore(series, Date.now() - 30 * 86400000);
        if (ref30) m1 = ((last - ref30) / ref30) * 100;
      }

      if (last == null) return;
      data.set(symbol, { label, group, last, pct: { daily, mtd, m1 } });
    });
    if (data.size) {
      marketOverviewData = data;
      marketOverviewFetchedAt = Date.now();
      marketOverviewLongFetchedAt = 0; // force a fresh long-range merge for the new short data
      _saveMarketOverviewCache();
    }
  } catch (e) {
    console.warn('[market-overview] fetch failed:', e.message);
  }
  if (statusEl) {
    statusEl.textContent = marketOverviewData
      ? `Updated ${new Date(marketOverviewFetchedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
      : 'Could not load market data — check your connection and retry.';
  }
  renderMarketOverviewCards();
  _ensureMarketOverviewLongRange(); // fetch 3M/6M/1Y/5Y data in the background, not blocking the initial paint
}

// 3M/6M/1Y/5Y need a much longer series (5y/weekly) that most visits never look
// at — fetched lazily, after the fast Daily/MTD view is already on screen, so a
// slow mobile connection isn't stuck waiting on data most people won't select.
async function _ensureMarketOverviewLongRange() {
  if (!marketOverviewData) return;
  if (marketOverviewLongFetchedAt && (Date.now() - marketOverviewLongFetchedAt) < MARKET_OVERVIEW_TTL_MS) return;
  marketOverviewLongFetchedAt = Date.now(); // claim immediately so concurrent calls don't double-fetch
  try {
    const all = [...MARKET_PINNED_INDICES, ...MARKET_MOVER_POOL];
    const longBySym = await fetchSparkCloses(all.map(i => i.symbol), '5y', '1wk');
    const now = new Date();
    const daysAgo = (n) => now.getTime() - n * 86400000;
    all.forEach(({ symbol }) => {
      const entry = marketOverviewData.get(symbol);
      const longSeries = longBySym.get(symbol);
      if (!entry) return;
      // Some indices (Nifty Smallcap 100 confirmed) have NO historical series in
      // Yahoo at all — every range/interval returns a single "today" bar. That's
      // a genuine data-source gap, not a transient fetch failure, so flag it
      // distinctly: the card shows "n/a" with an explanatory tooltip instead of
      // a bare dash that looks like it'll resolve on the next refresh.
      if (!longSeries || longSeries.closes.length < 2) { entry.pct.longUnsupported = true; return; }
      const last = entry.last;
      const pctFrom = (base) => (base ? ((last - base) / base) * 100 : null);
      if (entry.pct.m1 == null) entry.pct.m1 = pctFrom(_closeBefore(longSeries, daysAgo(30)));
      entry.pct.m3 = pctFrom(_closeBefore(longSeries, daysAgo(91)));
      entry.pct.m6 = pctFrom(_closeBefore(longSeries, daysAgo(182)));
      entry.pct.y1 = pctFrom(_closeBefore(longSeries, daysAgo(365)));
      entry.pct.y3 = pctFrom(_closeBefore(longSeries, daysAgo(365 * 3)));
      entry.pct.y5 = pctFrom(_closeBefore(longSeries, daysAgo(365 * 5)));
      if (entry.pct.mtd == null) {
        // Same 5-day guard as the short-series MTD: a weekly bar too far before
        // the month boundary would overstate the month's move.
        const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        let refIdx = -1;
        for (let i = 0; i < longSeries.dates.length; i++) if (longSeries.dates[i] < mStart) refIdx = i;
        if (refIdx >= 0 && (mStart - longSeries.dates[refIdx]) <= 5 * 86400000) {
          entry.pct.mtd = pctFrom(longSeries.closes[refIdx]);
        }
      }
    });
    // Repair pass: for any Nifty index whose figures are still missing or only
    // approximate after the Yahoo merge (its series has holes, or — Smallcap
    // 100 — no history at all), pull the COMPLETE daily series from Groww's
    // charting API and compute everything exactly. Runs in parallel and only
    // for the deficient indices, so the common case adds zero extra requests.
    const needsRepair = all.filter(({ symbol, groww }) => {
      if (!groww) return false;
      const e = marketOverviewData.get(symbol);
      if (!e) return false;
      const p = e.pct;
      return p.longUnsupported || p.mtd == null || p.m1 == null ||
             p.m3 == null || p.m6 == null || p.y1 == null || p.y3 == null || p.y5 == null;
    });
    await Promise.all(needsRepair.map(async ({ symbol, groww }) => {
      try {
        const s = await fetchGrowwCandles(groww);
        if (!s.closes.length) return;
        const entry = marketOverviewData.get(symbol);
        // Cross-source sanity: Groww's latest close must agree with the price we
        // display (same guard that caught the Pharma/Healthcare mixup) — a >2%
        // disagreement means a wrong scrip-code mapping, so keep hands off.
        const gLast = s.closes[s.closes.length - 1];
        if (Math.abs(gLast - entry.last) / entry.last > 0.02) return;
        const pctFrom = (base) => (base ? ((entry.last - base) / base) * 100 : null);
        const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const mtdRef = _closeBefore(s, mStart);
        if (mtdRef) entry.pct.mtd = pctFrom(mtdRef);
        entry.pct.m1 = pctFrom(_closeBefore(s, daysAgo(30)))  ?? entry.pct.m1;
        entry.pct.m3 = pctFrom(_closeBefore(s, daysAgo(91)))  ?? entry.pct.m3;
        entry.pct.m6 = pctFrom(_closeBefore(s, daysAgo(182))) ?? entry.pct.m6;
        entry.pct.y1 = pctFrom(_closeBefore(s, daysAgo(365))) ?? entry.pct.y1;
        entry.pct.y3 = pctFrom(_closeBefore(s, daysAgo(365 * 3))) ?? entry.pct.y3;
        entry.pct.y5 = pctFrom(_closeBefore(s, daysAgo(365 * 5))) ?? entry.pct.y5;
        // First close in the series stands in for 5Y when the index is younger
        // (Groww's smallcap history starts Apr 2021).
        if (entry.pct.y5 == null && s.closes[0]) entry.pct.y5 = pctFrom(s.closes[0]);
        entry.pct.longUnsupported = false;
      } catch (_) { /* keep whatever the Yahoo merge produced */ }
    }));

    _saveMarketOverviewCache(); // long-range figures are the expensive part — keep them across reloads
    // Re-render if the user is currently looking at a period that just filled in.
    if (['mtd', 'm1', 'm3', 'm6', 'y1', 'y3', 'y5'].includes(marketOverviewMode)) renderMarketOverviewCards();
  } catch (e) {
    console.warn('[market-overview] long-range fetch failed:', e.message);
  }
}

function renderMarketOverviewCards() {
  const grid = document.getElementById('market-overview-grid');
  if (!grid) return;
  if (!marketOverviewData) { grid.innerHTML = ''; return; }

  const pctKey = marketOverviewMode;
  const all = [...MARKET_PINNED_INDICES, ...MARKET_MOVER_POOL];

  const cardHtml = ({ symbol, label, group }) => {
    const d = marketOverviewData.get(symbol);
    const pct = d?.pct?.[pctKey];
    if (!d) return '';
    // Some indices (Nifty Smallcap 100 confirmed) have no historical series
    // anywhere on Yahoo for 3M/6M/1Y/5Y — a permanent data-source gap, not a
    // transient fetch failure. Show it distinctly ("n/a") so it doesn't look
    // like a bug that a refresh will fix.
    const isLongUnsupported = ['m1', 'm3', 'm6', 'y1', 'y3', 'y5'].includes(pctKey) && d.pct?.longUnsupported;
    // pct can be legitimately unavailable (e.g. daily suppressed because Yahoo's
    // series has a multi-day hole, or exact MTD not yet filled) — show the card
    // with a dash, not a wrong number.
    const cls = pct == null ? '' : (pct >= 0 ? 'trend-up' : 'trend-down');
    const accent = pct == null ? '#64748b' : (pct >= 0 ? '#34d399' : '#f87171');
    const pctTxt = isLongUnsupported ? 'n/a' : (pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
    const title = isLongUnsupported
      ? ' title="No historical price data is available for this index from any free data source"'
      : '';
    const openCls = symbol === _miChartSymbol ? ' mi-open' : '';
    return `
      <div class="market-index-card mi-clickable${openCls}" style="--card-accent: ${accent};"
           onclick="toggleMarketIndexChart('${symbol.replace(/'/g, '')}', this)"
           title="Click for a price chart vs Nifty 50">
        <div class="mi-group">${escapeHtml(group)}</div>
        <div class="mi-label">${escapeHtml(label)}</div>
        <div class="mi-pct ${cls}"${title}>${pctTxt}</div>
        <div class="mi-last">${d.last.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
      </div>`;
  };

  const section = (title, items) => {
    const html = items.map(cardHtml).join('');
    if (!html) return '';
    return `<div class="market-section">
      <div class="market-section-title">${escapeHtml(title)}</div>
      <div class="market-index-grid">${html}</div>
    </div>`;
  };

  // Indian Indices: broad market benchmarks (Nifty 50, Sensex, Midcap/Smallcap
  // 100) — as distinct from sector-specific indices below.
  const indianIndices = MARKET_PINNED_INDICES.filter(i => i.group === 'National' || i.group === 'Market Cap');
  // Global Indices: overseas benchmarks + gold, the non-India reference points.
  const globalIndices = MARKET_PINNED_INDICES.filter(i => i.group === 'Global' || i.group === 'Commodity');
  // Sectoral Indices: every sector-specific index, pinned or from the mover pool —
  // one section instead of splitting "pinned sectors" from "everything else".
  const sectoralIndices = [
    ...MARKET_PINNED_INDICES.filter(i => i.group === 'Sectoral'),
    ...MARKET_MOVER_POOL.map(i => ({ ...i, group: i.group || 'Sectoral' })),
  ];

  // Top 3 Gainers / Losers: ranked across EVERY tracked index for the current
  // period (not just the sector pool), split by sign — not by |change| — so a
  // -1.5% doesn't crowd out the real losers under a "movers" umbrella.
  const ranked = all
    .map(i => ({ ...i, d: marketOverviewData.get(i.symbol) }))
    .filter(i => i.d && i.d.pct?.[pctKey] != null);
  const gainers = ranked.filter(i => i.d.pct[pctKey] >= 0).sort((a, b) => b.d.pct[pctKey] - a.d.pct[pctKey]).slice(0, 3);
  const losers = ranked.filter(i => i.d.pct[pctKey] < 0).sort((a, b) => a.d.pct[pctKey] - b.d.pct[pctKey]).slice(0, 3);
  const gainersHtml = gainers.map(i => cardHtml({ symbol: i.symbol, label: i.label, group: 'Gainer' }));
  const losersHtml = losers.map(i => cardHtml({ symbol: i.symbol, label: i.label, group: 'Loser' }));

  const sectionsHtml = [
    section('Indian Indices', indianIndices),
    section('Global Indices', globalIndices),
    section('Sectoral Indices', sectoralIndices),
    gainersHtml.length ? `<div class="market-section"><div class="market-section-title">Top 3 Gainers</div><div class="market-index-grid">${gainersHtml.join('')}</div></div>` : '',
    losersHtml.length ? `<div class="market-section"><div class="market-section-title">Top 3 Losers</div><div class="market-index-grid">${losersHtml.join('')}</div></div>` : '',
  ].join('');

  const isLongPeriod = ['m1', 'm3', 'm6', 'y1', 'y3', 'y5'].includes(pctKey);
  grid.innerHTML = sectionsHtml
    || (isLongPeriod
      ? '<p style="color:var(--text-muted);">Loading longer-range data…</p>'
      : '<p style="color:var(--text-muted);">No market data available.</p>');

  // A re-render (period change, background refresh) rebuilds the grid HTML and
  // silently drops the open chart panel — re-attach it to the first card of the
  // still-open symbol so the chart survives filter changes.
  if (_miChartSymbol) {
    const card = grid.querySelector('.market-index-card.mi-open');
    if (card) _openMarketIndexChart(_miChartSymbol, card);
    else _miChartSymbol = null;
  }
}

// ── Inline index chart (click a market overview card) ──────────────────────
let _miChartSymbol = null;   // symbol whose chart panel is currently open
let _miChart = null;         // Chart.js instance in the open panel
const _miSeriesCache = new Map(); // symbol → { at, series:{dates,closes} } (full daily history)

// Full daily close series for an overview index. Nifty indices come from
// Groww (complete 5y dailies for every index); global ones from Yahoo spark.
async function _getMarketIndexSeries(symbol) {
  const hit = _miSeriesCache.get(symbol);
  if (hit && (Date.now() - hit.at) < MARKET_OVERVIEW_TTL_MS) return hit.series;
  const meta = [...MARKET_PINNED_INDICES, ...MARKET_MOVER_POOL].find(i => i.symbol === symbol);
  let series = null;
  if (meta?.groww) {
    series = await fetchGrowwCandles(meta.groww);
  } else {
    // 1y of dailies covers every period except 5Y; weekly bars for the rest.
    const [daily, weekly] = await Promise.all([
      fetchSparkCloses([symbol], '1y', '1d'),
      fetchSparkCloses([symbol], '5y', '1wk'),
    ]);
    const d = daily.get(symbol), w = weekly.get(symbol);
    if (d?.closes?.length) {
      const firstDaily = d.dates[0];
      const older = w?.dates?.map((t, i) => ({ t, c: w.closes[i] })).filter(p => p.t < firstDaily) || [];
      series = {
        dates: [...older.map(p => p.t), ...d.dates],
        closes: [...older.map(p => p.c), ...d.closes],
      };
    } else if (w?.closes?.length) {
      series = { dates: w.dates, closes: w.closes };
    }
  }
  if (!series || !series.closes.length) throw new Error('no series');
  _miSeriesCache.set(symbol, { at: Date.now(), series });
  return series;
}

function toggleMarketIndexChart(symbol, cardEl) {
  if (_miChartSymbol === symbol) { _closeMarketIndexChart(); return; }
  _closeMarketIndexChart();
  _miChartSymbol = symbol;
  cardEl.classList.add('mi-open');
  _openMarketIndexChart(symbol, cardEl);
}

function _closeMarketIndexChart() {
  if (_miChart) { _miChart.destroy(); _miChart = null; }
  document.querySelectorAll('.market-chart-panel').forEach(p => p.remove());
  document.querySelectorAll('.market-index-card.mi-open').forEach(c => c.classList.remove('mi-open'));
  _miChartSymbol = null;
}

async function _openMarketIndexChart(symbol, cardEl) {
  // The grid re-render path calls this with the old chart's canvas already gone.
  if (_miChart) { _miChart.destroy(); _miChart = null; }
  const meta = [...MARKET_PINNED_INDICES, ...MARKET_MOVER_POOL].find(i => i.symbol === symbol);
  const label = meta?.label || symbol;
  const panel = document.createElement('div');
  panel.className = 'market-chart-panel';
  panel.innerHTML = `
    <div class="market-chart-head">
      <span class="market-chart-title">${escapeHtml(label)} vs Nifty 50 — indexed to 100</span>
      <button class="market-chart-close" onclick="event.stopPropagation(); _closeMarketIndexChart()" title="Close">✕</button>
    </div>
    <div class="market-chart-body"><canvas></canvas></div>
    <p class="market-chart-status">Loading chart…</p>`;
  // Full-width row right below the clicked card, inside the same grid.
  cardEl.insertAdjacentElement('afterend', panel);

  try {
    const wantNifty = symbol !== '^NSEI';
    const [main, nifty] = await Promise.all([
      _getMarketIndexSeries(symbol),
      wantNifty ? _getMarketIndexSeries('^NSEI').catch(() => null) : null,
    ]);
    // A stale click (user closed / switched index while fetching) must not draw.
    if (_miChartSymbol !== symbol || !panel.isConnected) return;

    const days = { daily: 30, mtd: 0, m1: 30, m3: 91, m6: 182, y1: 365, y3: 365 * 3, y5: 365 * 5 }[marketOverviewMode] ?? 365;
    const now = new Date();
    const cutoff = marketOverviewMode === 'mtd'
      ? new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      : Date.now() - days * 86400000;
    const pts = main.dates.map((t, i) => ({ t, c: main.closes[i] })).filter(p => p.t >= cutoff);
    if (pts.length < 2) { panel.querySelector('.market-chart-status').textContent = 'Not enough data for this period.'; return; }

    const base = pts[0].c;
    const mainIdx = pts.map(p => +(p.c / base * 100).toFixed(2));
    let niftyIdx = null;
    if (nifty) {
      const nBase = closeAtOrBefore(nifty, pts[0].t);
      if (nBase) niftyIdx = pts.map(p => {
        const v = closeAtOrBefore(nifty, p.t);
        return v ? +(v / nBase * 100).toFixed(2) : null;
      });
    }
    const labels = pts.map(p => new Date(p.t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: days > 365 ? '2-digit' : undefined }));

    panel.querySelector('.market-chart-status').remove();
    const datasets = [{
      label, data: mainIdx, borderColor: '#818cf8', backgroundColor: 'rgba(129,140,248,0.08)',
      fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2,
    }];
    if (niftyIdx) datasets.push({
      label: 'Nifty 50', data: niftyIdx, borderColor: '#64748b', borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: false,
    });
    _miChart = new Chart(panel.querySelector('canvas').getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#94a3b8', boxWidth: 18 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} (${(c.parsed.y - 100).toFixed(2)}%)` } },
        },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
      },
    });
  } catch (e) {
    const st = panel.querySelector('.market-chart-status');
    if (st) st.textContent = 'Could not load chart data — check your connection and retry.';
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

// Format the as-of date of a price/NAV as DD-MM-YYYY, matching the MF holdings
// "NAV Date" column. MFs carry navDate (already DD-MM-YYYY from mfapi); stocks carry
// priceAsOf (epoch ms — the market session the LTP belongs to, not the refresh time).
function priceNavDateStr(holding, type) {
  if (type === 'MF' && holding.navDate) return holding.navDate;
  if (type !== 'MF' && holding.priceAsOf) {
    return new Date(holding.priceAsOf).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(/\//g, '-');
  }
  // No live refresh yet this session — the price is from the last committed
  // snapshot, so show that date instead of a blank (the column used to be
  // empty until the first refresh, which read as a bug).
  const dates = (typeof breakupSummary !== 'undefined' && breakupSummary?.dates) || [];
  if (dates.length) {
    const d = dates[dates.length - 1];
    return `${d.slice(8,10)}-${d.slice(5,7)}-${d.slice(0,4)}`;
  }
  return null;
}

// "01 Jun 2026" style date for headline copy.
function _fmtDMY(d) {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
// The trading day immediately before `date` (skips Sat/Sun; holidays not modelled).
function _prevTradingDay(date) {
  const x = new Date(date);
  do { x.setDate(x.getDate() - 1); } while (x.getDay() === 0 || x.getDay() === 6);
  return x;
}

// ── Daily Overview Table (top gainers across stocks & MFs by daily value) ──
function renderDailyOverviewTable() {
  const combined = [];
  let totalStockGain = 0;
  let totalMfGain = 0;

  // Headline: "Daily Performance (since <previous trading day>)". The daily change
  // compares the current price/NAV against the previous close, so reference the
  // trading day before the latest price session among holdings.
  const _titleEl = document.getElementById('daily-overview-title');
  if (_titleEl) {
    const latestMs = (latestEquity || []).reduce((m, s) => Math.max(m, s.priceAsOf || 0), 0);
    const ref = latestMs ? new Date(latestMs) : new Date();
    _titleEl.textContent = `Daily Performance (since ${_fmtDMY(_prevTradingDay(ref))})`;
  }

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
      priceDate: priceNavDateStr(s, 'Stock'),
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
      changePct: gainPct,
      priceDate: priceNavDateStr(f, 'MF')
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
  // Recent new investments from the ledger (last 7 days) for the daily summary.
  const _wkAgo = localDateStr(new Date(Date.now() - 7 * 86400000));
  let recentInv = 0, recentCount = 0;
  (typeof transactions !== 'undefined' ? transactions : []).forEach(t => {
    if (!t.date || t.date < _wkAgo) return;
    if (t.type === 'buy') { recentInv += (t.amount || 0); recentCount++; }
    else if (t.type === 'sell') { recentInv -= (t.amount || 0); recentCount++; }
  });
  // Balance contributions (PF/PPF/NPS/...) are new investment too — the Monthly
  // Overview counts them, so L7D must as well or the two cards contradict each
  // other (₹0.5L vs ₹0.97L for the same week).
  (typeof balances !== 'undefined' ? balances : []).forEach(b => {
    if (!b.date || b.date < _wkAgo) return;
    if (b.contribution) { recentInv += b.contribution; recentCount++; }
  });

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
      <div class="tab-kpi-card" style="--card-accent:#6366f1;">
        <div class="tab-kpi-label">New Investment (7d)</div>
        <div class="tab-kpi-value">${recentCount ? (recentInv >= 0 ? '+' : '') + formatINR(recentInv) : '—'}</div>
        <div class="tab-kpi-sub">${recentCount ? `${recentCount} ledger transaction${recentCount > 1 ? 's' : ''}` : 'no recent transactions'}</div>
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
  } else if (col === 6) {
    filteredCombined.sort((a, b) => sortNullableNumber(_mfNavDateMs(a.priceDate), _mfNavDateMs(b.priceDate), asc));
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
      <td style="text-align: right;">${item.priceDate ? escapeHtml(item.priceDate) : '—'}</td>
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
// ── Calendar-month-to-date data: portfolio MTD must track the CALENDAR month
// (1st-of-month → today), independent of when "Close Period" was last run —
// otherwise closing a period mid-month resets the MTD clock to that moment,
// silently discarding whatever move already happened earlier that day/month.
let calendarMtdData = null; // { month: 'YYYY-MM', stockPriceByInstrument: Map, mfNavByScheme: Map, fetchedAt }
const CALENDAR_MTD_TTL_MS = 60 * 60 * 1000; // 1 hour

function currentCalendarMonthStr() {
  return localDateStr().slice(0, 7);
}

let _calendarMtdFetchPromise = null;

function ensureCalendarMtdData() {
  const month = currentCalendarMonthStr();
  if (calendarMtdData && calendarMtdData.month === month &&
      (Date.now() - calendarMtdData.fetchedAt) < CALENDAR_MTD_TTL_MS) {
    return Promise.resolve(calendarMtdData);
  }
  if (_calendarMtdFetchPromise) return _calendarMtdFetchPromise; // de-dupe concurrent callers
  _calendarMtdFetchPromise = _fetchCalendarMtdData(month).finally(() => { _calendarMtdFetchPromise = null; });
  return _calendarMtdFetchPromise;
}

async function _fetchCalendarMtdData(month) {
  const now = new Date();
  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  // Stocks: one batched Yahoo request for everything with a live price source.
  const stockPriceByInstrument = new Map();
  try {
    const tickerOf = (instr) => instr.replace(/-RR$/, '') + '.NS';
    const stockHoldings = (latestEquity || []).filter(s =>
      typeof hasLivePriceSource === 'function' && hasLivePriceSource(s.instrument) && s.qty > 0);
    const closesBySym = await fetchSparkCloses(stockHoldings.map(h => tickerOf(h.instrument)));
    stockHoldings.forEach(h => {
      const series = closesBySym.get(tickerOf(h.instrument));
      if (!series) return;
      let val = null;
      for (let i = 0; i < series.dates.length; i++) if (series.dates[i] < monthStartMs) val = series.closes[i];
      if (val != null) stockPriceByInstrument.set(h.instrument, val);
    });

    // SGBs have no live Yahoo ticker (hasLivePriceSource is false for them), so they're
    // excluded above — leaving them to a stale "last two closed snapshots" fallback that
    // compares across whole CLOSED PERIODS (e.g. the full prior month), not the calendar
    // month. Since SGBs track gold 1:1 intraday, derive their month-start price from
    // GOLDBEES (already fetched here) scaled by today's SGB:GOLDBEES ratio — preserves
    // any real premium/discount while reflecting only this month's gold price movement.
    const goldbeesNow = (latestEquity || []).find(s => s.instrument === 'GOLDBEES');
    const goldbeesMonthStart = stockPriceByInstrument.get('GOLDBEES');
    if (goldbeesNow?.ltp > 0 && goldbeesMonthStart != null) {
      const ratio = goldbeesMonthStart / goldbeesNow.ltp;
      (latestEquity || []).forEach(s => {
        if (s.qty > 0 && typeof isGoldHolding === 'function' && isGoldHolding(s) &&
            !stockPriceByInstrument.has(s.instrument) && s.ltp > 0) {
          stockPriceByInstrument.set(s.instrument, s.ltp * ratio);
        }
      });
    }
  } catch (e) { console.warn('[calendar-mtd] stock fetch failed:', e.message); }

  // MFs: one mfapi call per scheme (full NAV history), same pattern as the 30-day perf chart.
  const mfNavByScheme = new Map();
  try {
    const parseMfDate = (s) => { const [d, m, y] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
    const mfHoldings = (latestMf || []).filter(f => f.qty > 0);
    await Promise.all(mfHoldings.map(async (f) => {
      const code = (typeof MF_SCHEME_CODES !== 'undefined' && MF_SCHEME_CODES[f.scheme]) ||
                   (typeof dynamicMfSchemeCodes !== 'undefined' && dynamicMfSchemeCodes[f.scheme]);
      if (!code) return;
      try {
        const res = await fetch(`https://api.mfapi.in/mf/${code}`, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return;
        const j = await res.json();
        const pts = (j?.data || [])
          .map(e => ({ t: parseMfDate(e.date), c: parseFloat(e.nav) }))
          .filter(p => !isNaN(p.t) && p.c > 0)
          .sort((a, b) => a.t - b.t);
        let val = null;
        for (const p of pts) if (p.t < monthStartMs) val = p.c;
        if (val != null) mfNavByScheme.set(f.scheme, val);
      } catch (_) { /* skip this scheme */ }
    }));
  } catch (e) { console.warn('[calendar-mtd] MF fetch failed:', e.message); }

  calendarMtdData = { month, stockPriceByInstrument, mfNavByScheme, fetchedAt: Date.now() };
  return calendarMtdData;
}

// Kicks off the calendar-MTD fetch (if stale/missing) and re-renders the Monthly
// Overview table once it lands. Safe to call repeatedly — ensureCalendarMtdData
// short-circuits when already fresh.
function refreshCalendarMtdAndRerender() {
  ensureCalendarMtdData().then(() => {
    if (document.getElementById('monthly-overview-body')) renderMonthlyOverviewTable();
  });
}

function renderMonthlyOverviewTable() {
  const combined = [];
  let totalStockMonthlyGain = 0;
  let totalMfMonthlyGain = 0;
  let totalStockBaseVal = 0;
  let totalMfBaseVal = 0;

  // Headline: "MTD Performance (since <calendar month start>)" — always the 1st of
  // the current calendar month, independent of when Close Period last ran.
  const _now = new Date();
  const _monthStartDate = new Date(_now.getFullYear(), _now.getMonth(), 1);
  const _mTitleEl = document.getElementById('monthly-overview-title');
  if (_mTitleEl) {
    _mTitleEl.textContent = `🏆 MTD Performance (since ${_fmtDMY(_monthStartDate)})`;
  }

  // Period gain per holding, calendar-month basis:
  //  • Preferred: live price/NAV vs. the price as of the last close BEFORE this
  //    calendar month started (fetched by ensureCalendarMtdData — a real market
  //    price, not tied to when Close Period was last run).
  //  • Fallback while that data is loading (or unavailable for a holding): the old
  //    thisMonthGain/historicalHoldings-based estimate, so the table isn't blank.
  const hasLive = !!(window.lastRefreshReport);
  const _baseDate = (typeof frozenBase !== 'undefined' && frozenBase) ? frozenBase.baseDate : null;
  const _calMonth = currentCalendarMonthStr();
  const calReady = calendarMtdData && calendarMtdData.month === _calMonth;
  const periodGain = (holding, type) => {
    if (calReady) {
      const basePrice = type === 'stock'
        ? calendarMtdData.stockPriceByInstrument.get(holding.instrument)
        : calendarMtdData.mfNavByScheme.get(holding.scheme);
      if (basePrice != null) {
        const curPrice = type === 'stock' ? holding.ltp : holding.price;
        return { gain: (curPrice - basePrice) * holding.qty, baseVal: basePrice * holding.qty };
      }
    }
    if (hasLive && holding.thisMonthGain) {
      return { gain: holding.thisMonthGain, baseVal: (holding.basePrice ?? 0) * holding.qty };
    }
    const obj = type === 'stock'
      ? ((typeof getStockHistoryKey === 'function' && getStockHistoryKey(holding.instrument)) || historicalHoldings.stocks?.[holding.instrument])
      : historicalHoldings.mfs?.[holding.scheme];
    let h = obj?.history;
    if (h && _baseDate) h = h.filter(p => p.date <= _baseDate); // month-end snapshots only
    if (h && h.length >= 2) {
      const cur = h[h.length - 1].cur_val || 0;
      const prev = h[h.length - 2].cur_val || 0;
      return { gain: cur - prev, baseVal: prev };
    }
    return { gain: 0, baseVal: holding.cur_val || 0 };
  };
  if (!calReady) refreshCalendarMtdAndRerender();

  latestEquity.forEach(s => {
    const { gain, baseVal } = periodGain(s, 'stock');
    const gainPct = baseVal > 0 ? (gain / baseVal) * 100 : 0;
    combined.push({ name: s.instrument, type: 'Stock', qty: s.qty, baseVal, currentVal: s.cur_val, gain, gainPct, priceDate: priceNavDateStr(s, 'Stock') });
    totalStockMonthlyGain += gain;
    totalStockBaseVal += baseVal;
  });

  latestMf.forEach(f => {
    const { gain, baseVal } = periodGain(f, 'mf');
    const gainPct = baseVal > 0 ? (gain / baseVal) * 100 : 0;
    combined.push({ name: f.scheme, type: 'MF', qty: f.qty, baseVal, currentVal: f.cur_val, gain, gainPct, priceDate: priceNavDateStr(f, 'MF') });
    totalMfMonthlyGain += gain;
    totalMfBaseVal += baseVal;
  });

  // Card totals are the SUM of the per-holding period gains computed above, so the
  // "Period Gain" cards always equal the sum of the rows in the Movers table below.
  // (The 30-day perf chart is a live reference; small differences from it are expected.)
  const totalMonthlyGain = totalStockMonthlyGain + totalMfMonthlyGain;

  // ── Compute monthly % change denominators ──
  const monthlyStockPct = totalStockBaseVal > 0 ? (totalStockMonthlyGain / totalStockBaseVal) * 100 : 0;
  const monthlyMfPct = totalMfBaseVal > 0 ? (totalMfMonthlyGain / totalMfBaseVal) * 100 : 0;
  const totalBaseVal = totalStockBaseVal + totalMfBaseVal;
  const monthlyTotalPct = totalBaseVal > 0 ? (totalMonthlyGain / totalBaseVal) * 100 : 0;

  // ── Real Sensex monthly change (falls back to 0 if not yet fetched) ──
  const niftyMonthlyPct = _niftyMonthlyPctReal ?? 0;
  const niftyMonthlyLabel = _niftyMonthlyPctReal != null ? 'Month-to-date change (Nifty 50)' : 'Monthly change (loading…)';

  // Period label: live MTD (from refreshed prices or the 30-day perf series) vs the
  // last completed period from history.
  const _lastPeriodDate = (breakupSummary.dates || []).slice(-1)[0];
  const periodLabel = hasLive
    ? 'month to date (live)'
    : `period to ${_lastPeriodDate ? formatDateString(_lastPeriodDate) : 'last close'}`;

  // New investment this CALENDAR month, from the ledger only. The closed-period
  // breakup total is NOT included here — it represents new_investment "since the
  // previous close" (e.g. all of June, rolled up at the July 1 close), a different,
  // non-calendar-aligned window that would misattribute last month's contributions
  // to this month. Going forward, everything since month start lives in the ledger.
  const _monthStartStr = localDateStr(_monthStartDate);
  let newInvTotal = 0;
  (typeof transactions !== 'undefined' ? transactions : []).forEach(t => {
    if (t.date < _monthStartStr) return;
    if (t.type === 'buy') newInvTotal += (t.amount || 0);
    else if (t.type === 'sell') newInvTotal -= (t.amount || 0);
  });
  (typeof balances !== 'undefined' ? balances : []).forEach(b => {
    if (b.date < _monthStartStr) return;
    newInvTotal += (b.contribution || 0);
  });

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
        <div class="tab-kpi-sub">${periodLabel}</div>
      </div>
      <div class="tab-kpi-card${monthlyTypeFilter === 'mf' ? ' filter-active' : ''}" style="--card-accent:${totalMfMonthlyGain >= 0 ? G : R}; cursor:pointer;" onclick="setMonthlyTypeFilter('mf')">
        <div class="tab-kpi-label">Period Gain — MFs</div>
        <div class="tab-kpi-value ${totalMfMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalMfMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMfMonthlyGain)} <span class="tab-kpi-inline-pct">(${monthlyMfPct >= 0 ? '+' : ''}${monthlyMfPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">${periodLabel}</div>
      </div>
      <div class="tab-kpi-card${monthlyTypeFilter === 'all' ? ' filter-active' : ''}" style="--card-accent:${totalMonthlyGain >= 0 ? G : R}; cursor:pointer;" onclick="setMonthlyTypeFilter('all')">
        <div class="tab-kpi-label">Combined Gain</div>
        <div class="tab-kpi-value ${totalMonthlyGain >= 0 ? 'trend-up' : 'trend-down'}">
          ${totalMonthlyGain >= 0 ? '+' : ''}${formatINR(totalMonthlyGain)} <span class="tab-kpi-inline-pct">(${monthlyTotalPct >= 0 ? '+' : ''}${monthlyTotalPct.toFixed(2)}%)</span>
        </div>
        <div class="tab-kpi-sub">Stocks + MFs</div>
      </div>
      <div class="tab-kpi-card" style="--card-accent:#6366f1;">
        <div class="tab-kpi-label">New Investment</div>
        <div class="tab-kpi-value">${newInvTotal >= 0 ? '+' : ''}${formatINR(newInvTotal)}</div>
        <div class="tab-kpi-sub">month to date (ledger)</div>
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
    filteredCombined.sort((a, b) => asc ? a.baseVal - b.baseVal : b.baseVal - a.baseVal);
  } else if (col === 3) {
    filteredCombined.sort((a, b) => asc ? a.currentVal - b.currentVal : b.currentVal - a.currentVal);
  } else if (col === 4) {
    filteredCombined.sort((a, b) => asc ? a.gain - b.gain : b.gain - a.gain);
  } else if (col === 5) {
    filteredCombined.sort((a, b) => asc ? a.gainPct - b.gainPct : b.gainPct - a.gainPct);
  } else if (col === 6) {
    filteredCombined.sort((a, b) => sortNullableNumber(_mfNavDateMs(a.priceDate), _mfNavDateMs(b.priceDate), asc));
  } else {
    // Name column (0) or fallback: sort by name
    filteredCombined.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }

  const tbody = document.getElementById('monthly-overview-body');
  tbody.innerHTML = filteredCombined.map(item => `
    <tr class="${item.gain >= 0 ? 'row-gain' : 'row-loss'}">
      <td class="instrument-cell">${escapeHtml(item.name)}</td>
      <td style="text-align: right;">${item.qty.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatINR(item.baseVal)}</td>
      <td style="text-align: right;">${formatINR(item.currentVal)}</td>
      <td style="text-align: right;" class="${item.gain >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.gain >= 0 ? '+' : ''}${formatINR(item.gain)}
      </td>
      <td style="text-align: right;" class="${item.gainPct >= 0 ? 'trend-up' : 'trend-down'}">
        ${item.gainPct >= 0 ? '+' : ''}${item.gainPct.toFixed(2)}%
      </td>
      <td style="text-align: right;">${item.priceDate ? escapeHtml(item.priceDate) : '—'}</td>
    </tr>
  `).join('');
}

// ==================== TOTAL RETURN XIRR (using transaction_history.json) ====================

// Whole-portfolio money-weighted XIRR from the breakup Total series:
// opening Total balance as the first outflow + each period's net new investment
// as outflows + the final Total net worth as the terminal inflow. This is the
// single source of truth used by BOTH the Net Worth KPI card and the
// "Portfolio (Overall)" row of the Performance Comparison table, so they match.
function computePortfolioXirr() {
  if (!breakupSummary || typeof computeXirr !== 'function') return null;
  const dates = breakupSummary.dates || [];
  const nw = breakupSummary.net_worth || {};
  const ni = breakupSummary.new_investment || {};
  if (!dates.length) return null;
  const nwTot = nw['Total']?.values || [];
  const niTot = ni['Total Investment']?.values || [];
  const opening = nwTot[0] || 0;
  if (opening <= 0) return null;
  const flows = [{ date: dates[0], amount: -opening * 100000 }];
  dates.forEach((d, i) => {
    if (i === 0) return;
    const inv = niTot[i] || 0;
    if (Math.abs(inv) > 1e-4) flows.push({ date: d, amount: -inv * 100000 });
  });
  const terminal = nwTot[nwTot.length - 1] || 0;
  if (terminal <= 0) return null;
  flows.push({ date: dates[dates.length - 1], amount: terminal * 100000 });
  flows.sort((a, b) => a.date.localeCompare(b.date));
  const x = computeXirr(flows, 0.12);
  return (x != null && isFinite(x)) ? x : null;
}

function computeDebtXirr() {
  if (!breakupSummary || typeof computeXirr !== 'function') return null;
  const dates = breakupSummary.dates || [];
  const nw = breakupSummary.net_worth || {};
  const ni = breakupSummary.new_investment || {};
  const debtKeys = ['PF (Debt)', 'PPF (Debt)', 'Bonds (Debt)', 'NPS C (Debt)', 'NPS G (Debt)'];
  if (!dates.length) return null;

  // Opening balance at the first date MUST be seeded as the initial cash outflow.
  // Otherwise the XIRR sees only sporadic contributions producing a huge terminal
  // balance → absurd return (the 44% bug). These are debt instruments whose first
  // column is an existing balance, not a fresh investment.
  let opening = 0;
  debtKeys.forEach(k => { opening += (nw[k]?.values?.[0] || 0); });

  const flows = [];
  if (opening > 0) flows.push({ date: dates[0], amount: -opening * 100000 });

  // Subsequent net contributions (skip index 0 — already captured in opening balance).
  dates.forEach((d, i) => {
    if (i === 0) return;
    let inv = 0;
    debtKeys.forEach(k => { inv += (ni[k]?.values?.[i] || 0); });
    if (Math.abs(inv) > 0.0001) flows.push({ date: d, amount: -inv * 100000 });
  });

  let terminal = 0;
  debtKeys.forEach(k => {
    const vals = nw[k]?.values || [];
    terminal += vals.length ? vals[vals.length - 1] : 0;
  });
  if (terminal <= 0 || flows.length < 1) return null;
  flows.push({ date: dates[dates.length - 1], amount: terminal * 100000 });
  flows.sort((a, b) => a.date.localeCompare(b.date));
  const x = computeXirr(flows, 0.08);
  // Sanity guard: debt XIRR outside [-20%, 60%] is almost certainly a data artifact.
  if (x == null || !isFinite(x) || x < -0.2 || x > 0.6) return null;
  return x;
}

// After transaction_history loads, refresh per-holding XIRR (now dividend-aware)
// and the dividend-yield column. The portfolio/equity/debt XIRR KPI cards are set
// synchronously in updateKpis() from breakup data and are NOT touched here, so the
// cards stay consistent with the Performance Comparison table.
function updateEquityXirrFromHistory() { /* dividends fold into holdingXIRR + div-yield on re-render */ }

// Load the transaction history file (dividends + pre-base flows for portfolio XIRR).
// Called from BOTH load paths (cached + server) — it was previously only in the
// server path, so cached loads left transactionHistory null → blank portfolio XIRR.
function loadTransactionHistory() {
  if (transactionHistory) { try { updateEquityXirrFromHistory(); } catch (_) {} return; }
  fetch('data/transaction_history.json?v=' + APP_VERSION, { credentials: 'same-origin' })
    .then(r => r.ok ? parsePortfolioJson(r) : null)
    .then(data => {
      if (!data) return;
      transactionHistory = data;
      // Invalidate dividend index + per-holding XIRR caches that were computed
      // before dividends were available, then refresh the visible views.
      _divIndex = null;
      (latestEquity || []).forEach(s => { delete s._xirr; });
      (latestMf || []).forEach(f => { delete f._xirr; });
      try { updateEquityXirrFromHistory(); } catch (e) { console.warn('updateEquityXirrFromHistory:', e); }
      try { if (typeof reapplyStocksView === 'function') reapplyStocksView(); } catch (_) {}
    })
    .catch(() => {});
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

// ==================== HISTORICAL GROWTH TAB ====================

// Common Growth & Benchmark tab time filter → start index into the monthly
// breakupSummary.dates. Drives every chart in the tab (re-rendered on change).
function setGrowthPeriod(val, btn) {
  document.querySelectorAll('#growth-time-seg button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyGrowthTimeFilter();
}

function growthSliceIdx() {
  const filter = document.querySelector('#growth-time-seg button.active')?.dataset.val || 'ALL';
  const len = (breakupSummary && breakupSummary.dates) ? breakupSummary.dates.length : 0;
  switch (filter) {
    case '5Y': return Math.max(0, len - 60);
    case '3Y': return Math.max(0, len - 36);
    case '1Y': return Math.max(0, len - 12);
    case '6M': return Math.max(0, len - 6);
    case '3M': return Math.max(0, len - 3);
    default:   return 0; // ALL
  }
}

// Valuation + cumulative-capital-invested series for the capital-vs-valuation chart,
// by asset type. Cumulative invested = running sum of monthly new investment.
function _capValSeries(assetType) {
  const nw = breakupSummary.net_worth, ni = breakupSummary.new_investment;
  const cumsum = arr => { let s = 0; return (arr || []).map(v => (s += (v || 0))); };
  if (assetType === 'stocks')
    return { val: nw['Stocks (Equity)'].values, cumInv: cumsum(ni['Stocks (Equity)'].values), label: 'Stocks' };
  if (assetType === 'mfs')
    return { val: nw['Mutual Funds (Equity)'].values, cumInv: cumsum(ni['Mutual Funds (Equity)'].values), label: 'Mutual Funds' };
  if (assetType === 'combined') {
    const st = nw['Stocks (Equity)'].values, mf = nw['Mutual Funds (Equity)'].values;
    const stI = ni['Stocks (Equity)'].values, mfI = ni['Mutual Funds (Equity)'].values;
    return {
      val: st.map((v, i) => (v || 0) + (mf[i] || 0)),
      cumInv: cumsum(stI.map((v, i) => (v || 0) + (mfI[i] || 0))),
      label: 'Stocks + MFs'
    };
  }
  // total — keep the precomputed cumulative_investment_history for exact parity.
  return { val: nw['Total'].values, cumInv: (portfolioSummary.cumulative_investment_history || []).slice(), label: 'Total Portfolio' };
}

// Data table under the Net Worth Progression chart — the exact values per
// period, newest first, with the same window as the charts.
function renderNetWorthSnapshotTable(dates, sliceIdx) {
  const body = document.getElementById('networth-snapshot-body');
  if (!body) return;
  const SL = arr => (arr || []).slice(sliceIdx);
  const nwT  = SL(breakupSummary.net_worth['Total']?.values);
  const chg  = SL(breakupSummary.net_change?.['Total Change']?.values);
  const inv  = SL(breakupSummary.new_investment?.['Total Investment']?.values);
  const ret  = SL(breakupSummary.returns?.['Total Growth']?.values);
  const cls = v => v == null ? '' : (v >= 0 ? 'trend-up' : 'trend-down');
  const fmt = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + ' L';
  const rows = dates.map((d, i) => ({ d, nw: nwT[i], chg: chg[i], inv: inv[i], ret: ret[i] })).reverse();
  body.innerHTML = rows.map(r => `
    <tr>
      <td>${formatDateString(r.d)}</td>
      <td style="text-align:right; font-weight:600;">${r.nw != null ? '₹' + r.nw.toFixed(2) + ' L' : '—'}</td>
      <td style="text-align:right;" class="${cls(r.chg)}">${fmt(r.chg)}</td>
      <td style="text-align:right;">${r.inv != null ? '₹' + r.inv.toFixed(2) + ' L' : '—'}</td>
      <td style="text-align:right;" class="${cls(r.ret)}">${fmt(r.ret)}</td>
    </tr>`).join('');
}

// Re-render the whole Growth & Benchmark tab for the current common filters.
function applyGrowthTimeFilter() { initGrowthTab(); }

function initGrowthTab() {
  // Destroy existing charts before re-creating
  if (netWorthGrowthChart) netWorthGrowthChart.destroy();
  if (capitalVsValuationChart) capitalVsValuationChart.destroy();
  if (benchmarkComparisonChart) benchmarkComparisonChart.destroy();
  if (rollingReturnsChart) rollingReturnsChart.destroy();
  if (allocationChart) allocationChart.destroy();
  if (componentXirrChart) componentXirrChart.destroy();

  // Common time-filter window: slice all series + dates to the selected period so
  // each chart's axes rescale to that window (not just a cropped viewport).
  const sliceIdx = growthSliceIdx();
  const SL = arr => (arr || []).slice(sliceIdx);
  const dates = breakupSummary.dates.slice(sliceIdx);
  const nwSec = breakupSummary.net_worth;
  const nwDatasets = [];

  Object.keys(nwSec).forEach(key => {
    if (key !== 'Total') {
      const label = nwSec[key].label;
      const vals = SL(nwSec[key].values);

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
        legend: { position: 'top', labels: { color: '#f3f4f6' } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ₹${(ctx.parsed.y ?? 0).toFixed(2)} L`,
            footer: (items) => ` Total Net Worth: ₹${items.reduce((t, i) => t + (i.parsed.y || 0), 0).toFixed(2)} L`
          }
        }
      }
    }
  });

  renderNetWorthSnapshotTable(dates, sliceIdx);

  // Capital vs Valuation Line Chart — asset type from the dedicated filter.
  const assetSel = document.getElementById('capval-asset-filter');
  const capValAsset = assetSel ? assetSel.value : 'total';
  const { val: _capValFull, cumInv: _capInvFull, label: capValLabel } = _capValSeries(capValAsset);
  // Offset cumulative investment to align with valuation at inception (full-series
  // start), so applying the time window just crops this inception-anchored relationship.
  const _capOffset = (_capValFull.length > 0 && _capInvFull.length > 0) ? _capValFull[0] - _capInvFull[0] : 0;
  const totalNw = SL(_capValFull);
  const cumInvested = SL(_capInvFull.map(v => v + _capOffset));

  const ctxCap = document.getElementById('capital-vs-valuation-chart').getContext('2d');
  capitalVsValuationChart = new Chart(ctxCap, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: capValLabel + ' Valuation',
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

  // ── Asset Allocation & XIRR ──

  // 1. Asset Allocation Over Time (Stacked Bar, 100%) — category groups or
  // individual components (the old separate "Allocation Shift" chart showed the
  // component view; merged here behind one toggle).
  const allocView = document.getElementById('alloc-view-filter')?.value || 'category';
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
        SL(nwSec[key].values).forEach((v, i) => { catValues[cat][i] += v; });
      }
    });
  });
  
  // Compute percentage per category (each date sums to 100%)
  const totalPerDate = dates.map((_, i) =>
    Object.keys(categoryMap).reduce((sum, cat) => sum + catValues[cat][i], 0)
  );
  
  let allocStackedDatasets;
  if (allocView === 'component') {
    // Component-level split straight from the breakup contribution section
    const contribSec = breakupSummary.contribution;
    allocStackedDatasets = Object.keys(contribSec)
      .filter(key => key !== 'Total')
      .map(key => ({
        label: contribSec[key].label,
        data: SL(contribSec[key].values).map(v => (v || 0) * 100),
        backgroundColor: getAssetColor(contribSec[key].label) + 'cc',
        borderColor: getAssetColor(contribSec[key].label),
        borderWidth: 0.5
      }));
  } else {
    allocStackedDatasets = Object.keys(categoryMap).map(cat => ({
      label: cat,
      data: catValues[cat].map((v, i) => totalPerDate[i] > 0 ? (v / totalPerDate[i]) * 100 : 0),
      backgroundColor: getAssetColor(cat) + 'cc',
      borderColor: getAssetColor(cat),
      borderWidth: 0.5
    }));
  }
  
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
        data: SL(vals).slice(xirrStartIdx).map(v => v * 100),
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

  // Initialize benchmark comparison chart (default: Nifty 50)
  renderBenchmarkComparisonChart('nifty50');
  renderRollingReturnsChart();
  renderXirrComparisonTable();
}

// ============ FIXED INCOME & NPS TAB (PF / PPF / Bonds / Gold / NPS) ============
function initFixedIncomeTab() {
  try { renderGoldSection(); } catch (e) { console.error('renderGoldSection failed:', e); }
  try { initNpsTab(); } catch (e) { console.error('initNpsTab failed:', e); }
  // Destroy existing charts before re-creating
  if (window.pfGrowthChart) window.pfGrowthChart.destroy();
  if (window.ppfGrowthChart) window.ppfGrowthChart.destroy();

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

  // Use the LIVE gold valuation (Σ qty×ltp of SGB tranches + GOLDBEES) that the
  // main KPI card shows, not the raw breakup column. When no month has closed
  // since the frozen base, breakup's last Gold value is still the base-date
  // snapshot — reading it here made this sub-card disagree with the main KPI
  // (e.g. 5.32 vs the live 5.09). portfolioSummary.gold_lakhs is kept current by
  // recomputePortfolioFromLiveData on every price refresh.
  const goldCurrent = (portfolioSummary && portfolioSummary.gold_lakhs != null)
    ? portfolioSummary.gold_lakhs
    : (nw['Gold (Gold)']?.values?.slice(-1)?.[0] || 0);
  const goldGain = getMonthlyChangeLakhs('Gold (Gold)');
  document.getElementById('fi-gold-value').innerText = formatLakhs(goldCurrent);
  document.getElementById('fi-gold-gain').innerText = (goldGain >= 0 ? '+' : '') + goldGain.toFixed(2) + ' L';
  document.getElementById('fi-gold-gain').className = goldGain >= 0 ? 'trend-up' : 'trend-down';

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
  // Only canonical month-end snapshots (breakup dates) drive this time series.
  // Post-base transaction snapshots appended by the ledger must be excluded,
  // otherwise adding a transaction injects a spurious intra-month bar.
  const _monthEnds = new Set(breakupSummary.dates || []);
  const allStockDates = new Set();
  Object.values(stockHistory).forEach(stock => {
    stock.history.forEach(h => {
      if (h.date >= '2020-01-01' && _monthEnds.has(h.date)) allStockDates.add(h.date);
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

  // ── Continuity scaling ──────────────────────────────────────────────────
  // The per-stock history under-covers early months: pre-Aug-2022 workbook
  // fragments only captured ~45% of the true equity value, jumping to ~76%+
  // afterwards. Rendered raw, the stacked bars jump at Aug 2022 even though the
  // real portfolio grew smoothly. Scale each date's per-stock sums so the stacked
  // total matches the authoritative breakup "Stocks (Equity)" value, preserving the
  // sector/cap PROPORTIONS from whatever holdings are tracked. dateScale[d] is
  // reused by the Market Cap chart below so both stay consistent.
  const _bsStockVals = (breakupSummary.net_worth?.['Stocks (Equity)']?.values) || [];
  const breakupStockRs = {};
  (breakupSummary.dates || []).forEach((d, i) => { breakupStockRs[d] = (_bsStockVals[i] || 0) * 100000; });
  // Coverage guard: if a date's tracked holdings capture under 25% of the
  // authoritative breakup value, the proportions are meaningless and the scale
  // factor would blow a sliver up to the full bar (a partial month once rendered
  // one ETF as the entire equity book). Drop such dates from the time axis.
  for (let i = sortedStockDates.length - 1; i >= 0; i--) {
    const d = sortedStockDates[i];
    const raw = Object.values(dateSectorMap[d]).reduce((s, v) => s + v, 0);
    const target = breakupStockRs[d];
    if (target > 0 && raw < 0.25 * target) {
      sortedStockDates.splice(i, 1);
      delete dateSectorMap[d];
    }
  }
  const dateScale = {};
  sortedStockDates.forEach(date => {
    const rawTotal = Object.values(dateSectorMap[date]).reduce((s, v) => s + v, 0);
    const target = breakupStockRs[date];
    // Only scale when we have both a positive raw total and an authoritative target.
    dateScale[date] = (rawTotal > 0 && target > 0) ? target / rawTotal : 1;
    if (dateScale[date] !== 1) {
      Object.keys(dateSectorMap[date]).forEach(sec => { dateSectorMap[date][sec] *= dateScale[date]; });
    }
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
      // Scale value to the authoritative breakup total (same factor as the sector
      // chart) so the rawValue tooltips are continuous across the Aug-2022 coverage
      // change. Percentages are unaffected (a per-date constant cancels in the ratio);
      // count stays the real number of tracked stocks.
      dateCapMap[date][cap].value += entry.cur_val * (dateScale[date] || 1);
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

  // Populate Table - default sort by Valuation (col 6) descending
  stockSortColumn = 6;
  stockSortAsc = false;
  const stockThs = document.querySelectorAll('#stocks-table th');
  stockThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === 6) th.classList.add('sort-desc');
  });
  const sortedStocks = [...latestEquity].sort((a, b) => (b.cur_val ?? 0) - (a.cur_val ?? 0));
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
          <th style="text-align:right;" title="Sale proceeds (qty sold × sale price) — hover a value for the realized P&amp;L">Realized (₹)</th>
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
        // `cf` (set only on not-yet-closed ledger replay snapshots — see
        // rebuildHoldingHistoryFromLedger) is the transaction's OWN recorded
        // sale price × qty. Pass it through so realized value doesn't have to
        // fall back to the snapshot's `ltp`, which for an unclosed period is
        // just today's live price, not the historical price the sale actually
        // happened at.
        deltaRows.push({ date: h.date, dQty, qty: h.qty, price: h.ltp, dInv, cf: h.cf, action: dQty > 0 ? 'Buy' : 'Sell' });
      }
    }
  }
  tbody.innerHTML = deltaRows.map(r => {
    const isBuy = r.action === 'Buy';
    const isSell = r.action === 'Sell';
    const aStyle = isBuy ? 'background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)' : 'background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3)';
    // Δ Invested only shows the COST BASIS removed on a sale, not what the
    // position was actually sold for — there was previously no way to see the
    // realized value from this panel. Realized = qty sold × sale price;
    // hovering shows the realized P&L (proceeds vs the cost basis removed).
    let realizedCell = '<span style="color:var(--text-muted);">—</span>';
    if (isSell) {
      // Prefer the exact recorded sale proceeds (`cf`); only approximate from
      // qty × snapshot price if this row predates that tracking (pre-existing
      // Excel-era / already-closed history).
      const proceeds = typeof r.cf === 'number' ? r.cf : Math.abs(r.dQty) * r.price;
      const costRemoved = Math.abs(r.dInv);
      const realizedPnl = proceeds - costRemoved;
      const pnlCls = realizedPnl >= 0 ? 'trend-up' : 'trend-down';
      realizedCell = `<span class="${pnlCls}" title="Realized P&amp;L: ${realizedPnl >= 0 ? '+' : '−'}${formatINR(Math.abs(realizedPnl))}">${formatINR(proceeds)}</span>`;
    }
    return `<tr>
      <td style="white-space:nowrap;">${formatDateString(r.date)}</td>
      <td><span class="history-action-tag" style="${aStyle}">${r.action}</span></td>
      <td style="text-align:right;" class="${r.dQty > 0 ? 'trend-up' : 'trend-down'}">${r.dQty > 0 ? '+' : ''}${r.dQty.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;">${r.qty.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;">₹${r.price.toLocaleString(undefined,{maximumFractionDigits:pricePrecision})}</td>
      <td style="text-align:right;" class="${r.dInv >= 0 ? 'trend-up' : 'trend-down'}">${r.dInv >= 0 ? '+' : '−'}${formatINR(Math.abs(r.dInv))}</td>
      <td style="text-align:right;">${realizedCell}</td>
    </tr>`;
  }).join('');
}

function renderStocksTable(data) {
  const body = document.getElementById('stocks-table-body');
  body.innerHTML = data.map(s => {
    const divYield = dividendYieldPct(s);
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
      <td style="text-align: right;">${divYield == null ? '—' : divYield.toFixed(2) + '%'}</td>
      <td style="text-align: right;">${escapeHtml(formatPriceAsOf(s.priceAsOf))}</td>
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

// Re-render the stocks table with the CURRENT filter + sort, without touching
// charts or resetting user state. Used after a live price refresh so the
// visible numbers update even when the user is sitting on the Stocks tab.
function reapplyStocksView() {
  if (!latestEquity) return;
  const query = (document.getElementById('stock-search')?.value || '').toLowerCase().trim();
  const sector = document.getElementById('stock-sector-filter')?.value || 'ALL';
  const filtered = latestEquity.filter(s => {
    const mq = s.instrument.toLowerCase().includes(query) || s.sector.toLowerCase().includes(query);
    const ms = (sector === 'ALL') || (s.sector === sector);
    return mq && ms;
  });
  if (stockSortColumn >= 0) {
    const val = (s) => {
      switch (stockSortColumn) {
        case 0: return s.instrument; case 1: return s.sector; case 2: return s.qty;
        case 3: return s.ltp; case 4: return s.avg_cost;
        case 5: return s.invested; case 6: return s.cur_val; case 7: return s.pnl;
        case 8: return s.gain_pct; case 9: return holdingXIRR(s, 'stock') ?? -Infinity;
        case 10: return dividendYieldPct(s) ?? -Infinity; case 11: return s.priceAsOf ?? -Infinity;
        default: return s.instrument;
      }
    };
    filtered.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string') return stockSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return stockSortAsc ? va - vb : vb - va;
    });
  }
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
      case 4: valA = a.avg_cost; valB = b.avg_cost; break;
      case 5: valA = a.invested; valB = b.invested; break;
      case 6: valA = a.cur_val; valB = b.cur_val; break;
      case 7: valA = a.pnl; valB = b.pnl; break;
      case 8: valA = a.gain_pct; valB = b.gain_pct; break;
      case 9: valA = holdingXIRR(a, 'stock') ?? -Infinity; valB = holdingXIRR(b, 'stock') ?? -Infinity; break;
      case 10: valA = dividendYieldPct(a) ?? -Infinity; valB = dividendYieldPct(b) ?? -Infinity; break;
      case 11: valA = a.priceAsOf ?? -Infinity; valB = b.priceAsOf ?? -Infinity; break;
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

  // Only canonical month-end snapshots (breakup dates) drive this time series —
  // exclude post-base transaction snapshots so a new transaction doesn't inject a
  // spurious intra-month bar.
  const _mfMonthEnds = new Set(breakupSummary.dates || []);
  const allMfDates = new Set();
  Object.values(mfHistory).forEach(mf => {
    mf.history.forEach(h => { if (_mfMonthEnds.has(h.date)) allMfDates.add(h.date); });
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

  // Populate table - default sort by Valuation (col 6) descending
  mfSortColumn = 6;
  mfSortAsc = false;
  const mfThs = document.querySelectorAll('#mfs-table th');
  mfThs.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === 6) th.classList.add('sort-desc');
  });
  const sortedMfs = [...latestMf].sort((a, b) => (b.cur_val ?? 0) - (a.cur_val ?? 0));
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
    const xirr = holdingXIRR(f, 'mf');
    const hasHistory = !!historicalHoldings.mfs?.[f.scheme];
    return `
    <tr class="holdings-row"${hasHistory ? ` onclick="toggleMfRowHistory(this,'${escapeAttr(f.scheme)}')" title="Click to view history" style="cursor:pointer;"` : ''}>
      <td class="instrument-cell" title="${escapeAttr(f.scheme)}">${hasHistory ? '<span class="row-expand-icon">▶</span>' : ''}${escapeHtml(f.scheme)}</td>
      <td><span class="category-tag">${escapeHtml(f.scheme_type.replace('Equity : ', ''))}</span></td>
      <td style="text-align: right;">${f.qty.toLocaleString()}</td>
      <td style="text-align: right;">₹${f.price.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
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
      <td style="text-align: right;">${f.navDate ? escapeHtml(f.navDate) : '—'}</td>
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

// ── Real benchmark data (Yahoo Finance monthly series) ────────────────────────
// Fetches actual monthly closes for Nifty 50, Sensex, S&P 500 and Gold, aligns
// them to the portfolio's date spine, and caches for 24 h. If the fetch fails
// the benchmark rows/series simply stay empty (rendered as loading/'—').

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
function computeHoldingXIRR(history, divFlows) {
  if (!history || history.length < 1) return null;
  const cf = [], dt = [];
  let prevInv = 0;
  for (let i = 0; i < history.length; i++) {
    const inv = history[i].invested || 0;
    // Post-base ledger snapshots carry `cf` — the ACTUAL signed cash flow (buy =
    // −amount, sell = +proceeds). Use it directly so realized gains/losses on sells
    // are captured. Pre-base (Excel-era) snapshots have no `cf`, so fall back to the
    // invested-delta approximation (cost-basis), which is the best available there.
    if (typeof history[i].cf === 'number') {
      if (Math.abs(history[i].cf) > 1) {
        cf.push(history[i].cf);
        dt.push(new Date(history[i].date));
      }
    } else {
      const delta = inv - prevInv;
      if (Math.abs(delta) > 1) {           // ignore sub-₹1 rounding noise
        cf.push(-delta);
        dt.push(new Date(history[i].date));
      }
    }
    prevInv = inv;
  }
  // Dividend receipts are positive cash inflows at their pay dates (total return).
  if (divFlows && divFlows.length) {
    for (const d of divFlows) {
      if (d.amount > 0) { cf.push(d.amount); dt.push(new Date(d.date)); }
    }
  }
  const last = history[history.length - 1];
  const terminal = last.cur_val || 0;
  if (terminal !== 0) {
    cf.push(terminal);
    dt.push(new Date(last.date));
  }
  return computeXIRR(cf, dt);
}

// ── Dividend index (from transaction_history.json) ──────────────────────────
// { ticker: { flows:[{date,amount}], total, ttm } }. TTM = trailing 12 months
// of available dividend data (the source ends ~2026-05, so we anchor the window
// to each ticker's last dividend date rather than "today").
let _divIndex = null;
function _buildDividendIndex() {
  if (_divIndex) return _divIndex;
  _divIndex = {};
  const flows = (typeof transactionHistory !== 'undefined' && transactionHistory?.xirr_flows) || [];
  for (const f of flows) {
    if (f.type !== 'dividend' || !(f.amount > 0)) continue;
    const e = _divIndex[f.ticker] || (_divIndex[f.ticker] = { flows: [], total: 0, ttm: 0 });
    e.flows.push({ date: f.date, amount: f.amount });
    e.total += f.amount;
  }
  // Compute TTM per ticker anchored to its latest dividend date.
  Object.values(_divIndex).forEach(e => {
    e.flows.sort((a, b) => a.date.localeCompare(b.date));
    const last = e.flows[e.flows.length - 1].date;
    const cut = new Date(last); cut.setFullYear(cut.getFullYear() - 1);
    const cutStr = localDateStr(cut);
    e.ttm = e.flows.filter(f => f.date >= cutStr).reduce((s, f) => s + f.amount, 0);
  });
  return _divIndex;
}

// Trailing-12-month dividend yield % for a stock holding, or null if unknown.
function dividendYieldPct(s) {
  if (!s || !s.cur_val) return null;
  const e = _buildDividendIndex()[s.instrument];
  if (!e || e.ttm <= 0) return null;
  return (e.ttm / s.cur_val) * 100;
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
  const divFlows = (type === 'stock') ? (_buildDividendIndex()[obj.instrument]?.flows || null) : null;
  obj._xirr = computeHoldingXIRR(history, divFlows);
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
      xirr:     computePortfolioXirr() ?? (totalXirrKey ? lastNonZero(xirrSec[totalXirrKey].values) : null),
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
  const allDates = breakupSummary.dates;

  // Which slice of the portfolio to compare: Stocks, Mutual Funds, or both combined.
  // (Combined = Stocks + MFs equity — the tradeable portfolio comparable to the
  // equity benchmarks, not the whole net worth which includes debt/NPS/gold.)
  const compSel = document.getElementById('benchmark-component');
  const comp = compSel ? compSel.value : 'combined';
  const _nwSt = breakupSummary.net_worth['Stocks (Equity)'].values;
  const _niSt = breakupSummary.new_investment['Stocks (Equity)'].values;
  const _nwMf = breakupSummary.net_worth['Mutual Funds (Equity)'].values;
  const _niMf = breakupSummary.new_investment['Mutual Funds (Equity)'].values;
  let nwTotal, newMoneyTotal, portLabel;
  if (comp === 'stocks') {
    nwTotal = _nwSt; newMoneyTotal = _niSt; portLabel = 'Stocks';
  } else if (comp === 'mfs') {
    nwTotal = _nwMf; newMoneyTotal = _niMf; portLabel = 'Mutual Funds';
  } else if (comp === 'total') {
    nwTotal = breakupSummary.net_worth['Total'].values;
    newMoneyTotal = breakupSummary.new_investment['Total Investment'].values;
    portLabel = 'Total Portfolio';
  } else {
    nwTotal = _nwSt.map((v, i) => (v || 0) + (_nwMf[i] || 0));
    newMoneyTotal = _niSt.map((v, i) => (v || 0) + (_niMf[i] || 0));
    portLabel = 'Stocks + MFs';
  }

  // Time window comes from the common tab filter. Both portfolio and benchmark are
  // sliced to it and RE-INDEXED to 100 at the window start, so the comparison reflects
  // the chosen period rather than always since inception.
  const startIdx = growthSliceIdx();
  const dates = allDates.slice(startIdx);

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
  // Uses computeTWRIndex() so fresh cash inflows don't distort the line. Computed over
  // the full series (TWR is cumulative), then sliced + re-normalised to 100 at the
  // window start for the selected period.
  const twrIdxFull = computeTWRIndex(nwTotal, newMoneyTotal);
  const twrIdx = twrIdxFull.slice(startIdx);
  const portfolioNormalized = twrIdx.map(v => (v / twrIdx[0]) * 100);

  // Slice + re-normalise benchmark to start at 100 at the window start.
  const benchHist = (benchmark.history || []).slice(startIdx);
  const benchBase = benchHist.length ? benchHist[0].value : 1;
  const benchmarkNormalized = benchHist.map(h => (h.value / benchBase) * 100);

  benchmarkComparisonChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: portLabel,
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
  
  // TWR index needs the full series (12-month lookback); only the DISPLAY is limited
  // to the common time-filter window.
  const twrIdx = computeTWRIndex(nwTotal, newMoneyTotal);
  const startI = Math.max(12, growthSliceIdx());
  for (let i = startI; i < nwTotal.length; i++) {
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
    if (gran === 'M')   return d.slice(0, 7); // YYYY-MM (one bucket per month)
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
  _patchCurrentBucketFromLedger(buckets, gran, bucketOf);
  return buckets;
}

// The last (current, still-open) bucket sources newInv/deltaNW purely from
// breakupSummary — which only reflects whatever was folded in at the LAST Close
// Period. A close dated e.g. "2026-07-01" bakes in everything since the PREVIOUS
// close (i.e. all of June, however it happens to be dated), then that single data
// point gets bucketed as "2026-07" — so the "current month" bucket shows last
// month's closed activity, not this month's, and never reflects transactions
// entered since that close (dated after it) at all. Recompute the current bucket
// directly from the live ledger + live net worth, calendar-aligned to today,
// instead of trusting the breakup aggregate for the still-open period.
function _patchCurrentBucketFromLedger(buckets, gran, bucketOf) {
  if (!buckets.length) return;
  const today = new Date();
  const todayStr = localDateStr(today);
  const last = buckets[buckets.length - 1];
  if (bucketOf(todayStr) !== last.label) return; // last bucket isn't "now" — leave it alone

  const y = today.getFullYear(), m = today.getMonth();
  const periodStart = gran === 'Q' ? new Date(y, Math.floor(m / 3) * 3, 1)
    : gran === 'H' ? new Date(y, m < 6 ? 0 : 6, 1)
    : gran === 'Y' ? new Date(y, 0, 1)
    : new Date(y, m, 1); // 'M' and default
  const periodStartStr = localDateStr(periodStart);

  let liveNewInvRupees = 0;
  (typeof transactions !== 'undefined' ? transactions : []).forEach(t => {
    if (t.date < periodStartStr || t.date > todayStr) return;
    liveNewInvRupees += t.type === 'sell' ? -t.amount : t.amount;
  });
  (typeof balances !== 'undefined' ? balances : []).forEach(b => {
    if (b.date < periodStartStr || b.date > todayStr) return;
    liveNewInvRupees += b.contribution || 0;
  });
  const newInv = liveNewInvRupees / 100000; // rupees → lakhs, matching breakupSummary units

  // Opening NW = last CLOSED net worth strictly before this calendar period started.
  const dates = breakupSummary.dates;
  const nwVals = breakupSummary.net_worth['Total'].values;
  let openNW = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] < periodStartStr) { openNW = nwVals[i]; break; }
  }
  if (openNW == null) openNW = last.openNW; // no earlier close found — fall back
  const closeNW = (typeof portfolioSummary !== 'undefined' && portfolioSummary?.total_net_worth_lakhs != null)
    ? portfolioSummary.total_net_worth_lakhs : last.closeNW;

  last.openNW = openNW;
  last.closeNW = closeNW;
  last.deltaNW = closeNW - openNW;
  last.newInv = newInv;
  last.mktRet = last.deltaNW - newInv;
  last.deltaNWPct = openNW ? (last.deltaNW / openNW) * 100 : 0;
  last.mktRetPct = openNW ? (last.mktRet / openNW) * 100 : 0;
  last.isPartial = true;
}

function _buildComparisons(buckets, gran) {
  const n   = buckets.length;
  if (n < 1) return [];
  const cur = buckets[n - 1];
  const pairs = [];

  // Current vs Previous period (CM vs LM / CQ vs LQ / CH vs LH / CY vs LY)
  const prevLabels = { M: 'LM', Q: 'LQ', H: 'LH', Y: 'LY', MAT: 'Prev MAT' };
  const curLabels  = { M: 'CM', Q: 'CQ', H: 'CH', Y: 'CYTD', MAT: 'MAT' };
  if (n >= 2) {
    pairs.push({ label: `${curLabels[gran]} vs ${prevLabels[gran]}`, a: cur, aLbl: curLabels[gran], b: buckets[n - 2], bLbl: prevLabels[gran] });
  }

  // Monthly: current month vs same month last year (labels are YYYY-MM).
  if (gran === 'M') {
    const curMonth = cur.label.slice(5, 7);
    const lyMatch = buckets.slice(0, n - 1).filter(b => b.label.slice(5, 7) === curMonth);
    if (lyMatch.length) {
      const lyc = lyMatch[lyMatch.length - 1];
      pairs.push({ label: 'CM vs LYCM', a: cur, aLbl: 'CM', b: lyc, bLbl: 'LYCM' });
    }
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
  syncAllSegThumbs();

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
  // Stacked bars: each period's bar is composed of New Investment (capital added)
  // + Returns (market gain/loss). Positive returns stack green above the New
  // Investment; negative returns drop below the zero line in red so loss periods
  // stand out at a glance. A thin line traces the net NW change.
  periodicPerfChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'New Investment (₹ L)', data: newInvL, stack: 'nw',
          backgroundColor: 'rgba(99,102,241,0.75)', borderColor: '#6366f1', borderWidth: 1,
          categoryPercentage: 0.7, barPercentage: 0.9, order: 2 },
        { label: 'Returns (₹ L)', data: mktRet, stack: 'nw',
          backgroundColor: (c) => (c.raw >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.9)'),
          borderColor: (c) => (c.raw >= 0 ? '#10b981' : '#ef4444'), borderWidth: 1,
          categoryPercentage: 0.7, barPercentage: 0.9, order: 2 },
        { label: 'Net NW Change (₹ L)', data: nwChange, type: 'line',
          borderColor: '#e5e7eb', backgroundColor: '#e5e7eb', borderWidth: 1.5,
          pointRadius: 2.5, pointBackgroundColor: '#e5e7eb', tension: 0.2, order: 1 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { color: '#9ca3af', boxWidth: 14, usePointStyle: true, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => ` ${c.dataset.label}: ${c.parsed.y >= 0 ? '+' : '−'}₹${Math.abs(c.parsed.y).toFixed(2)} L`,
          }
        }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#9ca3af', maxRotation: 45 } },
        y: { stacked: true, grid: { color: 'rgba(255,255,255,0.04)' },
             // emphasise the zero line so negative bars are unmistakable
             border: { color: 'rgba(255,255,255,0.25)' },
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
// Format a market-data timestamp (epoch ms) as an IST date+time — this is the
// date the price actually belongs to (e.g. last session's close), distinct from
// when the refresh ran.
function formatPriceAsOf(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// Parse an mfapi NAV date (DD-MM-YYYY) to epoch ms for sorting; -Infinity if absent.
function _mfNavDateMs(navDate) {
  if (!navDate) return -Infinity;
  const [d, mo, y] = String(navDate).split('-').map(Number);
  const t = new Date(y, (mo || 1) - 1, d || 1).getTime();
  return isNaN(t) ? -Infinity : t;
}

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

  // ── Per-Stock / Per-MF detail tables (sortable — populated below) ──
  if (report.stockDetails && report.stockDetails.length > 0) {
    html += '<h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem;">📈 Stock Refresh Details</h3>';
    html += '<div id="ul-stock-table"></div>';
  }
  if (report.mfDetails && report.mfDetails.length > 0) {
    html += '<h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem;">📊 Mutual Fund NAV Details</h3>';
    html += '<div id="ul-mf-table"></div>';
  }

  container.innerHTML = html;
  renderUlStockTable();
  renderUlMfTable();
}

// ── Sortable Update Log detail tables ──────────────────────────────────────
let _ulStockSort = { col: 0, asc: true };
let _ulMfSort = { col: 0, asc: true };

function _ulChangePct(price, base) {
  return (price != null && base != null && base > 0) ? (price - base) / base * 100 : null;
}
function _ulSortIndicator(state, col) {
  return state.col === col ? (state.asc ? ' ▲' : ' ▼') : '';
}
// Build a sortable table: headers[], rows sorted by keyFns[col], rendered by rowFn.
function _ulRenderSortable(rows, headers, keyFns, state, sortFnName, rowFn) {
  const { col, asc } = state;
  const kf = keyFns[col] || (() => '');
  const sorted = rows.slice().sort((a, b) => {
    const va = kf(a), vb = kf(b);
    const r = (typeof va === 'string' || typeof vb === 'string')
      ? String(va).localeCompare(String(vb)) : (va - vb);
    return asc ? r : -r;
  });
  let h = '<div class="table-wrapper"><table class="update-log-table"><thead><tr>';
  headers.forEach((label, i) => {
    h += `<th class="sortable-th" onclick="${sortFnName}(${i})">${escapeHtml(label)}${_ulSortIndicator(state, i)}</th>`;
  });
  h += '</tr></thead><tbody>';
  sorted.forEach(r => { h += rowFn(r); });
  h += '</tbody></table></div>';
  return h;
}

function renderUlStockTable() {
  const el = document.getElementById('ul-stock-table');
  const report = window.lastRefreshReport || lastRefreshReport;
  if (!el || !report || !report.stockDetails) return;
  const headers = ['Instrument', 'Status', 'Price (₹)', 'Price As Of', 'Prev Close (₹)', 'Change %', 'Error'];
  const keyFns = [
    s => s.instrument || '', s => s.status || '', s => s.price ?? -Infinity, s => s.asOf ?? -Infinity,
    s => s.prevClose ?? -Infinity, s => _ulChangePct(s.price, s.prevClose) ?? -Infinity, s => s.error || '',
  ];
  const rowFn = (s) => {
    const statusClass = s.status === 'success' ? 'status-ok' : s.status === 'stale' ? 'status-stale' : (s.status === 'skipped' || s.status === 'stable') ? 'status-skip' : 'status-fail';
    const statusText = s.status === 'success' ? '✅ OK' : s.status === 'stale' ? '⚠️ Stale' : s.status === 'stable' ? '🔒 Stable' : s.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
    const price = s.price != null ? s.price.toFixed(2) : '—';
    const priceAsOf = escapeHtml(formatPriceAsOf(s.asOf));
    const prevClose = s.prevClose != null ? s.prevClose.toFixed(2) : '—';
    const chg = _ulChangePct(s.price, s.prevClose);
    const changePctCell = chg != null
      ? `<td class="${chg >= 0 ? 'change-up' : 'change-down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</td>` : '<td>—</td>';
    const error = s.error ? escapeHtml(s.error) : '—';
    return `<tr class="${statusClass}"><td>${escapeHtml(s.instrument)}</td><td>${statusText}</td><td>${price}</td><td>${priceAsOf}</td><td>${prevClose}</td>${changePctCell}<td class="error-cell">${error}</td></tr>`;
  };
  el.innerHTML = _ulRenderSortable(report.stockDetails, headers, keyFns, _ulStockSort, 'sortUlStock', rowFn);
}

function renderUlMfTable() {
  const el = document.getElementById('ul-mf-table');
  const report = window.lastRefreshReport || lastRefreshReport;
  if (!el || !report || !report.mfDetails) return;
  const headers = ['Scheme', 'Status', 'NAV (₹)', 'NAV Date', 'Prev NAV (₹)', 'Change %', 'Error'];
  const navKey = m => _mfNavDateMs(m.navDate); // chronological (mfapi gives DD-MM-YYYY)
  const keyFns = [
    m => m.scheme || '', m => m.status || '', m => m.nav ?? -Infinity, navKey,
    m => m.prevNav ?? -Infinity, m => _ulChangePct(m.nav, m.prevNav) ?? -Infinity, m => m.error || '',
  ];
  const rowFn = (m) => {
    const statusClass = m.status === 'success' ? 'status-ok' : m.status === 'stale' ? 'status-stale' : m.status === 'skipped' ? 'status-skip' : 'status-fail';
    const statusText = m.status === 'success' ? '✅ OK' : m.status === 'stale' ? '⚠️ Stale' : m.status === 'skipped' ? '⏭️ Skipped' : '❌ Failed';
    const nav = m.nav != null ? m.nav.toFixed(4) : '—';
    const navDate = m.navDate ? escapeHtml(m.navDate) : '—';
    const prevNav = m.prevNav != null ? m.prevNav.toFixed(4) : '—';
    const chg = _ulChangePct(m.nav, m.prevNav);
    const changePctCell = chg != null
      ? `<td class="${chg >= 0 ? 'change-up' : 'change-down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</td>` : '<td>—</td>';
    const error = m.error ? escapeHtml(m.error) : '—';
    return `<tr class="${statusClass}"><td>${escapeHtml(m.scheme)}</td><td>${statusText}</td><td>${nav}</td><td>${navDate}</td><td>${prevNav}</td>${changePctCell}<td class="error-cell">${error}</td></tr>`;
  };
  el.innerHTML = _ulRenderSortable(report.mfDetails, headers, keyFns, _ulMfSort, 'sortUlMf', rowFn);
}

function sortUlStock(col) {
  if (_ulStockSort.col === col) _ulStockSort.asc = !_ulStockSort.asc;
  else { _ulStockSort.col = col; _ulStockSort.asc = true; }
  renderUlStockTable();
}
function sortUlMf(col) {
  if (_ulMfSort.col === col) _ulMfSort.asc = !_ulMfSort.asc;
  else { _ulMfSort.col = col; _ulMfSort.asc = true; }
  renderUlMfTable();
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
  // Chart removed — superseded by the Monthly tab in Periodic Performance.
  if (!document.getElementById('monthly-change-chart')) return;
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
        
        const [monthTxt, yearTxt] = m.label.split(' ');
        return `
          <div class="heatmap-cell ${selectedClass}" style="background: ${color}"
               onclick="selectHeatmapRange(${m.index})"
               title="${m.label}: ${change >= 0 ? '+' : ''}${change.toFixed(1)}% — Click to select range">
            <div class="heatmap-year">${yearTxt || ''}</div>
            <div class="heatmap-month">${monthTxt}</div>
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
  // Chart removed — superseded by the Monthly tab in Periodic Performance.
  if (!document.getElementById('monthly-activity-chart')) return;
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

// Trading Activity Log filter state (type + coarse asset category) and the last
// rendered date range, so a filter change re-renders without losing the range.
let _tradingTypeFilter = 'ALL';
let _tradingCatFilter = 'ALL';
let _tradingLastStart = 0, _tradingLastEnd = null;

function setTradingFilter() {
  _tradingTypeFilter = document.getElementById('trading-type-filter')?.value || 'ALL';
  _tradingCatFilter = document.getElementById('trading-cat-filter')?.value || 'ALL';
  renderTradingActivityLog(0, _tradingLastStart, _tradingLastEnd);
}

// Generate Trading Activity Log
function renderTradingActivityLog(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;

  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = dates.length - 1;
  _tradingLastStart = startIndex; _tradingLastEnd = endIndex;
  
  const trades = [];

  // The ledger (transactions[]/balances[]) is the source of truth for anything
  // it covers — so historical snapshot-diffing is only used for the PURE
  // pre-ledger era (Excel-imported months with no corresponding ledger entry).
  // Anything from the ledger's earliest entry onward is shown as an individual,
  // editable row further below instead of a coarser per-period aggregate — this
  // is what lets the log double as the (now-merged) Ledger view.
  const _ledgerDates = [
    ...(typeof transactions !== 'undefined' ? transactions.map(t => t.date) : []),
    ...(typeof balances !== 'undefined' ? balances.map(b => b.date) : []),
  ];
  const ledgerEraStart = _ledgerDates.length ? _ledgerDates.reduce((a, b) => a < b ? a : b) : null;

  // Historical (pre-ledger) stock/MF buys & sells, derived from monthly snapshot deltas.
  const stockHistory = historicalHoldings.stocks;
  const mfHistory = historicalHoldings.mfs;

  Object.keys(stockHistory).forEach(symbol => {
    const stock = stockHistory[symbol];
    const history = stock.history;
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if (ledgerEraStart && curr.date >= ledgerEraStart) continue; // covered by individual ledger rows below
      if (curr.invested > prev.invested) {
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date, instrument: symbol, type: 'BUY',
            quantity: qty, price: curr.ltp, total: curr.invested - prev.invested,
            category: stock.sector || 'Equity', closed: true,
          });
        }
      }
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        trades.push({
          date: curr.date, instrument: symbol, type: 'SELL',
          quantity: sellQty, price: curr.ltp, total: sellQty * curr.ltp,
          category: stock.sector || 'Equity', closed: true,
        });
      }
    }
  });

  Object.keys(mfHistory).forEach(scheme => {
    const mf = mfHistory[scheme];
    const history = mf.history;
    const label = scheme.length > 30 ? scheme.substring(0, 30) + '...' : scheme;
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if (ledgerEraStart && curr.date >= ledgerEraStart) continue;
      if (curr.invested > prev.invested) {
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date, instrument: label, type: 'BUY',
            quantity: qty, price: curr.ltp, total: curr.invested - prev.invested,
            category: 'Mutual Fund', closed: true,
          });
        }
      }
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        trades.push({
          date: curr.date, instrument: label, type: 'SELL',
          quantity: sellQty, price: curr.ltp, total: sellQty * curr.ltp,
          category: 'Mutual Fund', closed: true,
        });
      }
    }
  });

  // Historical (pre-ledger) contributions for non-tradeable components (Gold,
  // NPS, PF, PPF, Bonds, Cash, Crypto), from the breakup new_investment series.
  const COMP_META = {
    'Gold (Gold)':        { label: 'Gold',   category: 'Gold',      assetCategory: 'Gold' },
    'NPS E (Equity)':     { label: 'NPS E',  category: 'Equity',    assetCategory: 'NPS' },
    'NPS C (Debt)':       { label: 'NPS C',  category: 'Debt',      assetCategory: 'NPS' },
    'NPS G (Debt)':       { label: 'NPS G',  category: 'Debt',      assetCategory: 'NPS' },
    'PF (Debt)':          { label: 'PF',     category: 'Debt',      assetCategory: 'PF' },
    'PPF (Debt)':         { label: 'PPF',    category: 'Debt',      assetCategory: 'PPF' },
    'Bonds (Debt)':       { label: 'Bonds',  category: 'Debt',      assetCategory: 'Bonds' },
    'Cash (Liquid)':      { label: 'Cash',   category: 'Liquid',    assetCategory: 'Cash' },
    'Crypto (Alternate)': { label: 'Crypto', category: 'Alternate', assetCategory: 'Crypto' },
  };
  const niSec = breakupSummary.new_investment || {};
  Object.entries(COMP_META).forEach(([key, meta]) => {
    const vals = niSec[key]?.values;
    if (!vals) return;
    vals.forEach((v, i) => {
      if (!v) return;
      if (ledgerEraStart && dates[i] >= ledgerEraStart) return; // covered by individual ledger rows below
      trades.push({
        date: dates[i], instrument: meta.label,
        type: v >= 0 ? 'CONTRIBUTION' : 'WITHDRAWAL',
        quantity: null, price: null, total: Math.abs(v) * 100000,
        category: meta.category, assetCategory: meta.assetCategory, closed: true,
      });
    });
  });

  // ── Every ledger entry, individually — this is what replaces the separate
  // Ledger view. Each row carries its id/kind so it can be edited or deleted
  // right here, plus a live Closed/Pending status. ──
  const _catAcFor = (code) => ({
    cat: /Debt|PF|PPF|Bonds|NPS-C|NPS-G/.test(code) ? 'Debt'
       : /Gold/.test(code) ? 'Gold' : /Cash/.test(code) ? 'Liquid'
       : /Crypto/.test(code) ? 'Alternate' : 'Equity',
    ac: /NPS/.test(code) ? 'NPS' : /PPF/.test(code) ? 'PPF' : /PF/.test(code) ? 'PF'
      : /Bonds/.test(code) ? 'Bonds' : /Gold/.test(code) ? 'Gold'
      : /Cash/.test(code) ? 'Cash' : /Crypto/.test(code) ? 'Crypto' : 'NPS',
  });
  const _fbBaseDateForLog = (typeof frozenBase !== 'undefined' && frozenBase) ? frozenBase.baseDate : null;

  (typeof transactions !== 'undefined' ? transactions : []).forEach(t => {
    const folded = (typeof _isTxnFolded === 'function') ? _isTxnFolded(t, _fbBaseDateForLog) : (t.date <= _fbBaseDateForLog);
    const typeLabel = t.type === 'split' ? 'SPLIT' : t.type === 'bonus' ? 'BONUS' : t.type === 'sell' ? 'SELL' : 'BUY';
    const isMf = t.assetClass === 'mf';
    trades.push({
      date: t.date, instrument: t.instrument, type: typeLabel,
      quantity: t.qty, price: t.price, total: t.amount,
      category: isMf ? 'Mutual Fund' : (t.category || 'Equity'),
      assetCategory: isMf ? 'Mutual Funds' : 'Stocks',
      closed: folded, id: t.id, kind: 'txn',
    });
  });
  (typeof balances !== 'undefined' ? balances : []).forEach(b => {
    const folded = !!(_fbBaseDateForLog && b.date <= _fbBaseDateForLog);
    const { cat, ac } = _catAcFor(b.component);
    const lbl = b.component.replace('-', ' ');
    if (b.contribution) {
      trades.push({
        date: b.date, instrument: lbl,
        type: b.contribution >= 0 ? 'CONTRIBUTION' : 'WITHDRAWAL',
        quantity: null, price: null, total: Math.abs(b.contribution),
        category: cat, assetCategory: ac, closed: folded, id: b.id, kind: 'bal',
      });
    } else {
      // Balance entries with zero contribution (pure value update) still need a
      // row so they're visible/editable — shown as an UPDATE with no amount.
      trades.push({
        date: b.date, instrument: lbl, type: 'UPDATE',
        quantity: null, price: null, total: 0,
        category: cat, assetCategory: ac, closed: folded, id: b.id, kind: 'bal',
      });
    }
  });

  // Monthly Return row per component, per CLOSED period — pure market/interest growth
  // (Net Change − New Investment), straight from breakupSummary.returns. That series
  // already spans every period since the start of tracking (Excel-era history AND
  // every Close Period since), so this covers the full history automatically.
  const RETURN_META = {
    'Stocks (Equity)':    { label: 'Stocks',   category: 'Equity',    assetCategory: 'Stocks' },
    'Mutual Funds (Equity)': { label: 'Mutual Funds', category: 'Equity', assetCategory: 'Mutual Funds' },
    'Gold (Gold)':        { label: 'Gold',     category: 'Gold',      assetCategory: 'Gold' },
    'NPS E (Equity)':     { label: 'NPS E',    category: 'Equity',    assetCategory: 'NPS' },
    'NPS C (Debt)':       { label: 'NPS C',    category: 'Debt',      assetCategory: 'NPS' },
    'NPS G (Debt)':       { label: 'NPS G',    category: 'Debt',      assetCategory: 'NPS' },
    'PF (Debt)':          { label: 'PF',       category: 'Debt',      assetCategory: 'PF' },
    'PPF (Debt)':         { label: 'PPF',      category: 'Debt',      assetCategory: 'PPF' },
    'Bonds (Debt)':       { label: 'Bonds',    category: 'Debt',      assetCategory: 'Bonds' },
    'Cash (Liquid)':      { label: 'Cash',     category: 'Liquid',    assetCategory: 'Cash' },
    'Crypto (Alternate)': { label: 'Crypto',   category: 'Alternate', assetCategory: 'Crypto' },
  };
  const returnsSec = breakupSummary.returns || {};
  Object.entries(RETURN_META).forEach(([key, meta]) => {
    const vals = returnsSec[key]?.values;
    if (!vals) return;
    vals.forEach((v, i) => {
      if (!v) return; // only periods with a nonzero return
      trades.push({
        date: dates[i], instrument: `${meta.label} — Monthly Return`,
        type: 'RETURN', quantity: null, price: null, total: Math.abs(v) * 100000,
        category: meta.category, assetCategory: meta.assetCategory, isLoss: v < 0,
      });
    });
  });

  // Tag existing stock/MF trades with a coarse asset category for filtering.
  trades.forEach(t => {
    if (!t.assetCategory) t.assetCategory = (t.category === 'Mutual Fund') ? 'Mutual Funds' : 'Stocks';
  });

  // Sort by date (newest first)
  trades.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Filter by selected date range. When the latest period is in view, extend the
  // upper bound past the last breakup date so transactions entered this period
  // (not yet captured by a month close) still appear.
  const startDate = dates[startIndex];
  const endDate = (endIndex >= dates.length - 1) ? '9999-12-31' : dates[endIndex];
  let filteredTrades = trades.filter(t => t.date >= startDate && t.date <= endDate);

  // Populate the category filter dropdown from the categories actually present.
  const catSel = document.getElementById('trading-cat-filter');
  if (catSel) {
    const cats = [...new Set(trades.map(t => t.assetCategory))].sort();
    const cur = catSel.value || 'ALL';
    catSel.innerHTML = '<option value="ALL">All Categories</option>' +
      cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
    catSel.value = cats.includes(cur) ? cur : 'ALL';
  }

  // Apply type + category filters.
  if (_tradingTypeFilter !== 'ALL') filteredTrades = filteredTrades.filter(t => t.type === _tradingTypeFilter);
  if (_tradingCatFilter !== 'ALL')  filteredTrades = filteredTrades.filter(t => t.assetCategory === _tradingCatFilter);

  // Render table
  const tbody = document.getElementById('trading-activity-body');
  tbody.innerHTML = filteredTrades.map(trade => {
    const typeClass = trade.type === 'CONTRIBUTION' ? 'buy'
      : trade.type === 'WITHDRAWAL' ? 'sell'
      : trade.type === 'RETURN' ? (trade.isLoss ? 'return-loss' : 'return-gain')
      : trade.type === 'UPDATE' ? 'bal'
      : trade.type.toLowerCase();
    const totalStr = trade.type === 'RETURN'
      ? `${trade.isLoss ? '-' : '+'}${formatINR(trade.total)}`
      : (trade.total ? formatINR(trade.total) : '—');
    const statusBadge = trade.closed
      ? '<span class="ledger-status closed" title="Already baked into the last Close Period">🔒 Closed</span>'
      : (trade.id
        ? '<span class="ledger-status pending" title="Not yet folded into a Close Period — counts in the current live total">🟢 Pending</span>'
        : '');
    const actions = trade.id
      ? `<button class="ledger-btn" onclick="${trade.kind === 'txn' ? 'editTxn' : 'editBal'}('${trade.id}')">✏️</button>
         <button class="ledger-btn" onclick="${trade.kind === 'txn' ? 'removeTxn' : 'removeBal'}('${trade.id}')">🗑️</button>`
      : '';
    return `
    <tr>
      <td>${formatFullDate(trade.date)}</td>
      <td style="font-weight: 600;">${escapeHtml(trade.instrument)}</td>
      <td>
        <span class="trade-type ${typeClass}">${trade.type}</span>
      </td>
      <td style="text-align: right;">${trade.quantity == null ? '—' : trade.quantity.toLocaleString(undefined, {maximumFractionDigits: 4})}</td>
      <td style="text-align: right;">${trade.price == null ? '—' : '₹' + trade.price.toLocaleString(undefined, {maximumFractionDigits: 2})}</td>
      <td style="text-align: right; font-weight: 600;" class="${trade.type === 'RETURN' ? (trade.isLoss ? 'trend-down' : 'trend-up') : ''}">${totalStr}</td>
      <td><span class="sector-tag">${escapeHtml(trade.category)}</span></td>
      <td>${statusBadge}</td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>
  `;
  }).join('');

  // Show message if no trades
  if (filteredTrades.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          No trading activity found for the selected period
        </td>
      </tr>
    `;
  }
}

// Re-render the MF table with the CURRENT filter + sort (no chart churn), used
// after a live refresh so refreshed NAVs show while the user is on the MF tab.
function reapplyMfsView() {
  if (!latestMf) return;
  const query = (document.getElementById('mf-search')?.value || '').toLowerCase().trim();
  const cat = document.getElementById('mf-type-filter')?.value || 'ALL';
  const filtered = latestMf.filter(f => {
    const mq = f.scheme.toLowerCase().includes(query) || f.scheme_type.toLowerCase().includes(query);
    const mc = (cat === 'ALL') || (f.scheme_type === cat);
    return mq && mc;
  });
  if (mfSortColumn >= 0) {
    const val = (f) => {
      switch (mfSortColumn) {
        case 0: return f.scheme; case 1: return f.scheme_type; case 2: return f.qty;
        case 3: return f.price; case 4: return f.avg_nav;
        case 5: return f.invested; case 6: return f.cur_val; case 7: return f.pnl;
        case 8: return f.gain_pct; case 9: return holdingXIRR(f, 'mf') ?? -Infinity;
        case 10: return _mfNavDateMs(f.navDate);
        default: return f.scheme;
      }
    };
    filtered.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string') return mfSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return mfSortAsc ? va - vb : vb - va;
    });
  }
  renderMfsTable(filtered);
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
      case 4: valA = a.avg_nav; valB = b.avg_nav; break;
      case 5: valA = a.invested; valB = b.invested; break;
      case 6: valA = a.cur_val; valB = b.cur_val; break;
      case 7: valA = a.pnl; valB = b.pnl; break;
      case 8: valA = a.gain_pct; valB = b.gain_pct; break;
      case 9: valA = holdingXIRR(a, 'mf') ?? -Infinity; valB = holdingXIRR(b, 'mf') ?? -Infinity; break;
      case 10: valA = _mfNavDateMs(a.navDate); valB = _mfNavDateMs(b.navDate); break;
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
  const today = localDateStr();
  ['txn-date', 'bal-date', 'close-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = today;
  });
  onTxnAssetClassChange();
  updateBalComputedValue();
}

// ── Handy calculator (Manage Portfolio) — a basic +−×÷ pad for working out
// figures (e.g. NPS contributions, PF interest) while filling the forms above. ──
let _calcExpr = '';
let _calcJustEvaluated = false;

function toggleCalculator() {
  const panel = document.getElementById('calculator-panel');
  if (!panel) return;
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : 'block';
}

function _calcRender() {
  const el = document.getElementById('calc-display');
  if (el) el.value = _calcExpr === '' ? '0' : _calcExpr;
}

function calcInput(ch) {
  const isOp = ['+', '-', '*', '/'].includes(ch);
  if (_calcJustEvaluated) {
    _calcExpr = isOp ? _calcExpr : '';
    _calcJustEvaluated = false;
  }
  if (isOp && (_calcExpr === '' && ch !== '-')) return; // no leading operator (minus allowed for negatives)
  if (isOp && /[+\-*/]$/.test(_calcExpr)) { _calcExpr = _calcExpr.slice(0, -1) + ch; _calcRender(); return; }
  if (ch === '%') {
    // Convert the trailing number to a percentage of itself (e.g. "1000" → "1000*0.01")
    const m = _calcExpr.match(/(\d+\.?\d*)$/);
    if (m) { _calcExpr = _calcExpr.slice(0, -m[1].length) + (parseFloat(m[1]) / 100); _calcRender(); }
    return;
  }
  _calcExpr += ch;
  _calcRender();
}

function calcBackspace() {
  _calcExpr = _calcExpr.slice(0, -1);
  _calcJustEvaluated = false;
  _calcRender();
}

function calcClear() {
  _calcExpr = '';
  _calcJustEvaluated = false;
  _calcRender();
}

function calcEquals() {
  if (!/^[0-9+\-*/.\s]+$/.test(_calcExpr)) return; // only digits/operators — no eval injection
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${_calcExpr})`)();
    if (!isFinite(result)) throw new Error('Invalid result');
    _calcExpr = String(+result.toFixed(6));
  } catch (_) {
    _calcExpr = 'Error';
  }
  _calcJustEvaluated = true;
  _calcRender();
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

function onTxnTypeChange() {
  const type = document.getElementById('txn-type').value;
  const hint = document.getElementById('txn-corporate-hint');
  const isCorporateAction = type === 'split' || type === 'bonus';
  if (hint) hint.style.display = isCorporateAction ? '' : 'none';
  if (isCorporateAction) {
    document.getElementById('txn-price').value = '0';
    document.getElementById('txn-amount').value = '0';
  }
  // Corporate actions carry no price (shares granted for free) — fetching a
  // market quote for them would be meaningless.
  const fetchBtn = document.getElementById('txn-fetch-price-btn');
  if (fetchBtn) fetchBtn.style.display = isCorporateAction ? 'none' : '';
  const exitWrap = document.getElementById('txn-exit-wrap');
  if (exitWrap) {
    exitWrap.style.display = type === 'sell' ? '' : 'none';
    if (type !== 'sell') {
      document.getElementById('txn-exit-all').checked = false;
      _setTxnQtyLocked(false);
    }
  }
}

// Fetch the most recent market price (stock) or NAV (mutual fund) for
// whatever instrument is currently typed into the Add Transaction form —
// works for both an existing holding and a brand-new instrument, since it
// looks the price up directly rather than reading a cached holding. The
// fetched value only PRE-FILLS the price field; it stays fully editable so
// the user can still record their actual buy/sell price if it differed.
async function fetchTxnLatestPrice() {
  const cls = document.getElementById('txn-assetClass').value;
  const name = (document.getElementById('txn-instrument').value || '').trim();
  const btn = document.getElementById('txn-fetch-price-btn');
  const statusEl = document.getElementById('txn-price-status');
  if (!name) {
    if (statusEl) { statusEl.textContent = 'Enter an instrument name first.'; statusEl.className = 'manage-hint trend-down'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  if (statusEl) { statusEl.textContent = 'Fetching latest price…'; statusEl.className = 'manage-hint'; }
  try {
    let price = null, asOf = '';
    if (cls === 'mf') {
      let schemeCode = MF_SCHEME_CODES[name];
      if (schemeCode === null) throw new Error('Price lookups are disabled for this scheme — enter it manually.');
      if (!schemeCode) schemeCode = dynamicMfSchemeCodes[name];
      if (!schemeCode) {
        const searchQuery = name
          .replace(/Direct\s*-?\s*Growth$/i, '')
          .replace(/Fund\s*Direct\s*-?\s*Growth$/i, '')
          .replace(/\s*-\s*/g, ' ')
          .trim();
        const searchResp = await fetchWithFallback(`/api/search-mf-scheme?q=${encodeURIComponent(searchQuery)}`);
        const searchData = await searchResp.json();
        if (searchData.results?.length > 0) {
          const directGrowth = searchData.results.find(r =>
            r.schemeName.toLowerCase().includes('direct') && r.schemeName.toLowerCase().includes('growth'));
          const bestMatch = directGrowth || searchData.results[0];
          schemeCode = bestMatch.schemeCode;
          dynamicMfSchemeCodes[name] = schemeCode;
        }
      }
      if (!schemeCode) throw new Error('Could not find this scheme — check the name or enter the price manually.');
      const resp = await fetchWithFallback(`/api/live-mf-nav/${schemeCode}`);
      if (window.__staticMode) {
        const raw = await resp.json();
        if (raw?.data?.length > 0) { price = parseFloat(raw.data[0].nav); asOf = raw.data[0].date || ''; }
      } else {
        const data = await resp.json();
        price = data?.nav ?? null; asOf = data?.navDate || '';
      }
    } else {
      const canon = (typeof canonicalInstrument === 'function') ? canonicalInstrument(name, 'stock') : name;
      if (isStableDebt(canon)) throw new Error('No live price source for this instrument — enter it manually.');
      if (canon.startsWith('SGB')) {
        // SGB tranches don't trade on Yahoo — their own Groww quote first,
        // falling back to the GOLDBEES×100 gold-per-gram proxy (same
        // hierarchy the bulk price refresh uses).
        try {
          const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${encodeURIComponent(canon)}/latest`;
          const resp = await fetchViaCorsProxy(url, {}, 8000);
          if (resp.ok) {
            const q = await resp.json();
            if (q?.ltp > 0) price = q.ltp;
          }
        } catch (_) { /* fall through to the proxy below */ }
        if (price == null) {
          const { price: fp } = await fetchStockQuote('GOLDBEES', 'yahoo');
          if (fp > 0) price = fp * 100;
        }
      } else {
        const { price: p } = await fetchStockQuote(canon, 'yahoo');
        price = p;
      }
    }
    if (!price || price <= 0) throw new Error('Price not available right now — try again or enter it manually.');
    document.getElementById('txn-price').value = +price.toFixed(4);
    document.getElementById('txn-amount').dataset.touched = ''; // let it recompute from the new price
    onTxnAmountInputs();
    if (statusEl) {
      statusEl.textContent = `Fetched ₹${price.toLocaleString('en-IN', { maximumFractionDigits: 4 })}` +
        (asOf ? ` (as of ${asOf})` : '') + ' — edit if your actual price differs.';
      statusEl.className = 'manage-hint trend-up';
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '⚠️ ' + (e.message || 'Could not fetch price.'); statusEl.className = 'manage-hint trend-down'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Fetch'; }
  }
}

// Current held quantity for the instrument currently typed into the form
// (matched against latestEquity/latestMf, the same live holdings the rest of
// the app reads) — used to auto-fill "Exit full position".
function _currentHeldQty() {
  const cls = document.getElementById('txn-assetClass').value;
  const name = (document.getElementById('txn-instrument').value || '').trim();
  if (!name) return null;
  if (cls === 'mf') {
    const h = (latestMf || []).find(f => f.scheme.toLowerCase() === name.toLowerCase());
    return h ? h.qty : null;
  }
  const canon = (typeof canonicalInstrument === 'function') ? canonicalInstrument(name, 'stock') : name;
  const h = (latestEquity || []).find(s => s.instrument === canon || s.instrument.toLowerCase() === name.toLowerCase());
  return h ? h.qty : null;
}

function _setTxnQtyLocked(locked) {
  const qtyEl = document.getElementById('txn-qty');
  qtyEl.readOnly = locked;
  qtyEl.classList.toggle('manage-computed-input', locked);
}

function onTxnExitAllChange() {
  const checked = document.getElementById('txn-exit-all').checked;
  _setTxnQtyLocked(checked);
  if (checked) _fillExitQty();
}

// Re-fills the locked qty field with the current holding whenever the exit
// checkbox is on and the instrument/asset-class changes — so switching the
// instrument while "exit full position" is checked doesn't leave a stale qty
// from the previously-typed instrument.
function _fillExitQty() {
  if (!document.getElementById('txn-exit-all')?.checked) return;
  const qty = _currentHeldQty();
  const qtyEl = document.getElementById('txn-qty');
  if (qty != null) {
    qtyEl.value = qty;
    onTxnAmountInputs();
  } else {
    qtyEl.value = '';
  }
}

function onTxnAssetClassChange() {
  const cls = document.getElementById('txn-assetClass').value;
  document.getElementById('txn-category-wrap').style.display = cls === 'mf' ? '' : 'none';
  populateInstrumentDatalist();
  onTxnInstrumentChange();
  _fillExitQty();
}

// Auto-derive the MF category from the matched scheme (read-only display) — the
// user never types it. For an existing scheme it comes from the holding's
// scheme_type; for a brand-new scheme it's left blank and resolved later from
// the MF price source.
function onTxnInstrumentChange() {
  // A fetched-price status message refers to whatever instrument was typed
  // when the fetch ran — clear it as soon as the user edits the field again.
  const statusEl = document.getElementById('txn-price-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'manage-hint'; }
  const cls = document.getElementById('txn-assetClass').value;
  const catEl = document.getElementById('txn-category');
  if (!catEl) return;
  if (cls !== 'mf') { catEl.value = ''; return; }
  const name = (document.getElementById('txn-instrument').value || '').trim().toLowerCase();
  const match = (latestMf || []).find(f => f.scheme.toLowerCase() === name);
  catEl.value = match ? (match.scheme_type || '') : '';
  _fillExitQty();
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
  const exitAll = document.getElementById('txn-exit-all')?.checked;
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
  // "Exit full position" re-reads the CURRENT holding qty at submit time
  // rather than trusting the (possibly stale, if prices refreshed since the
  // checkbox was ticked) value already sitting in the field.
  if (exitAll && payload.type === 'sell') {
    const heldQty = _currentHeldQty();
    if (heldQty == null || heldQty <= 0) {
      alert('No current holding found for this instrument — nothing to exit.'); return false;
    }
    payload.qty = heldQty;
    if (!payload.amount && isFinite(payload.price)) payload.amount = +(heldQty * payload.price).toFixed(2);
  }
  const isCorporateAction = payload.type === 'split' || payload.type === 'bonus';
  if (!payload.instrument || !isFinite(payload.qty) || (!isCorporateAction && !isFinite(payload.price))) {
    alert('Instrument and quantity are required.'); return false;
  }
  if (isCorporateAction) { payload.price = 0; payload.amount = 0; }
  if (editId) updateTransaction(editId, payload);
  else addTransaction(payload);
  resetTxnForm();
  refreshAfterLedgerChange();
  return false;
}

function resetTxnForm() {
  const f = document.getElementById('txn-form');
  if (f) f.reset();
  document.getElementById('txn-edit-id').value = '';
  document.getElementById('txn-amount').dataset.touched = '';
  document.getElementById('txn-submit-btn').textContent = 'Add Transaction';
  document.getElementById('txn-cancel-btn').style.display = 'none';
  document.getElementById('txn-date').value = localDateStr();
  _setTxnQtyLocked(false);
  const statusEl = document.getElementById('txn-price-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'manage-hint'; }
  onTxnAssetClassChange();
  onTxnTypeChange();
}

function editTxn(id) {
  const t = (transactions || []).find(x => x.id === id);
  if (!t) return;
  switchTab('manage'); // editing may be triggered from the Transaction Log (Periodic Performance tab)
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
  // Editing shows the transaction's OWN recorded qty — never re-derive it from
  // current holdings, so "exit all" starts unchecked and unlocked.
  const exitCb = document.getElementById('txn-exit-all');
  if (exitCb) exitCb.checked = false;
  _setTxnQtyLocked(false);
  onTxnAssetClassChange();
  onTxnTypeChange();
  document.getElementById('txn-qty').value = t.qty; // onTxnAssetClassChange may have re-triggered _fillExitQty; restore the exact stored qty
  document.getElementById('txn-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeTxn(id) {
  if (!confirm('Delete this transaction?')) return;
  deleteTransaction(id);
  refreshAfterLedgerChange();
}

// Most recent known value for a component strictly before `beforeDate` — the
// last manually entered balance if one exists, else the last closed Breakup
// column (lakhs → rupees). Excludes `excludeId` so editing an entry doesn't
// use itself as its own "previous" value.
function priorBalanceValue(component, beforeDate, excludeId) {
  const meta = (typeof COMPONENT_BREAKUP !== 'undefined') ? COMPONENT_BREAKUP[component] : null;
  const prior = (balances || [])
    .filter(b => b.component === component && b.id !== excludeId && (!beforeDate || b.date < beforeDate))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (prior.length) return prior[prior.length - 1].value;
  const v = meta && breakupSummary?.net_worth?.[meta.key]?.values;
  return (v && v.length) ? v[v.length - 1] * 1e5 : 0;
}

// NPS components ask for Current value directly (from your statement) + Contribution —
// no "interest" concept (NPS is market-linked, not a declared interest rate) and no
// auto-calc, since the statement already tells you the current value.
const NPS_BAL_COMPONENTS = new Set(['NPS-E', 'NPS-C', 'NPS-G']);

// Toggle the form between NPS mode (editable Current value, no interest/auto-calc)
// and the standard mode (auto-computed Current value = previous + contribution + interest).
function updateBalFormMode() {
  const isNps = NPS_BAL_COMPONENTS.has(document.getElementById('bal-component').value);
  document.getElementById('bal-interest-wrap').style.display = isNps ? 'none' : '';
  document.getElementById('bal-prev-wrap').style.display = isNps ? 'none' : '';
  document.getElementById('bal-value-computed-wrap').style.display = isNps ? 'none' : '';
  document.getElementById('bal-value-input-wrap').style.display = isNps ? '' : 'none';
  return isNps;
}

// Lock whichever field the current mode auto-derives while "exit full position"
// is checked: the contribution field for standard components (it's computed to
// zero the balance out), or the current-value field for NPS (set directly to 0).
function _applyBalExitLock(isNps, exitAll) {
  const contribEl = document.getElementById('bal-contribution');
  const valInputEl = document.getElementById('bal-value-input');
  const lockContrib = exitAll && !isNps;
  const lockValue = exitAll && isNps;
  contribEl.readOnly = lockContrib;
  contribEl.classList.toggle('manage-computed-input', lockContrib);
  valInputEl.readOnly = lockValue;
  valInputEl.classList.toggle('manage-computed-input', lockValue);
}

function onBalExitAllChange() {
  updateBalComputedValue();
}

// Recompute the "Current value" field: auto-calculated (previous + contribution +
// interest) for standard components, or read directly from the editable input for NPS.
// When "exit full position" is checked, the whole balance is withdrawn instead —
// the component's current value becomes ₹0 (accrued interest can still be logged
// first; contribution auto-computes to exactly cancel it out).
function updateBalComputedValue() {
  const isNps = updateBalFormMode();
  const exitAll = !!document.getElementById('bal-exit-all')?.checked;
  _applyBalExitLock(isNps, exitAll);
  if (isNps) {
    if (exitAll) {
      document.getElementById('bal-value-input').value = '0';
      document.getElementById('bal-value').value = '0';
      return;
    }
    const entered = parseFloat(document.getElementById('bal-value-input').value);
    document.getElementById('bal-value').value = isFinite(entered) ? entered : '';
    return;
  }
  const component = document.getElementById('bal-component').value;
  const date = document.getElementById('bal-date').value;
  const editId = document.getElementById('bal-edit-id').value;
  const interest = parseFloat(document.getElementById('bal-interest').value) || 0;
  const prevValue = priorBalanceValue(component, date, editId || null);
  const contribEl = document.getElementById('bal-contribution');
  let contribution;
  if (exitAll) {
    contribution = -(prevValue + interest);
    contribEl.value = contribution.toFixed(2);
  } else {
    contribution = parseFloat(contribEl.value) || 0;
  }
  const currentValue = prevValue + contribution + interest;
  document.getElementById('bal-prev-value').textContent = formatINR(prevValue);
  document.getElementById('bal-value-display').textContent = formatINR(currentValue);
  document.getElementById('bal-value').value = currentValue.toFixed(2);
}

function handleBalSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('bal-edit-id').value;
  const isNps = NPS_BAL_COMPONENTS.has(document.getElementById('bal-component').value);
  updateBalComputedValue();
  const payload = {
    component: document.getElementById('bal-component').value,
    date: document.getElementById('bal-date').value,
    value: parseFloat(document.getElementById('bal-value').value),
    contribution: parseFloat(document.getElementById('bal-contribution').value) || 0,
    interest: isNps ? 0 : (parseFloat(document.getElementById('bal-interest').value) || 0),
    note: document.getElementById('bal-note').value.trim(),
  };
  if (!isFinite(payload.value)) { alert('Current value is required.'); return false; }
  if (editId) updateBalance(editId, payload);
  else addBalance(payload);
  resetBalForm();
  refreshAfterLedgerChange();
  return false;
}

function resetBalForm() {
  const f = document.getElementById('bal-form');
  if (f) f.reset();
  document.getElementById('bal-edit-id').value = '';
  document.getElementById('bal-submit-btn').textContent = 'Save Balance';
  document.getElementById('bal-cancel-btn').style.display = 'none';
  document.getElementById('bal-date').value = localDateStr();
  document.getElementById('bal-contribution').value = '0';
  document.getElementById('bal-interest').value = '0';
  document.getElementById('bal-value-input').value = '';
  document.getElementById('bal-exit-all').checked = false;
  updateBalComputedValue();
}

function editBal(id) {
  const b = (balances || []).find(x => x.id === id);
  if (!b) return;
  switchTab('manage'); // editing may be triggered from the Transaction Log (Periodic Performance tab)
  document.getElementById('bal-edit-id').value = b.id;
  document.getElementById('bal-component').value = b.component;
  document.getElementById('bal-date').value = b.date;
  // Editing always shows the entry's OWN recorded numbers — exit-all starts
  // unchecked/unlocked so a past withdrawal's real contribution/value isn't
  // silently re-derived.
  document.getElementById('bal-exit-all').checked = false;
  document.getElementById('bal-contribution').value = b.contribution;
  document.getElementById('bal-interest').value = b.interest || 0;
  document.getElementById('bal-value-input').value = b.value;
  document.getElementById('bal-note').value = b.note || '';
  document.getElementById('bal-submit-btn').textContent = 'Update Balance';
  document.getElementById('bal-cancel-btn').style.display = '';
  updateBalComputedValue();
  document.getElementById('bal-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeBal(id) {
  if (!confirm('Delete this balance entry?')) return;
  deleteBalance(id);
  refreshAfterLedgerChange();
}

// Re-derive holdings from the ledger and re-render every analytics view,
// including Periodic Performance.
function autoCloseMonthIfNeeded() {
  if (!breakupSummary || typeof closeMonth !== 'function') return false;
  const dates = breakupSummary.dates || [];
  if (!dates.length) return false;
  const lastDate = dates[dates.length - 1];
  const now = new Date();
  // Last day of the previous calendar month
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const prevMonthEndStr = localDateStr(prevMonthEnd);
  // Compare year-month only (first 7 chars) so "2026-05-31" and "2026-05-01"
  // are treated as the same closed period — prevents a spurious close when the
  // breakup dates use month-start format while we compute month-end dates.
  if (prevMonthEndStr.slice(0, 7) <= lastDate.slice(0, 7)) return false;
  try {
    const res = closeMonth(prevMonthEndStr);
    refreshAfterLedgerChange();
    console.log('[auto-close] Closed month:', prevMonthEndStr, '— NW:', res?.totalValue?.toFixed(2), 'L');
    const badge = document.getElementById('live-time-badge');
    if (badge) {
      const prev = badge.innerText;
      badge.innerText = `✓ Auto-closed ${prevMonthEndStr}`;
      setTimeout(() => { badge.innerText = prev; }, 4000);
    }
    return true;
  } catch (e) {
    console.warn('[auto-close] Failed:', e.message);
    return false;
  }
}

function refreshAfterLedgerChange() {
  if (typeof applyLedgerToHoldings === 'function') applyLedgerToHoldings();
  if (typeof initializeLiveBaseline === 'function') initializeLiveBaseline();
  // Re-derive the monthly history columns from the ledger so backdated,
  // edited, or deleted entries retro-apply to every table/chart immediately.
  try { if (typeof rebuildBreakupFromLedger === 'function') rebuildBreakupFromLedger(); } catch (e) { console.error(e); }
  // Recompute net worth from live holdings so buys/sells reflect immediately.
  try { recomputePortfolioFromLiveData(); } catch (e) { console.error(e); }
  try { updateKpis(); } catch (e) { console.error(e); }
  try { renderDailyOverviewTable(); renderMonthlyOverviewTable(); } catch (e) {}
  // Rebuild only tabs the user has actually opened this session; drop the rest
  // from initializedTabs so they rebuild (with the new ledger state) on first visit.
  ['stocks', 'mfs', 'growth', 'fixed-income', 'monthly'].forEach(tabId => {
    if (initializedTabs.has(tabId)) {
      try { tabInitMap[tabId](); } catch (e) {}
    }
  });
  try { saveRefreshedPrices(latestEquity, latestMf); } catch (e) {}
}

function handleCloseMonth() {
  const date = document.getElementById('close-date').value;
  const preview = document.getElementById('close-preview');
  if (!date) { preview.textContent = 'Pick a close date first.'; return; }
  try {
    const res = closeMonth(date);
    refreshAfterLedgerChange();
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
    status.innerHTML = `<span class="trend-up">✓ Imported backup from ${escapeHtml((data._backup_meta || {}).exported_at || 'file')}. Commit to persist.</span>`;
  } catch (err) {
    status.innerHTML = `<span class="trend-down">⚠️ ${escapeHtml(err.message)}</span>`;
  } finally {
    e.target.value = '';
  }
}


// ==================== PULL-TO-REFRESH (mobile) ====================
// Native pull-to-refresh reloads the whole page; in standalone PWA mode it's
// disabled entirely. This gives the natural mobile gesture a useful meaning:
// pull down from the top of the page to trigger a price refresh.
(function initPullToRefresh() {
  let startY = null, pulling = false;
  const THRESH = 80;
  const ind = () => document.getElementById('ptr-indicator');
  const atTop = () => (document.scrollingElement?.scrollTop || 0) <= 0;
  document.addEventListener('touchstart', (e) => {
    startY = atTop() ? e.touches[0].clientY : null;
    pulling = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY == null || !atTop()) return;
    const dy = e.touches[0].clientY - startY;
    const el = ind();
    if (!el || dy < 24) return;
    pulling = true;
    el.classList.add('visible');
    el.classList.toggle('ready', dy > THRESH);
    el.textContent = dy > THRESH ? '⟳ Release to refresh prices' : '↓ Pull to refresh prices';
  }, { passive: true });
  document.addEventListener('touchend', () => {
    const el = ind();
    if (pulling && el && el.classList.contains('ready')) {
      el.textContent = '⟳ Refreshing prices…';
      Promise.resolve(typeof refreshPrices === 'function' ? refreshPrices() : null)
        .finally(() => { el.classList.remove('visible', 'ready'); });
    } else if (el) {
      el.classList.remove('visible', 'ready');
    }
    startY = null; pulling = false;
  }, { passive: true });
})();

// ==================== MONTH-CLOSE CHECKLIST ====================
// Guided flow for the monthly routine: every opaque component listed with its
// last recorded value pre-filled — update the ones that changed, save them all
// in one tap, then hit Close Period. Replaces nine separate form submissions.
function _lastBalanceFor(component) {
  const entries = (balances || []).filter(b => b.component === component)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length) {
    const last = entries[entries.length - 1];
    return { value: last.value, date: last.date, source: 'ledger' };
  }
  const key = (typeof COMPONENT_BREAKUP !== 'undefined') && COMPONENT_BREAKUP[component]?.key;
  const vals = key && breakupSummary?.net_worth?.[key]?.values;
  if (vals && vals.length) {
    const dates = breakupSummary.dates || [];
    // breakup values are in lakhs → rupees
    return { value: (vals[vals.length - 1] || 0) * 100000, date: dates[dates.length - 1] || '', source: 'breakup' };
  }
  return { value: 0, date: '', source: 'none' };
}

function startCloseChecklist() {
  const box = document.getElementById('close-checklist');
  if (!box) return;
  const comps = (typeof OPAQUE_COMPONENTS !== 'undefined') ? OPAQUE_COMPONENTS : [];
  const rows = comps.map(c => {
    const last = _lastBalanceFor(c);
    const lastTxt = last.date ? `${formatINR(last.value)} · ${formatDateString(last.date)}` : 'no record yet';
    return `<div class="close-check-row" data-component="${c}" data-orig="${last.value}">
      <div class="close-check-name">${c}<span class="close-check-last">${lastTxt}</span></div>
      <label>Value ₹<input type="number" step="any" class="close-check-value" value="${Math.round(last.value)}"></label>
      <label>Contribution ₹<input type="number" step="any" class="close-check-contrib" value="0"></label>
    </div>`;
  }).join('');
  box.innerHTML = `
    <p class="manage-hint">Update each component's current value (and any fresh contribution this month).
    Untouched rows are skipped — only changed values are recorded.</p>
    ${rows}
    <div class="manage-actions">
      <button type="button" class="upload-btn" onclick="saveCloseChecklist()">✓ Save entered updates</button>
      <button type="button" class="ghost-btn" onclick="document.getElementById('close-checklist').innerHTML=''">Cancel</button>
    </div>
    <div id="close-checklist-status" class="manage-preview"></div>`;
}

function saveCloseChecklist() {
  const box = document.getElementById('close-checklist');
  const status = document.getElementById('close-checklist-status');
  if (!box) return;
  const date = document.getElementById('close-date')?.value || localDateStr();
  let saved = 0;
  box.querySelectorAll('.close-check-row').forEach(row => {
    const value = parseFloat(row.querySelector('.close-check-value').value);
    const contrib = parseFloat(row.querySelector('.close-check-contrib').value) || 0;
    const orig = parseFloat(row.dataset.orig);
    const changed = Number.isFinite(value) && (Math.abs(value - orig) > 0.5 || contrib !== 0);
    if (!changed) return;
    addBalance({ date, component: row.dataset.component, value, contribution: contrib, note: 'month-close checklist' });
    saved++;
    row.style.opacity = '0.45';
  });
  refreshAfterLedgerChange();
  if (status) status.innerHTML = saved
    ? `<span class="trend-up">✓ ${saved} balance update${saved > 1 ? 's' : ''} recorded (${date}).</span> Now hit <b>Close Period →</b> when ready.`
    : 'No rows changed — nothing recorded.';
}


// ==================== UPDATE LOG (inside Manage tab) ====================
function toggleUpdateLog() {
  const wrap = document.getElementById('update-log-wrap');
  const btn = document.getElementById('update-log-toggle');
  if (!wrap) return;
  const show = wrap.style.display === 'none';
  wrap.style.display = show ? '' : 'none';
  if (btn) btn.textContent = show ? 'Hide' : 'Show';
  if (show) { try { initUpdateLogTab(); } catch (_) {} }
}

// ==================== GOLD SECTION (Fixed Income & NPS tab) ====================
// SGB tranches + gold ETFs live inside latestEquity for pricing; surface them
// as an explicit section with their own table and value-over-time chart.
let goldValueChart = null;
function renderGoldSection() {
  const body = document.getElementById('gold-holdings-body');
  if (!body) return;
  const holdings = (latestEquity || []).filter(s => isGoldHolding(s));
  let totInv = 0, totVal = 0;
  body.innerHTML = holdings
    .sort((a, b) => b.cur_val - a.cur_val)
    .map(h => {
      totInv += h.invested || 0; totVal += h.cur_val || 0;
      const pnl = (h.cur_val || 0) - (h.invested || 0);
      const pct = h.invested > 0 ? (pnl / h.invested) * 100 : 0;
      const cls = pnl >= 0 ? 'trend-up' : 'trend-down';
      return `<tr>
        <td>${escapeHtml(h.instrument)}</td>
        <td style="text-align:right;">${h.qty}</td>
        <td style="text-align:right;">${formatINR(h.invested)}</td>
        <td style="text-align:right;">${formatINR(h.cur_val)}</td>
        <td style="text-align:right;" class="${cls}">${pnl >= 0 ? '+' : ''}${formatINR(pnl)}</td>
        <td style="text-align:right;" class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--text-muted);">No gold holdings.</td></tr>';
  const badge = document.getElementById('gold-total-badge');
  if (badge) {
    const pnl = totVal - totInv;
    badge.textContent = `${formatINR(totVal)} · P&L ${pnl >= 0 ? '+' : ''}${formatINR(pnl)}`;
  }

  // Gold valuation vs cumulative invested — same pattern as the Growth tab's
  // Capital vs Valuation chart: cumulative invested is a running sum of monthly
  // new_investment, offset so it starts level with the valuation series (the
  // frozen-base gold corpus predates the ledger and has no per-month entries).
  const canvas = document.getElementById('gold-value-chart');
  if (!canvas) return;
  const dates = breakupSummary?.dates || [];
  const vals = breakupSummary?.net_worth?.['Gold (Gold)']?.values || [];
  const invRaw = breakupSummary?.new_investment?.['Gold (Gold)']?.values || [];
  let running = 0;
  const cumInvRaw = invRaw.map(v => (running += Number(v) || 0));
  const offset = (vals.length && cumInvRaw.length) ? vals[0] - cumInvRaw[0] : 0;
  const cumInv = cumInvRaw.map(v => v + offset);
  if (goldValueChart) goldValueChart.destroy();
  goldValueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Valuation',
          data: vals,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          borderWidth: 3, fill: true, pointRadius: 0, pointHoverRadius: 5,
        },
        {
          label: 'Cumulative Invested',
          data: cumInv,
          borderColor: '#6366f1',
          borderWidth: 2, borderDash: [5, 5], fill: false, pointRadius: 0, pointHoverRadius: 5,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', callback: v => '₹' + v + ' L' } }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ₹${(ctx.parsed.y ?? 0).toFixed(2)} L` } }
      }
    }
  });
}
