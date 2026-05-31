// Zerodha Portfolio Integration Server with Live Price Auto-Refresh
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory session storage (use Redis/DB in production)
const sessions = new Map();
const appSessions = new Map();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_PASSWORD = process.env.PORTFOLIO_PASSWORD || 'Portfolio2026!';

function createSession(store, payload = {}) {
  const token = `session_${crypto.randomUUID()}`;
  store.set(token, {
    ...payload,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getValidSession(store, token) {
  if (!token || !store.has(token)) return null;
  const session = store.get(token);
  if (Date.now() > session.expiresAt) {
    store.delete(token);
    return null;
  }
  return session;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function requireAppAuth(req, res, next) {
  const session = getValidSession(appSessions, bearerToken(req));
  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }
  req.appSession = session;
  next();
}

// App auth endpoints must be public so the login screen can obtain a token.
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: 'Incorrect password'
    });
  }

  const token = createSession(appSessions, { scope: 'portfolio' });
  res.json({
    success: true,
    token,
    expiresAt: appSessions.get(token).expiresAt
  });
});

app.get('/api/auth/session', (req, res) => {
  const session = getValidSession(appSessions, bearerToken(req));
  res.json({
    success: Boolean(session),
    expiresAt: session?.expiresAt || null
  });
});

// Portfolio JSON contains private holdings. Serve it only after app auth.
app.use('/data', requireAppAuth, express.static(path.join(__dirname, 'data')));
app.use('/data', (req, res) => {
  res.status(404).json({ success: false, error: 'Data file not found' });
});
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}data${path.sep}`)) {
      res.statusCode = 404;
    }
  }
}));

// Zerodha Kite Connect configuration
const KITE_API_KEY = process.env.KITE_API_KEY || 'your_kite_api_key';
const KITE_API_SECRET = process.env.KITE_API_SECRET || 'your_kite_api_secret';

// Valid Zerodha credentials
const VALID_CREDENTIALS = {
  'CX7784': '07ec1025'
};

// ============================================================
// LIVE PRICE CACHE — Auto-refreshes from Yahoo Finance
// ============================================================

// All NSE tickers in the portfolio (from latest_equity.json)
const ALL_TICKERS = [
  'RELIANCE', 'INFY', 'HDFCBANK', 'TCS', 'ICICIBANK',
  'WIPRO', 'ITC', 'SBIN', 'LT', 'HINDUNILVR',
  'SUNPHARMA', 'BAJFINANCE', 'BHARTIARTL', 'KOTAKBANK',
  'TATASTEEL', 'AXISBANK', 'M&M', 'BAJAJ-AUTO',
  'COALINDIA', 'ONGC', 'NESTLEIND', 'TITAN',
  'CIPLA', 'HCLTECH', 'MARICO', 'DLF',
  'SIEMENS', 'PERSISTENT', 'DMART', 'EICHERMOT',
  'BRITANNIA', 'HEROMOTOCO', 'DRREDDY', 'BANKBARODA',
  'TVSMOTOR', 'PIDILITIND', 'COLPAL', 'DABUR',
  'DIVISLAB', 'APOLLOTYRE', 'FEDERALBNK', 'OBEROIRLTY',
  'MOTHERSON', 'MPHASIS', 'KPITTECH', 'GODREJPROP',
  'PRESTIGE', 'MANKIND', 'ZYDUSLIFE', 'SYNGENE',
  'HDFCLIFE', 'SBILIFE', 'ICICIGI', 'ICICIPRULI',
  'MFSL', 'BALKRISIND', 'CASTROLIND', 'COFORGE',
  'ERIS', 'EXIDEIND', 'JBCHEPHARM', 'LALPATHLAB',
  'PHOENIXLTD', 'UNOMINDA', 'CIEINDIA', 'KARURVYSYA',
  'BRIGADE', 'ENDURANCE', 'AJANTPHARM', 'OFSS',
  'VBL', 'TATACONSUM', 'GOLDBEES', 'BANKIETF',
  'FMCGIETF', 'ENRIN', 'MINDSPACE-RR', 'EMBASSY-RR',
  'NXST-RR', 'MOTHERSON', 'BANKBARODA', 'MANKIND',
  'NESTLEIND', 'ZYDUSLIFE', 'SYNGENE', 'HDFCLIFE',
  'SBILIFE', 'ICICIGI', 'ICICIPRULI', 'MFSL',
  'BALKRISIND', 'CASTROLIND', 'COFORGE', 'ERIS',
  'EXIDEIND', 'JBCHEPHARM', 'LALPATHLAB', 'PHOENIXLTD',
  'UNOMINDA', 'CIEINDIA', 'KARURVYSYA', 'BRIGADE',
  'ENDURANCE', 'AJANTPHARM', 'OFSS', 'VBL',
  'TATACONSUM', 'GOLDBEES', 'BANKIETF', 'FMCGIETF',
  'ENRIN'
];

// Deduplicate
const TICKERS = [...new Set(ALL_TICKERS)];

// In-memory live price cache
let livePriceCache = {
  prices: {},        // symbol -> { price, change, changePercent, lastUpdated }
  lastUpdated: null,
  isRefreshing: false
};

// Fetch a batch of prices from Yahoo Finance
async function fetchYahooPrices(tickers) {
  const results = {};
  const batchSize = 5;
  
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const promises = batch.map(async (symbol) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?range=1d&interval=1d`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000)
        });
        const data = await response.json();
        const result = data.chart?.result?.[0];
        if (result && result.meta) {
          const meta = result.meta;
          const quotes = result.indicators?.quote?.[0];
          const prevClose = meta.previousClose || meta.chartPreviousClose || 0;
          const currentPrice = meta.regularMarketPrice;
          const change = currentPrice - prevClose;
          const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
          
          results[symbol] = {
            price: currentPrice,
            prevClose: prevClose,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            lastUpdated: new Date().toISOString()
          };
        }
      } catch (err) {
        // Silently skip failed fetches
        if (!results[symbol]) {
          results[symbol] = { error: err.message };
        }
      }
    });
    await Promise.allSettled(promises);
    // Rate limit: 1 second between batches
    if (i + batchSize < tickers.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return results;
}

