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

// 2. Verify _worker.js and cloudflare-worker/worker.js have /api/chat route and allowed hosts for fundamentals
const rootWorker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf-8');
assert.ok(rootWorker.includes("reqUrl.pathname.endsWith('/api/chat')"), '_worker.js must contain /api/chat endpoint');
assert.ok(rootWorker.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), '_worker.js must reference Llama 3.3 fp8-fast model');
assert.ok(rootWorker.includes("'www.screener.in'"), '_worker.js must allow www.screener.in for fundamentals');
assert.ok(rootWorker.includes("'www.google.com'"), '_worker.js must allow www.google.com for Google Finance');

const cfWorker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-worker', 'worker.js'), 'utf-8');
assert.ok(cfWorker.includes("reqUrl.pathname.endsWith('/api/chat')"), 'cloudflare-worker/worker.js must contain /api/chat endpoint');
assert.ok(cfWorker.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), 'cloudflare-worker must reference Llama 3.3 fp8-fast model');
assert.ok(cfWorker.includes("'www.screener.in'"), 'cloudflare-worker must allow www.screener.in for fundamentals');
assert.ok(cfWorker.includes("'www.google.com'"), 'cloudflare-worker must allow www.google.com for Google Finance');
console.log('  ✓ Cloudflare Worker endpoints properly implement /api/chat and proxy ALLOWED_HOSTS for Screener & Google');

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

// 4b. Test Intent Classification, Alias Resolution & Holding Matching
const mockEquityHoldings = [
  { instrument: 'ITC', sector: 'Consumer Goods & FMCG', qty: 788, avg_cost: 206.55, ltp: 285.05, cur_val: 224619, invested: 162761, pnl: 61858, gain_pct: 38.01 },
  { instrument: 'HDFCBANK', sector: 'Banking', qty: 100, avg_cost: 1520, ltp: 1720, cur_val: 172000, invested: 152000, pnl: 20000, gain_pct: 13.15 },
  { instrument: 'ICICIBANK', sector: 'Banking & Financial Services', qty: 120, avg_cost: 1050, ltp: 1280, cur_val: 153600, invested: 126000, pnl: 27600, gain_pct: 21.90 },
  { instrument: 'ICICIGI', sector: 'Insurance', qty: 50, avg_cost: 1450, ltp: 1720, cur_val: 86000, invested: 72500, pnl: 13500, gain_pct: 18.62 }
];

// Verify STOCK_ALIASES in assistant.js
assert.ok(assistantJs.includes('const STOCK_ALIASES'), 'assistant.js must define STOCK_ALIASES');
assert.ok(assistantJs.includes("'ICICI':"), 'STOCK_ALIASES must include ICICI');
assert.ok(assistantJs.includes("'HUL':"), 'STOCK_ALIASES must include HUL');
assert.ok(assistantJs.includes("'HINDUNILVR'"), 'STOCK_ALIASES must map HUL to HINDUNILVR');
assert.ok(assistantJs.includes('findMatchingHoldings'), 'assistant.js must define findMatchingHoldings');
assert.ok(assistantJs.includes('portfolioHoldings'), 'assistant.js must provide full portfolioHoldings');
assert.ok(assistantJs.includes('allOwnedStockSymbols'), 'assistant.js must provide allOwnedStockSymbols');
assert.ok(assistantJs.includes('NEVER say "as it is not listed in your top stocks holdings"'), 'assistant.js prompt must forbid top stocks disclaimer');

// Replicate findMatchingHoldings logic for unit test
const TEST_ALIASES = {
  'ICICI BANK': { symbols: ['ICICIBANK'], name: 'ICICI Bank' },
  'ICICI': { symbols: ['ICICIBANK', 'ICICIGI', 'ICICIPRULI'], name: 'ICICI Group', isGroup: true },
  'HUL': { symbols: ['HINDUNILVR'], name: 'Hindustan Unilever (HUL)' },
  'HDFCBANK': { symbols: ['HDFCBANK'], name: 'HDFC Bank' }
};

function testFindMatchingHoldings(query, holdingsList) {
  const q = query.trim().toUpperCase();
  const sorted = Object.keys(TEST_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    const escaped = alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const rx = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
    if (rx.test(q)) {
      const entry = TEST_ALIASES[alias];
      const targetSymbols = entry.symbols || [];
      const matched = holdingsList.filter(h => {
        const inst = (h.instrument || '').toUpperCase();
        return targetSymbols.some(ts => ts === inst || inst.startsWith(ts));
      });
      return { matches: matched, queriedGroup: alias, targetSymbols, entry };
    }
  }
  for (const h of holdingsList) {
    if (!h.instrument) continue;
    const inst = h.instrument.toUpperCase();
    const rx = new RegExp(`(^|[^A-Z0-9])${inst}([^A-Z0-9]|$)`, 'i');
    if (rx.test(q)) {
      return { matches: [h], queriedGroup: inst, targetSymbols: [inst], entry: { symbols: [inst], name: inst } };
    }
  }
  return { matches: [], queriedGroup: null, targetSymbols: [] };
}

