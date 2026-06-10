const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'portfolio_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Portfolio2026!';
const sessions = new Map();

app.use(express.json({ limit: '50mb' }));

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('=') || '')];
  }).filter(([key]) => key));
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect dashboard password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt });
  setSessionCookie(res, token, expiresAt);
  res.json({ authenticated: true, expiresAt });
});

app.get('/api/session', (req, res) => {
  const active = getSession(req);
  if (!active) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, expiresAt: active.session.expiresAt });
});

app.post('/api/logout', (req, res) => {
  const active = getSession(req);
  if (active) sessions.delete(active.token);
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.use('/data', requireAuth, express.static(path.join(__dirname, 'data')));

app.get('/vendor/chart.umd.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
});

app.get('/vendor/read-excel-file.min.js', (_req, res) => {
  const file = path.join(__dirname, 'node_modules', 'read-excel-file', 'bundle', 'read-excel-file.min.js');
  if (!fs.existsSync(file)) return res.status(404).send('Excel parser library is not installed.');
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}data${path.sep}`)) {
      res.statusCode = 404;
    }
  }
}));

app.use('/api', requireAuth);

// ── Live Price Proxy Endpoints ──────────────────────────────────────────────

// Helper: fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ── In-memory price cache (60 second TTL) ──────────────────────────────────
const PRICE_CACHE_TTL_MS = 60 * 1000;
const priceCache = new Map();

function getCached(key) {
  const entry = priceCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    priceCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  priceCache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

// ── Combined stock quote: fetches current price AND prev close in ONE request ──
// This replaces /api/live-stock-price and /api/stock-prev-close with a single call,
// halving the number of outbound HTTP requests per stock.
app.get('/api/stock-quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `goog:${symbol}`;

  // Serve from cache if fresh
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const url = `https://www.google.com/finance/quote/${symbol}:NSE`;

  try {
    // IMPORTANT: Do NOT send a User-Agent header — without it, Google Finance returns
    // the server-rendered HTML with data-last-price attributes.
    const response = await fetchWithTimeout(url, {}, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `Google Finance returned status ${response.status}` });
    }

    const html = await response.text();

    // Extract current price
    const priceMatch = html.match(/data-last-price="([\d.]+)"/);
    if (!priceMatch) {
      return res.status(404).json({ error: `No price data found for symbol: ${symbol}` });
    }
    const price = parseFloat(priceMatch[1]);

    // Extract previous close from the same page
    let prevClose = null;
    const prevIdx = html.indexOf('Previous close');
    if (prevIdx !== -1) {
      const afterLabel = html.substring(prevIdx);
      const p6k39cRegex = /<div class="P6K39c">[^<]*?([\d,]+\.?\d*)/;
      const p6k39cMatch = afterLabel.match(p6k39cRegex);
      if (p6k39cMatch) {
        prevClose = parseFloat(p6k39cMatch[1].replace(/,/g, ''));
      }
    }

    const result = { symbol, price, prevClose, source: 'google', timestamp: Math.floor(Date.now() / 1000) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Google Finance: ' + e.message });
  }
});

