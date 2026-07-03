// Tests for computeXirr (js/ledger.js) — the highest-risk math in the app.
// Run: node tests/compute-xirr.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ledger.js is a browser script; evaluate it in a sandbox with just enough
// globals stubbed for the top-level code to run.
const sandbox = {
  console,
  window: undefined,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ledger.js'), 'utf8'), sandbox);
const computeXirr = sandbox.computeXirr;
assert.strictEqual(typeof computeXirr, 'function', 'computeXirr not found');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}
const close = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b}`);

test('single flow returns null', () => {
  assert.strictEqual(computeXirr([{ date: '2025-01-01', amount: -100 }]), null);
});

test('all-negative flows return null', () => {
  assert.strictEqual(computeXirr([
    { date: '2025-01-01', amount: -100 },
    { date: '2025-06-01', amount: -100 },
  ]), null);
});

test('exact one-year 10% gain', () => {
  // Invest 100, worth 110 exactly 365.25 days later → 10.0%
  const x = computeXirr([
    { date: '2025-01-01T00:00:00Z', amount: -100 },
    { date: new Date(Date.UTC(2025, 0, 1) + 365.25 * 86400 * 1000).toISOString(), amount: 110 },
  ]);
  close(x, 0.10);
});

test('loss case: -20% over one year', () => {
  const x = computeXirr([
    { date: '2025-01-01T00:00:00Z', amount: -100 },
    { date: new Date(Date.UTC(2025, 0, 1) + 365.25 * 86400 * 1000).toISOString(), amount: 80 },
  ]);
  close(x, -0.20);
});

test('two-year doubling ≈ 41.42% annualized', () => {
  const x = computeXirr([
    { date: '2024-01-01T00:00:00Z', amount: -100 },
    { date: new Date(Date.UTC(2024, 0, 1) + 2 * 365.25 * 86400 * 1000).toISOString(), amount: 200 },
  ]);
  close(x, Math.SQRT2 - 1, 1e-3);
});

test('multiple contributions: NPV at returned rate ≈ 0', () => {
  const flows = [
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-07-01', amount: -500 },
    { date: '2025-01-01', amount: -500 },
    { date: '2025-12-31', amount: 2300 },
  ];
  const x = computeXirr(flows);
  assert.ok(x != null && x > 0 && x < 1, `implausible xirr ${x}`);
  const t0 = new Date(flows[0].date).getTime();
  const npv = flows.reduce((s, f) =>
    s + f.amount / Math.pow(1 + x, (new Date(f.date).getTime() - t0) / (365.25 * 86400 * 1000)), 0);
  close(npv, 0, 0.01);
});

console.log(`\n${passed} computeXirr tests passed`);
