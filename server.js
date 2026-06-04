const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

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
      res.json({
        schemeCode: schemeCode,
        schemeName: parsed.meta?.scheme_name || '',
        nav: parseFloat(latest.nav),
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
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`Portfolio dashboard running on http://localhost:${PORT}`);
});
