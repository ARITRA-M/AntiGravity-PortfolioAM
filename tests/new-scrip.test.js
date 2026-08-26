// Tests for adding new MF and Stock scrips (js/ledger.js)
// Run: node tests/new-scrip.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const lsStorage = {};
const sandbox = {
  console,
  window: undefined,
  localStorage: {
    getItem: (k) => lsStorage[k] || null,
    setItem: (k, v) => { lsStorage[k] = String(v); },
    removeItem: (k) => { delete lsStorage[k]; }
  },
  document: undefined,
  SECTOR_MAP: { TCS: 'IT & Software Services' },
  dynamicMfCategories: {},
  dynamicStockSectors: {},
  dynamicMarketCaps: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ledger.js'), 'utf8'), sandbox);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

const base = {
  baseDate: '2025-01-01',
  equity: [],
  mf: [],
  stockLakhs: 0,
  mfLakhs: 0,
  goldLakhs: 0,
  npsELakhs: 0,
  totalLakhs: 0
};

test('deriveHoldings adds a new stock with custom sector', () => {
  sandbox.dynamicStockSectors['ZOMATO'] = 'Consumer Tech';
  const txns = [
    {
      id: 't_test1',
      date: '2025-02-01',
      assetClass: 'stock',
      instrument: 'ZOMATO',
      type: 'buy',
      qty: 100,
      price: 250,
      amount: 25000,
      sector: 'Consumer Tech',
      folded: false
    }
  ];

  const holdings = sandbox.deriveHoldings(base, txns);
  assert.strictEqual(holdings.equity.length, 1);
  assert.strictEqual(holdings.equity[0].instrument, 'ZOMATO');
  assert.strictEqual(holdings.equity[0].qty, 100);
  assert.strictEqual(holdings.equity[0].avg_cost, 250);
  assert.strictEqual(holdings.equity[0].sector, 'Consumer Tech');
});

test('deriveHoldings adds a new mutual fund with category', () => {
  sandbox.dynamicMfCategories['Nippon India Small Cap Fund Direct-Growth'] = 'Equity: Small Cap';
  const txns = [
    {
      id: 't_test2',
      date: '2025-02-01',
      assetClass: 'mf',
      instrument: 'Nippon India Small Cap Fund Direct-Growth',
      type: 'buy',
      qty: 500,
      price: 120,
      amount: 60000,
      category: 'Equity: Small Cap',
      folded: false
    }
  ];

  const holdings = sandbox.deriveHoldings(base, txns);
  assert.strictEqual(holdings.mf.length, 1);
  assert.strictEqual(holdings.mf[0].scheme, 'Nippon India Small Cap Fund Direct-Growth');
  assert.strictEqual(holdings.mf[0].qty, 500);
  assert.strictEqual(holdings.mf[0].price, 120);
  assert.strictEqual(holdings.mf[0].scheme_type, 'Equity: Small Cap');
});

test('addTransaction saves transaction with category and sector', () => {
  const txn = sandbox.addTransaction({
    date: '2025-02-15',
    assetClass: 'stock',
    instrument: 'HAL',
    type: 'buy',
    qty: 10,
    price: 4500,
    amount: 45000,
    sector: 'Defence & Aerospace'
  });

  assert.strictEqual(txn.instrument, 'HAL');
  assert.strictEqual(txn.sector, 'Defence & Aerospace');
  const storedTxns = JSON.parse(lsStorage['ag_portfolio_ledger_transactions'] || '[]');
  assert.ok(storedTxns.some(t => t.instrument === 'HAL' && t.sector === 'Defence & Aerospace'));
});

test('MF scheme matcher picks exact IDCW scheme over Growth scheme when requested', () => {
  const list = [
    { schemeCode: 120044, schemeName: 'HSBC Global Emerging Markets Fund - Direct Plan - IDCW' },
    { schemeCode: 120043, schemeName: 'HSBC Global Emerging Markets Fund - Direct Plan - Growth' },
    { schemeCode: 107989, schemeName: 'HSBC Global Emerging Markets Fund - Regular Plan - IDCW' },
    { schemeCode: 107988, schemeName: 'HSBC Global Emerging Markets Fund - Regular Plan - Growth' }
  ];

  const targetName = 'HSBC Global Emerging Markets Fund - Direct Plan - IDCW';
  const rawLower = targetName.trim().toLowerCase();
  const exact = list.find(r => r.schemeName.trim().toLowerCase() === rawLower);
  assert.ok(exact);
  assert.strictEqual(exact.schemeCode, 120044);
});

console.log(`\n${passed} new scrip tests passed\n`);