// Proxy for Google Finance stock prices (NSE: symbol:NSE)
// LEGACY: kept for backward compat — internally uses the same cache as /api/stock-quote
app.get('/api/live-stock-price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `goog:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ symbol, price: cached.price, source: cached.source, cached: true });

  const url = `https://www.google.com/finance/quote/${symbol}:NSE`;

  try {
    const response = await fetchWithTimeout(url, {}, 8000);
    if (!response.ok) return res.status(502).json({ error: `Google Finance returned status ${response.status}` });
    const html = await response.text();
    const priceMatch = html.match(/data-last-price="([\d.]+)"/);
    if (!priceMatch) return res.status(404).json({ error: `No price data found for symbol: ${symbol}` });
    const price = parseFloat(priceMatch[1]);
    // Extract prevClose too so we can cache it for the other endpoint
    let prevClose = null;
    const prevIdx = html.indexOf('Previous close');
    if (prevIdx !== -1) {
      const afterLabel = html.substring(prevIdx);
      const m = afterLabel.match(/<div class="P6K39c">[^<]*?([\d,]+\.?\d*)/);
      if (m) prevClose = parseFloat(m[1].replace(/,/g, ''));
    }
    setCache(cacheKey, { symbol, price, prevClose, source: 'google', timestamp: Math.floor(Date.now() / 1000) });
    res.json({ symbol, price, source: 'google', timestamp: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Google Finance: ' + e.message });
  }
});

// Proxy for Google Finance previous day's closing price
// LEGACY: serves from the cache populated by /api/stock-quote or /api/live-stock-price
// Falls back to a fresh fetch only if the cache is cold.
app.get('/api/stock-prev-close/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `goog:${symbol}`;

  // Read from the shared Google Finance cache first
  const cached = getCached(cacheKey);
  if (cached && cached.prevClose != null) {
    return res.json({ symbol, prevClose: cached.prevClose, source: cached.source, cached: true });
  }

  const url = `https://www.google.com/finance/quote/${symbol}:NSE`;
  try {
    const response = await fetchWithTimeout(url, {}, 8000);
    if (!response.ok) return res.status(502).json({ error: `Google Finance returned status ${response.status}` });
    const html = await response.text();
    const prevIdx = html.indexOf('Previous close');
    if (prevIdx === -1) return res.status(404).json({ error: `No previous close label found for symbol: ${symbol}` });
    const afterLabel = html.substring(prevIdx);
    const p6k39cMatch = afterLabel.match(/<div class="P6K39c">[^<]*?([\d,]+\.?\d*)/);
    if (!p6k39cMatch) return res.status(404).json({ error: `No previous close value found for symbol: ${symbol}` });
    const prevClose = parseFloat(p6k39cMatch[1].replace(/,/g, ''));
    setCache(cacheKey, { symbol, price: cached?.price ?? null, prevClose, source: 'google', timestamp: Math.floor(Date.now() / 1000) });
    res.json({ symbol, prevClose, source: 'google', timestamp: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch previous close from Google Finance: ' + e.message });
  }
});

// Combined Yahoo Finance quote: price + prevClose in a single request
// Used for REITs (which are not on Google Finance) and as a fallback for all stocks on GitHub Pages.
app.get('/api/stock-quote-yahoo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const yahooSymbol = symbol.replace(/-RR$/, '');
  const cacheKey = `yahoo:${symbol}`;

  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}.NS`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);
    if (!response.ok) return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    const data = await response.json();
    const r = data?.chart?.result?.[0];
    if (!r?.meta?.regularMarketPrice) return res.status(404).json({ error: `No price data for symbol: ${symbol}` });

    const price = r.meta.regularMarketPrice;
    // chartPreviousClose is the clean previous trading day's close
    const prevClose = r.meta.chartPreviousClose ?? r.meta.previousClose ?? null;

    const result = { symbol, price, prevClose, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Yahoo Finance: ' + e.message });
  }
});

// ── Real BSE Sensex month-to-date change (current price vs last trading day of previous month) ──
app.get('/api/sensex-monthly-change', async (req, res) => {
  const cacheKey = 'sensex:monthly';
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  // Fetch from 15 days before month start to now so the response includes
  // the last trading day of the previous month as the MTD baseline.
  const now = new Date();
  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const period1 = Math.floor((monthStartMs - 15 * 24 * 60 * 60 * 1000) / 1000);
  const period2 = Math.floor(now.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);
    if (!response.ok) return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    const data = await response.json();
    const r = data?.chart?.result?.[0];
    const closes = r?.indicators?.quote?.[0]?.close;
    const timestamps = r?.timestamp;
    const currentPrice = r?.meta?.regularMarketPrice;
    if (!closes || !timestamps || !currentPrice) return res.status(404).json({ error: 'Incomplete Sensex monthly data' });
    // Find the last close strictly before the 1st of the current month
    let monthStartClose = null;
    for (let i = 0; i < timestamps.length; i++) {
      const dayMs = timestamps[i] * 1000;
      if (dayMs < monthStartMs && closes[i] != null) {
        monthStartClose = closes[i];
      }
    }
    if (!monthStartClose) return res.status(404).json({ error: 'No previous-month close found' });
    const monthlyChangePct = ((currentPrice - monthStartClose) / monthStartClose) * 100;
    const result = { price: currentPrice, monthStartClose, monthlyChangePct, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch Sensex monthly data: ' + e.message });
  }
});

// ── Real BSE Sensex daily change (current price vs previous close) ──
// Fetches ^BSESN from Yahoo Finance and returns the daily change %.
app.get('/api/sensex-daily-change', async (req, res) => {
  const cacheKey = 'sensex:change';
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN';
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);
    if (!response.ok) return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    const data = await response.json();
    const r = data?.chart?.result?.[0];
    if (!r?.meta?.regularMarketPrice || !r?.meta?.chartPreviousClose) {
      return res.status(404).json({ error: 'Incomplete Sensex data from Yahoo Finance' });
    }
    const price = r.meta.regularMarketPrice;
    const prevClose = r.meta.chartPreviousClose;
    const dailyChangePct = ((price - prevClose) / prevClose) * 100;
    const marketTime = r.meta.regularMarketTime;
    const result = { price, prevClose, dailyChangePct, marketTime, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch Sensex data: ' + e.message });
  }
});

// Yahoo Finance individual endpoints (legacy, served from cache populated above)
app.get('/api/live-stock-price-yahoo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const yahooSymbol = symbol.replace(/-RR$/, '');
  const cacheKey = `yahoo:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ symbol, price: cached.price, source: 'yahoo', cached: true });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}.NS`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);
    if (!response.ok) return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    const data = await response.json();
    const r = data?.chart?.result?.[0];
    if (!r?.meta?.regularMarketPrice) return res.status(404).json({ error: `No price data for symbol: ${symbol}` });
    const price = r.meta.regularMarketPrice;
    const prevClose = r.meta.chartPreviousClose ?? r.meta.previousClose ?? null;
    setCache(cacheKey, { symbol, price, prevClose, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) });
    res.json({ symbol, price, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Yahoo Finance: ' + e.message });
  }
});

app.get('/api/stock-prev-close-yahoo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `yahoo:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached && cached.prevClose != null) return res.json({ symbol, prevClose: cached.prevClose, source: 'yahoo', cached: true });

  const yahooSymbol = symbol.replace(/-RR$/, '');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}.NS`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);
    if (!response.ok) return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    const data = await response.json();
    const r = data?.chart?.result?.[0];
    if (!r) return res.status(404).json({ error: `No data for symbol: ${symbol}` });
    const prevClose = r.meta.chartPreviousClose ?? r.meta.previousClose ?? null;
    if (!prevClose) return res.status(404).json({ error: `No prevClose for symbol: ${symbol}` });
    setCache(cacheKey, { symbol, price: cached?.price ?? null, prevClose, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) });
    res.json({ symbol, prevClose, source: 'yahoo', timestamp: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch previous close from Yahoo Finance: ' + e.message });
  }
});

// Proxy for mfapi.in mutual fund NAV (by scheme code)
// mfapi.in has open CORS headers so GitHub Pages can call it directly — this proxy
// is only used locally to avoid needing the CORS proxy for mfapi.
app.get('/api/live-mf-nav/:schemeCode', async (req, res) => {
  const schemeCode = req.params.schemeCode;
  const cacheKey = `mf:${schemeCode}`;

  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const url = `https://api.mfapi.in/mf/${schemeCode}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 10000);

    if (!response.ok) {
      return res.status(502).json({ error: `mfapi.in returned status ${response.status}` });
    }

    const parsed = await response.json();
    if (parsed && parsed.data && parsed.data.length > 0) {
      const latest = parsed.data[0];
      const previous = parsed.data.find((entry, index) => index > 0 && Number(entry.nav) > 0);
      const result = {
        schemeCode,
        schemeName: parsed.meta?.scheme_name || '',
        nav: parseFloat(latest.nav),
        prevNav: previous ? parseFloat(previous.nav) : null,
        date: latest.date
      };
      setCache(cacheKey, result);
      res.json(result);
    } else {
      res.status(404).json({ error: `No data for scheme code: ${schemeCode}` });
    }
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from mfapi.in: ' + e.message });
  }
});

