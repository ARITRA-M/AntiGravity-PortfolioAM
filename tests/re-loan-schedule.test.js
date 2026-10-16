// Tests for Real Estate installment and Home Loan schedule tracking
// Run: node tests/re-loan-schedule.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const lsStorage = {};
const sandbox = {
  console,
  window: {},
  localStorage: {
    getItem: (k) => lsStorage[k] || null,
    setItem: (k, v) => { lsStorage[k] = String(v); },
    removeItem: (k) => { delete lsStorage[k]; }
  },
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  Chart: function() { return { destroy: () => {} }; },
  breakupSummary: {
    dates: ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'],
    net_worth: {
      'Real Estate (Property)': { values: [10.50, 36.48, 36.48, 130.64, 130.64, 130.64] },
      'Home Loan (Liability)': { values: [0.00, -25.74, -25.74, -116.90, -106.90, -106.90] }
    },
    new_investment: {
      'Real Estate (Property)': { values: [10.50, 0.24, 0.00, 0.90, 0.00, 0.00] },
      'Home Loan (Liability)': { values: [0.09, 0.15, 0.17, 2.83, 10.00, 0.00] }
    }
  },
  balances: [],
  transactions: []
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

// Load ledger.js
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ledger.js'), 'utf8'), sandbox);

// Extract and run _getDynamicHomeLoanSchedule logic
const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Helper to evaluate schedule inside sandbox
function evalSchedule(mockPropLakhs, mockLoanLakhs, customBalances) {
  sandbox.balances = customBalances || [];
  sandbox._liveOpaqueLakhs = (comp) => {
    if (comp === 'RE-PROP') return mockPropLakhs;
    if (comp === 'LOAN-HOME') return mockLoanLakhs;
    return 0;
  };
  return vm.runInContext(`(${appJs.match(/function _getDynamicHomeLoanSchedule\(\) \{[\s\S]*?\n\}/)[0]})()`, sandbox);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

test('September baseline matches historical snapshot values', () => {
  const sched = evalSchedule(130.64, -106.90, []);
  const sep = sched.find(r => r.period === 'Sep 2026');
  assert(sep, 'September row exists');
  assert.strictEqual(sep.propVal, 130.64);
  assert.strictEqual(sep.loanVal, 106.90);
  assert.strictEqual(sep.disbursedBank, 119.00);
  assert.strictEqual(sep.disbursedSelf, 11.64);
  assert.strictEqual(sep.repaymentSelf, 12.10);
  assert.strictEqual(sep.equity, 23.74);
});

test('Current period installment with bank disbursement updates Disbursed Bank and preserves Disbursed Self', () => {
  // Installment demand: Gross Property reaches 148.63 L (+17.99 L demand).
  // Loan Liability becomes -124.90 L (bank disbursed 18.00 L).
  // User tried to update loan balance to -124.90 L.
  const sched = evalSchedule(148.63, -124.90, [
    { component: 'RE-PROP', date: '2026-10-15', value: 14863000, contribution: 0 },
    { component: 'LOAN-HOME', date: '2026-10-15', value: -12490000, contribution: 0, interest: 64000 }
  ]);
  const curr = sched.find(r => r.period === 'Current');
  assert(curr, 'Current row exists');
  assert.strictEqual(curr.propVal, 148.63);
  assert.strictEqual(curr.loanVal, 124.90);
  // Total Disbursed Bank should be 119.00 + 18.00 = 137.00 L
  assert.strictEqual(curr.disbursedBank, 137.00);
  // Total Disbursed Self should remain ~11.63 L, NOT inflated to 29.63 L
  assert.strictEqual(Number(curr.disbursedSelf.toFixed(2)), 11.63);
  // Repayment Self should remain 12.10 L, NOT dropping to negative or 0
  assert.strictEqual(curr.repaymentSelf, 12.10);
  // Net Equity should be 148.63 - 124.90 = +23.73 L
  assert.strictEqual(Number(curr.equity.toFixed(2)), 23.73);
});

test('Negative LOAN-HOME contribution legacy workaround is sanitized and does not corrupt repayment', () => {
  // If user previously entered -1800000 contribution trying to force negative balance
  const sched = evalSchedule(148.63, -124.90, [
    { component: 'LOAN-HOME', date: '2026-10-15', value: -12490000, contribution: -1800000, interest: 64000 }
  ]);
  const curr = sched.find(r => r.period === 'Current');
  assert(curr, 'Current row exists');
  assert.strictEqual(curr.disbursedBank, 137.00);
  assert.strictEqual(curr.repaymentSelf, 12.10);
});

test('Subsequent partial self and partial bank payment correctly splits equity and disbursements', () => {
  // Future milestone: Gross Property becomes 158.63 L (+10 L demand).
  // Bank disbursed 8 L (Loan becomes 132.90 L).
  // Self paid 2 L.
  const sched = evalSchedule(158.63, -132.90, [
    { component: 'RE-PROP', date: '2026-11-15', value: 15863000, contribution: 200000 },
    { component: 'LOAN-HOME', date: '2026-11-15', value: -13290000, contribution: 0, interest: 64000 }
  ]);
  const curr = sched.find(r => r.period === 'Current');
  assert(curr, 'Current row exists');
  assert.strictEqual(curr.disbursedBank, 145.00); // 137 + 8
  assert.strictEqual(Number(curr.disbursedSelf.toFixed(2)), 13.63); // 11.63 + 2
  assert.strictEqual(Number(curr.equity.toFixed(2)), 25.73); // 23.73 + 2
});

console.log(`\n${passed} re-loan-schedule tests passed`);
