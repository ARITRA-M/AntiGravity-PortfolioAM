const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'portfolio_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Portfolio2026!';
const sessions = new Map();

app.use(express.json({ limit: '16kb' }));

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

// Proxy for Google Finance stock prices (NSE: symbol:NSE)
// Google Finance does not require API keys and has generous rate limits.
// We scrape the data-last-price attribute from the HTML page.
app.get('/api/live-stock-price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const url = `https://www.google.com/finance/quote/${symbol}:NSE`;

  try {
    // IMPORTANT: Do NOT send a User-Agent header. Google Finance serves different
    // HTML based on the User-Agent. Without a User-Agent, it returns the server-rendered
    // page with data-last-price attributes. With a browser User-Agent, it returns the
    // beta/SPA version which does NOT contain data-last-price.
    const response = await fetchWithTimeout(url, {}, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `Google Finance returned status ${response.status}` });
    }

    const html = await response.text();

    // Extract data-last-price from the HTML
    const priceMatch = html.match(/data-last-price="([\d.]+)"/);
    if (!priceMatch) {
      return res.status(404).json({ error: `No price data found for symbol: ${symbol}` });
    }

    const price = parseFloat(priceMatch[1]);

    res.json({
      symbol: symbol,
      price: price,
      source: 'google',
      timestamp: Math.floor(Date.now() / 1000)
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Google Finance: ' + e.message });
  }
});

// Proxy for Google Finance previous day's closing price (for daily gain calculation)
// Google Finance renders "Previous close" label followed by a <div class="P6K39c"> with the value
app.get('/api/stock-prev-close/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const url = `https://www.google.com/finance/quote/${symbol}:NSE`;

  try {
    const response = await fetchWithTimeout(url, {}, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `Google Finance returned status ${response.status}` });
    }

    const html = await response.text();

    // Find "Previous close" then look for the next P6K39c div containing the value
    const prevIdx = html.indexOf('Previous close');
    if (prevIdx === -1) {
      return res.status(404).json({ error: `No previous close label found for symbol: ${symbol}` });
    }

    const afterLabel = html.substring(prevIdx);
    // Match the first <div class="P6K39c"> containing a number (₹ symbol is multi-byte UTF-8)
    const p6k39cRegex = /<div class="P6K39c">[^<]*?([\d,]+\.?\d*)/;
    const p6k39cMatch = afterLabel.match(p6k39cRegex);
    if (!p6k39cMatch) {
      return res.status(404).json({ error: `No previous close value found for symbol: ${symbol}` });
    }

    // Remove commas and parse
    const prevClose = parseFloat(p6k39cMatch[1].replace(/,/g, ''));

    res.json({
      symbol: symbol,
      prevClose: prevClose,
      source: 'google',
      timestamp: Math.floor(Date.now() / 1000)
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch previous close from Google Finance: ' + e.message });
  }
});

// Fallback: Yahoo Finance for instruments not on Google Finance (REITs, etc.)
// Yahoo Finance uses .NS suffix for NSE stocks
app.get('/api/live-stock-price-yahoo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  // Remove -RR suffix for REITs (Yahoo uses plain symbol.NS)
  const yahooSymbol = symbol.replace(/-RR$/, '');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}.NS`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.meta || !result.meta.regularMarketPrice) {
      return res.status(404).json({ error: `No price data found for symbol: ${symbol}` });
    }

    res.json({
      symbol: symbol,
      price: result.meta.regularMarketPrice,
      source: 'yahoo',
      timestamp: Math.floor(Date.now() / 1000)
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch from Yahoo Finance: ' + e.message });
  }
});

// Fallback: Yahoo Finance previous close for instruments not on Google Finance (REITs, etc.)
app.get('/api/stock-prev-close-yahoo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const yahooSymbol = symbol.replace(/-RR$/, '');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}.NS`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, 8000);

    if (!response.ok) {
      return res.status(502).json({ error: `Yahoo Finance returned status ${response.status}` });
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) {
      return res.status(404).json({ error: `No data found for symbol: ${symbol}` });
    }

    // Get the previous close from the first data point's close value
    const closes = result.indicators.quote[0].close;
    // Filter out null values
    const validCloses = closes.filter(c => c !== null);
    if (validCloses.length < 2) {
      return res.status(404).json({ error: `Not enough close data for symbol: ${symbol}` });
    }
    // The second-to-last close is yesterday's close (last is today's current/close)
    const prevClose = validCloses[validCloses.length - 2];

    res.json({
      symbol: symbol,
      prevClose: prevClose,
      source: 'yahoo',
      timestamp: Math.floor(Date.now() / 1000)
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch previous close from Yahoo Finance: ' + e.message });
  }
});

// Proxy for mfapi.in mutual fund NAV (by scheme code)
app.get('/api/live-mf-nav/:schemeCode', async (req, res) => {
  const schemeCode = req.params.schemeCode;
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
      // The latest NAV is the first entry in the data array
      const latest = parsed.data[0];
      const previous = parsed.data.find((entry, index) => index > 0 && Number(entry.nav) > 0);
      res.json({
        schemeCode: schemeCode,
        schemeName: parsed.meta?.scheme_name || '',
        nav: parseFloat(latest.nav),
        prevNav: previous ? parseFloat(previous.nav) : null,
        date: latest.date
      });
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
