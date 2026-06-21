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
      // Light edge caching (30s) smooths repeated quote lookups and reduces the
      // chance of Yahoo rate-limiting during a full portfolio refresh.
      const upstream = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
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
