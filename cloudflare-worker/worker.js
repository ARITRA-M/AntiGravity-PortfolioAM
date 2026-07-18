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
  // Groww's public price API — the only free source for Sovereign Gold Bond
  // tranche quotes (Yahoo doesn't list SGB tickers at all, and the GOLDBEES
  // proxy understates them by ~20%).
  'groww.in',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const reqUrl = new URL(request.url);
    
    // --- New: GitHub Commit API Endpoint ---
    if (request.method === 'POST' && reqUrl.pathname.endsWith('/api/commit-data')) {
      try {
        const payload = await request.json();
        
        // Ensure secrets are configured
        if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
          return new Response(JSON.stringify({
            success: false, 
            error: 'GitHub secrets (GITHUB_TOKEN, GITHUB_REPO) not configured in Cloudflare Dashboard.'
          }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }
        
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const headers = {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'AntiGravity-Cloudflare-Worker'
        };

        // 1. Get current branch ref
        let res = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, { headers });
        if (!res.ok) throw new Error('Failed to get branch ref: ' + await res.text());
        const refData = await res.json();
        const baseSha = refData.object.sha;

        // 2. Get the commit the branch points to
        res = await fetch(`https://api.github.com/repos/${repo}/git/commits/${baseSha}`, { headers });
        if (!res.ok) throw new Error('Failed to get base commit: ' + await res.text());
        const commitData = await res.json();
        const treeSha = commitData.tree.sha;

        // 3. Create a new tree with the updated files
        const tree = [];
        for (const [key, value] of Object.entries(payload)) {
          tree.push({
            path: `data/${key}.json`,
            mode: '100644',
            type: 'blob',
            content: JSON.stringify(value, null, 2)
          });
        }

        res = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ base_tree: treeSha, tree })
        });
        if (!res.ok) throw new Error('Failed to create tree: ' + await res.text());
        const newTreeData = await res.json();
        const newTreeSha = newTreeData.sha;

        // 4. Create a new commit
        res = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: `Portfolio Sync via Cloudflare Worker`,
            tree: newTreeSha,
            parents: [baseSha]
          })
        });
        if (!res.ok) throw new Error('Failed to create commit: ' + await res.text());
        const newCommitData = await res.json();
        const newCommitSha = newCommitData.sha;

        // 5. Update the reference
        res = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ sha: newCommitSha })
        });
        if (!res.ok) throw new Error('Failed to update ref: ' + await res.text());

        return new Response(JSON.stringify({
          success: true,
          message: 'Synced to GitHub successfully',
          details: [`Commit ${newCommitSha.substring(0,7)}`]
        }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
    }
    // ---------------------------------------

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
