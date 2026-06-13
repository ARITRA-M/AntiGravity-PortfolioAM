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

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8080;

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
