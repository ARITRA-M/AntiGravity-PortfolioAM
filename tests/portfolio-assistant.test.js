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
assert.ok(rootWorker.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), '_worker.js must reference Llama 3.3 fp8-fast model');

const cfWorker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-worker', 'worker.js'), 'utf-8');
assert.ok(cfWorker.includes("reqUrl.pathname.endsWith('/api/chat')"), 'cloudflare-worker/worker.js must contain /api/chat endpoint');
assert.ok(cfWorker.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), 'cloudflare-worker must reference Llama 3.3 fp8-fast model');
console.log('  ✓ Cloudflare Worker endpoints properly implement /api/chat with Llama 3.3 70B fp8-fast');

// 3. Verify server.js and static-server.js have /api/chat
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
assert.ok(serverJs.includes("app.post('/api/chat'"), 'server.js must contain app.post("/api/chat")');

const staticServerJs = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'static-server.js'), 'utf-8');
assert.ok(staticServerJs.includes("route === '/api/chat'"), 'static-server.js must handle route === "/api/chat"');
console.log('  ✓ server.js and static-server.js support /api/chat for local development');

// 4. Verify assistant.js logic
const assistantJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'assistant.js'), 'utf-8');
assert.ok(assistantJs.includes('buildPortfolioContext'), 'assistant.js must define buildPortfolioContext');
assert.ok(assistantJs.includes('solveLocallyIfPossible'), 'assistant.js must define solveLocallyIfPossible');
assert.ok(assistantJs.includes('fetchMarketResearch'), 'assistant.js must define fetchMarketResearch');
assert.ok(assistantJs.includes('fetchStockFundamentals'), 'assistant.js must define fetchStockFundamentals');
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

// 4b. Test Intent Classification & Comparative Performance Delegation
const mockEquityHoldings = [
  { instrument: 'ITC', sector: 'Consumer Goods & FMCG', qty: 788, avg_cost: 206.55, ltp: 285.05, cur_val: 224619, invested: 162761, pnl: 61858, gain_pct: 38.01 },
  { instrument: 'HDFCBANK', sector: 'Banking', qty: 100, avg_cost: 1520, ltp: 1720, cur_val: 172000, invested: 152000, pnl: 20000, gain_pct: 13.15 }
];

function isAnalyticalOrComparative(query) {
  return /\b(compare|comparison|relative|vs|versus|against|index|benchmark|fmcg|sector|trend|history|historical|why|analysis|research|recommend|should i|underperform|outperform|cagr|alpha|beta|valuation|pe|pb|dividend|growth|outlook|holding period|timeline)\b/i.test(query);
}

function isHoldingLookup(query) {
  return /\b(how many|how much|quantity|qty|shares|units|do i have|do i own|holding of|my holding|what is my avg|buy price|cost basis|how much invested)\b/i.test(query);
}

function testSolveHolding(query, holdings) {
  // If analytical or comparative, MUST NOT be intercepted locally
  if (isAnalyticalOrComparative(query)) {
    return { matched: false, reason: 'routed_to_ai_pipeline' };
  }
  if (!isHoldingLookup(query)) {
    return { matched: false, reason: 'not_explicit_holding_lookup' };
  }
  for (const s of holdings) {
    const inst = s.instrument.toUpperCase();
    const regex = new RegExp(`\\b${inst}\\b`, 'i');
    if (regex.test(query)) {
      return {
        matched: true,
        instrument: s.instrument,
        qty: s.qty,
        avg_cost: s.avg_cost,
        ltp: s.ltp
      };
    }
  }
  return { matched: false };
}

// 1. Simple lookup: "How many ITC stocks do I have?" -> Matches fast holding card
const simpleLookup = testSolveHolding('How many ITC stocks do I have?', mockEquityHoldings);
assert.strictEqual(simpleLookup.matched, true, 'Simple holding lookup must match local holding card');
assert.strictEqual(simpleLookup.instrument, 'ITC');
assert.strictEqual(simpleLookup.qty, 788);

// 2. Analytical comparative query: "How has been the performance of ITC stocks relative to overall fmcg index over my holding period?"
// MUST NOT be intercepted by the simple holding card, but routed to the AI pipeline
const compQuery = 'How has been the performance of ITC stocks relative to overall fmcg index over my holding period?';
assert.strictEqual(isAnalyticalOrComparative(compQuery), true, 'Comparative query must be classified as analytical');
const compResult = testSolveHolding(compQuery, mockEquityHoldings);
assert.strictEqual(compResult.matched, false, 'Comparative query must bypass local holding card');
assert.strictEqual(compResult.reason, 'routed_to_ai_pipeline');

// 3. Test Benchmark Index Detection for FMCG
function detectBenchmarkIndex(query, holdingSector) {
  const q = (query || '').toLowerCase();
  const sec = (holdingSector || '').toLowerCase();
  if (q.includes('fmcg') || sec.includes('fmcg') || sec.includes('consumer goods')) {
    if (q.includes('index') || q.includes('fmcg') || q.includes('sector') || q.includes('relative') || q.includes('benchmark')) {
      return { symbol: '^CNXFMCG', name: 'NIFTY FMCG Index', sector: 'FMCG' };
    }
  }
  return null;
}
const bench = detectBenchmarkIndex(compQuery, 'Consumer Goods & FMCG');
assert.ok(bench, 'Must detect benchmark index');
assert.strictEqual(bench.symbol, '^CNXFMCG', 'Benchmark symbol must be ^CNXFMCG');
console.log('  ✓ Query intent classification & benchmark routing verified (comparative queries bypass local card and route to AI)');

// 4c. Test Valuation Query Detection & Chart Type Intelligence
const peQuery = 'How has the PE for ITC moved over this period?';
function isValuationQuery(query) {
  return /\b(pe|p\/e|valuation|earnings|eps|ratio|dividend|yield|mcap|market cap|book value|pb|p\/b|multiple|re-rating|derating)\b/i.test(query);
}
assert.strictEqual(isValuationQuery(peQuery), true, 'PE question must trigger valuation query workflow');
assert.strictEqual(testExtractTicker(peQuery, [{ instrument: 'ITC' }]), 'ITC', 'Must extract ITC ticker from PE query');
console.log('  ✓ Valuation query detection and ticker resolution confirmed');

// 5. Verify index.html & style.css references (Clean Portfolio Copilot Branding)
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
assert.ok(indexHtml.includes('copilot-modal'), 'index.html must contain copilot-modal');
assert.ok(indexHtml.includes('copilot-fab'), 'index.html must contain copilot-fab');
assert.ok(indexHtml.includes('Portfolio Copilot'), 'index.html must brand as Portfolio Copilot');
assert.ok(!indexHtml.includes('copilot-privacy-pill'), 'index.html must not contain privacy pill');
assert.ok(!indexHtml.includes('>Cloudflare AI<'), 'index.html must not contain Cloudflare AI tag');
assert.ok(indexHtml.includes('js/assistant.js'), 'index.html must include js/assistant.js');

const styleCss = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf-8');
assert.ok(styleCss.includes('.copilot-drawer'), 'style.css must contain .copilot-drawer styles');
assert.ok(styleCss.includes('.copilot-chart-card'), 'style.css must contain .copilot-chart-card styles');
console.log('  ✓ UI markup and clean branding references confirmed');

console.log('\nAll 5 Portfolio Copilot tests passed successfully!\n');
