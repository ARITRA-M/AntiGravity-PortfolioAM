// ── Helper: Check if an instrument can be refreshed via a live price source ──
function hasLivePriceSource(instrument) {
  if (/^\d/.test(instrument)) return false;         // Bonds (start with digits)
  if (instrument.includes('-GS')) return false;      // Government Securities
  if (instrument === 'TVSMNCRPS') return false;      // Debt — no free API
  if (instrument === '738REC27TF') return false;     // Corporate bond — no free API
  // SGBs are now refreshed via gold price proxy — handled separately
  return true;
}

// Instruments that are stable debt (no live price API — keep uploaded value)
const STABLE_DEBT_INSTRUMENTS = new Set(['TVSMNCRPS', '738REC27TF']);
// Detect bonds by digit-start or -GS suffix
function isStableDebt(instrument) {
  return STABLE_DEBT_INSTRUMENTS.has(instrument) ||
         /^\d/.test(instrument) ||
         instrument.includes('-GS');
}

// ── Helper: Determine which API source to use for a given instrument ──
function getPriceSource(_instrument) {
  return 'yahoo';
}

// ── Price Snapshot Persistence (localStorage) ───────────────────────────────
// Stores the last successfully fetched price for each instrument so that
// when a subsequent refresh fails, the stale-but-valid value is retained.
const PRICE_SNAPSHOTS_KEY = 'ag_portfolio_price_snapshots';