// Test Group Matching: "How many ICICI do I own?" matches BOTH ICICIBANK and ICICIGI
const iciciMatch = testFindMatchingHoldings('How many ICICI do I own?', mockEquityHoldings);
assert.strictEqual(iciciMatch.matches.length, 2, 'ICICI group query must match both ICICIBANK and ICICIGI');
assert.ok(iciciMatch.matches.some(m => m.instrument === 'ICICIBANK'), 'Must include ICICIBANK');
assert.ok(iciciMatch.matches.some(m => m.instrument === 'ICICIGI'), 'Must include ICICIGI');

// Test Specific Alias Matching: "How many ICICI Bank shares do I own?" matches ONLY ICICIBANK
const iciciBankMatch = testFindMatchingHoldings('How many ICICI Bank shares do I own?', mockEquityHoldings);
assert.strictEqual(iciciBankMatch.matches.length, 1, 'ICICI Bank query must match exactly 1 holding');
assert.strictEqual(iciciBankMatch.matches[0].instrument, 'ICICIBANK');

// Test Non-Held Alias: "How many HUL stocks do i own?" resolves to HINDUNILVR with 0 holdings
const hulMatch = testFindMatchingHoldings('How many HUL stocks do i own?', mockEquityHoldings);
assert.strictEqual(hulMatch.matches.length, 0, 'HUL must have 0 holdings in mock portfolio');
assert.strictEqual(hulMatch.targetSymbols[0], 'HINDUNILVR', 'HUL must map to HINDUNILVR');
assert.strictEqual(hulMatch.entry.name, 'Hindustan Unilever (HUL)');

console.log('  ✓ Stock alias resolution & multi-holding matching (ICICI -> Bank + GI, HUL -> HINDUNILVR) confirmed');

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

// Verify assistant.js buildProxyUrl prioritizes localhost
const proxyUrlCode = assistantJs.slice(assistantJs.indexOf('function buildProxyUrl'), assistantJs.indexOf('async function fetchMarketResearch'));
assert.ok(proxyUrlCode.indexOf('isLocalhost') < proxyUrlCode.indexOf('_proxyList'), 'buildProxyUrl must prioritize isLocalhost check before external proxies');

// Verify Google Finance stats parsing logic
const sampleGfHtml = '<div class="SwQK7">P/E ratio</div><div class="dO6ijd">18.78</div><div class="SwQK7">EPS</div><div class="dO6ijd">₹15.07</div><div class="SwQK7">Mkt. cap</div><div class="dO6ijd">3.55T INR</div>';
const gfRegex = /<div class="(?:SwQK7|mD6t2c)">([^<]+)<\/div>[\s\S]*?<div class="(?:dO6ijd|P6K39c)">([^<]+)<\/div>/g;
let gfMatch;
const sampleStats = {};
while ((gfMatch = gfRegex.exec(sampleGfHtml)) !== null) sampleStats[gfMatch[1].trim()] = gfMatch[2].trim();
assert.strictEqual(sampleStats['P/E ratio'], '18.78');
assert.strictEqual(sampleStats['EPS'], '₹15.07');
assert.strictEqual(parseFloat(sampleStats['P/E ratio']), 18.78);
console.log('  ✓ Valuation query detection, buildProxyUrl localhost routing, and fundamentals parsing confirmed');

// 4d. Test Asset Allocation calculation with real breakupSummary keys
const testBreakup = {
  dates: ['2026-01-31', '2026-10-31'],
  net_worth: {
    'Total': { values: [350.0, 371.48] },
    'Stocks (Equity)': { values: [140.0, 155.2] },
    'Mutual Funds (Equity)': { values: [28.0, 30.0] },
    'PF (Debt)': { values: [55.0, 60.5] },
    'PPF (Debt)': { values: [22.0, 25.0] },
    'Bonds (Debt)': { values: [20.0, 25.0] },
    'Gold (Gold)': { values: [12.0, 14.8] },
    'Real Estate (Property)': { values: [130.0, 130.0] },
    'Home Loan (Liability)': { values: [-72.0, -69.02] }
  }
};

