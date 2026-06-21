# CORS proxy (Cloudflare Worker)

A tiny proxy you own, so the dashboard stops depending on flaky public CORS
proxies for Yahoo Finance. Fixes "prices won't refresh on mobile."

Free tier, no credit card, ~2 minutes.

## Deploy (dashboard, no CLI)

1. Sign up / log in at <https://dash.cloudflare.com>.
2. **Workers & Pages** → **Create** → **Create Worker**.
3. Name it (e.g. `portfolio-proxy`) → **Deploy**.
4. **Edit code** → replace the sample with the contents of [`worker.js`](worker.js) → **Deploy**.
5. Copy the Worker URL — looks like `https://portfolio-proxy.<your-subdomain>.workers.dev`.

## Point the app at it

Either of these (no redeploy needed for option A):

**A. Per-device (quickest):** open the dashboard, open the browser console, run:

```js
localStorage.setItem('ag_portfolio_worker_proxy', 'https://portfolio-proxy.YOURNAME.workers.dev');
location.reload();
```

**B. Everywhere (bake into the build):** set `WORKER_PROXY_URL` near the top of
`js/api.js` to your Worker URL, then commit. All devices use it automatically.

The Worker is tried **first**; the public proxies remain as automatic fallback,
so nothing breaks if the Worker is ever unavailable.

## Notes

- The Worker only forwards to `query1/query2.finance.yahoo.com` — it can't be
  abused as a generic open proxy.
- Cloudflare's free tier allows 100k requests/day; a portfolio refresh is a
  handful of requests, so you'll never approach the limit.
- MF NAVs (mfapi.in) already send open CORS headers and are fetched directly —
  they don't go through any proxy.
