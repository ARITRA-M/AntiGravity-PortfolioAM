// AntiGravity Portfolio — CORS proxy (Cloudflare Worker)
// ------------------------------------------------------------------
// The deployed dashboard (GitHub Pages) has no backend, so it must reach
// Yahoo Finance through a CORS proxy. The free public proxies it falls back to
// (corsproxy.io / allorigins / codetabs) are rate-limited and frequently return
// 403/522 — that's the root cause of "prices won't refresh on mobile".
//
// This Worker is a thin, allow-listed pass-through you own: it forwards
//   GET https://<your-worker>/?url=<encoded Yahoo URL>
// to Yahoo and returns the response with permissive CORS headers. It ONLY
// proxies Yahoo Finance hosts, so it can't be abused as a generic open proxy.
//
// Deploy: see README.md in this folder (≈2 minutes, free tier, no card).

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  // NSE's own index API — used as the primary source for Nifty index moves.
  // Unlike Yahoo, it always returns a complete, correct daily/30-day/365-day
  // change for every NSE index (Yahoo's series has multi-day gaps for several
  // sectoral indices). Requires a browser-like User-Agent (see below);
  // otherwise NSE returns a bot-block page instead of JSON.
  'www.nseindia.com',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: CORS });
    }

    let t;
    try { t = new URL(target); } catch {
      return new Response('Malformed ?url=', { status: 400, headers: CORS });
    }
    if (!ALLOWED_HOSTS.has(t.hostname)) {
      return new Response('Host not allowed: ' + t.hostname, { status: 403, headers: CORS });
    }

    try {
      // NSE rejects requests without a full browser User-Agent (+ Accept) with a
      // bot-challenge page instead of JSON; Yahoo doesn't care either way, so one
      // header set works for both.
      const isNse = t.hostname === 'www.nseindia.com';
      // Light edge caching (30s) smooths repeated quote lookups and reduces the
      // chance of rate-limiting during a full portfolio refresh.
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': isNse
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            : 'Mozilla/5.0',
          ...(isNse ? { 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/market-data/live-market-indices' } : {}),
        },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...CORS,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        },
      });
    } catch (e) {
      return new Response('Upstream error: ' + (e && e.message), { status: 502, headers: CORS });
    }
  },
};
