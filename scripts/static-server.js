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
      const execOpts = { cwd: ROOT, encoding: 'utf-8', timeout: 45000, maxBuffer: 10 * 1024 * 1024 };

      // 4a. git add -A
      execSync('git add -A', execOpts);
      results.push('git add -A');

      // 4b. git commit (only if there are staged changes)
      const stagedFiles = execSync('git diff --cached --name-only', execOpts).trim();
      if (stagedFiles) {
        execSync(`git commit -m "Update portfolio data ${todayStr}"`, execOpts);
        results.push(`git commit: "Update portfolio data ${todayStr}"`);
      } else {
        results.push('git commit: working tree already clean (no new staged changes)');
      }

      // 4c. Current branch
      const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();

      // 4d. Rebase on remote before push in case Cloudflare Worker or remote has new commits
      try {
        execSync(`git pull --rebase origin ${branch}`, execOpts);
        results.push(`git pull --rebase: synced with origin/${branch}`);
      } catch (pullErr) {
        console.warn('git pull --rebase note:', (pullErr.stderr || pullErr.message || '').toString().trim());
        try { execSync('git rebase --abort', execOpts); } catch (_) {}
      }

      // 4e. git push current branch
      const pushOut = execSync(`git push origin ${branch}`, execOpts).toString().trim();
      results.push(`git push (${branch}): ${pushOut.split('\n').pop() || 'ok'}`);

      // 4f. GitHub Pages deploys from `main`. If committing on another branch,
      // fast-forward `main` to this commit so the live site actually updates.
      if (branch !== 'main') {
        try {
          execSync(`git push origin ${branch}:main`, execOpts);
          results.push(`git push (${branch} → main): Pages deploy`);
        } catch (e) {
          results.push(`⚠️ could not fast-forward main: ${((e && (e.stderr || e.message)) || '').split('\n').pop()}`);
          throw e;
        }
      }

      console.log(`✅ ${results.join(' | ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '✅ Committed & pushed! GitHub Pages will update shortly.', details: results }));
    } catch (e) {
      const errMsg = (e && (e.stderr ? e.stderr.toString() : (e.stdout ? e.stdout.toString() : e.message))) || 'Unknown error';
      console.error('Commit failed:', errMsg);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Commit failed: ' + errMsg }));
    }
  });
}

// Handle pulling latest changes from GitHub (for local syncing).
function handleGitPull(req, res) {
  try {
    const execOpts = { cwd: ROOT, encoding: 'utf-8', timeout: 30000 };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();

    execSync('git fetch origin', execOpts);
    let output;
    try {
      output = execSync(`git pull origin ${branch}`, execOpts).trim();
    } catch (pullErr) {
      execSync('git checkout -- data/', execOpts);
      output = execSync(`git pull origin ${branch}`, execOpts).trim();
    }

    console.log(`✅ git pull successful: ${output.split('\n').pop() || 'ok'}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Successfully pulled latest changes', details: output }));
  } catch (e) {
    const errMsg = (e && (e.stderr || e.message)) || 'Unknown error';
    console.error('Git pull failed:', errMsg);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Git pull failed: ' + errMsg }));
  }
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
  // Commit & git-pull endpoints (localhost only).
  if (req.method === 'POST') {
    const route = req.url.split('?')[0];
    if (route === '/api/commit-data') return handleCommitData(req, res);
    if (route === '/api/git-pull') return handleGitPull(req, res);
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
