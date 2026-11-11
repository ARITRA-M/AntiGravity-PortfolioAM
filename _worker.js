// AntiGravity Portfolio — CORS proxy & GitHub Commit (Cloudflare Worker)
// ------------------------------------------------------------------
// Acts as both a CORS proxy (Yahoo Finance, NSE, Groww) and a GitHub Commit endpoint.
// In Cloudflare Pages / Workers with Static Assets, this root `_worker.js` intercepts
// incoming requests. If the request has ?url=... or /api/commit-data, it handles it.
// Otherwise, it delegates to env.ASSETS to serve the static dashboard.

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  // NSE's own index API — used as the primary source for Nifty index moves.
  'www.nseindia.com',
  // Groww's public price API — for Sovereign Gold Bond tranche quotes.
  'groww.in',
  // Screener.in & Google Finance — for valuation fundamentals, P/E ratios, EPS, and 5Y median
  'www.screener.in',
  'screener.in',
  'www.google.com',
  'google.com',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const reqUrl = new URL(request.url);

    // --- 1. GitHub Commit API Endpoint ---
    if (request.method === 'POST' && reqUrl.pathname.endsWith('/api/commit-data')) {
      try {
        const payload = await request.json();

        const repo = (env && env.GITHUB_REPO) || 'ARITRA-M/AntiGravity-PortfolioAM';
        const branch = (env && env.GITHUB_BRANCH) || 'main';
        const token = (env && env.GITHUB_TOKEN) || request.headers.get('X-GitHub-Token') || payload.github_token;

        if (!token) {
          return new Response(JSON.stringify({
            success: false,
            needsToken: true,
            error: 'GitHub token (GITHUB_TOKEN) not configured in Cloudflare Dashboard.'
          }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }

        const headers = {
          'Authorization': `Bearer ${token}`,
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
        const ALLOWED_SAVE_KEYS = new Set([
          'portfolio_summary', 'breakup_summary', 'latest_equity', 'latest_mf', 'historical_holdings',
          'ledger_transactions', 'ledger_balances', 'ledger_frozen_base',
        ]);
        const tree = [];
        for (const [key, value] of Object.entries(payload)) {
          if (ALLOWED_SAVE_KEYS.has(key)) {
            tree.push({
              path: `data/${key}.json`,
              mode: '100644',
              type: 'blob',
              content: JSON.stringify(value, null, 2)
            });
          }
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
          details: [`Commit ${newCommitSha.substring(0, 7)}`]
        }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
    }

    // --- 2. Cloudflare Workers AI Chat Endpoint ---
    if (request.method === 'POST' && reqUrl.pathname.endsWith('/api/chat')) {
      try {
        const payload = await request.json();
        const { messages, model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast', systemPrompt } = payload;

        if (!env || !env.AI) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Cloudflare Workers AI binding (env.AI) not configured. Add "ai": { "binding": "AI" } to wrangler.json.'
          }), { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }

        const chatMessages = [];
        if (systemPrompt) {
          chatMessages.push({ role: 'system', content: systemPrompt });
        }
        if (Array.isArray(messages)) {
          chatMessages.push(...messages);
        }

        let aiResult;
        try {
          aiResult = await env.AI.run(model, {
            messages: chatMessages,
            max_tokens: 1200,
            temperature: 0.3
          });
        } catch (mErr) {
          // Graceful fallback to 8B model if 70B is congested or throttled
          if (model !== '@cf/meta/llama-3.1-8b-instruct-fp8') {
            aiResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
              messages: chatMessages,
              max_tokens: 1200,
              temperature: 0.3
            });
          } else {
            throw mErr;
          }
        }

        const reply = typeof aiResult === 'string'
          ? aiResult
          : (aiResult.response || aiResult.text || JSON.stringify(aiResult));

        return new Response(JSON.stringify({
          success: true,
          response: reply
        }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // --- 2. CORS Proxy Endpoint ---
    const target = reqUrl.searchParams.get('url');
    if (target) {
      let t;
      try { t = new URL(target); } catch {
        return new Response('Malformed ?url=', { status: 400, headers: CORS });
      }
      if (!ALLOWED_HOSTS.has(t.hostname)) {
        return new Response('Host not allowed: ' + t.hostname, { status: 403, headers: CORS });
      }

      try {
        const isNse = t.hostname === 'www.nseindia.com';
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
    }

    // --- 3. Static Asset Serving (Pages / Workers with Assets) ---
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Missing ?url= parameter', { status: 400, headers: CORS });
  },
};
