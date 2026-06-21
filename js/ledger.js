// ─────────────────────────────────────────────────────────────────────────
// Ledger module — incremental transaction & balance entry
//
// Replaces the monthly Excel upload. The user records individual buy/sell
// transactions (stocks/MFs) and periodic balance updates (NPS, PF, PPF, Bonds,
// Gold, Cash, Crypto). Current holdings are DERIVED as:
//
//     current holdings = frozen opening snapshot  ±  transactions since
//
// The frozen snapshot is the last Excel-era month (baseDate), captured once and
// never recomputed. New monthly data points are appended via closeMonth()
// (see Phase 2 — computeXirr / closeMonth).
//
// Cross-file note: top-level declarations are shared across <script>s in the
// same realm, so functions here may reference app.js globals (SECTOR_MAP,
// getStockHistoryKey, buildPortfolioSummary, …) at call time even though
// ledger.js loads first — they are evaluated only at runtime, after app.js ran.
// ─────────────────────────────────────────────────────────────────────────

// Persisted ledger state (also mirrored to localStorage and the git commit).
let transactions = [];   // [{ id, date, assetClass:'stock'|'mf', instrument, type:'buy'|'sell', qty, price, amount, category?, note }]
let balances = [];       // [{ id, date, component, value, contribution, note }]
let frozenBase = null;   // { baseDate, equity:[...], mf:[...] }  — immutable opening positions

// The nine opaque (non-tradeable) components, in Breakup row order.
const OPAQUE_COMPONENTS = ['NPS-E', 'NPS-C', 'NPS-G', 'PF', 'PPF', 'Bonds', 'Gold', 'Cash', 'Crypto'];

// Map an opaque component code → its Breakup net_worth key + asset_type.
const COMPONENT_BREAKUP = {
  'NPS-E': { key: 'NPS E (Equity)', label: 'NPS E', asset_type: 'Equity' },
  'NPS-C': { key: 'NPS C (Debt)', label: 'NPS C', asset_type: 'Debt' },
  'NPS-G': { key: 'NPS G (Debt)', label: 'NPS G', asset_type: 'Debt' },
  'PF':    { key: 'PF (Debt)', label: 'PF', asset_type: 'Debt' },
  'PPF':   { key: 'PPF (Debt)', label: 'PPF', asset_type: 'Debt' },
  'Bonds': { key: 'Bonds (Debt)', label: 'Bonds', asset_type: 'Debt' },
  'Gold':  { key: 'Gold (Gold)', label: 'Gold', asset_type: 'Gold' },
  'Cash':  { key: 'Cash (Liquid)', label: 'Cash', asset_type: 'Liquid' },
  'Crypto':{ key: 'Crypto (Alternate)', label: 'Crypto', asset_type: 'Alternate' },
};

const LEDGER_KEYS = {
  transactions: 'ledger_transactions',
  balances: 'ledger_balances',
  frozenBase: 'ledger_frozen_base',
};

// ── Persistence ──────────────────────────────────────────────────────────
function saveLedger() {
  try {
    const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
    localStorage.setItem(P + LEDGER_KEYS.transactions, JSON.stringify(transactions));
    localStorage.setItem(P + LEDGER_KEYS.balances, JSON.stringify(balances));
    if (frozenBase) localStorage.setItem(P + LEDGER_KEYS.frozenBase, JSON.stringify(frozenBase));
  } catch (e) {
    console.warn('Failed to persist ledger:', e);
  }
}

function loadLedger() {
  try {
    const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
    transactions = JSON.parse(localStorage.getItem(P + LEDGER_KEYS.transactions) || '[]');
    balances = JSON.parse(localStorage.getItem(P + LEDGER_KEYS.balances) || '[]');
    const fb = localStorage.getItem(P + LEDGER_KEYS.frozenBase);
    frozenBase = fb ? JSON.parse(fb) : null;
  } catch (e) {
    console.warn('Failed to load ledger:', e);
    transactions = []; balances = []; frozenBase = null;
  }
}

// One-time migration: capture the current Excel-era holdings as the immutable
// opening snapshot. Called once when the ledger is first initialised (no
// frozenBase yet) and live holdings exist. baseDate = latest breakup date.
// Look up the closing price for an instrument at baseDate from historicalHoldings.
// Returns null if not found (caller should fall back to current ltp).
function _histBasePriceEq(instrument, baseDate) {
  const h = (typeof historicalHoldings !== 'undefined') && historicalHoldings?.stocks?.[instrument];
  if (!h?.history?.length) return null;
  const entry = [...h.history].reverse().find(p => p.date <= baseDate);
  return entry?.ltp ?? null;
}
function _histBasePriceMf(scheme, baseDate) {
  const h = (typeof historicalHoldings !== 'undefined') && historicalHoldings?.mfs?.[scheme];
  if (!h?.history?.length) return null;
  const entry = [...h.history].reverse().find(p => p.date <= baseDate);
  return entry?.ltp ?? null; // historicalHoldings.mfs stores price as .ltp
}

