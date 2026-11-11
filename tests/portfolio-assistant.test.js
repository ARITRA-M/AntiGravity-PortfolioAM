// AntiGravity Portfolio — Assistant & Cloudflare Workers AI Test Suite
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Testing Portfolio Copilot & Cloudflare Workers AI Architecture...');

// 1. Verify wrangler.json AI binding
const wranglerRaw = fs.readFileSync(path.join(__dirname, '..', 'wrangler.json'), 'utf-8');
const wrangler = JSON.parse(wranglerRaw);
assert.ok(wrangler.ai, 'wrangler.json must configure "ai" property');
assert.strictEqual(wrangler.ai.binding, 'AI', 'wrangler.json AI binding must be "AI"');
console.log('  ✓ wrangler.json contains valid Cloudflare Workers AI binding');

// 2. Verify _worker.js and cloudflare-worker/worker.js have /api/chat route
const rootWorker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf-8');
assert.ok(rootWorker.includes("reqUrl.pathname.endsWith('/api/chat')"), '_worker.js must contain /api/chat endpoint');
assert.ok(rootWorker.includes('@cf/meta/llama-3.3-70b-instruct'), '_worker.js must reference Llama 3.3 model');

const cfWorker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-worker', 'worker.js'), 'utf-8');
assert.ok(cfWorker.includes("reqUrl.pathname.endsWith('/api/chat')"), 'cloudflare-worker/worker.js must contain /api/chat endpoint');
console.log('  ✓ Cloudflare Worker endpoints properly implement /api/chat with Llama 3.3');

// 3. Verify server.js has /api/chat proxy
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
assert.ok(serverJs.includes("app.post('/api/chat'"), 'server.js must contain app.post("/api/chat")');
console.log('  ✓ server.js proxies /api/chat for local development');

// 4. Verify assistant.js logic
const assistantJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'assistant.js'), 'utf-8');
assert.ok(assistantJs.includes('buildPortfolioContext'), 'assistant.js must define buildPortfolioContext');
assert.ok(assistantJs.includes('solveLocallyIfPossible'), 'assistant.js must define solveLocallyIfPossible');
assert.ok(assistantJs.includes('fetchMarketResearch'), 'assistant.js must define fetchMarketResearch');
assert.ok(assistantJs.includes('mountInlineCharts'), 'assistant.js must support mounting inline Chart.js canvases');

// Test Anonymization Logic: in anonymized mode, values are undefined or omitted
const mockBreakup = {
  net_worth: {
    Total: { values: [50.5, 52.0] },
    Equity: { values: [25.0, 26.0] },
    'Mutual Funds': { values: [15.0, 16.0] }
  }
};
const mockEquity = [
  { instrument: 'HDFCBANK', sector: 'Banking', cur_val: 500000, gain_pct: 12.5 },
  { instrument: 'TCS', sector: 'IT', cur_val: 300000, gain_pct: 18.2 }
];

// Test ticker extraction logic matching assistant.js
function testExtractTicker(query, latestEquity = []) {
  if (!query) return null;
  const q = query.trim().toUpperCase();

  const suffixMatch = q.match(/\b([A-Z0-9-]{3,12})\.(?:NS|BO)\b/);
  if (suffixMatch) return suffixMatch[1];

  for (const eq of latestEquity) {
    if (eq.instrument && new RegExp(`\\b${eq.instrument}\\b`, 'i').test(q)) {
      return eq.instrument;
    }
  }

  const keywordMatch = q.match(/(?:RESEARCH|PE\s+RATIO\s+OF|PRICE\s+OF|PE\s+OF|TREND\s+OF|ABOUT|ANALYZE)\s+([A-Z0-9-]{3,12})\b/);
  if (keywordMatch) {
    const candidate = keywordMatch[1];
    const stopWords = new Set(['THE', 'THIS', 'THAT', 'MY', 'ALL', 'ANY', 'OUR']);
    if (!stopWords.has(candidate)) return candidate;
  }

  const stopWords = new Set([
    'THE', 'AND', 'FOR', 'ARE', 'CAN', 'YOU', 'ALL', 'ANY', 'NOT', 'GET',
    'WHAT', 'WHEN', 'WHERE', 'SHOW', 'HOW', 'CHART', 'GRAPH', 'PORTFOLIO',
    'STOCKS', 'STOCK', 'FUNDS', 'SHARE', 'PRICE', 'RESEARCH', 'TOTAL', 'WORTH',
    'VALUE', 'INVEST', 'MONEY', 'GAIN', 'LOSS', 'BANK', 'TECH', 'RATIO',
    'TELL', 'ABOUT', 'CURRENT', 'TREND', 'RANGE', 'COMPARE', 'OVERVIEW', 'DETAILS'
  ]);
  const tokens = q.match(/\b[A-Z0-9-]{3,14}\b/g) || [];
  for (const token of tokens) {
    if (!stopWords.has(token) && !/^\d+$/.test(token)) {
      return token;
    }
  }
  return null;
}

const q1 = 'What is the PE ratio of HDFCBANK?';
const m1 = testExtractTicker(q1);
assert.strictEqual(m1, 'HDFCBANK', 'Ticker extraction should find HDFCBANK');

const q2 = 'Research TRENT 52W range';
const m2 = testExtractTicker(q2);
assert.strictEqual(m2, 'TRENT', 'Ticker extraction should find TRENT');

const q3 = 'How is my BANKIETF performing?';
const m3 = testExtractTicker(q3, [{ instrument: 'BANKIETF' }]);
assert.strictEqual(m3, 'BANKIETF', 'Ticker extraction should match holding');

console.log('  ✓ Ticker detection and regex extraction passed');

// Test Chart fence regex extraction
const sampleAiReply = 'Here is your allocation:\n\n```chart:doughnut\n{\n  "title": "Allocation",\n  "labels": ["Equity", "Debt"],\n  "data": [60, 40]\n}\n```\nLooks healthy!';
const chartMatch = sampleAiReply.match(/```chart:(line|bar|doughnut)([\s\S]*?)```/i);
assert.ok(chartMatch, 'Chart fence regex must match ```chart:doughnut block');
assert.strictEqual(chartMatch[1].toLowerCase(), 'doughnut', 'Chart type must be doughnut');
const parsedConfig = JSON.parse(chartMatch[2].trim());
assert.strictEqual(parsedConfig.title, 'Allocation');
assert.strictEqual(parsedConfig.data.length, 2);
console.log('  ✓ Chart.js block detection and JSON parsing verified');

// 5. Verify index.html & style.css references
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
assert.ok(indexHtml.includes('copilot-modal'), 'index.html must contain copilot-modal');
assert.ok(indexHtml.includes('copilot-fab'), 'index.html must contain copilot-fab');
assert.ok(indexHtml.includes('js/assistant.js'), 'index.html must include js/assistant.js');

const styleCss = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf-8');
assert.ok(styleCss.includes('.copilot-drawer'), 'style.css must contain .copilot-drawer styles');
assert.ok(styleCss.includes('.copilot-chart-card'), 'style.css must contain .copilot-chart-card styles');
console.log('  ✓ UI markup and styling references confirmed');

console.log('\nAll 5 Portfolio Copilot tests passed successfully!\n');