// Refresh the entire price cache
async function refreshPriceCache() {
  if (livePriceCache.isRefreshing) return;
  livePriceCache.isRefreshing = true;
  
  console.log(`[PriceCache] Refreshing prices for ${TICKERS.length} tickers...`);
  const startTime = Date.now();
  
  try {
    const prices = await fetchYahooPrices(TICKERS);
    const successCount = Object.keys(prices).filter(k => prices[k].price !== undefined).length;
    
    // Merge new prices into cache (keep old prices for tickers that failed)
    for (const [symbol, data] of Object.entries(prices)) {
      if (data.price !== undefined) {
        livePriceCache.prices[symbol] = data;
      }
    }
    
    livePriceCache.lastUpdated = new Date().toISOString();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PriceCache] Refreshed ${successCount}/${TICKERS.length} prices in ${elapsed}s`);
  } catch (err) {
    console.error('[PriceCache] Refresh failed:', err.message);
  } finally {
    livePriceCache.isRefreshing = false;
  }
}
// Cache staleness threshold: refresh if cache is older than 15 minutes
const CACHE_STALE_MS = 15 * 60 * 1000; // 15 minutes

// Check if cache is stale and refresh on-demand
async function ensureFreshCache() {
  const now = Date.now();
  const lastUpdated = livePriceCache.lastUpdated ? new Date(livePriceCache.lastUpdated).getTime() : 0;
  const isStale = (now - lastUpdated) > CACHE_STALE_MS;
  
  if (isStale && !livePriceCache.isRefreshing) {
    console.log('[PriceCache] Cache is stale, refreshing on-demand...');
    await refreshPriceCache();
    return true;
  }
  return false;
}
// ============================================================
// LIVE DATA-ENABLED MOCK HOLDINGS
// ============================================================

// User's actual portfolio holdings with quantities (from latest_equity.json)
const USER_HOLDINGS = [
  { symbol: "716GS2050-GS", qty: 100, avg_cost: 109.73, sector: "Government Bonds" },
  { symbol: "AJANTPHARM", qty: 19, avg_cost: 489.54, sector: "Pharmaceuticals" },
  { symbol: "APOLLOTYRE", qty: 250, avg_cost: 183.59, sector: "Automobile & Ancillaries" },
  { symbol: "AXISBANK", qty: 62, avg_cost: 708.24, sector: "Banking & Financial Services" },
  { symbol: "BAJAJ-AUTO", qty: 19, avg_cost: 3076.33, sector: "Automobile & Ancillaries" },
  { symbol: "BAJFINANCE", qty: 80, avg_cost: 673.10, sector: "Banking & Financial Services" },
  { symbol: "BALKRISIND", qty: 15, avg_cost: 2427.47, sector: "Automobile & Ancillaries" },
  { symbol: "BHARTIARTL", qty: 180, avg_cost: 322.89, sector: "Telecommunication Services" },
  { symbol: "BRIGADE", qty: 40, avg_cost: 446.04, sector: "Real Estate & Construction" },
  { symbol: "BRITANNIA", qty: 14, avg_cost: 3489.94, sector: "Consumer Goods & FMCG" },
  { symbol: "CASTROLIND", qty: 180, avg_cost: 155.25, sector: "Other Equities" },
  { symbol: "CIPLA", qty: 45, avg_cost: 990.66, sector: "Pharmaceuticals" },
  { symbol: "COALINDIA", qty: 470, avg_cost: 194.39, sector: "Energy & Mining" },
  { symbol: "COFORGE", qty: 65, avg_cost: 909.05, sector: "IT & Software Services" },
  { symbol: "COLPAL", qty: 21, avg_cost: 1503.03, sector: "Consumer Goods & FMCG" },
  { symbol: "DLF", qty: 66, avg_cost: 557.49, sector: "Real Estate & Construction" },
  { symbol: "DMART", qty: 12, avg_cost: 3474.64, sector: "Other Equities" },
  { symbol: "DRREDDY", qty: 60, avg_cost: 992.60, sector: "Pharmaceuticals" },
  { symbol: "EICHERMOT", qty: 7, avg_cost: 3506.83, sector: "Automobile & Ancillaries" },
  { symbol: "ENDURANCE", qty: 24, avg_cost: 2007.86, sector: "Automobile & Ancillaries" },
  { symbol: "ERIS", qty: 42, avg_cost: 664.74, sector: "Pharmaceuticals" },
  { symbol: "EXIDEIND", qty: 230, avg_cost: 189.67, sector: "Automobile & Ancillaries" },
  { symbol: "FEDERALBNK", qty: 351, avg_cost: 91.30, sector: "Banking & Financial Services" },
  { symbol: "GODREJPROP", qty: 20, avg_cost: 1600.68, sector: "Real Estate & Construction" },
  { symbol: "GOLDBEES", qty: 1200, avg_cost: 81.55, sector: "Gold Commodity (ETF)" },
  { symbol: "HCLTECH", qty: 74, avg_cost: 1149.02, sector: "IT & Software Services" },
  { symbol: "HDFCBANK", qty: 94, avg_cost: 825.12, sector: "Banking & Financial Services" },
  { symbol: "HDFCLIFE", qty: 136, avg_cost: 596.67, sector: "Insurance" },
  { symbol: "HEROMOTOCO", qty: 10, avg_cost: 3016.79, sector: "Automobile & Ancillaries" },
  { symbol: "ICICIBANK", qty: 59, avg_cost: 656.47, sector: "Banking & Financial Services" },
  { symbol: "ICICIGI", qty: 54, avg_cost: 1308.59, sector: "Insurance" },
  { symbol: "ICICIPRULI", qty: 118, avg_cost: 492.05, sector: "Insurance" },
  { symbol: "INFY", qty: 65, avg_cost: 1576.72, sector: "IT & Software Services" },
  { symbol: "ITC", qty: 788, avg_cost: 206.55, sector: "Consumer Goods & FMCG" },
  { symbol: "JBCHEPHARM", qty: 45, avg_cost: 1006.05, sector: "Pharmaceuticals" },
  { symbol: "KOTAKBANK", qty: 285, avg_cost: 355.68, sector: "Banking & Financial Services" },
  { symbol: "KPITTECH", qty: 80, avg_cost: 814.86, sector: "IT & Software Services" },
  { symbol: "LALPATHLAB", qty: 40, avg_cost: 1147.69, sector: "Healthcare & Diagnostics" },
  { symbol: "LT", qty: 62, avg_cost: 1053.22, sector: "Engineering & Construction" },
  { symbol: "M&M", qty: 10, avg_cost: 1189.63, sector: "Automobile & Ancillaries" },
  { symbol: "MARICO", qty: 73, avg_cost: 523.91, sector: "Consumer Goods & FMCG" },
  { symbol: "MOTHERSON", qty: 285, avg_cost: 51.08, sector: "Automobile & Ancillaries" },
  { symbol: "MPHASIS", qty: 33, avg_cost: 2284.62, sector: "IT & Software Services" },
  { symbol: "OBEROIRLTY", qty: 80, avg_cost: 621.89, sector: "Real Estate & Construction" },
  { symbol: "OFSS", qty: 10, avg_cost: 4342.57, sector: "IT & Software Services" },
  { symbol: "ONGC", qty: 300, avg_cost: 82.33, sector: "Energy & Mining" },
  { symbol: "PERSISTENT", qty: 16, avg_cost: 2003.97, sector: "IT & Software Services" },
  { symbol: "PHOENIXLTD", qty: 31, avg_cost: 603.24, sector: "Real Estate & Construction" },
  { symbol: "PIDILITIND", qty: 60, avg_cost: 1249.57, sector: "Chemicals & Adhesives" },
  { symbol: "SBILIFE", qty: 54, avg_cost: 1278.86, sector: "Insurance" },
  { symbol: "SBIN", qty: 66, avg_cost: 426.28, sector: "Banking & Financial Services" },
  { symbol: "SIEMENS", qty: 35, avg_cost: 749.79, sector: "Industrial Engineering" },
  { symbol: "SUNPHARMA", qty: 139, avg_cost: 582.57, sector: "Pharmaceuticals" },
  { symbol: "SYNGENE", qty: 75, avg_cost: 581.84, sector: "Biotechnology" },
  { symbol: "TATACONSUM", qty: 46, avg_cost: 794.51, sector: "Consumer Goods & FMCG" },
  { symbol: "TATASTEEL", qty: 1050, avg_cost: 40.48, sector: "Metals & Mining" },
  { symbol: "TCS", qty: 33, avg_cost: 3575.90, sector: "IT & Software Services" },
  { symbol: "TITAN", qty: 24, avg_cost: 2584.40, sector: "Other Equities" },
  { symbol: "TVSMOTOR", qty: 14, avg_cost: 2306.82, sector: "Automobile & Ancillaries" },
  { symbol: "UNOMINDA", qty: 30, avg_cost: 373.77, sector: "Automobile & Ancillaries" },
  { symbol: "VBL", qty: 110, avg_cost: 130.18, sector: "Consumer Goods & FMCG" },
  { symbol: "ZYDUSLIFE", qty: 54, avg_cost: 896.15, sector: "Pharmaceuticals" },
  { symbol: "CIEINDIA", qty: 88, avg_cost: 373.58, sector: "Industrial Engineering" },
  { symbol: "BANKBARODA", qty: 184, avg_cost: 188.19, sector: "Banking & Financial Services" },
  { symbol: "BANKIETF", qty: 8500, avg_cost: 50.47, sector: "Banking & Financial Services (ETF)" },
  { symbol: "MANKIND", qty: 28, avg_cost: 2226.31, sector: "Pharmaceuticals" },
  { symbol: "NESTLEIND", qty: 18, avg_cost: 1081.33, sector: "Consumer Goods & FMCG" },
  { symbol: "FMCGIETF", qty: 940, avg_cost: 53.20, sector: "Consumer Goods & FMCG (ETF)" },
  { symbol: "ENRIN", qty: 35, avg_cost: 234.44, sector: "Industrial Engineering" },
  { symbol: "KARURVYSYA", qty: 304, avg_cost: 108.80, sector: "Banking & Financial Services" },
  { symbol: "PRESTIGE", qty: 33, avg_cost: 761.09, sector: "Real Estate & Construction" },
  { symbol: "MFSL", qty: 73, avg_cost: 735.56, sector: "Banking & Financial Services" },
  { symbol: "EMBASSY-RR", qty: 92, avg_cost: 359.33, sector: "Real Estate (REIT)" },
  { symbol: "MINDSPACE-RR", qty: 75, avg_cost: 337.52, sector: "Real Estate (REIT)" },
  { symbol: "NXST-RR", qty: 207, avg_cost: 127.65, sector: "Real Estate (REIT)" }
];

// Build live holdings from cache + user portfolio
function buildLiveHoldings() {
  const holdings = [];
  
  for (const holding of USER_HOLDINGS) {
    const cacheEntry = livePriceCache.prices[holding.symbol];
    const livePrice = cacheEntry?.price || 0;
    const prevClose = cacheEntry?.prevClose || livePrice;
    
    // Skip if no price data (use fallback)
    const ltp = livePrice > 0 ? livePrice : holding.avg_cost;
    const curVal = holding.qty * ltp;
    const invested = holding.qty * holding.avg_cost;
    const pnl = curVal - invested;
    const gainPct = invested > 0 ? ((ltp - holding.avg_cost) / holding.avg_cost) * 100 : 0;
    
    holdings.push({
      tradingsymbol: holding.symbol,
      exchange: holding.symbol.includes('-RR') ? 'BSE' : 'NSE',
      quantity: holding.qty,
      average_price: Math.round(holding.avg_cost * 100) / 100,
      last_price: Math.round(ltp * 100) / 100,
      close_price: Math.round(prevClose * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      day_change: Math.round((ltp - prevClose) * holding.qty * 100) / 100,
      day_change_percentage: prevClose > 0 ? Math.round(((ltp - prevClose) / prevClose) * 100 * 100) / 100 : 0,
      sector: holding.sector,
      invested: Math.round(invested * 100) / 100,
      cur_val: Math.round(curVal * 100) / 100,
      gain_pct: Math.round(gainPct * 100) / 100
    });
  }
  
  return holdings;
}

function mockZerodhaMargins() {
  return {
    equity: {
      available: {
        cash: 125000,
        opening_balance: 100000
      },
      utilised: {
        debits: 45000,
        exposure: 0,
        span: 0,
        holding_sales: 0,
        premium: 0
      }
    },
    commodity: {
      available: {
        cash: 0,
        opening_balance: 0
      },
      utilised: {
        debits: 0,
        exposure: 0,
        span: 0,
        holding_sales: 0,
        premium: 0
      }
    }
  };
}

// ============================================================
// API ROUTES
// ============================================================

// Generate Zerodha login URL
app.get('/api/zerodha/login-url', (req, res) => {
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${KITE_API_KEY}&v=3`;
  res.json({ url: loginUrl });
});

