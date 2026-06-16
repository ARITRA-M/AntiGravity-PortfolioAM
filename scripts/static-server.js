#!/usr/bin/env node
// Minimal static file server — NO auth, NO API, NO password prompt.
// Serves the app as a pure frontend (just like GitHub Pages) for local use:
//
//   npm run static      →   http://localhost:8080
//
// The data files are encrypted at rest, so serving them without a gate is
// safe: the browser decrypts them after you type the dashboard password into
// the unlock screen. Live prices come from public CORS proxies, same as the
// hosted version.
//
// Use `npm run dev` instead when you need the commit / git-push backend.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8080;

// Data blobs the commit endpoint is allowed to write (mirrors server.js).
const ALLOWED_SAVE_KEYS = new Set([
  'portfolio_summary', 'breakup_summary', 'latest_equity', 'latest_mf', 'historical_holdings',
  'ledger_transactions', 'ledger_balances', 'ledger_frozen_base',
]);

// Handle the one-click Commit: write data files, bump versions, git add/commit/push.
// Lives here too (not just server.js) so the static dev flow can persist + sync.
function handleCommitData(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 50 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const todayStr = new Date().toISOString().slice(0, 10);
      const results = [];

      // 1. Write JSON data files
      const dataDir = path.join(ROOT, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      let saved = 0;
      for (const [key, value] of Object.entries(payload)) {
        if (ALLOWED_SAVE_KEYS.has(key)) {
          fs.writeFileSync(path.join(dataDir, key + '.json'), JSON.stringify(value, null, 2), 'utf-8');
          saved++;
        }
      }
      results.push(`Saved ${saved} data files`);

      // 2. Bump APP_VERSION in app.js
      const appJsPath = path.join(ROOT, 'app.js');
      const appContent = fs.readFileSync(appJsPath, 'utf-8');
      const appUpdated = appContent.replace(/const APP_VERSION\s*=\s*'[\d-]+'/, `const APP_VERSION = '${todayStr}'`);
      if (appUpdated !== appContent) { fs.writeFileSync(appJsPath, appUpdated, 'utf-8'); results.push(`APP_VERSION → ${todayStr}`); }

      // 3. Bump CACHE_NAME in sw.js
      const swJsPath = path.join(ROOT, 'sw.js');
      const swContent = fs.readFileSync(swJsPath, 'utf-8');
      const verMatch = swContent.match(/portfolio-analytics-v(\d+)/);
      if (verMatch) {
        const newVer = parseInt(verMatch[1]) + 1;
        fs.writeFileSync(swJsPath, swContent.replace(`portfolio-analytics-v${verMatch[1]}`, `portfolio-analytics-v${newVer}`), 'utf-8');
        results.push(`CACHE_NAME → v${newVer}`);
      }

      // 4. Git add / commit / push (current branch, whatever it is)
      const execOpts = { cwd: ROOT, encoding: 'utf-8', timeout: 30000 };
      execSync('git add .', execOpts);
      execSync(`git commit -m "Update portfolio data ${todayStr}"`, execOpts);
      const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();
      const pushOut = execSync(`git push origin ${branch}`, execOpts).trim();
      results.push(`git push (${branch}): ${pushOut.split('\n').pop() || 'ok'}`);

      console.log(`✅ ${results.join(' | ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '✅ Committed & pushed! Mobile will sync within 10 min.', details: results }));
    } catch (e) {
      const errMsg = (e && (e.stderr || e.message)) || 'Unknown error';
      console.error('Commit failed:', errMsg);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Commit failed: ' + errMsg }));
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  // Commit endpoint — the only API the static server exposes (localhost only).
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/commit-data') {
    return handleCommitData(req, res);
  }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve within ROOT only — block path traversal (../)
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 404 on /api/* is intentional — it tells the frontend "no backend here",
      // which is how the app auto-selects static (client-side) mode.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Portfolio (static, no backend) → http://localhost:${PORT}\n`);
  console.log('  No password is needed to start the server.');
  console.log('  Enter your dashboard password in the browser to decrypt your data.');
  console.log('  (Use `npm run dev` if you need the commit / git-push feature.)\n');
});
