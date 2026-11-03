# CORS proxy & GitHub Commit (Cloudflare Worker)

A tiny proxy you own, so the dashboard stops depending on flaky public CORS
proxies for Yahoo Finance, NSE indices, and Groww SGB quotes, plus direct
GitHub commits from non-localhost devices (e.g. mobile PWA).

Free tier, no credit card, ~2 minutes.

---

## Deployment Options

### Option 1: Git-connected Deployment (Recommended if your Cloudflare Worker / Pages is connected to GitHub)
The repository includes `_worker.js` in the root directory. When Cloudflare deploys the GitHub repository, it automatically runs `_worker.js`:
- `?url=...` requests are proxied with CORS headers.
- `POST /api/commit-data` commits changes to GitHub using `GITHUB_TOKEN` and `GITHUB_REPO` secrets.
- All other requests serve the static dashboard assets.

Ensure the following Environment Variables / Secrets are set in Cloudflare:
- `GITHUB_TOKEN`: A GitHub Personal Access Token with repo permissions.
- `GITHUB_REPO`: `ARITRA-M/AntiGravity-PortfolioAM`
- `GITHUB_BRANCH`: `main`

---

### Option 2: Standalone Worker (Dashboard manual deploy)
If `portfolio-proxy` is set up as a standalone Worker in Cloudflare:
1. Log in to <https://dash.cloudflare.com>.
2. Go to **Workers & Pages** → select **portfolio-proxy**.
3. Click **Edit code** (or **Quick Edit**).
4. Replace the code with the contents of [`_worker.js`](../_worker.js) (or `cloudflare-worker/worker.js`).
5. Click **Deploy**.
6. Under **Settings** → **Variables and Secrets**, ensure `GITHUB_TOKEN` and `GITHUB_REPO` are configured.

---

## Configuration in the App

The dashboard defaults to:
```js
let WORKER_PROXY_URL = 'https://portfolio-proxy.aritra2k7.workers.dev/';
```
in `js/api.js`.

To test or override per-device in the browser console:
```js
localStorage.setItem('ag_portfolio_worker_proxy', 'https://portfolio-proxy.aritra2k7.workers.dev/');
location.reload();
```
To test falling back to public CORS proxies:
```js
localStorage.removeItem('ag_portfolio_worker_proxy');
```