// Validate Zerodha credentials
app.post('/api/zerodha/validate-login', (req, res) => {
  const { userId, password } = req.body;
  
  if (!userId || !password) {
    return res.status(400).json({
      success: false,
      error: 'User ID and password are required'
    });
  }
  
  const expectedPassword = VALID_CREDENTIALS[userId];
  
  if (!expectedPassword) {
    return res.status(401).json({
      success: false,
      error: 'Invalid User ID'
    });
  }
  
  if (password !== expectedPassword) {
    return res.status(401).json({
      success: false,
      error: 'Invalid password'
    });
  }
  
  const sessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  sessions.set(sessionToken, {
    userId: userId,
    validatedAt: Date.now(),
    accessToken: `mock_access_token_${Date.now()}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  
  res.json({
    success: true,
    sessionToken: sessionToken,
    userId: userId,
    message: 'Credentials validated successfully'
  });
});

// Handle Zerodha webhook/callback
app.post('/api/zerodha/callback', (req, res) => {
  const { request_token, user_id, sessionToken } = req.body;
  
  if (!request_token) {
    return res.status(400).json({
      success: false,
      error: 'Request token is required'
    });
  }

  const session = getValidSession(sessions, sessionToken);
  if (sessionToken && !session) {
    return res.status(401).json({
      success: false,
      error: 'Session expired. Please login again.'
    });
  }
  
  const newSessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  sessions.set(newSessionToken, {
    userId: session?.userId || user_id || 'API_USER',
    requestToken: request_token,
    accessToken: `mock_access_token_${Date.now()}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  
  if (sessionToken) sessions.delete(sessionToken);
  
  res.json({
    success: true,
    sessionToken: newSessionToken,
    userId: session?.userId || user_id || 'API_USER',
    isMock: true
  });
});

app.get('/api/zerodha/session', (req, res) => {
  const session = getValidSession(sessions, bearerToken(req));
  res.json({
    success: Boolean(session),
    userId: session?.userId || null,
    expiresAt: session?.expiresAt || null
  });
});

// Get live portfolio holdings (with real-time prices)
app.get('/api/portfolio/holdings', async (req, res) => {
  const sessionToken = bearerToken(req);
  
  if (!getValidSession(sessions, sessionToken)) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated. Please connect to Zerodha first.'
    });
  }
  
  // Refresh cache on-demand if stale
  await ensureFreshCache();
  
  const holdings = buildLiveHoldings();
  
  res.json({
    success: true,
    data: {
      net: holdings,
      long: [],
      short: []
    },
    isMock: false,
    priceCacheAge: livePriceCache.lastUpdated
  });
});