function loadAllPriceSnapshots() {
  try {
    const raw = localStorage.getItem(PRICE_SNAPSHOTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePriceSnapshot(instrument, data) {
  try {
    const all = loadAllPriceSnapshots();
    all[instrument] = data;
    localStorage.setItem(PRICE_SNAPSHOTS_KEY, JSON.stringify(all));
  } catch { /* localStorage may be full */ }
}

function loadPriceSnapshot(instrument) {
  const all = loadAllPriceSnapshots();
  return all[instrument] || null;
}

// ── Live Price Refresh ──────────────────────────────────────────────────────
let isRefreshing = false;

// ── Response Cache ──────────────────────────────────────────────────────────
// Prevents duplicate fetches of the same ticker within a single refresh cycle
const PRICE_CACHE = new Map();
const CACHE_TTL_MS = 30000;

function getCachedPrice(key) {
  const entry = PRICE_CACHE.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) return entry;
  return null;
}

function setCachedPrice(key, data) {
  PRICE_CACHE.set(key, { ...data, timestamp: Date.now() });
}

// ── Helpers for cross-origin API access (GitHub Pages support) ──────────────
// On GitHub Pages there is no backend proxy. Strategy:
//   - Stocks: fetch via Yahoo Finance (returns JSON with price + prevClose in one call)
//   - MFs: fetch mfapi.in DIRECTLY (it has open CORS headers — no proxy needed!)
// The CORS proxy is only needed for stocks on GitHub Pages because Yahoo Finance
// blocks direct browser requests due to CORS policy.
// Multiple proxies are tried in rotation — any one of them can go down for
// hours at a time (allorigins outage 2026-06-11 hung every refresh on mobile).
const CORS_PROXIES = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
];
// Sticky index of the last proxy that worked, so one outage costs a single
// failed request per session instead of one per stock.
let _workingProxyIdx = 0;

async function fetchViaCorsProxy(targetUrl, options = {}, timeoutMs = 8000) {
  let lastErr = null;
  for (let i = 0; i < CORS_PROXIES.length; i++) {
    const idx = (_workingProxyIdx + i) % CORS_PROXIES.length;
    try {
      const resp = await fetch(CORS_PROXIES[idx](targetUrl), { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok) {
        _workingProxyIdx = idx;
        return resp;
      }
      lastErr = new Error('Proxy HTTP ' + resp.status);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All CORS proxies failed');
}

// Builds the direct URL for a given endpoint+param for GitHub Pages mode
function buildDirectUrl(endpointType, param) {
  // All stock endpoints map to a single Yahoo Finance chart call
  // (returns both regularMarketPrice and chartPreviousClose)
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  switch (endpointType) {
    case 'stock-quote':
    case 'stock-quote-yahoo':
    case 'live-stock-price':
    case 'live-stock-price-yahoo':
    case 'stock-prev-close':
    case 'stock-prev-close-yahoo':
      return `${yahooBase}${encodeURIComponent(param.replace(/-RR$/, ''))}.NS`;
    case 'live-mf-nav':
      // mfapi.in has open CORS — call directly with NO proxy
      return { url: `https://api.mfapi.in/mf/${param}`, directCors: true };
    case 'search-mf-scheme':
      return { url: `https://api.mfapi.in/mf/search?q=${encodeURIComponent(param)}`, directCors: true };
    default:
      return null;
  }
}

// YYYY-MM-DD for a Date in Asia/Kolkata (IST) — used to tell whether the last
// traded price belongs to today's session or a prior one.
function istDateString(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Parse Yahoo Finance /v8/finance/chart response into { price, prevClose, asOf }.
// On the default 1-day range, meta.chartPreviousClose is the close of the
// session immediately before the one the price belongs to — i.e. exactly the
// "previous close" a broker shows (e.g. pre-open Tuesday: price = Monday's
// close, prevClose = Friday's close → daily change = Monday's session move).
// asOf = the market timestamp the price belongs to (NOT the refresh time).
function parseYahooChart(data) {
  const r = data?.chart?.result?.[0];
  if (!r?.meta?.regularMarketPrice) return null;
  const meta = r.meta;
  return {
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
  };
}

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;

async function fetchWithFallback(url, options = {}, retryCount = 0) {
  // First try the URL directly (works on local server with proxy)
  try {
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    if (resp.ok) return resp;
    // Retry on 429 (rate limited) with exponential backoff
    if (resp.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithFallback(url, options, retryCount + 1);
    }
  } catch (_) { /* fall through */ }

  // Build the direct URL for the GitHub Pages fallback
  // Parse both path-segment style (/api/type/param) and query-string style (/api/type?q=param)
  const urlObj = new URL(url, window.location.href);
  const pathParts = urlObj.pathname.split('/').filter(Boolean); // ['api', 'type', 'param?']
  const endpointType = pathParts[1] || '';
  // param is the path segment after the endpoint, or the raw query string for search endpoints
  const param = pathParts[2]
    ? decodeURIComponent(pathParts[2])
    : urlObj.searchParams.get('q') || urlObj.search.slice(1) || '';
  const directInfo = buildDirectUrl(endpointType, param);
  if (!directInfo) throw new Error('All fetch attempts failed');

  const directUrl = typeof directInfo === 'string' ? directInfo : directInfo.url;
  const useDirect = typeof directInfo !== 'string' && directInfo.directCors;

  // mfapi.in supports CORS natively — call it directly, no proxy
  if (useDirect) {
    try {
      const resp = await fetch(directUrl, { ...options, signal: AbortSignal.timeout(10000) });
      if (resp.ok) return resp;
    } catch (_) { /* fall through */ }
  }

  // For Yahoo Finance, we must go through a CORS proxy (no CORS headers on
  // browser requests). fetchViaCorsProxy rotates across proxies internally.
  try {
    const resp = await fetchViaCorsProxy(directUrl, options, 10000);
    if (resp.ok) return resp;
  } catch (_) { /* fall through */ }

  // Final retry with backoff if we haven't exhausted retries
  if (retryCount < MAX_RETRIES) {
    const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount);
    await new Promise(resolve => setTimeout(resolve, delay));
    return fetchWithFallback(url, options, retryCount + 1);
  }

  throw new Error('All fetch attempts failed');
}

// ── Bulk quote helper: many symbols per request via Yahoo's spark endpoint ──
// One request returns price + previous close for ≈20 symbols, so a full
// portfolio refresh needs a handful of requests instead of one per stock.
//   price     = meta.regularMarketPrice (matches the chart endpoint exactly)
//   prevClose = second-to-last daily close (spark's meta.chartPreviousClose is
//               the pre-range value, so it is NOT used)
// Returns Map<yahooTicker, { price, prevClose }> for symbols that resolved.
async function fetchSparkQuotes(tickers) {
  const out = new Map();
  const BATCH = 20;
  const batches = [];
  for (let i = 0; i < tickers.length; i += BATCH) batches.push(tickers.slice(i, i + BATCH));

  await Promise.all(batches.map(async (batch) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=5d&interval=1d`;
    try {
      const res = await fetchViaCorsProxy(url, {}, 12000);
      if (!res.ok) return;
      const raw = await res.json();
      for (const r of (raw?.spark?.result || [])) {
        const resp = r?.response?.[0];
        if (!resp) continue;
        // Pair each daily close with its date. (spark's meta.chartPreviousClose
        // is the pre-range value, so it's unusable as the previous close here.)
        const closeArr = resp.indicators?.quote?.[0]?.close || [];
        const tsArr = resp.timestamp || [];
        const bars = [];
        for (let i = 0; i < closeArr.length; i++) {
          if (closeArr[i] != null) bars.push({ t: tsArr[i], c: closeArr[i] });
        }
        if (!bars.length) continue;
        const price = resp.meta?.regularMarketPrice ?? bars[bars.length - 1].c;
        // Previous close = the close of the latest session STRICTLY BEFORE the
        // session the current price belongs to. Using the price's own session
        // date (regularMarketTime) — not "today" — means pre-open we still show
        // the last completed session's move (e.g. Mon close vs Fri close), and
        // it's robust if the latest daily bar hasn't appeared in the series yet
        // (which previously made the baseline land a day too far back).
        const rmt = resp.meta?.regularMarketTime;
        const asOf = rmt ? rmt * 1000 : (bars[bars.length - 1].t * 1000);
        const ltpSession = istDateString(new Date(asOf));
        let prevClose = null;
        for (let i = bars.length - 1; i >= 0; i--) {
          if (istDateString(new Date(bars[i].t * 1000)) < ltpSession) { prevClose = bars[i].c; break; }
        }
        if (prevClose == null) {
          prevClose = bars.length >= 2 ? bars[bars.length - 2].c : (resp.meta?.chartPreviousClose ?? null);
        }
        if (price != null && price > 0) out.set(r.symbol, { price, prevClose, asOf });
      }
    } catch (_) { /* a failed batch just means those stocks fall back to per-stock fetch */ }
  }));
  return out;
}

// ── Single-call stock quote helper ─────────────────────────────────────────
// Fetches both current price and previous close in ONE request.
// On local server: calls /api/stock-quote (Google, 1 round-trip) or /api/stock-quote-yahoo
// On GitHub Pages: calls Yahoo via CORS proxy, parses both fields from response
async function fetchStockQuote(ticker, source) {
  // Check cache first to avoid duplicate fetches
  const cacheKey = `stock:${ticker}:${source}`;
  const cached = getCachedPrice(cacheKey);
  if (cached) return { price: cached.price, prevClose: cached.prevClose };

  const endpoint = source === 'yahoo' ? '/api/stock-quote-yahoo/' : '/api/stock-quote/';
  const resp = await fetchWithFallback(`${endpoint}${encodeURIComponent(ticker)}`);

  let price, prevClose;

  // Local server returns { price, prevClose } directly
  if (!window.__staticMode) {
    const data = await resp.json();
    price = data.price ?? null;
    prevClose = data.prevClose ?? null;
  } else {
    // GitHub Pages: response is raw Yahoo Finance JSON — parse it ourselves
    const data = await resp.json();
    const parsed = parseYahooChart(data);
    price = parsed?.price ?? null;
    prevClose = parsed?.prevClose ?? null;
  }

  // Cache the result
  if (price != null) {
    setCachedPrice(cacheKey, { price, prevClose });
  }

  return { price, prevClose };
}

// stocksOnly=true skips the MF NAV loop — used by the 1-min auto-refresh cycle.
async function refreshPrices(stocksOnly = false) {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('refresh-prices-btn');
  const status = document.getElementById('refresh-status');
  const badge = document.getElementById('live-time-badge');

  btn.classList.add('loading');
  btn.disabled = true;
  status.className = 'refresh-status visible';

  let stockSuccess = 0;
  let stockFail = 0;
  let mfSuccess = 0;
  let mfFail = 0;
  const stockDetails = [];
  const mfDetails = [];

  try {
    const now = new Date();
    const refreshDateStr = now.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    let done = 0;
    const totalItems = latestEquity.length;

    const updateProgress = (label) => {
      done++;
      status.textContent = `${label} (${done}/${totalItems + latestMf.length})…`;
    };

    // Fetch GOLDBEES.NS once for all SGB refreshes (1 gram gold proxy = GOLDBEES × 100)
    let goldPricePerGram = null;
    const sgbInstruments = latestEquity.filter(s => s.instrument.startsWith('SGB'));
    if (sgbInstruments.length > 0) {
      try {
        const { price } = await fetchStockQuote('GOLDBEES', 'yahoo');
        if (price && price > 0) goldPricePerGram = price * 100;
      } catch (_) { /* use snapshot fallback per SGB below */ }
    }

    // 1. Refresh Stock Prices.
    // Fast path: a single bulk prefetch (Yahoo "spark", ≈20 symbols/request)
    // resolves almost every stock in a handful of requests. Any symbol the
    // bulk call misses falls back to the per-stock fetch below, batched with a
    // short delay to respect rate limits. So the common case is a few requests
    // instead of ~80, with no loss of reliability.
    const STOCK_BATCH_SIZE = 8;
    const STOCK_BATCH_DELAY_MS = 250;

    // Build the Yahoo ticker for an instrument (strip REIT suffix, add .NS).
    const yahooTickerOf = (instr) => instr.replace(/-RR$/, '') + '.NS';

    // Bulk-prefetch all live-priced equities (excludes bonds and SGBs, which
    // are handled separately). Keyed by Yahoo ticker.
    let sparkQuotes = new Map();
    try {
      const bulkTickers = latestEquity
        .filter(s => !isStableDebt(s.instrument) && !s.instrument.startsWith('SGB'))
        .map(s => yahooTickerOf(s.instrument));
      if (bulkTickers.length) sparkQuotes = await fetchSparkQuotes(bulkTickers);
    } catch (_) { sparkQuotes = new Map(); }

    // Counts real network calls in the current batch so we can skip the
    // inter-batch delay when every stock was served from the bulk prefetch.
    let netCallsInBatch = 0;

    async function refreshOneStock(stock) {
      const ticker = stock.instrument;

      // Stable debt instruments — no live price API; keep uploaded value
      if (isStableDebt(ticker)) {
        updateProgress(ticker);
        stockDetails.push({ instrument: ticker, status: 'stable', price: stock.ltp, prevClose: null, error: null });
        return;
      }

      // SGBs — priced at current gold price per gram (GOLDBEES × 100 proxy)
      if (ticker.startsWith('SGB')) {
        if (stock.lastUploadedPrice === undefined) stock.lastUploadedPrice = stock.ltp;
        const goldPrice = goldPricePerGram ?? loadPriceSnapshot(ticker)?.price ?? null;
        if (goldPrice && goldPrice > 0) {
          stock.ltp = goldPrice;
          stock.cur_val = stock.qty * goldPrice;
          stock.pnl = stock.cur_val - stock.invested;
          stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
          stock.lastRefreshDate = refreshDateStr;
          stock.thisMonthGain = (stock.ltp - stock.lastUploadedPrice) * stock.qty;
          stockSuccess++;
          stockDetails.push({ instrument: ticker, status: 'success', price: goldPrice, prevClose: null, error: null });
          savePriceSnapshot(ticker, { price: goldPrice, prevClose: null, refreshDate: refreshDateStr });
        } else {
          stockFail++;
          stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: 'Gold price unavailable' });
        }
        updateProgress(ticker);
        return;
      }

      // Snapshot the uploaded price on first refresh
      if (stock.lastUploadedPrice === undefined) {
        stock.lastUploadedPrice = stock.ltp;
      }

      const source = getPriceSource(ticker);

      try {
        // Fast path: serve from the bulk spark prefetch (no per-stock network).
        // Miss → fall back to the single-stock fetch (counts as a network call).
        const pre = sparkQuotes.get(yahooTickerOf(ticker));
        let price, prevClose, asOf = null;
        if (pre) {
          ({ price, prevClose, asOf = null } = pre);
        } else {
          netCallsInBatch++;
          ({ price, prevClose, asOf = null } = await fetchStockQuote(ticker, source));
        }

        if (price && price > 0) {
          stock.ltp = price;
          stock.cur_val = stock.qty * price;
          stock.pnl = stock.cur_val - stock.invested;
          stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
          stock.lastRefreshDate = refreshDateStr;
          stock.priceAsOf = asOf; // market timestamp the price belongs to (not refresh time)
          stock.thisMonthGain = (stock.ltp - stock.lastUploadedPrice) * stock.qty;
          if (prevClose && prevClose > 0) stock.yesterdayClose = prevClose;
          stockSuccess++;
          stockDetails.push({ instrument: ticker, status: 'success', price, prevClose, asOf, error: null });
          // Persist snapshot for fallback on future failures
          savePriceSnapshot(ticker, { price, prevClose, refreshDate: refreshDateStr });
        } else {
          // Single-call failed → try Yahoo as explicit fallback (Google stocks only)
          if (source === 'google') {
            const { price: fp, prevClose: fpc } = await fetchStockQuote(ticker, 'yahoo');
            if (fp && fp > 0) {
              stock.ltp = fp;
              stock.cur_val = stock.qty * fp;
              stock.pnl = stock.cur_val - stock.invested;
              stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
              stock.lastRefreshDate = refreshDateStr;
              stock.thisMonthGain = (stock.ltp - stock.lastUploadedPrice) * stock.qty;
              if (fpc && fpc > 0) stock.yesterdayClose = fpc;
              stockSuccess++;
              stockDetails.push({ instrument: ticker, status: 'success', price: fp, prevClose: fpc, error: null });
              savePriceSnapshot(ticker, { price: fp, prevClose: fpc, refreshDate: refreshDateStr });
            } else {
              // Both sources failed — use snapshot fallback
              const snap = loadPriceSnapshot(ticker);
              if (snap) {
                stock.ltp = snap.price;
                stock.cur_val = stock.qty * snap.price;
                stock.pnl = stock.cur_val - stock.invested;
                stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
                stock.lastRefreshDate = snap.refreshDate + ' (stale)';
                stock.yesterdayClose = snap.prevClose || stock.yesterdayClose;
                stockSuccess++;
                stockDetails.push({ instrument: ticker, status: 'stale', price: snap.price, prevClose: snap.prevClose, error: null });
              } else {
                stockFail++;
                stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: 'No valid price from fallback' });
              }
            }
          } else {
            // Primary source failed (Yahoo stock) — use snapshot fallback
            const snap = loadPriceSnapshot(ticker);
            if (snap) {
              stock.ltp = snap.price;
              stock.cur_val = stock.qty * snap.price;
              stock.pnl = stock.cur_val - stock.invested;
              stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
              stock.lastRefreshDate = snap.refreshDate + ' (stale)';
              stock.yesterdayClose = snap.prevClose || stock.yesterdayClose;
              stockSuccess++;
              stockDetails.push({ instrument: ticker, status: 'stale', price: snap.price, prevClose: snap.prevClose, error: null });
            } else {
              stockFail++;
              stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: 'No valid price from primary source' });
            }
          }
        }
      } catch (e) {
        // Exception — use snapshot fallback
        const snap = loadPriceSnapshot(ticker);
        if (snap) {
          stock.ltp = snap.price;
          stock.cur_val = stock.qty * snap.price;
          stock.pnl = stock.cur_val - stock.invested;
          stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
          stock.lastRefreshDate = snap.refreshDate + ' (stale)';
          stock.yesterdayClose = snap.prevClose || stock.yesterdayClose;
          stockSuccess++;
          stockDetails.push({ instrument: ticker, status: 'stale', price: snap.price, prevClose: snap.prevClose, error: null });
        } else {
          stockFail++;
          stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: e.message || String(e) });
        }
      }
      updateProgress(ticker);
    }

    // 2. Refresh one MF NAV (mfapi.in — a different backend from the stock
    // proxy, so MF refresh can run concurrently with the stock batches).
    async function refreshOneMf(fund) {
      let schemeCode = MF_SCHEME_CODES[fund.scheme];

      if (schemeCode === null) { mfFail++; mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: 'Explicitly excluded' }); updateProgress(fund.scheme); return; }
      if (!schemeCode) schemeCode = dynamicMfSchemeCodes[fund.scheme];

      // Dynamic lookup if still not found
      if (!schemeCode) {
        try {
          const searchQuery = fund.scheme
            .replace(/Direct\s*-?\s*Growth$/i, '')
            .replace(/Fund\s*Direct\s*-?\s*Growth$/i, '')
            .replace(/\s*-\s*/g, ' ')
            .trim();
          const searchResp = await fetchWithFallback(`/api/search-mf-scheme?q=${encodeURIComponent(searchQuery)}`);
          const searchData = await searchResp.json();
          if (searchData.results?.length > 0) {
            const directGrowth = searchData.results.find(r =>
              r.schemeName.toLowerCase().includes('direct') &&
              r.schemeName.toLowerCase().includes('growth')
            );
            const bestMatch = directGrowth || searchData.results[0];
            schemeCode = bestMatch.schemeCode;
            dynamicMfSchemeCodes[fund.scheme] = schemeCode;
          }
        } catch (_) { /* ignore */ }
      }

      if (!schemeCode) { mfFail++; mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: 'Scheme code not found' }); updateProgress(fund.scheme); return; }

      if (fund.lastUploadedPrice === undefined) fund.lastUploadedPrice = fund.price;

      try {
        const resp = await fetchWithFallback(`/api/live-mf-nav/${schemeCode}`);

        let data;
        if (window.__staticMode) {
          // On GitHub Pages, mfapi.in is fetched directly — parse its native format
          const raw = await resp.json();
          if (raw?.data?.length > 0) {
            const latest = raw.data[0];
            const prev = raw.data.find((e, i) => i > 0 && Number(e.nav) > 0);
            data = {
              nav: parseFloat(latest.nav),
              prevNav: prev ? parseFloat(prev.nav) : null,
              navDate: latest.date || null // mfapi gives the NAV's own date (DD-MM-YYYY)
            };
          }
        } else {
          // Local server returns already-parsed { nav, prevNav, navDate? }
          data = await resp.json();
        }

        if (data?.nav && data.nav > 0) {
          fund.price = data.nav;
          fund.cur_val = fund.qty * data.nav;
          fund.pnl = fund.cur_val - fund.invested;
          fund.gain_pct = fund.invested > 0 ? (fund.pnl / fund.invested) * 100 : 0;
          fund.lastRefreshDate = refreshDateStr;
          fund.navDate = data.navDate || null; // the date this NAV is for (not refresh time)
          fund.previousNav = data.prevNav || null;
          fund.thisMonthGain = (fund.price - fund.lastUploadedPrice) * fund.qty;
          mfSuccess++;
          mfDetails.push({ scheme: fund.scheme, status: 'success', nav: data.nav, prevNav: data.prevNav, navDate: data.navDate || null, error: null });
          // Persist snapshot for fallback on future failures
          savePriceSnapshot(fund.scheme, { nav: data.nav, prevNav: data.prevNav, refreshDate: refreshDateStr });
        } else {
          // Primary source failed — use snapshot fallback
          const snap = loadPriceSnapshot(fund.scheme);
          if (snap) {
            fund.price = snap.nav;
            fund.cur_val = fund.qty * snap.nav;
            fund.pnl = fund.cur_val - fund.invested;
            fund.gain_pct = fund.invested > 0 ? (fund.pnl / fund.invested) * 100 : 0;
            fund.lastRefreshDate = snap.refreshDate + ' (stale)';
            fund.previousNav = snap.prevNav || null;
            fund.thisMonthGain = (fund.price - fund.lastUploadedPrice) * fund.qty;
            mfSuccess++;
            mfDetails.push({ scheme: fund.scheme, status: 'stale', nav: snap.nav, prevNav: snap.prevNav, error: null });
          } else {
            mfFail++;
            mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: 'Invalid NAV response' });
          }
        }
      } catch (e) {
        // Exception — use snapshot fallback
        const snap = loadPriceSnapshot(fund.scheme);
        if (snap) {
          fund.price = snap.nav;
          fund.cur_val = fund.qty * snap.nav;
          fund.pnl = fund.cur_val - fund.invested;
          fund.gain_pct = fund.invested > 0 ? (fund.pnl / fund.invested) * 100 : 0;
          fund.lastRefreshDate = snap.refreshDate + ' (stale)';
          fund.previousNav = snap.prevNav || null;
          fund.thisMonthGain = (fund.price - fund.lastUploadedPrice) * fund.qty;
          mfSuccess++;
          mfDetails.push({ scheme: fund.scheme, status: 'stale', nav: snap.nav, prevNav: snap.prevNav, error: null });
        } else {
          mfFail++;
          mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: e.message || String(e) });
        }
      }
      updateProgress(fund.scheme);
    }

    // Kick off MF refresh concurrently with stocks (different backend, no
    // rate-limit contention). Skipped on stocks-only auto-refresh cycles.
    const mfRefreshDone = stocksOnly ? Promise.resolve() : Promise.allSettled(latestMf.map(refreshOneMf));

    // Run stocks in batches. Spark-served stocks make no network call, so the
    // rate-limit delay is only paid between batches that actually hit the API.
    for (let i = 0; i < latestEquity.length; i += STOCK_BATCH_SIZE) {
      const batch = latestEquity.slice(i, i + STOCK_BATCH_SIZE);
      netCallsInBatch = 0;
      await Promise.allSettled(batch.map(s => refreshOneStock(s)));
      if (i + STOCK_BATCH_SIZE < latestEquity.length && netCallsInBatch > 0) {
        await new Promise(r => setTimeout(r, STOCK_BATCH_DELAY_MS));
      }
    }

    // Make sure the concurrent MF refresh has finished before reporting.
    await mfRefreshDone;

    // 3. Compute report totals
    const stableDebtCount = latestEquity.filter(s => isStableDebt(s.instrument)).length;
    const totalStocks = latestEquity.length - stableDebtCount;
    const totalMfs = latestMf.length;
    const mappedMfs = latestMf.filter(f => MF_SCHEME_CODES[f.scheme] != null || dynamicMfSchemeCodes[f.scheme]).length;
    const skippedStocks = 0; // nothing skipped anymore — bonds show as stable
    const missingMfs = totalMfs - mappedMfs;

    // Attach each instrument's retained last-refresh time to its detail row.
    // For a FAILED instrument this is its previous successful time (failures
    // never overwrite lastRefreshDate), so the Update Log shows that the price
    // is held over from an earlier cycle rather than lost.
    const equityByName = Object.fromEntries(latestEquity.map(s => [s.instrument, s]));
    stockDetails.forEach(d => { d.lastRefresh = equityByName[d.instrument]?.lastRefreshDate || null; });
    const mfByName = Object.fromEntries(latestMf.map(f => [f.scheme, f]));
    mfDetails.forEach(d => { d.lastRefresh = mfByName[d.scheme]?.lastRefreshDate || null; });

    // 4. Build refresh report BEFORE re-rendering tabs (initUpdateLogTab reads it)
    // Use window.lastRefreshReport explicitly so it's accessible from app.js regardless
    // of script load order or Service Worker caching behavior.
    window.lastRefreshReport = {
      refreshedAt: refreshDateStr, stockSuccess, stockFail, mfSuccess, mfFail,
      totalStocks, totalMfs, mappedMfs, skippedStocks, missingMfs,
      stockDetails, mfDetails
    };

    // 5. Recompute portfolio summary totals from updated data
    recomputePortfolioFromLiveData();

    // 6. Persist refreshed prices to localStorage so page reload keeps live prices.
    // Deliberately does NOT save breakupSummary — its latest values are mutated with live data
    // and saving that would corrupt the uploadedSnapshot baseline on next reload.
    saveRefreshedPrices(latestEquity, latestMf);

    // 7. Re-render all tabs (initUpdateLogTab will now find lastRefreshReport)
    refreshAllTabs();

    // 7. Update badge and status
    badge.innerText = `Live: ${refreshDateStr}`;
    badge.style.borderColor = 'rgba(16, 185, 129, 0.5)';

    let statusMsg = stocksOnly
      ? `Stocks: ${stockSuccess}/${totalStocks} updated (MFs skipped)`
      : `Stocks: ${stockSuccess}/${totalStocks} | MFs: ${mfSuccess}/${mappedMfs} updated`;
    if (skippedStocks > 0) statusMsg += ` (${skippedStocks} bonds/SGBs skipped)`;
    if (!stocksOnly && missingMfs > 0) statusMsg += ` | ${missingMfs} MFs not found on mfapi.in`;

    if (stockFail > 0 || mfFail > 0) {
      statusMsg += ` | ${stockFail + mfFail} failed (rate limited or API down)`;
      status.className = 'refresh-status visible error';
    } else {
      status.className = 'refresh-status visible success';
    }
    status.textContent = statusMsg;
    updateDataFreshness(stocksOnly
      ? `Live refresh: ${refreshDateStr}. Stocks ${stockSuccess}/${totalStocks} (stocks only).`
      : `Live refresh: ${refreshDateStr}. Stocks ${stockSuccess}/${totalStocks}, MFs ${mfSuccess}/${mappedMfs}, skipped ${skippedStocks + missingMfs}.`);
  } catch (error) {
    console.error('Price refresh failed:', error);
    status.className = 'refresh-status visible error';
    status.textContent = 'Refresh failed. Check console for details.';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    isRefreshing = false;
    setTimeout(() => { status.className = 'refresh-status'; }, 8000);
  }
}

// ── Auto-refresh during NSE market hours (9:15 AM – 3:30 PM IST, Mon–Fri) ───
// Stocks refresh every 1 min; full refresh (stocks + MFs) every 5th tick.
const AUTO_REFRESH_TICK_MS  = 1 * 60 * 1000; // 1 minute
const AUTO_FULL_REFRESH_EVERY = 5;            // full refresh on every 5th tick

let _autoRefreshTimer = null;
let _autoRefreshCountdownTimer = null;
let _autoRefreshNextAt = null;
let _autoRefreshTickCount = 0; // increments each tick; resets on market-closed pause

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dow = now.getDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

function updateAutoRefreshBadge() {
  const badge = document.getElementById('auto-refresh-badge');
  if (!badge) return;
  if (!isMarketOpen()) {
    badge.classList.remove('active');
    badge.textContent = '';
    return;
  }
  badge.classList.add('active');
  if (_autoRefreshNextAt) {
    const secsLeft = Math.max(0, Math.round((_autoRefreshNextAt - Date.now()) / 1000));
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    // Show whether next tick is stocks-only or full
    const nextIsFull = (_autoRefreshTickCount + 1) % AUTO_FULL_REFRESH_EVERY === 0;
    badge.textContent = `Auto ⟳ ${m}:${String(s).padStart(2, '0')} ${nextIsFull ? '(full)' : '(stocks)'}`;
  } else {
    badge.textContent = 'Auto ⟳';
  }
}

function scheduleNextAutoRefresh() {
  clearTimeout(_autoRefreshTimer);
  clearInterval(_autoRefreshCountdownTimer);

  if (!isMarketOpen()) {
    // Check again in 1 minute in case the market opens
    _autoRefreshNextAt = null;
    _autoRefreshTickCount = 0; // reset so first tick after open is stocks-only
    updateAutoRefreshBadge();
    _autoRefreshTimer = setTimeout(scheduleNextAutoRefresh, 60 * 1000);
    return;
  }

  _autoRefreshNextAt = Date.now() + AUTO_REFRESH_TICK_MS;
  updateAutoRefreshBadge();

  // Tick the countdown every second
  _autoRefreshCountdownTimer = setInterval(updateAutoRefreshBadge, 1000);

  _autoRefreshTimer = setTimeout(async () => {
    clearInterval(_autoRefreshCountdownTimer);
    if (isMarketOpen() && !isRefreshing) {
      _autoRefreshTickCount++;
      const doFull = _autoRefreshTickCount % AUTO_FULL_REFRESH_EVERY === 0;
      await refreshPrices(/* stocksOnly */ !doFull);
      // Refresh Nifty 50 daily/monthly KPI after every stock refresh
      if (typeof fetchNiftySeries === 'function') fetchNiftySeries();
    }
    scheduleNextAutoRefresh();
  }, AUTO_REFRESH_TICK_MS);
}

// Start auto-refresh once the page data is loaded (called from app.js after init)
function startAutoRefresh() {
  _autoRefreshTickCount = 0;
  scheduleNextAutoRefresh();
}