// Dynamic MF scheme code lookup via mfapi.in search API
// Searches by fund name and returns the best matching scheme code
app.get('/api/search-mf-scheme', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  try {
    const url = `https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `mfapi.in search returned status ${response.status}` });
    }

    const results = await response.json();
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: 'Failed to search mfapi.in: ' + e.message });
  }
});

// ── Commit portfolio data to GitHub (one-click deploy) ───────────────────
const ALLOWED_SAVE_KEYS = new Set(['portfolio_summary', 'breakup_summary', 'latest_equity', 'latest_mf', 'historical_holdings']);

app.post('/api/commit-data', (req, res) => {
  try {
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const commitMsg = `Update portfolio data ${todayStr}`;
    const results = [];

    // 1. Save JSON data files
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    let savedCount = 0;
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED_SAVE_KEYS.has(key)) {
        const filePath = path.join(dataDir, key + '.json');
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
        savedCount++;
      }
    }
    results.push(`Saved ${savedCount} data files`);

    // 2. Bump APP_VERSION in app.js → today's date
    const appJsPath = path.join(__dirname, 'app.js');
    const appContent = fs.readFileSync(appJsPath, 'utf-8');
    const appUpdated = appContent.replace(
      /const APP_VERSION\s*=\s*'[\d-]+'/,
      `const APP_VERSION = '${todayStr}'`
    );
    if (appUpdated !== appContent) {
      fs.writeFileSync(appJsPath, appUpdated, 'utf-8');
      results.push(`APP_VERSION → ${todayStr}`);
    }

    // 3. Bump CACHE_NAME in sw.js → increment vN → vN+1
    const swJsPath = path.join(__dirname, 'sw.js');
    const swContent = fs.readFileSync(swJsPath, 'utf-8');
    const verMatch = swContent.match(/portfolio-analytics-v(\d+)/);
    if (verMatch) {
      const newVer = parseInt(verMatch[1]) + 1;
      const swUpdated = swContent.replace(
        `portfolio-analytics-v${verMatch[1]}`,
        `portfolio-analytics-v${newVer}`
      );
      fs.writeFileSync(swJsPath, swUpdated, 'utf-8');
      results.push(`CACHE_NAME → v${newVer}`);
    }

    // 4. Git operations
    const repoDir = __dirname;
    const execOpts = { cwd: repoDir, encoding: 'utf-8', timeout: 30000 };

    // 4a. git add .
    execSync('git add .', execOpts);
    results.push('git add .');

    // 4b. git commit
    execSync(`git commit -m "${commitMsg}"`, execOpts);
    results.push(`git commit: "${commitMsg}"`);

    // 4c. git push
    const pushOutput = execSync('git push origin main', execOpts).trim();
    results.push(`git push: ${pushOutput.split('\n').pop()}`);

    console.log(`✅ ${results.join(' | ')}`);
    res.json({ success: true, message: `✅ Committed & pushed! Mobile will sync within 10 min.`, details: results });
  } catch (e) {
    const errMsg = e.stderr || e.message || 'Unknown error';
    console.error('Commit failed:', errMsg);
    res.status(500).json({ error: 'Commit failed: ' + errMsg });
  }
});

// Catch-all: serve index.html for any non-file route (SPA fallback)
// Express 5 uses path-to-regexp v8+ which does not support bare '*'
// Use a middleware that catches all unmatched GET requests
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    next();
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Portfolio dashboard running on http://localhost:${PORT}`);
  });
}

module.exports = app;