// Get portfolio margins
app.get('/api/portfolio/margins', (req, res) => {
  res.json({ 
    success: true, 
    data: mockZerodhaMargins()
  });
});

// Generate portfolio summary from live data
app.get('/api/portfolio/summary', async (req, res) => {
  const sessionToken = bearerToken(req);
  
  if (!getValidSession(sessions, sessionToken)) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated. Please connect to Zerodha first.'
    });
  }
  
  // Refresh cache on-demand if stale
  await ensureFreshCache();
  
  const holdings = buildLiveHoldings();
  const margins = mockZerodhaMargins();
  
  const totalInvested = holdings.reduce((sum, h) => sum + h.invested, 0);
  const totalValue = holdings.reduce((sum, h) => sum + h.cur_val, 0);
  const totalPnl = holdings.reduce((sum, h) => sum + h.pnl, 0);
  
  res.json({
    success: true,
    data: {
      totalValue: Math.round(totalValue * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalPnlPercent: totalInvested > 0 ? Math.round((totalPnl / totalInvested) * 100 * 100) / 100 : 0,
      cash: margins.equity.available.cash,
      holdings: holdings,
      lastRefreshed: livePriceCache.lastUpdated
    }
  });
});

// ============================================================
// LIVE PRICE API ENDPOINTS
// ============================================================