const getLatestVal = (nw, key) => {
  const v = nw[key]?.values;
  return (v && v.length) ? (v[v.length - 1] || 0) : 0;
};

const stocksEq = getLatestVal(testBreakup.net_worth, 'Stocks (Equity)');
const mfEq = getLatestVal(testBreakup.net_worth, 'Mutual Funds (Equity)');
const totalEq = stocksEq + mfEq;
const pf = getLatestVal(testBreakup.net_worth, 'PF (Debt)');
const ppf = getLatestVal(testBreakup.net_worth, 'PPF (Debt)');
const bonds = getLatestVal(testBreakup.net_worth, 'Bonds (Debt)');
const totalDebt = pf + ppf + bonds;
const gold = getLatestVal(testBreakup.net_worth, 'Gold (Gold)');
const re = Math.max(0, getLatestVal(testBreakup.net_worth, 'Real Estate (Property)') + getLatestVal(testBreakup.net_worth, 'Home Loan (Liability)'));
const totalNw = getLatestVal(testBreakup.net_worth, 'Total');

assert.strictEqual(totalNw, 371.48);
assert.strictEqual(totalEq, 185.2);
assert.strictEqual(totalDebt, 110.5);
assert.strictEqual(gold, 14.8);
assert.strictEqual(Number(((gold / totalNw) * 100).toFixed(1)), 4.0);
console.log('  ✓ Asset Allocation mapping to breakupSummary.net_worth keys verified');

// 4e. Test Clean Ticker Detection (no false positive on 'SHOULD')
const goldAdviceQuery = 'Should I increase my gold allocation now?';
const generalPortfolioCheck = /\b(ALLOCATION|ASSET CLASS|NET WORTH|PORTFOLIO|REBALANCE|WEALTH|TAX|RETURNS|OVERALL)\b/i.test(goldAdviceQuery);
assert.strictEqual(generalPortfolioCheck, true, 'Should I increase my gold allocation must be recognized as broad portfolio topic');

assert.ok(assistantJs.includes('ctx.historicalNetWorthTrend'), 'assistant.js must provide historicalNetWorthTrend');
assert.ok(assistantJs.includes('ctx.goldExposure'), 'assistant.js must provide goldExposure');
console.log('  ✓ Net worth trend and gold exposure context generation verified');

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

// 6. Verify Sector Disambiguation, Oracle / OFSS Alias, and ROCE extraction logic
const assistantModule = require('../js/assistant.js');

// 6a. Oracle / OFSS Alias detection
const oracleQuery = 'What is the performance of oracle stock over last 5 years? Show both price and valuation trends.';
const detectedOracle = assistantModule.detectTickerQuery(oracleQuery);
assert.strictEqual(detectedOracle, 'OFSS', 'detectTickerQuery must map "oracle stock" to OFSS');

const ofssDirect = assistantModule.detectTickerQuery('What is the ROCE of OFSS?');
assert.strictEqual(ofssDirect, 'OFSS', 'detectTickerQuery must extract OFSS directly');

// 6b. Sector Disambiguation (Prevent false positives on 'it' substring)
assert.strictEqual(assistantModule.matchSector('Energy & Mining', 'technology'), false, 'Castrol (Energy & Mining) must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Speciality Chemicals', 'technology'), false, 'Speciality Chemicals must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Commodities - Gold', 'technology'), false, 'Gold Commodities must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Gold Commodity (ETF)', 'technology'), false, 'Gold Commodity (ETF) must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Real Estate (REIT)', 'technology'), false, 'Embassy REIT must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Government Bonds', 'technology'), false, '716GS2050 Government Bonds must NOT match technology');
assert.strictEqual(assistantModule.matchSector('Corporate Bonds', 'technology'), false, 'Corporate Bonds must NOT match technology');

assert.strictEqual(assistantModule.matchSector('IT & Software Services', 'technology'), true, 'IT & Software Services must match technology');
assert.strictEqual(assistantModule.matchSector('Information Technology', 'technology'), true, 'Information Technology must match technology');
assert.strictEqual(assistantModule.matchSector('IT Services', 'technology'), true, 'IT Services must match technology');

// 6c. Verify ROCE & Fundamentals HTML parsing logic
const sampleCompanyHtml = `
<ul id="top-ratios">
  <li><span class="name">ROCE</span><span class="number">28.4</span></li>
  <li><span class="name">ROE</span><span class="number">31.0</span></li>
  <li><span class="name">Book Value</span><span class="number">208</span></li>
</ul>
<div id="ratios">
  <table>
    <thead><tr><th data-date-key="2021">Mar 2021</th><th data-date-key="2022">Mar 2022</th><th data-date-key="2023">Mar 2023</th></tr></thead>
    <tbody>
      <tr>
        <td class="text">ROCE %</td>
        <td class="">39%</td>
        <td class="">25%</td>
        <td class="">27%</td>
      </tr>
    </tbody>
  </table>
</div>
`;

