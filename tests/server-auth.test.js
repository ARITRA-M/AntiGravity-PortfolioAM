const assert = require('assert');
const http = require('http');

const app = require('../server');

function request(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body
  });
}

async function run() {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const blockedData = await request(baseUrl, '/data/portfolio_summary.json');
    assert.strictEqual(blockedData.status, 401, 'portfolio data should require auth');

    const blockedApi = await request(baseUrl, '/api/live-stock-price/INFY');
    assert.strictEqual(blockedApi.status, 401, 'live API should require auth');

    const badLogin = await request(baseUrl, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    });
    assert.strictEqual(badLogin.status, 401, 'bad password should be rejected');

    const goodLogin = await request(baseUrl, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.DASHBOARD_PASSWORD || 'Portfolio2026!' })
    });
    assert.strictEqual(goodLogin.status, 200, 'correct password should unlock session');

    const cookie = goodLogin.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('portfolio_session='), 'login should set session cookie');

    const unlockedData = await request(baseUrl, '/data/portfolio_summary.json', {
      headers: { Cookie: cookie }
    });
    assert.strictEqual(unlockedData.status, 200, 'unlocked session should read portfolio data');

    const parsed = await unlockedData.json();
    assert.ok(parsed.total_net_worth_lakhs > 0, 'portfolio summary should parse as JSON');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