function initFrozenBaseFromCurrent() {
  if (frozenBase) return frozenBase; // already migrated
  if (!latestEquity || !latestMf || !breakupSummary) return null;
  const dates = breakupSummary.dates || [];
  const baseDate = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  const nw = breakupSummary.net_worth || {};
  const _last = (key) => { const v = nw[key]?.values || []; return v.length ? v[v.length-1] : 0; };
  frozenBase = {
    baseDate,
    stockLakhs: _last('Stocks (Equity)'),
    mfLakhs:    _last('Mutual Funds (Equity)'),
    npsELakhs:  _last('NPS E (Equity)'),
    totalLakhs: _last('Total'),
    equity: latestEquity.map(s => ({
      instrument: s.instrument, sector: s.sector, qty: s.qty,
      avg_cost: s.avg_cost, invested: s.invested,
      // basePrice MUST equal the snapshot price (current ltp) at baseDate. Then on a
      // fresh load Σ(qty×basePrice) == Σ(qty×ltp), and the reconciliation gap bridges
      // exactly to the breakup baseline (stockLakhs). Using a historical-lookup price
      // here instead introduced mismatches (bonds→0, stale SGB prices) that leaked a
      // phantom gain into net worth.
      basePrice: s.ltp,
    })),
    mf: latestMf.map(f => ({
      scheme: f.scheme, scheme_type: f.scheme_type, qty: f.qty,
      avg_nav: f.avg_nav, invested: f.invested,
      basePrice: f.price,
    })),
    _snapshotBase: true,
  };
  saveLedger();
  return frozenBase;
}

// Repair a frozenBase that was created with the old historical-lookup basePrices
// (basePricesFromHistory) or with null baseline lakhs. Rebuilds each holding's
// basePrice from the current snapshot price (latestEquity/latestMf, which on a
// fresh load are the base-date prices) and populates the baseline lakhs from the
// breakup last column. This is the fix for the phantom +2L net-worth gain caused
// when Σ(qty×basePrice) didn't equal Σ(qty×ltp) at the base date.
//
// Safe because integrateLedger() runs this at load time, BEFORE any price refresh,
// so latestEquity[].ltp still holds the committed base-date snapshot prices.
function repairFrozenBasePrices() {
  if (!frozenBase || !latestEquity || !latestMf) return;
  // Already a clean snapshot base with populated lakhs → nothing to do.
  if (frozenBase._snapshotBase && frozenBase.totalLakhs != null) return;

  const eqLtp = new Map(latestEquity.map(s => [s.instrument, s.ltp]));
  const mfPx  = new Map(latestMf.map(f => [f.scheme, f.price]));
  (frozenBase.equity || []).forEach(s => {
    const p = eqLtp.get(s.instrument);
    if (p != null) s.basePrice = p;
  });
  (frozenBase.mf || []).forEach(f => {
    const p = mfPx.get(f.scheme);
    if (p != null) f.basePrice = p;
  });

  // Populate / correct baseline lakhs from the breakup last column.
  if (breakupSummary) {
    const nw = breakupSummary.net_worth || {};
    const _last = k => { const v = nw[k]?.values || []; return v.length ? v[v.length - 1] : 0; };
    frozenBase.stockLakhs = _last('Stocks (Equity)');
    frozenBase.mfLakhs    = _last('Mutual Funds (Equity)');
    frozenBase.npsELakhs  = _last('NPS E (Equity)');
    frozenBase.totalLakhs = _last('Total');
  }

  delete frozenBase.basePricesFromHistory;
  frozenBase._snapshotBase = true;
  saveLedger();
  if (typeof uploadedSnapshot !== 'undefined') uploadedSnapshot = null;
  console.log('[ledger] Rebuilt frozenBase basePrices from snapshot + baseline lakhs from breakup.');
}

// Wire the ledger into the load flow. Safe to call after latestEquity/latestMf/
// breakupSummary are populated and initializeLiveBaseline() has run.
//   • loads persisted ledger
//   • captures the immutable frozen base on first run (one-time migration)
//   • if any transactions exist, re-derives current holdings from base + txns
// Until the user records their first transaction, holdings are unchanged.
function integrateLedger() {
  loadLedger();

  const serverLastDate = (breakupSummary?.dates || []).slice(-1)[0] || '';

  // Discard a frozenBase whose baseDate lies beyond the last server breakup date.
  // This happens when a spurious auto-close (e.g. triggered before the year-month
  // guard was in place) wrote a stale frozenBase to localStorage, causing net worth
  // to be computed from gap-free raw sums instead of the Excel-anchored total.
  if (frozenBase && frozenBase.baseDate > serverLastDate) {
    console.warn('[ledger] Discarding stale frozenBase (baseDate', frozenBase.baseDate,
      '> server last', serverLastDate, '). Will rebuild from current state.');
    frozenBase = null;
    try {
      const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
      localStorage.removeItem(P + LEDGER_KEYS.frozenBase);
    } catch (_) {}
  }

  // Apply any locally-closed periods (closeMonth appends clean columns the
  // server copy doesn't have yet). Only accept override periods that represent
  // a genuinely NEW calendar month — not just a different day in the same month
  // (which could arise from month-start vs month-end date format mismatches).
  const override = loadBreakupOverride();
  if (override && breakupSummary && override.dates) {
    const overrideLast = override.dates[override.dates.length - 1] || '';
    if (overrideLast.slice(0, 7) > serverLastDate.slice(0, 7)) {
      breakupSummary = override;
      if (typeof buildPortfolioSummary === 'function') portfolioSummary = buildPortfolioSummary(breakupSummary);
    }
  }

  if (!frozenBase) initFrozenBaseFromCurrent();
  // Repair a contaminated frozenBase (history-lookup basePrices and/or null
  // baseline lakhs) so net worth reconciles to the breakup baseline. No-op once
  // the frozenBase is a clean snapshot base. repairFrozenBasePrices() resets
  // uploadedSnapshot itself when it changes anything.
  repairFrozenBasePrices();
  if (frozenBase && transactions && transactions.length) {
    applyLedgerToHoldings();
  }
  // Always re-run baseline after frozenBase is set up. The first call in loadData()
  // runs before loadLedger() populates frozenBase (it's null then), so basePrice
  // falls back to current ltp → thisMonthGain = 0. This corrects that.
  if (frozenBase && typeof initializeLiveBaseline === 'function') initializeLiveBaseline();
}