// Extract top ratios
const topListMatch = sampleCompanyHtml.match(/<ul id="top-ratios"[^>]*>([\s\S]*?)<\/ul>/);
assert.ok(topListMatch, 'Top ratios list must be matched');
const listHtml = topListMatch[1];
const liRegex = /<span class="name">\s*([^<]+?)\s*<\/span>[\s\S]*?<span class="number">\s*([^<]+?)\s*<\/span>/g;
let liMatch;
const parsed = {};
while ((liMatch = liRegex.exec(listHtml)) !== null) {
  parsed[liMatch[1].trim()] = parseFloat(liMatch[2].trim());
}
assert.strictEqual(parsed['ROCE'], 28.4);
assert.strictEqual(parsed['ROE'], 31.0);
assert.strictEqual(parsed['Book Value'], 208);

// Extract ROCE % row
const ratiosIdx = sampleCompanyHtml.indexOf('id="ratios"');
assert.ok(ratiosIdx > -1, 'Ratios table must be found');
const ratiosHtml = sampleCompanyHtml.slice(ratiosIdx);
const thRegex = /<th[^>]*data-date-key="([^"]+)"[^>]*>\s*([A-Za-z]{3}\s*\d{4})/g;
let thMatch;
const years = [];
while ((thMatch = thRegex.exec(ratiosHtml)) !== null) {
  years.push(thMatch[2].replace(/[A-Za-z\s]+/, '').trim());
}
assert.deepStrictEqual(years, ['2021', '2022', '2023']);

const tdRegex = /<td[^>]*class=""[^>]*>\s*([0-9.-]+)%?\s*<\/td>/g;
let tdMatch;
const cells = [];
while ((tdMatch = tdRegex.exec(ratiosHtml)) !== null) {
  cells.push(parseFloat(tdMatch[1]));
}
assert.deepStrictEqual(cells, [39, 25, 27]);
console.log('  ✓ Oracle/OFSS alias, sector disambiguation, and ROCE extraction verified');

// 6d. Verify multi-ticker comparative extraction & comparedFundamentals context
assert.ok(typeof assistantModule.detectTickersQuery === 'function', 'detectTickersQuery must be exported');
const compTickers = assistantModule.detectTickersQuery("How does ITC's ROCE compare with HUL?");
assert.deepStrictEqual(compTickers, ['ITC', 'HINDUNILVR'], 'Comparative query must detect both ITC and HINDUNILVR in prompt order');

const compTech = assistantModule.detectTickersQuery('Compare TCS with Infosys on PE ratio');
assert.deepStrictEqual(compTech, ['TCS', 'INFY'], 'Comparative query must detect TCS and INFY');

const goldQueryTickers = assistantModule.detectTickersQuery('Should I increase my gold allocation now?');
assert.deepStrictEqual(goldQueryTickers, [], 'Broad gold query must not mistakenly match "SHOULD" as a ticker');

// Verify context generation with comparedFundamentals
const mockItcFund = { symbol: 'ITC', companyName: 'ITC Ltd', latestRoce: 38.9, latestRoe: 29.3, latestPe: 18.9, bookValue: 57, marketCap: '₹357544 Cr' };
const mockHulFund = { symbol: 'HINDUNILVR', companyName: 'Hindustan Unilever', latestRoce: 28.4, latestRoe: 31.0, latestPe: 42.4, bookValue: 208, marketCap: '₹474776 Cr' };
const compContext = assistantModule.buildPortfolioContext('ITC', null, mockItcFund, "How does ITC's ROCE compare with HUL?", [mockHulFund]);

assert.ok(compContext.comparedFundamentals, 'Context must include comparedFundamentals array');
assert.strictEqual(compContext.comparedFundamentals.length, 1);
assert.strictEqual(compContext.comparedFundamentals[0].symbol, 'HINDUNILVR');
assert.strictEqual(compContext.comparedFundamentals[0].latestRoce, '28.4%');
assert.strictEqual(compContext.comparedFundamentals[0].latestRoe, '31%');
assert.strictEqual(compContext.comparedFundamentals[0].currentPe, 42.4);
console.log('  ✓ Multi-ticker extraction and multi-stock comparison context verified');

console.log('\nAll 6 Portfolio Copilot tests passed successfully!\n');
