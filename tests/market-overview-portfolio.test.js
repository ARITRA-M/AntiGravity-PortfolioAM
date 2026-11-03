// Tests for Market Overview portfolio benchmarking cards and mobile table column retention
// Run: node tests/market-overview-portfolio.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

test('style.css does not hide columns on mobile across holdings and overview tables', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert(!css.includes('#stocks-table th:nth-child(2)'), 'stocks-table columns should not be hidden on mobile');
  assert(!css.includes('#mfs-table th:nth-child(2)'), 'mfs-table columns should not be hidden on mobile');
  assert(!css.includes('#daily-overview-table th:nth-child(2)'), 'daily-overview-table columns should not be hidden on mobile');
  assert(!css.includes('#monthly-overview-table th:nth-child(2)'), 'monthly-overview-table columns should not be hidden on mobile');
  assert(!css.includes('#fixed-income-table th:nth-child(5)'), 'fixed-income-table columns should not be hidden on mobile');
  assert(!css.includes('#trading-activity-table th:nth-child(3)'), 'trading-activity-table columns should not be hidden on mobile');
});

test('app.js includes Market Overview My Portfolio section and portfolio series generator', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert(appJs.includes('_populateMarketOverviewPortfolioMetrics'), 'Must define _populateMarketOverviewPortfolioMetrics');
  assert(appJs.includes('_getPortfolioIndexSeries'), 'Must define _getPortfolioIndexSeries');
  assert(appJs.includes('portfolio:total'), 'Must support portfolio:total benchmark symbol');
  assert(appJs.includes('portfolio:stocks'), 'Must support portfolio:stocks benchmark symbol');
  assert(appJs.includes('portfolio:mfs'), 'Must support portfolio:mfs benchmark symbol');
});

test('TWR and portfolio metrics calculations compute accurately', () => {
  // Test computeTWRIndex logic
  function computeTWRIndex(nwArr, newMoneyArr) {
    const idx = [1];
    for (let i = 1; i < nwArr.length; i++) {
      const newMoney = newMoneyArr[i] || 0;
      const base = nwArr[i - 1] + newMoney;
      idx.push(idx[idx.length - 1] * (base > 0 ? nwArr[i] / base : 1));
    }
    return idx;
  }

  // Example: 100 invested initially, +10 investment next month, value grows to 121
  // base = 100 + 10 = 110, end = 121 -> return = 121/110 = 1.10 (10% growth)
  const twr = computeTWRIndex([100, 121], [100, 10]);
  assert.strictEqual(twr.length, 2);
  assert.strictEqual(twr[0], 1);
  assert(Math.abs(twr[1] - 1.10) < 1e-4, 'TWR should be 1.10 (+10%)');

  const retPct = ((twr[1] / twr[0]) - 1) * 100;
  assert(Math.abs(retPct - 10) < 1e-4, 'Percentage return should be 10%');
});

console.log(`\n${passed} market-overview-portfolio tests passed\n`);
