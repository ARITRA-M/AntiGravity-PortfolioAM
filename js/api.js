// ── Helper: Check if an instrument can be refreshed via a live price source ──
// Returns false for instruments that have no known live price source
// (e.g., government bonds, corporate bonds, SGBs, debt instruments).
function hasLivePriceSource(instrument) {
  if (/^\d/.test(instrument)) return false;         // Bonds (start with digits)
  if (instrument.includes('-GS')) return false;      // Government Securities
  if (instrument === 'TVSMNCRPS') return false;      // Debt instrument
  if (instrument === '738REC27TF') return false;     // Corporate bond
  if (instrument.startsWith('SGB')) return false;    // Sovereign Gold Bonds
  return true;
}

// ── Helper: Determine which API source to use for a given instrument ──
function getPriceSource(instrument) {
  if (instrument.includes('-RR')) return 'yahoo';  // REITs not on Google Finance
  return 'google';
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
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

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

// Parse Yahoo Finance /v8/finance/chart response into { price, prevClose }
function parseYahooChart(data) {
  const r = data?.chart?.result?.[0];
  if (!r?.meta?.regularMarketPrice) return null;
  return {
    price: r.meta.regularMarketPrice,
    prevClose: r.meta.chartPreviousClose ?? r.meta.previousClose ?? null
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

  // For Yahoo Finance, we must go through the CORS proxy (no CORS headers on browser requests)
  try {
    const proxyUrl = CORS_PROXY + encodeURIComponent(directUrl);
    const resp = await fetch(proxyUrl, { ...options, signal: AbortSignal.timeout(12000) });
    if (resp.ok) return resp;
    // Retry on 429 with exponential backoff
    if (resp.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount + 1);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithFallback(url, options, retryCount + 1);
    }
  } catch (_) { /* fall through */ }

  // Final retry with backoff if we haven't exhausted retries
  if (retryCount < MAX_RETRIES) {
    const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount);
    await new Promise(resolve => setTimeout(resolve, delay));
    return fetchWithFallback(url, options, retryCount + 1);
  }

  throw new Error('All fetch attempts failed');
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
  if (!window.__isGitHubPages) {
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

async function refreshPrices() {
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
  let rateLimitedCount = 0;
  let cacheHitCount = 0;
  const stockDetails = [];
  const mfDetails = [];

  try {
    const now = new Date();
    const refreshDateStr = now.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const stocksToRefresh = latestEquity.filter(s => hasLivePriceSource(s.instrument));
    const totalItems = stocksToRefresh.length + latestEquity.filter(s => !hasLivePriceSource(s.instrument)).length;
    let done = 0;

    const updateProgress = (label) => {
      done++;
      status.textContent = `${label} (${done}/${totalItems + latestMf.length})…`;
    };

    // 1. Refresh Stock Prices — ONE request per stock (price + prevClose together)
    const stockPromises = latestEquity.map(async (stock) => {
      const ticker = stock.instrument;

      if (!hasLivePriceSource(ticker)) {
        updateProgress(`Skipped ${ticker}`);
        stockDetails.push({ instrument: ticker, status: 'skipped', price: null, prevClose: null, error: null });
        return;
      }

      // Snapshot the uploaded price on first refresh
      if (stock.lastUploadedPrice === undefined) {
        stock.lastUploadedPrice = stock.ltp;
      }

      const source = getPriceSource(ticker);

      try {
        const { price, prevClose } = await fetchStockQuote(ticker, source);

        if (price && price > 0) {
          stock.ltp = price;
          stock.cur_val = stock.qty * price;
          stock.pnl = stock.cur_val - stock.invested;
          stock.gain_pct = stock.invested > 0 ? (stock.pnl / stock.invested) * 100 : 0;
          stock.lastRefreshDate = refreshDateStr;
          stock.thisMonthGain = (stock.ltp - stock.lastUploadedPrice) * stock.qty;
          if (prevClose && prevClose > 0) stock.yesterdayClose = prevClose;
          stockSuccess++;
          stockDetails.push({ instrument: ticker, status: 'success', price, prevClose, error: null });
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
            } else {
              stockFail++;
              stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: 'No valid price from fallback' });
            }
          } else {
            stockFail++;
            stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: 'No valid price from primary source' });
          }
        }
      } catch (e) {
        stockFail++;
        const errMsg = e.message || String(e);
        stockDetails.push({ instrument: ticker, status: 'fail', price: null, prevClose: null, error: errMsg });
        // Detect rate-limit errors
        if (errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('too many')) {
          rateLimitedCount++;
        }
      }
      updateProgress(ticker);
    });

    await Promise.allSettled(stockPromises);

    // 2. Refresh MF NAVs
    const mfPromises = latestMf.map(async (fund) => {
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

      // Check MF cache
      const mfCacheKey = `mf:${schemeCode}`;
      const cachedMf = getCachedPrice(mfCacheKey);
      if (cachedMf) {
        cacheHitCount++;
        fund.price = cachedMf.nav;
        fund.cur_val = fund.qty * cachedMf.nav;
        fund.pnl = fund.cur_val - fund.invested;
        fund.gain_pct = fund.invested > 0 ? (fund.pnl / fund.invested) * 100 : 0;
        fund.lastRefreshDate = refreshDateStr;
        fund.previousNav = cachedMf.prevNav || null;
        fund.thisMonthGain = (fund.price - fund.lastUploadedPrice) * fund.qty;
        mfSuccess++;
        mfDetails.push({ scheme: fund.scheme, status: 'success', nav: cachedMf.nav, prevNav: cachedMf.prevNav, error: null });
        updateProgress(fund.scheme);
        return;
      }

      try {
        const resp = await fetchWithFallback(`/api/live-mf-nav/${schemeCode}`);

        let data;
        if (window.__isGitHubPages) {
          // On GitHub Pages, mfapi.in is fetched directly — parse its native format
          const raw = await resp.json();
          if (raw?.data?.length > 0) {
            const latest = raw.data[0];
            const prev = raw.data.find((e, i) => i > 0 && Number(e.nav) > 0);
            data = {
              nav: parseFloat(latest.nav),
              prevNav: prev ? parseFloat(prev.nav) : null
            };
          }
        } else {
          // Local server returns already-parsed { nav, prevNav }
          data = await resp.json();
        }

        if (data?.nav && data.nav > 0) {
          fund.price = data.nav;
          fund.cur_val = fund.qty * data.nav;
          fund.pnl = fund.cur_val - fund.invested;
          fund.gain_pct = fund.invested > 0 ? (fund.pnl / fund.invested) * 100 : 0;
          fund.lastRefreshDate = refreshDateStr;
          fund.previousNav = data.prevNav || null;
          fund.thisMonthGain = (fund.price - fund.lastUploadedPrice) * fund.qty;
          mfSuccess++;
          mfDetails.push({ scheme: fund.scheme, status: 'success', nav: data.nav, prevNav: data.prevNav, error: null });
          // Cache the MF result
          setCachedPrice(mfCacheKey, { nav: data.nav, prevNav: data.prevNav });
        } else {
          mfFail++;
          mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: 'Invalid NAV response' });
        }
      } catch (e) {
        mfFail++;
        const errMsg = e.message || String(e);
        mfDetails.push({ scheme: fund.scheme, status: 'fail', nav: null, prevNav: null, error: errMsg });
        if (errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('too many')) {
          rateLimitedCount++;
        }
      }
      updateProgress(fund.scheme);
    });

    await Promise.allSettled(mfPromises);

    // 3. Recompute portfolio summary totals from updated data
    recomputePortfolioFromLiveData();

    // 4. Re-render all tabs
    refreshAllTabs();

    // 5. Update badge and status
    badge.innerText = `Live: ${refreshDateStr}`;
    badge.style.borderColor = 'rgba(16, 185, 129, 0.5)';

    const totalStocks = latestEquity.filter(s => hasLivePriceSource(s.instrument)).length;
    const totalMfs = latestMf.length;
    const mappedMfs = latestMf.filter(f => MF_SCHEME_CODES[f.scheme] || dynamicMfSchemeCodes[f.scheme]).length;
    const skippedStocks = latestEquity.length - totalStocks;
    const missingMfs = totalMfs - mappedMfs;

    let statusMsg = `Stocks: ${stockSuccess}/${totalStocks} | MFs: ${mfSuccess}/${mappedMfs} updated`;
    if (skippedStocks > 0) statusMsg += ` (${skippedStocks} bonds/SGBs skipped)`;
    if (missingMfs > 0) statusMsg += ` | ${missingMfs} MFs not found on mfapi.in`;

    lastRefreshReport = {
      refreshedAt: refreshDateStr, stockSuccess, stockFail, mfSuccess, mfFail,
      totalStocks, totalMfs, mappedMfs, skippedStocks, missingMfs,
      rateLimitedCount, cacheHitCount,
      stockDetails, mfDetails
    };

    if (stockFail > 0 || mfFail > 0) {
      statusMsg += ` | ${stockFail + mfFail} failed (rate limited or API down)`;
      status.className = 'refresh-status visible error';
    } else {
      status.className = 'refresh-status visible success';
    }
    status.textContent = statusMsg;
    updateDataFreshness(`Live refresh: ${refreshDateStr}. Stocks ${stockSuccess}/${totalStocks}, MFs ${mfSuccess}/${mappedMfs}, skipped ${skippedStocks + missingMfs}.`);
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