// Get all live prices
app.get('/api/prices/live', (req, res) => {
  res.json({
    success: true,
    prices: livePriceCache.prices,
    lastUpdated: livePriceCache.lastUpdated,
    totalTickers: TICKERS.length,
    cachedTickers: Object.keys(livePriceCache.prices).length
  });
});

// Get price for a specific symbol
app.get('/api/prices/live/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const priceData = livePriceCache.prices[symbol];
  
  if (!priceData) {
    return res.status(404).json({
      success: false,
      error: `No price data for symbol: ${symbol}`
    });
  }
  
  res.json({
    success: true,
    symbol: symbol,
    data: priceData
  });
});

// Manually trigger price refresh
app.post('/api/prices/refresh', async (req, res) => {
  if (livePriceCache.isRefreshing) {
    return res.json({
      success: true,
      message: 'Price refresh already in progress',
      lastUpdated: livePriceCache.lastUpdated
    });
  }
  
  // Trigger async refresh
  refreshPriceCache().catch(err => console.error('[PriceCache] Manual refresh error:', err));
  
  res.json({
    success: true,
    message: 'Price refresh started',
    lastUpdated: livePriceCache.lastUpdated
  });
});

// Get price cache status
app.get('/api/prices/status', (req, res) => {
  const now = Date.now();
  const lastUpdated = livePriceCache.lastUpdated ? new Date(livePriceCache.lastUpdated).getTime() : 0;
  const isStale = (now - lastUpdated) > CACHE_STALE_MS;
  
  res.json({
    success: true,
    isRefreshing: livePriceCache.isRefreshing,
    lastUpdated: livePriceCache.lastUpdated,
    cachedCount: Object.keys(livePriceCache.prices).length,
    totalTickers: TICKERS.length,
    isStale: isStale,
    refreshMode: 'on-demand',
    staleAfterMs: CACHE_STALE_MS
  });
});

// Serve the main app
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// STARTUP
// ============================================================

app.listen(PORT, async () => {
  console.log(`🚀 Zerodha Portfolio Server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoints available at http://localhost:${PORT}/api/`);
  console.log(`🔄 Price refresh mode: ON-DEMAND (refreshed when user accesses portfolio)`);
  
  // Initial price fetch on startup (so first user doesn't wait)
  console.log('[PriceCache] Initial price fetch on startup...');
  await refreshPriceCache();
  
  console.log('[PriceCache] Initial refresh complete. Prices available at /api/prices/live');
  console.log('[PriceCache] Subsequent refreshes happen on-demand when portfolio endpoints are accessed.');
});