// Persist / load the post-closeMonth breakup so appended periods survive reload
// until the user commits to disk.
function saveBreakupOverride() {
  try {
    const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
    localStorage.setItem(P + 'ledger_breakup_override', JSON.stringify(breakupSummary));
  } catch (e) { console.warn('Failed to persist breakup override:', e); }
}
function loadBreakupOverride() {
  try {
    const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
    const raw = localStorage.getItem(P + 'ledger_breakup_override');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearBreakupOverride() {
  try {
    const P = (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_';
    localStorage.removeItem(P + 'ledger_breakup_override');
  } catch (e) { /* ignore */ }
}

// ── ID + lookup helpers ────────────────────────────────────────────────────
function newId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Resolve a transaction's instrument name to an existing holding key, folding
// renamed tickers via the app's canonical lookup when available.
function canonicalInstrument(name, assetClass) {
  if (assetClass === 'stock' && typeof getStockHistoryKey === 'function') {
    return getStockHistoryKey(name) || name;
  }
  return name;
}

// ── Holdings derivation ────────────────────────────────────────────────────
// Returns { equity:[...], mf:[...] } in the same shape app.js consumes:
//   equity item: { instrument, sector, qty, avg_cost, ltp, invested, cur_val, pnl, gain_pct, realized_pnl }
//   mf item:     { scheme, scheme_type, qty, price, avg_nav, invested, cur_val, pnl, gain_pct, realized_pnl }
function deriveHoldings(base, txns) {
  base = base || frozenBase;
  txns = txns || transactions;
  if (!base) return { equity: [], mf: [] };

  // Seed maps from the frozen opening snapshot.
  const eq = new Map();   // instrument -> holding
  const mf = new Map();   // scheme -> holding
  (base.equity || []).forEach(s => {
    eq.set(s.instrument, {
      instrument: s.instrument, sector: s.sector, qty: s.qty,
      avg_cost: s.avg_cost, ltp: s.ltp, invested: s.invested,
      cur_val: s.qty * s.ltp, pnl: s.qty * s.ltp - s.invested,
      gain_pct: s.invested > 0 ? (s.qty * s.ltp - s.invested) / s.invested : 0,
      realized_pnl: 0,
    });
  });
  (base.mf || []).forEach(f => {
    mf.set(f.scheme, {
      scheme: f.scheme, scheme_type: f.scheme_type, qty: f.qty,
      avg_nav: f.avg_nav, price: f.price, invested: f.invested,
      cur_val: f.qty * f.price, pnl: f.qty * f.price - f.invested,
      gain_pct: f.invested > 0 ? (f.qty * f.price - f.invested) / f.invested : 0,
      realized_pnl: 0,
    });
  });

  // Apply transactions in chronological order (only those after the frozen base).
  const ordered = [...txns]
    .filter(t => !base.baseDate || t.date > base.baseDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  ordered.forEach(t => {
    const qty = Number(t.qty) || 0;
    const price = Number(t.price) || 0;
    const amount = t.amount != null ? Number(t.amount) : qty * price;
    if (t.assetClass === 'mf') applyMfTxn(mf, t, qty, price, amount);
    else applyStockTxn(eq, t, qty, price, amount);
  });

  return {
    equity: [...eq.values()].filter(h => h.qty > 1e-9),
    mf: [...mf.values()].filter(h => h.qty > 1e-9),
  };
}

function applyStockTxn(eq, t, qty, price, amount) {
  const key = canonicalInstrument(t.instrument, 'stock');
  let h = eq.get(key) || eq.get(t.instrument);
  if (t.type === 'sell') {
    if (!h) return; // selling something not held — ignore defensively
    const sellQty = Math.min(qty, h.qty);
    h.realized_pnl += (price - h.avg_cost) * sellQty; // P&L vs cost basis
    h.invested -= h.avg_cost * sellQty;               // reduce cost basis proportionally
    h.qty -= sellQty;
    if (h.qty <= 1e-9) { h.qty = 0; }
  } else if (t.type === 'split' || t.type === 'bonus') {
    if (!h) return; // nothing held — ignore
    h.qty += qty;   // qty = additional shares granted
    h.avg_cost = h.qty > 0 ? h.invested / h.qty : 0;
    h.cur_val  = h.qty * h.ltp;
    h.pnl      = h.cur_val - h.invested;
    h.gain_pct = h.invested > 0 ? h.pnl / h.invested : 0;
    return;
  } else { // buy
    if (!h) {
      h = {
        instrument: t.instrument,
        sector: (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[t.instrument]) || 'Other Equities',
        qty: 0, avg_cost: price, ltp: price, invested: 0, realized_pnl: 0,
      };
      eq.set(t.instrument, h);
    }
    h.qty += qty;
    h.invested += amount;
    h.avg_cost = h.qty > 0 ? h.invested / h.qty : price;
  }
  // Refresh derived fields (ltp stays last-known until a price refresh).
  h.cur_val = h.qty * h.ltp;
  h.pnl = h.cur_val - h.invested;
  h.gain_pct = h.invested > 0 ? h.pnl / h.invested : 0;
}

function applyMfTxn(mf, t, qty, price, amount) {
  let h = mf.get(t.instrument);
  if (t.type === 'sell') {
    if (!h) return;
    const sellQty = Math.min(qty, h.qty);
    h.realized_pnl += (price - h.avg_nav) * sellQty;
    h.invested -= h.avg_nav * sellQty;
    h.qty -= sellQty;
    if (h.qty <= 1e-9) { h.qty = 0; }
  } else {
    if (!h) {
      h = {
        scheme: t.instrument, scheme_type: t.category || 'Other',
        qty: 0, avg_nav: price, price: price, invested: 0, realized_pnl: 0,
      };
      mf.set(t.instrument, h);
    }
    h.qty += qty;
    h.invested += amount;
    h.avg_nav = h.qty > 0 ? h.invested / h.qty : price;
  }
  h.cur_val = h.qty * h.price;
  h.pnl = h.cur_val - h.invested;
  h.gain_pct = h.invested > 0 ? h.pnl / h.invested : 0;
}

// Rebuild the global latestEquity / latestMf from the ledger and refresh the
// rest of derived state. Preserves live price fields (ltp, basePrice,
// thisMonthGain, yesterdayClose) for holdings that already exist in memory.
function applyLedgerToHoldings() {
  if (!frozenBase) return false;
  const prevEq = new Map((latestEquity || []).map(s => [s.instrument, s]));
  const prevMf = new Map((latestMf || []).map(f => [f.scheme, f]));
  const derived = deriveHoldings();

  // Build lookup for frozen-base prices (basePrice field; fallback for old saved data using ltp/price).
  const frozenEqPrice = new Map((frozenBase.equity || []).map(s => [s.instrument, s.basePrice ?? s.ltp ?? 0]));
  const frozenMfPrice = new Map((frozenBase.mf || []).map(f => [f.scheme, f.basePrice ?? f.price ?? 0]));

  latestEquity = derived.equity.map(h => {
    const prev = prevEq.get(h.instrument);
    if (prev) {
      // keep live price + baseline fields; recompute value from refreshed ltp
      h.ltp = prev.ltp; h.basePrice = prev.basePrice;
      h.lastRefreshedPrice = prev.lastRefreshedPrice;
      h.thisMonthGain = prev.thisMonthGain; h.yesterdayClose = prev.yesterdayClose;
      h.lastRefreshDate = prev.lastRefreshDate;
      h.cur_val = h.qty * h.ltp; h.pnl = h.cur_val - h.invested;
      h.gain_pct = h.invested > 0 ? h.pnl / h.invested : 0;
    } else {
      // New holding (not in frozen base): basePrice = 0 so its full market value
      // counts as gain relative to the frozen base in net-worth math.
      h.basePrice = 0;
    }
    // Ensure basePrice is set from frozenBase for holdings that existed at base date
    // (guards against the first run where prev is missing due to cold start order).
    if (h.basePrice === undefined) h.basePrice = frozenEqPrice.get(h.instrument) ?? 0;
    return h;
  });
  latestMf = derived.mf.map(h => {
    const prev = prevMf.get(h.scheme);
    if (prev) {
      h.price = prev.price; h.basePrice = prev.basePrice;
      h.lastRefreshedPrice = prev.lastRefreshedPrice;
      h.thisMonthGain = prev.thisMonthGain; h.previousNav = prev.previousNav;
      h.lastRefreshDate = prev.lastRefreshDate;
      h.cur_val = h.qty * h.price; h.pnl = h.cur_val - h.invested;
      h.gain_pct = h.invested > 0 ? h.pnl / h.invested : 0;
    } else {
      h.basePrice = 0;
    }
    if (h.basePrice === undefined) h.basePrice = frozenMfPrice.get(h.scheme) ?? 0;
    return h;
  });
  // Keep the per-holding history in sync so the inline transaction history,
  // Trading Activity log, and per-holding XIRR all reflect ledger edits.
  rebuildHoldingHistoryFromLedger();
  return true;
}

// Reconstruct each holding's post-base history from the transaction ledger so
// every history-derived view (inline transaction history, Trading Activity log,
// per-holding XIRR/returns) reflects transactions immediately — not only after a
// month close. Idempotent: truncates history to the immutable frozen base, then
// replays post-base transactions, emitting one snapshot per (instrument, date).
function rebuildHoldingHistoryFromLedger() {
  if (!frozenBase || !historicalHoldings) return;
  const baseDate = frozenBase.baseDate;

  // 1. Drop any post-base history (rebuilt each call); keep the frozen base.
  Object.values(historicalHoldings.stocks || {}).forEach(h => {
    h.history = (h.history || []).filter(p => p.date <= baseDate);
  });
  Object.values(historicalHoldings.mfs || {}).forEach(h => {
    h.history = (h.history || []).filter(p => p.date <= baseDate);
  });

  // 2. Seed running cost-basis state from the frozen base snapshot.
  const stockState = {};
  (frozenBase.equity || []).forEach(s => {
    stockState[s.instrument] = { qty: s.qty, invested: s.invested, avg_cost: s.avg_cost, sector: s.sector };
  });
  const mfState = {};
  (frozenBase.mf || []).forEach(f => {
    mfState[f.scheme] = { qty: f.qty, invested: f.invested, avg_nav: f.avg_nav, scheme_type: f.scheme_type };
  });

  // Current prices for valuing the rebuilt snapshots.
  const ltpOf = {}; (latestEquity || []).forEach(s => { ltpOf[s.instrument] = s.ltp; });
  const navOf = {}; (latestMf || []).forEach(f => { navOf[f.scheme] = f.price; });

  // 3. Replay post-base transactions grouped by date; snapshot affected holdings.
  const byDate = {};
  (transactions || [])
    .filter(t => !baseDate || t.date > baseDate)
    .forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });

  Object.keys(byDate).sort().forEach(date => {
    const affectedStocks = new Set();
    const affectedMfs = new Set();
    byDate[date].forEach(t => {
      const qty = Number(t.qty) || 0, price = Number(t.price) || 0;
      const amount = t.amount != null ? Number(t.amount) : qty * price;
      if (t.assetClass === 'mf') {
        const st = mfState[t.instrument] || (mfState[t.instrument] =
          { qty: 0, invested: 0, avg_nav: price, scheme_type: t.category || 'Other' });
        if (t.type === 'sell') { const s = Math.min(qty, st.qty); st.invested -= st.avg_nav * s; st.qty -= s; }
        else { st.qty += qty; st.invested += amount; st.avg_nav = st.qty > 0 ? st.invested / st.qty : price; }
        affectedMfs.add(t.instrument);
      } else {
        const st = stockState[t.instrument] || (stockState[t.instrument] =
          { qty: 0, invested: 0, avg_cost: price, sector: (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[t.instrument]) || 'Other Equities' });
        if (t.type === 'split' || t.type === 'bonus') {
          if (stockState[t.instrument]) { st.qty += qty; st.avg_cost = st.qty > 0 ? st.invested / st.qty : 0; }
          affectedStocks.add(t.instrument);
        } else if (t.type === 'sell') { const s = Math.min(qty, st.qty); st.invested -= st.avg_cost * s; st.qty -= s; affectedStocks.add(t.instrument); }
        else { st.qty += qty; st.invested += amount; st.avg_cost = st.qty > 0 ? st.invested / st.qty : price; affectedStocks.add(t.instrument); }
      }
    });
    affectedStocks.forEach(inst => {
      const st = stockState[inst];
      const ltp = ltpOf[inst] ?? st.avg_cost;
      const entry = historicalHoldings.stocks[inst] ||
        (historicalHoldings.stocks[inst] = { instrument: inst, sector: st.sector, history: [] });
      entry.history.push({
        date, qty: st.qty, avg_cost: st.avg_cost, ltp,
        invested: st.invested, cur_val: st.qty * ltp,
        pnl: st.qty * ltp - st.invested, gain_pct: st.invested > 0 ? (st.qty * ltp - st.invested) / st.invested : 0,
      });
    });
    affectedMfs.forEach(inst => {
      const st = mfState[inst];
      const nav = navOf[inst] ?? st.avg_nav;
      const entry = historicalHoldings.mfs[inst] ||
        (historicalHoldings.mfs[inst] = { instrument: inst, category: st.scheme_type, history: [] });
      entry.history.push({
        date, qty: st.qty, avg_cost: st.avg_nav, ltp: nav,
        invested: st.invested, cur_val: st.qty * nav,
        pnl: st.qty * nav - st.invested, gain_pct: st.invested > 0 ? (st.qty * nav - st.invested) / st.invested : 0,
      });
    });
  });

  // Invalidate cached per-holding XIRR so it recomputes from the new history.
  (latestEquity || []).forEach(s => { delete s._xirr; });
  (latestMf || []).forEach(f => { delete f._xirr; });
}

// ── Mutations (used by the Manage tab UI) ──────────────────────────────────
function addTransaction(txn) {
  const t = {
    id: newId(),
    date: txn.date,
    assetClass: txn.assetClass,        // 'stock' | 'mf'
    instrument: String(txn.instrument).trim(),
    type: txn.type,                    // 'buy' | 'sell'
    qty: Number(txn.qty),
    price: Number(txn.price),
    amount: txn.amount != null ? Number(txn.amount) : Number(txn.qty) * Number(txn.price),
    category: txn.category || null,    // for brand-new MFs
    note: txn.note || '',
  };
  transactions.push(t);
  saveLedger();
  return t;
}

function updateTransaction(id, patch) {
  const t = transactions.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  if (patch.qty != null || patch.price != null) {
    t.amount = Number(t.qty) * Number(t.price);
  }
  saveLedger();
  return t;
}

function deleteTransaction(id) {
  transactions = transactions.filter(x => x.id !== id);
  saveLedger();
}

function addBalance(entry) {
  const b = {
    id: newId(),
    date: entry.date,
    component: entry.component,         // one of OPAQUE_COMPONENTS
    value: Number(entry.value),
    contribution: Number(entry.contribution) || 0,
    note: entry.note || '',
  };
  balances.push(b);
  saveLedger();
  return b;
}

function updateBalance(id, patch) {
  const b = balances.find(x => x.id === id);
  if (!b) return null;
  Object.assign(b, patch);
  saveLedger();
  return b;
}

function deleteBalance(id) {
  balances = balances.filter(x => x.id !== id);
  saveLedger();
}

// Latest entered balance/contribution for a component as of (≤) a date.
function latestBalanceFor(component, asOfDate) {
  const entries = balances
    .filter(b => b.component === component && (!asOfDate || b.date <= asOfDate))
    .sort((a, b) => a.date.localeCompare(b.date));
  return entries.length ? entries[entries.length - 1] : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — compute engine: computeXirr + closeMonth
// ─────────────────────────────────────────────────────────────────────────

// XIRR via Newton–Raphson with a bisection fallback. `flows` is a list of
// { date:'YYYY-MM-DD', amount } where contributions are negative (cash out of
// pocket) and the terminal portfolio value is positive. Returns a decimal rate
// (0.14 = 14%) or null if it can't converge / has no sign change.
function computeXirr(flows, guess) {
  if (!flows || flows.length < 2) return null;
  const t0 = new Date(flows[0].date).getTime();
  const yrs = f => (new Date(f.date).getTime() - t0) / (365.25 * 86400 * 1000);
  const npv = r => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yrs(f)), 0);
  const dnpv = r => flows.reduce((s, f) => {
    const y = yrs(f);
    return s - (y * f.amount) / Math.pow(1 + r, y + 1);
  }, 0);

  // Newton–Raphson
  let r = (guess == null ? 0.1 : guess);
  for (let i = 0; i < 100; i++) {
    const v = npv(r), d = dnpv(r);
    if (Math.abs(v) < 1e-7) return r;
    if (!isFinite(d) || d === 0) break;
    let rn = r - v / d;
    if (!isFinite(rn)) break;
    if (rn <= -0.9999) rn = -0.9999;
    if (Math.abs(rn - r) < 1e-9) return rn;
    r = rn;
  }
  // Bisection fallback over [-0.9999, 10]
  let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// Resolve which logical component a Breakup row key/label refers to, returning
// the live value sources for the period being closed. Returns null for
// aggregate/total rows (handled separately).
//   sources = { value (lakhs), prevValue (lakhs), newInv (lakhs) }
function _componentSources(label, ctx) {
  const m = {
    'Stocks': 'stock', 'Mutual Funds': 'mf', 'Gold': 'Gold', 'NPS E': 'NPS-E',
    'NPS C': 'NPS-C', 'NPS G': 'NPS-G', 'PF': 'PF', 'PPF': 'PPF', 'Cash': 'Cash',
    'Crypto': 'Crypto', 'Bonds': 'Bonds', 'NPS': 'NPS-combined',
  };
  const comp = m[label];
  if (!comp) return null;
  if (comp === 'stock') return ctx.stock;
  if (comp === 'mf') return ctx.mf;
  if (comp === 'NPS-combined') {
    // contribution section lumps the three NPS sleeves together
    const e = ctx.opaque['NPS-E'], c = ctx.opaque['NPS-C'], g = ctx.opaque['NPS-G'];
    return {
      value: e.value + c.value + g.value,
      prevValue: e.prevValue + c.prevValue + g.prevValue,
      newInv: e.newInv + c.newInv + g.newInv,
    };
  }
  return ctx.opaque[comp];
}

// Close the current period: compute one new column for every Breakup section,
// append it (and a per-holding history point), and re-baseline live prices.
// `dateStr` is the YYYY-MM-DD label for the new column (defaults to today).
// Returns a small summary for the confirmation UI.
function closeMonth(dateStr) {
  if (!breakupSummary || !latestEquity || !latestMf) {
    throw new Error('No portfolio loaded.');
  }
  const dates = breakupSummary.dates;
  const prevDate = dates[dates.length - 1];
  const D = dateStr || new Date().toISOString().slice(0, 10);
  if (D <= prevDate) throw new Error(`Close date ${D} must be after the last period ${prevDate}.`);

  const L = 1e5; // rupees → lakhs

  // Live values for tradeables (lakhs) — use the reconciliation-gap-corrected values so
  // that closing a month doesn't silently drop the gap and cause a net-worth jump.
  // The gap = (uploadedSnapshot baseline) − Σ(frozenQty × frozenPrice).  If we stored
  // a raw per-holding sum here instead, the gap would vanish and every subsequent
  // recomputePortfolioFromLiveData() call would show a different (wrong) total.
  const rawStockVal = latestEquity.reduce((s, h) => s + h.cur_val, 0) / L;
  const rawMfVal    = latestMf.reduce((s, h) => s + h.price * h.qty, 0) / L;
  let stockValue = rawStockVal;
  let mfValue    = rawMfVal;
  if ((typeof uploadedSnapshot !== 'undefined') && uploadedSnapshot &&
      (typeof frozenBase !== 'undefined') && frozenBase) {
    const frozenStkVal = (frozenBase.equity || []).reduce((s, h) => s + h.qty * (h.basePrice ?? h.ltp ?? 0), 0) / L;
    const frozenMfVal  = (frozenBase.mf   || []).reduce((s, h) => s + h.qty * (h.basePrice ?? h.price ?? 0), 0) / L;
    stockValue = rawStockVal + (uploadedSnapshot.stockLakhs - frozenStkVal);
    mfValue    = rawMfVal   + (uploadedSnapshot.mfLakhs    - frozenMfVal);
  }

  // New investment this period for tradeables (lakhs): buys − sells in (prev, D]
  const inWindow = t => t.date > prevDate && t.date <= D;
  const stockNewInv = transactions.filter(t => inWindow(t) && t.assetClass === 'stock')
    .reduce((s, t) => s + (t.type === 'sell' ? -t.amount : t.amount), 0) / L;
  const mfNewInv = transactions.filter(t => inWindow(t) && t.assetClass === 'mf')
    .reduce((s, t) => s + (t.type === 'sell' ? -t.amount : t.amount), 0) / L;

  // Previous-period values per Breakup key (last column already there).
  const prevVal = (section, key) => {
    const v = breakupSummary[section]?.[key]?.values;
    return v && v.length ? v[v.length - 1] : 0;
  };

  // Build the per-component context (values in lakhs).
  const ctx = {
    stock: { value: stockValue, prevValue: prevVal('net_worth', 'Stocks (Equity)'), newInv: stockNewInv },
    mf: { value: mfValue, prevValue: prevVal('net_worth', 'Mutual Funds (Equity)'), newInv: mfNewInv },
    opaque: {},
  };
  OPAQUE_COMPONENTS.forEach(comp => {
    const meta = COMPONENT_BREAKUP[comp];
    const bal = latestBalanceFor(comp, D);
    const value = bal ? bal.value / L : prevVal('net_worth', meta.key); // carry forward if no new entry
    const newInv = bal && bal.date > prevDate ? (bal.contribution || 0) / L : 0;
    ctx.opaque[comp] = { value, prevValue: prevVal('net_worth', meta.key), newInv };
  });

  // Total net worth this period (for contribution shares + portfolio XIRR terminal).
  const totalValue = stockValue + mfValue +
    OPAQUE_COMPONENTS.reduce((s, c) => s + ctx.opaque[c].value, 0);

  // Capture scalars BEFORE any push — prevVal reads the last column, which the
  // pushes below would otherwise overwrite with the new period's value.
  const prevTotal = prevVal('net_worth', 'Total');
  const totalNewInv = stockNewInv + mfNewInv +
    OPAQUE_COMPONENTS.reduce((s, c) => s + ctx.opaque[c].newInv, 0);

  // ── Append one value to every key of every section ──
  const pushAll = (section, valueFor) => {
    const sec = breakupSummary[section];
    if (!sec) return;
    Object.entries(sec).forEach(([key, entry]) => {
      entry.values.push(valueFor(key, entry));
    });
  };

  const isTotal = label =>
    /^(Total|Total Investment|Total Growth|Total Change|Average|Total Return %)$/.test(label);

  // net_worth
  pushAll('net_worth', (key, e) => {
    if (isTotal(e.label)) return +totalValue.toFixed(6);
    const src = _componentSources(e.label, ctx);
    return src ? +src.value.toFixed(6) : 0;
  });
  // new_investment (lakhs)
  pushAll('new_investment', (key, e) => {
    if (isTotal(e.label)) return +totalNewInv.toFixed(6);
    const src = _componentSources(e.label, ctx);
    return src ? +src.newInv.toFixed(6) : 0;
  });
  // contribution = allocation share (0..1)
  pushAll('contribution', (key, e) => {
    if (isTotal(e.label)) return 1;
    const src = _componentSources(e.label, ctx);
    return src && totalValue > 0 ? +(src.value / totalValue).toFixed(6) : 0;
  });
  // net_change = value[t] − value[t-1]
  pushAll('net_change', (key, e) => {
    if (isTotal(e.label)) return +(totalValue - prevTotal).toFixed(6);
    const src = _componentSources(e.label, ctx);
    return src ? +(src.value - src.prevValue).toFixed(6) : 0;
  });
  // returns = net_change − new_investment
  pushAll('returns', (key, e) => {
    if (isTotal(e.label)) return +((totalValue - prevTotal) - totalNewInv).toFixed(6);
    const src = _componentSources(e.label, ctx);
    return src ? +((src.value - src.prevValue) - src.newInv).toFixed(6) : 0;
  });
  // net_cashflows = new investment (money in), best-effort
  pushAll('net_cashflows', (key, e) => {
    if (isTotal(e.label)) return +totalNewInv.toFixed(6);
    const src = _componentSources(e.label, ctx);
    return src ? +src.newInv.toFixed(6) : 0;
  });
  // pct_returns = returns / prevValue (decimal)
  pushAll('pct_returns', (key, e) => {
    if (isTotal(e.label)) {
      const ret = (totalValue - prevTotal) - totalNewInv;
      return prevTotal > 0 ? +(ret / prevTotal).toFixed(6) : 0;
    }
    const src = _componentSources(e.label, ctx);
    if (!src) return 0;
    const ret = (src.value - src.prevValue) - src.newInv;
    return src.prevValue > 0 ? +(ret / src.prevValue).toFixed(6) : 0;
  });

  // Push the new date BEFORE computing XIRR (so the cashflow series aligns).
  breakupSummary.dates.push(D);

  // xirr per key: cashflows = −(new_investment series) at each date + terminal
  // value at D. Uses the now-extended new_investment series.
  pushAll('xirr', (key, e) => {
    // find the matching net_worth + new_investment key for this component
    const niSeries = breakupSummary.new_investment[key]?.values;
    const nwSeries = breakupSummary.net_worth[key]?.values;
    let terminal, invSeries;
    if (isTotal(e.label)) {
      invSeries = breakupSummary.new_investment['Total Investment']?.values;
      terminal = breakupSummary.net_worth['Total']?.values;
    } else {
      invSeries = niSeries; terminal = nwSeries;
    }
    if (!invSeries || !terminal) return e.values.length ? e.values[e.values.length - 1] : 0;
    const termVal = terminal[terminal.length - 1];
    const flows = breakupSummary.dates.map((dt, i) => ({ date: dt, amount: -(invSeries[i] || 0) }));
    flows.push({ date: D, amount: termVal }); // terminal liquidation value
    const x = computeXirr(flows);
    return x == null ? (e.values.length ? e.values[e.values.length - 1] : 0) : +x.toFixed(6);
  });

  // Append a per-holding history point so per-instrument charts extend.
  const stamp = h => ({
    date: D, qty: h.qty, avg_cost: h.avg_cost, ltp: h.ltp,
    invested: h.invested, cur_val: h.cur_val, pnl: h.pnl, gain_pct: h.gain_pct,
  });
  latestEquity.forEach(h => {
    const inst = historicalHoldings.stocks[h.instrument] ||
      (historicalHoldings.stocks[h.instrument] = { instrument: h.instrument, sector: h.sector, history: [] });
    inst.history.push(stamp(h));
  });
  latestMf.forEach(h => {
    const inst = historicalHoldings.mfs[h.scheme] ||
      (historicalHoldings.mfs[h.scheme] = { instrument: h.scheme, category: h.scheme_type, history: [] });
    inst.history.push({
      date: D, qty: h.qty, avg_cost: h.avg_nav, ltp: h.price,
      invested: h.invested, cur_val: h.cur_val, pnl: h.pnl, gain_pct: h.gain_pct,
    });
  });

  // Re-derive portfolio summary + re-baseline live prices for the next period.
  portfolioSummary = buildPortfolioSummary(breakupSummary);
  latestEquity.forEach(h => { h.basePrice = h.ltp; h.thisMonthGain = 0; });
  latestMf.forEach(h => { h.basePrice = h.price; h.thisMonthGain = 0; });
  uploadedSnapshot = {
    totalLakhs: totalValue, stockLakhs: stockValue, mfLakhs: mfValue,
    npsELakhs: ctx.opaque['NPS-E'].value,
  };
  // Advance the frozen base to this close so future derivations start here.
  frozenBase = {
    baseDate: D,
    stockLakhs: stockValue,
    mfLakhs: mfValue,
    npsELakhs: ctx.opaque['NPS-E'].value,
    totalLakhs: totalValue,
    equity: latestEquity.map(s => ({
      instrument: s.instrument, sector: s.sector, qty: s.qty,
      avg_cost: s.avg_cost, invested: s.invested, basePrice: s.ltp,
    })),
    mf: latestMf.map(f => ({
      scheme: f.scheme, scheme_type: f.scheme_type, qty: f.qty,
      avg_nav: f.avg_nav, invested: f.invested, basePrice: f.price,
    })),
  };
  saveLedger();
  saveBreakupOverride();

  return {
    date: D,
    totalValue,
    netChange: totalValue - prevTotal,
    newInvestment: totalNewInv,
    portfolioXirr: breakupSummary.xirr['Average']?.values.slice(-1)[0] ?? null,
  };
}
