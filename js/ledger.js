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

// Local-timezone YYYY-MM-DD. toISOString() is UTC: for an IST user it returns
// YESTERDAY's date between midnight and 05:30, silently mis-dating transactions,
// month closes and calendar-window boundaries — so all "today"/date-string
// construction must go through this instead.
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

// ── Dirty flag ─────────────────────────────────────────────────────────────
// The ledger source of truth is the committed data/ledger_*.json files (so every
// device agrees). localStorage is a cache. But uncommitted local edits must not be
// clobbered by the committed copy on reload — so any mutation sets a "dirty" flag,
// and loadLedger() only adopts the committed files when NOT dirty. commitData()
// clears the flag on a successful push (local now == committed).
function _ledgerPrefix() { return (typeof LS_PREFIX !== 'undefined') ? LS_PREFIX : 'ag_portfolio_'; }
function markLedgerDirty() {
  try { localStorage.setItem(_ledgerPrefix() + 'ledger_dirty', '1'); } catch (_) {}
}
function clearLedgerDirty() {
  try { localStorage.removeItem(_ledgerPrefix() + 'ledger_dirty'); } catch (_) {}
}
function isLedgerDirty() {
  try { return localStorage.getItem(_ledgerPrefix() + 'ledger_dirty') === '1'; } catch (_) { return false; }
}

// ── Persistence ──────────────────────────────────────────────────────────
function saveLedger() {
  try {
    const P = _ledgerPrefix();
    localStorage.setItem(P + LEDGER_KEYS.transactions, JSON.stringify(transactions));
    localStorage.setItem(P + LEDGER_KEYS.balances, JSON.stringify(balances));
    if (frozenBase) localStorage.setItem(P + LEDGER_KEYS.frozenBase, JSON.stringify(frozenBase));
  } catch (e) {
    console.warn('Failed to persist ledger:', e);
  }
}

function loadLedger() {
  try {
    const P = _ledgerPrefix();
    // Source of truth = committed ledger files (fetched into window._committedLedger
    // before this runs), UNLESS there are uncommitted local edits (dirty flag). This
    // keeps every device consistent: a fresh device, or one whose edits are all
    // committed, computes net worth from the same base + transactions as the repo.
    const committed = (typeof window !== 'undefined') ? window._committedLedger : null;

    // Self-heal a stale dirty flag left over from a since-fixed bug (a pure
    // recompute — rebuildBreakupFromLedger — used to call markLedgerDirty()
    // on every load, with no real edit involved). Rather than requiring the
    // local ledger to be byte-identical to committed (which would fail to
    // self-heal the moment ANY other device commits something new — exactly
    // the reported symptom: "committed elsewhere, not reflecting here"),
    // check that every LOCAL item is either absent from committed (a
    // genuine unsynced local add — keep protecting it) or matches its
    // committed counterpart exactly (a genuine local edit to an existing
    // entry would fail this and also correctly keep protecting). Committed
    // having MORE items than local is fine — that's just other devices'
    // work, not something local is at risk of losing.
    if (committed && isLedgerDirty()) {
      try {
        const localTxns = JSON.parse(localStorage.getItem(P + LEDGER_KEYS.transactions) || '[]');
        const localBals = JSON.parse(localStorage.getItem(P + LEDGER_KEYS.balances) || '[]');
        const localFbRaw = localStorage.getItem(P + LEDGER_KEYS.frozenBase);
        const localFb = localFbRaw ? JSON.parse(localFbRaw) : null;
        const noOrphans = (localArr, committedArr) => {
          const byId = new Map((committedArr || []).map(x => [x.id, x]));
          return (localArr || []).every(item => {
            const match = byId.get(item.id);
            return match !== undefined && JSON.stringify(match) === JSON.stringify(item);
          });
        };
        const fbUnchanged = JSON.stringify(localFb) === JSON.stringify(committed.frozenBase || null);
        if (noOrphans(localTxns, committed.transactions) && noOrphans(localBals, committed.balances) && fbUnchanged) {
          clearLedgerDirty();
        }
      } catch (_) { /* comparison failed — leave the flag as-is, protecting whatever's local */ }
    }

    if (committed && !isLedgerDirty()) {
      transactions = Array.isArray(committed.transactions) ? committed.transactions : [];
      balances = Array.isArray(committed.balances) ? committed.balances : [];
      frozenBase = committed.frozenBase || null;
      saveLedger(); // refresh the localStorage cache to match committed
      return;
    }
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
  const baseDate = dates.length ? dates[dates.length - 1] : localDateStr();
  const nw = breakupSummary.net_worth || {};
  const _last = (key) => { const v = nw[key]?.values || []; return v.length ? v[v.length-1] : 0; };
  frozenBase = {
    baseDate,
    stockLakhs: _last('Stocks (Equity)'),
    mfLakhs:    _last('Mutual Funds (Equity)'),
    goldLakhs:  _last('Gold (Gold)'),
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
  // Always re-derive holdings from the immutable frozen base + ledger — even with
  // zero transactions. deriveHoldings() with an empty ledger simply reproduces the
  // frozen base, so this is safe, and it GUARANTEES latestEquity/latestMf and
  // historicalHoldings are rebuilt cleanly on every load. This purges any phantom
  // holdings a previous buggy session may have persisted to the localStorage cache
  // (e.g. a miscased 'FMCGiETF' duplicate sitting alongside the real 'FMCGIETF').
  // Previously this ran only when transactions existed, so deleting the last
  // transaction left stale phantoms in the cache uncorrected.
  if (frozenBase) applyLedgerToHoldings();
  // Self-heal: every holding must carry a close-snapshot stamp at baseDate (the
  // sector/market-cap time charts read them; a device whose cached history missed
  // a close renders a garbage last bar otherwise). frozenBase.basePrice IS the
  // ltp at that close, so missing stamps can be reconstructed exactly.
  if (frozenBase && historicalHoldings) restampBaseDateSnapshots();
  // Always re-run baseline after frozenBase is set up. The first call in loadData()
  // runs before loadLedger() populates frozenBase (it's null then), so basePrice
  // falls back to current ltp → thisMonthGain = 0. This corrects that.
  if (frozenBase && typeof initializeLiveBaseline === 'function') initializeLiveBaseline();
  // Derive the ledger-era breakup columns from the ledger — this is what makes
  // backdated/edited/deleted entries reflect in every table and chart without a
  // Close Period. Idempotent, so safe on every load.
  if (frozenBase) rebuildBreakupFromLedger();
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

// Resolve a transaction's instrument name to the canonical frozenBase key.
// Uses frozenBase.equity (ground truth) rather than historicalHoldings, which
// can contain phantom entries created by misspelled/miscased instrument names.
function canonicalInstrument(name, assetClass) {
  if (assetClass !== 'stock') return name;
  const fb = (typeof frozenBase !== 'undefined') ? frozenBase : null;
  if (!fb?.equity) return name;
  // Direct match
  if (fb.equity.some(s => s.instrument === name)) return name;
  // Case-insensitive / alphanumeric-cleaned match (handles 'FMCGiETF' → 'FMCGIETF')
  const clean = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = fb.equity.find(s => s.instrument.toUpperCase().replace(/[^A-Z0-9]/g, '') === clean);
  return match ? match.instrument : name;
}

// A transaction is "folded" (already reflected in the frozen base, so must NOT
// be replayed again) if explicitly marked so by closeMonth(). Legacy
// transactions predating that flag fall back to the old date-vs-baseDate check.
function _isTxnFolded(t, baseDate) {
  if (t.folded === true) return true;
  if (t.folded === false) return false;
  return !!baseDate && t.date <= baseDate;
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
    // frozenBase stores basePrice (freeze-date price), not ltp — seed from it so a
    // cold derivation (no prevEq to restore live prices) still values correctly.
    const px = s.ltp ?? s.basePrice ?? 0;
    eq.set(s.instrument, {
      instrument: s.instrument, sector: s.sector, qty: s.qty,
      avg_cost: s.avg_cost, ltp: px, invested: s.invested,
      cur_val: s.qty * px, pnl: s.qty * px - s.invested,
      // gain_pct is a PERCENTAGE (e.g. 5.33, not 0.0533) everywhere in the app —
      // js/api.js's live-refresh path and the Stocks/MF table both assume this.
      // A missing ×100 here (and at every other gain_pct assignment below) used
      // to make the table's "Gain %" column flip between the correct value and
      // one 100× too small depending on whether the last state-changing action
      // was a price refresh (api.js, ×100) or a ledger edit (this file, no ×100).
      gain_pct: s.invested > 0 ? (s.qty * px - s.invested) / s.invested * 100 : 0,
      realized_pnl: 0,
    });
  });
  (base.mf || []).forEach(f => {
    const px = f.price ?? f.basePrice ?? 0;
    mf.set(f.scheme, {
      scheme: f.scheme, scheme_type: f.scheme_type, qty: f.qty,
      avg_nav: f.avg_nav, price: px, invested: f.invested,
      cur_val: f.qty * px, pnl: f.qty * px - f.invested,
      gain_pct: f.invested > 0 ? (f.qty * px - f.invested) / f.invested * 100 : 0,
      realized_pnl: 0,
    });
  });

  // Apply transactions in chronological order — skip whatever is already baked
  // into this frozen base. Uses the explicit `folded` flag (set by closeMonth())
  // rather than date, so a transaction added AFTER a close — even if dated on or
  // before the base date — still replays. Legacy transactions with no `folded`
  // field (saved before this fix) fall back to the old date comparison.
  const ordered = [...txns]
    .filter(t => !_isTxnFolded(t, base.baseDate))
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
    h.gain_pct = h.invested > 0 ? h.pnl / h.invested * 100 : 0;
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
  h.gain_pct = h.invested > 0 ? h.pnl / h.invested * 100 : 0;
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
  h.gain_pct = h.invested > 0 ? h.pnl / h.invested * 100 : 0;
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
      h.gain_pct = h.invested > 0 ? h.pnl / h.invested * 100 : 0;
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
      h.gain_pct = h.invested > 0 ? h.pnl / h.invested * 100 : 0;
    } else {
      h.basePrice = 0;
    }
    if (h.basePrice === undefined) h.basePrice = frozenMfPrice.get(h.scheme) ?? 0;
    return h;
  });
  // Purge phantom historicalHoldings.stocks keys created by previous misspelled
  // instrument names (e.g. 'FMCGiETF' alongside 'FMCGIETF'). Keep entries that are a
  // current holding, a frozenBase instrument (pre-base history), OR referenced by any
  // transaction under its canonical name. The last clause preserves the history of a
  // position that was fully sold post-base (qty 0, dropped from latestEquity) so its
  // realized cash flows still feed aggregate XIRR and the investment log. Phantoms
  // survive none of these checks because their miscased key never matches the canonical.
  if (historicalHoldings?.stocks) {
    const validKeys = new Set(latestEquity.map(s => s.instrument));
    (frozenBase.equity || []).forEach(s => validKeys.add(s.instrument));
    (transactions || []).forEach(t => {
      if (t.assetClass !== 'mf') validKeys.add(canonicalInstrument(t.instrument, 'stock'));
    });
    Object.keys(historicalHoldings.stocks).forEach(k => {
      if (!validKeys.has(k)) delete historicalHoldings.stocks[k];
    });
  }
  // Keep the per-holding history in sync so the inline transaction history,
  // Trading Activity log, and per-holding XIRR all reflect ledger edits.
  rebuildHoldingHistoryFromLedger();
  return true;
}

// Ensure every frozen-base holding has a close-snapshot history entry at
// baseDate (no `cf` — replay entries carry one). Reconstructed from the base's
// own qty/invested/basePrice, so it's exact and idempotent.
function restampBaseDateSnapshots() {
  const D = frozenBase.baseDate;
  if (!D) return;
  (frozenBase.equity || []).forEach(s => {
    const e = historicalHoldings.stocks[s.instrument] ||
      (historicalHoldings.stocks[s.instrument] = { instrument: s.instrument, sector: s.sector, history: [] });
    if (e.history.some(p => p.date === D && p.cf == null)) return;
    const cur = s.qty * (s.basePrice || 0), pnl = cur - s.invested;
    e.history.push({ date: D, qty: s.qty, avg_cost: s.avg_cost, ltp: s.basePrice,
      invested: s.invested, cur_val: cur, pnl, gain_pct: s.invested > 0 ? pnl / s.invested * 100 : 0 });
    e.history.sort((a, b) => a.date.localeCompare(b.date));
  });
  (frozenBase.mf || []).forEach(s => {
    const e = historicalHoldings.mfs[s.scheme] ||
      (historicalHoldings.mfs[s.scheme] = { instrument: s.scheme, category: s.scheme_type, history: [] });
    if (e.history.some(p => p.date === D && p.cf == null)) return;
    const cur = s.qty * (s.basePrice || 0), pnl = cur - s.invested;
    e.history.push({ date: D, qty: s.qty, avg_cost: s.avg_nav, ltp: s.basePrice,
      invested: s.invested, cur_val: cur, pnl, gain_pct: s.invested > 0 ? pnl / s.invested * 100 : 0 });
    e.history.sort((a, b) => a.date.localeCompare(b.date));
  });
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
  // Replay-origin entries carry a `cf` field; close-snapshot stamps don't. A
  // replay entry dated exactly AT baseDate must be dropped too, otherwise each
  // rebuild appends another copy (they accumulated once per load previously).
  const keep = p => p.date < baseDate || (p.date === baseDate && p.cf == null);
  Object.values(historicalHoldings.stocks || {}).forEach(h => {
    h.history = (h.history || []).filter(keep);
  });
  Object.values(historicalHoldings.mfs || {}).forEach(h => {
    h.history = (h.history || []).filter(keep);
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

  // 3. Replay not-yet-folded transactions grouped by date; snapshot affected holdings.
  const byDate = {};
  (transactions || [])
    .filter(t => !_isTxnFolded(t, baseDate))
    .forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });

  Object.keys(byDate).sort().forEach(date => {
    const affectedStocks = new Set();
    const affectedMfs = new Set();
    // Actual signed cash flow per instrument for this date (buy → cash out (−amount),
    // sell → cash in (+proceeds = price×qty)). Recorded on the snapshot as `cf` so
    // per-holding XIRR uses real sale proceeds, not the cost-basis reduction (which
    // would silently omit realized gains/losses from the return).
    const cfStock = {}; const cfMf = {};
    byDate[date].forEach(t => {
      const qty = Number(t.qty) || 0, price = Number(t.price) || 0;
      const amount = t.amount != null ? Number(t.amount) : qty * price;
      if (t.assetClass === 'mf') {
        const st = mfState[t.instrument] || (mfState[t.instrument] =
          { qty: 0, invested: 0, avg_nav: price, scheme_type: t.category || 'Other' });
        if (t.type === 'sell') {
          const s = Math.min(qty, st.qty); st.invested -= st.avg_nav * s; st.qty -= s;
          cfMf[t.instrument] = (cfMf[t.instrument] || 0) + price * s; // proceeds in
        } else {
          st.qty += qty; st.invested += amount; st.avg_nav = st.qty > 0 ? st.invested / st.qty : price;
          cfMf[t.instrument] = (cfMf[t.instrument] || 0) - amount; // cash out
        }
        affectedMfs.add(t.instrument);
      } else {
        // Canonicalize so history is keyed under the same name as the frozenBase holding.
        const canon = canonicalInstrument(t.instrument, 'stock');
        const st = stockState[canon] || (stockState[canon] =
          { qty: 0, invested: 0, avg_cost: price, sector: (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[canon]) || 'Other Equities' });
        if (t.type === 'split' || t.type === 'bonus') {
          st.qty += qty; st.avg_cost = st.qty > 0 ? st.invested / st.qty : 0;
          affectedStocks.add(canon); // no cash flow for corporate actions
        } else if (t.type === 'sell') {
          const s = Math.min(qty, st.qty); st.invested -= st.avg_cost * s; st.qty -= s;
          cfStock[canon] = (cfStock[canon] || 0) + price * s; // proceeds in
          affectedStocks.add(canon);
        } else {
          st.qty += qty; st.invested += amount; st.avg_cost = st.qty > 0 ? st.invested / st.qty : price;
          cfStock[canon] = (cfStock[canon] || 0) - amount; // cash out
          affectedStocks.add(canon);
        }
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
        pnl: st.qty * ltp - st.invested, gain_pct: st.invested > 0 ? (st.qty * ltp - st.invested) / st.invested * 100 : 0,
        cf: cfStock[inst] || 0,
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
        pnl: st.qty * nav - st.invested, gain_pct: st.invested > 0 ? (st.qty * nav - st.invested) / st.invested * 100 : 0,
        cf: cfMf[inst] || 0,
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
    // `folded: false` marks this as NOT yet baked into a frozen-base snapshot —
    // explicit, so it always replays regardless of its date. Without this, a
    // transaction dated on/before the current frozen base (e.g. logged late, or
    // backdated) would be silently excluded by deriveHoldings' date filter,
    // since that filter otherwise assumes "date ≤ base date" means "already in
    // the snapshot" — true only for transactions that existed BEFORE the close
    // ran. closeMonth() flips this to `true` for every transaction it folds in.
    folded: false,
  };
  transactions.push(t);
  saveLedger(); markLedgerDirty();
  return t;
}

// Reverse a folded transaction's effect out of the frozenBase snapshot. A folded
// txn is already baked into the base's qty/invested; before it can be unfolded
// (edit) or removed (delete), the base must give it back — otherwise the replayed
// edit double-counts it (this exact bug inflated net worth by the txn amount).
function _reverseFromBase(t) {
  if (!frozenBase || _isTxnFolded(t, frozenBase.baseDate) !== true) return;
  const qty = Number(t.qty) || 0;
  const amount = t.amount != null ? Number(t.amount) : qty * (Number(t.price) || 0);
  if (t.assetClass === 'mf') {
    const h = (frozenBase.mf || []).find(f => f.scheme === t.instrument);
    if (!h) return;
    if (t.type === 'sell') { h.qty += qty; h.invested += h.avg_nav * qty; }
    else { h.qty -= qty; h.invested -= amount; }
    if (h.qty > 0) h.avg_nav = h.invested / h.qty;
  } else {
    const canon = canonicalInstrument(t.instrument, 'stock');
    const h = (frozenBase.equity || []).find(s => s.instrument === canon);
    if (!h) return;
    if (t.type === 'sell') { h.qty += qty; h.invested += h.avg_cost * qty; }
    else if (t.type === 'split' || t.type === 'bonus') { h.qty -= qty; }
    else { h.qty -= qty; h.invested -= amount; }
    if (h.qty > 0) h.avg_cost = h.invested / h.qty;
  }
}

function updateTransaction(id, patch) {
  const t = transactions.find(x => x.id === id);
  if (!t) return null;
  // If it was folded into a Close Period snapshot, back its OLD values out of
  // the frozen base first, so unfolding + replaying the edited values is exact.
  _reverseFromBase(t);
  Object.assign(t, patch);
  if (patch.qty != null || patch.price != null) {
    t.amount = Number(t.qty) * Number(t.price);
  }
  // Editing is an explicit "please re-apply me" signal — un-fold so the next
  // derivation replays it against current holdings.
  t.folded = false;
  saveLedger(); markLedgerDirty();
  return t;
}

function deleteTransaction(id) {
  const t = transactions.find(x => x.id === id);
  if (t) _reverseFromBase(t); // folded txns live in the base; removal must undo that too
  transactions = transactions.filter(x => x.id !== id);
  saveLedger(); markLedgerDirty();
}

function addBalance(entry) {
  const b = {
    id: newId(),
    date: entry.date,
    component: entry.component,         // one of OPAQUE_COMPONENTS
    value: Number(entry.value),
    contribution: Number(entry.contribution) || 0,
    interest: Number(entry.interest) || 0,
    note: entry.note || '',
  };
  balances.push(b);
  saveLedger(); markLedgerDirty();
  return b;
}

function updateBalance(id, patch) {
  const b = balances.find(x => x.id === id);
  if (!b) return null;
  Object.assign(b, patch);
  saveLedger(); markLedgerDirty();
  return b;
}

function deleteBalance(id) {
  balances = balances.filter(x => x.id !== id);
  saveLedger(); markLedgerDirty();
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
  const D = dateStr || localDateStr();
  if (D <= prevDate) throw new Error(`Close date ${D} must be after the last period ${prevDate}.`);

  const L = 1e5; // rupees → lakhs

  // Live values for tradeables (lakhs) — use the reconciliation-gap-corrected values so
  // that closing a month doesn't silently drop the gap and cause a net-worth jump.
  // The gap = (uploadedSnapshot baseline) − Σ(frozenQty × frozenPrice).  If we stored
  // a raw per-holding sum here instead, the gap would vanish and every subsequent
  // recomputePortfolioFromLiveData() call would show a different (wrong) total.
  // Gold (SGB / GOLDBEES) lives inside latestEquity for live pricing purposes but
  // belongs to the "Gold" net-worth bucket, not "Stocks (Equity)" — split it out
  // the same way recomputePortfolioFromLiveData() does.
  const nonGoldEquity = latestEquity.filter(h => !isGoldHolding(h));
  const goldEquity    = latestEquity.filter(isGoldHolding);
  const rawStockVal = nonGoldEquity.reduce((s, h) => s + h.cur_val, 0) / L;
  const rawGoldVal  = goldEquity.reduce((s, h) => s + h.cur_val, 0) / L;
  const rawMfVal    = latestMf.reduce((s, h) => s + h.price * h.qty, 0) / L;
  let stockValue = rawStockVal;
  let goldValue  = rawGoldVal;
  let mfValue    = rawMfVal;
  if ((typeof uploadedSnapshot !== 'undefined') && uploadedSnapshot &&
      (typeof frozenBase !== 'undefined') && frozenBase) {
    const frozenEquity = frozenBase.equity || [];
    const frozenStkVal  = frozenEquity.filter(h => !isGoldHolding(h)).reduce((s, h) => s + h.qty * (h.basePrice ?? h.ltp ?? 0), 0) / L;
    const frozenMfVal  = (frozenBase.mf   || []).reduce((s, h) => s + h.qty * (h.basePrice ?? h.price ?? 0), 0) / L;
    stockValue = rawStockVal + (uploadedSnapshot.stockLakhs - frozenStkVal);
    // Gold: no reconciliation gap — SGBs are now priced at their own real market
    // quotes (Groww), so Σ qty×ltp IS the true bucket value. The old gap only
    // bridged the GOLDBEES×100 proxy's understatement of SGBs vs the Excel-era
    // valuations; carrying it forward would double-count the correction.
    goldValue  = rawGoldVal;
    mfValue    = rawMfVal   + (uploadedSnapshot.mfLakhs    - frozenMfVal);
  }

  // New investment this period for tradeables (lakhs): buys − sells in (prev, D]
  const inWindow = t => t.date > prevDate && t.date <= D;
  const goldInstruments = new Set(goldEquity.map(h => h.instrument));
  const stockNewInv = transactions.filter(t => inWindow(t) && t.assetClass === 'stock' && !goldInstruments.has(t.instrument))
    .reduce((s, t) => s + (t.type === 'sell' ? -t.amount : t.amount), 0) / L;
  const goldNewInv = transactions.filter(t => inWindow(t) && t.assetClass === 'stock' && goldInstruments.has(t.instrument))
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
    // Gold is derived automatically from SGB/GOLDBEES holdings, not a manual balance entry.
    if (comp === 'Gold') {
      ctx.opaque[comp] = { value: goldValue, prevValue: prevVal('net_worth', meta.key), newInv: goldNewInv };
      return;
    }
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
    // The opening balance at dates[0] MUST be seeded as the initial cash outflow —
    // it's an existing balance (e.g. PF/PPF corpus at the frozen base), not a fresh
    // investment, so new_investment[0] is 0. Without this the terminal value looks
    // like pure profit on only the later sporadic contributions, producing an
    // absurd XIRR (matches the same fix already applied in computeDebtXirr/
    // computePortfolioXirr for the KPI cards).
    const opening = terminal[0] || 0;
    const flows = opening > 0 ? [{ date: breakupSummary.dates[0], amount: -opening }] : [];
    breakupSummary.dates.forEach((dt, i) => {
      if (i === 0) return;
      const inv = invSeries[i] || 0;
      if (Math.abs(inv) > 1e-6) flows.push({ date: dt, amount: -inv });
    });
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
    totalLakhs: totalValue, stockLakhs: stockValue, mfLakhs: mfValue, goldLakhs: goldValue,
    npsELakhs: ctx.opaque['NPS-E'].value,
  };
  // Advance the frozen base to this close so future derivations start here.
  // eraStart (the immutable Excel-history boundary) must survive the advance —
  // baseDate moves every close, eraStart never does.
  frozenBase = {
    baseDate: D,
    eraStart: frozenBase?.eraStart || _ledgerEraStart(),
    stockLakhs: stockValue,
    mfLakhs: mfValue,
    goldLakhs: goldValue,
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
  // Every transaction that exists right now is baked into the frozenBase snapshot
  // just built above (its qty/invested is already reflected in latestEquity/latestMf).
  // Mark them all folded so future derivations don't replay them a second time —
  // anything added AFTER this point, regardless of its own date, is new information.
  transactions.forEach(t => { t.folded = true; });

  saveLedger(); markLedgerDirty();
  saveBreakupOverride();

  return {
    date: D,
    totalValue,
    netChange: totalValue - prevTotal,
    newInvestment: totalNewInv,
    portfolioXirr: breakupSummary.xirr['Average']?.values.slice(-1)[0] ?? null,
  };
}

// ── Ledger-derived history ──────────────────────────────────────────────────
// Recompute every ledger-era breakup column directly from the ledger, so the
// monthly time series is a DERIVED view: adding, editing, or deleting a balance
// entry or transaction — even one dated into a past month — reflects everywhere
// (tables, charts, KPIs) immediately, with no dependence on Close Period.
// Close Period survives as the price-snapshot mechanism only: tradeable
// month-end VALUES keep their close-time snapshots (historical prices can't be
// recreated), while opaque values, all new-investment figures, and every
// derived section (net change, returns, cashflows, % returns, allocation
// shares, totals, XIRR) are recomputed here. Pure function of
// (Excel-era columns, ledger) → idempotent; runs on every load and after every
// ledger mutation.
//
// The Excel workbook's final Breakup column is the immutable-history boundary;
// columns after it are ledger-authored and always rebuilt. frozenBase.baseDate
// can't serve as this anchor (closeMonth advances it every month), so the era
// start is persisted separately on frozenBase.
const LEDGER_ERA_START_DEFAULT = '2026-05-01'; // last Excel-authored Breakup column

function _ledgerEraStart() {
  if (frozenBase?.eraStart) return frozenBase.eraStart;
  const dates = breakupSummary?.dates || [];
  const es = dates.includes(LEDGER_ERA_START_DEFAULT)
    ? LEDGER_ERA_START_DEFAULT
    : (frozenBase?.baseDate || dates[dates.length - 1] || '');
  if (frozenBase) frozenBase.eraStart = es;
  return es;
}

function _endOfMonthStr(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 0); // day 0 of next month = last day of this month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rebuildBreakupFromLedger() {
  if (!breakupSummary || !breakupSummary.dates?.length || !frozenBase) return false;
  const dates = breakupSummary.dates;
  const eraStart = _ledgerEraStart();
  const firstLedgerIdx = dates.findIndex(d => d > eraStart);
  if (firstLedgerIdx < 0) return false; // no ledger-era columns yet
  const L = 1e5;
  const winEnd = dates.map(_endOfMonthStr);
  const nw = breakupSummary.net_worth;
  const isTotal = label =>
    /^(Total|Total Investment|Total Growth|Total Change|Average|Total Return %)$/.test(label);

  // Gold trades are tradeables inside the equity list but belong to the Gold
  // bucket — same split closeMonth makes.
  const goldNames = new Set();
  (typeof latestEquity !== 'undefined' ? latestEquity || [] : []).forEach(h => { if (isGoldHolding(h)) goldNames.add(h.instrument); });
  (frozenBase.equity || []).forEach(h => { if (isGoldHolding(h)) goldNames.add(h.instrument); });
  const isGoldTxn = t => t.assetClass === 'stock' &&
    (goldNames.has(t.instrument) || isGoldHolding({ instrument: t.instrument }));

  // Bucket a ledger item into its column: item ∈ column i iff
  // winEnd[i-1] < date ≤ winEnd[i]. A pre-era date (backfill the immutable
  // Excel columns can't absorb) folds into the FIRST ledger column so its
  // cashflow still enters every series; the Transaction Log keeps the true
  // date. Dates after the last column's month (the live, un-closed month)
  // return -1 — they show via the live KPI path and enter at the next close.
  const colFor = (date) => {
    if (date > winEnd[dates.length - 1]) return -1;
    for (let i = firstLedgerIdx; i < dates.length; i++) {
      if (date <= winEnd[i]) return i;
    }
    return -1;
  };

  let changed = false;
  const setVal = (section, key, i, v) => {
    const e = breakupSummary[section]?.[key];
    if (!e || !e.values) return;
    const rounded = +Number(v).toFixed(6);
    // Tolerance swallows single-ULP (1e-6) rounding jitter: recomputing from
    // 6-decimal stored inputs can flip the last digit vs the close-time value
    // computed from unrounded intermediates. 2e-6 lakh = ₹0.20 — immaterial,
    // and without it every load would "change" the data and flag a commit.
    if (Math.abs((e.values[i] ?? 0) - rounded) > 2e-6) {
      e.values[i] = rounded;
      changed = true;
    }
  };

  // Close-time snapshot of each ledger-era column's opaque values, recorded the
  // FIRST time this rebuild sees the column (i.e. before any override). This is
  // the no-ledger-entry fallback: without it, deleting an entry couldn't revert
  // a column — the only "previous" value available would be the one the entry
  // itself had written. Persisted per column DATE so it survives reloads.
  let colSnaps = {};
  const snapKey = _ledgerPrefix() + 'ledger_col_snapshots';
  try { colSnaps = JSON.parse(localStorage.getItem(snapKey) || '{}'); } catch (_) { colSnaps = {}; }
  let snapsChanged = false;

  for (let i = firstLedgerIdx; i < dates.length; i++) {
    const txnsInCol = transactions.filter(t => colFor(t.date) === i);
    const sumNi = pred => txnsInCol.filter(pred)
      .reduce((s, t) => s + (t.type === 'sell' ? -t.amount : t.amount), 0) / L;

    // prevValue reads column i−1, which (for i > firstLedgerIdx) this loop has
    // already recomputed — ascending order matters. For the first ledger column
    // it's the untouched final Excel value.
    const ctx = {
      stock: {
        value: nw['Stocks (Equity)']?.values[i] ?? 0,
        prevValue: nw['Stocks (Equity)']?.values[i - 1] ?? 0,
        newInv: sumNi(t => t.assetClass === 'stock' && !isGoldTxn(t)),
      },
      mf: {
        value: nw['Mutual Funds (Equity)']?.values[i] ?? 0,
        prevValue: nw['Mutual Funds (Equity)']?.values[i - 1] ?? 0,
        newInv: sumNi(t => t.assetClass === 'mf'),
      },
      opaque: {},
    };
    OPAQUE_COMPONENTS.forEach(comp => {
      const key = COMPONENT_BREAKUP[comp].key;
      const prevValue = nw[key]?.values[i - 1] ?? 0;
      if (comp === 'Gold') {
        // Derived from live-priced holdings at close time, not balance entries.
        ctx.opaque[comp] = { value: nw[key]?.values[i] ?? 0, prevValue, newInv: sumNi(isGoldTxn) };
        return;
      }
      // Record the column's pre-override value once (see colSnaps above).
      const snaps = colSnaps[dates[i]] || (colSnaps[dates[i]] = {});
      if (snaps[key] === undefined && nw[key]?.values[i] !== undefined) {
        snaps[key] = nw[key].values[i];
        snapsChanged = true;
      }
      const latest = latestBalanceFor(comp, winEnd[i]);
      const value = latest ? latest.value / L : (snaps[key] ?? nw[key]?.values[i] ?? prevValue);
      const newInv = balances
        .filter(b => b.component === comp && colFor(b.date) === i)
        .reduce((s, b) => s + (b.contribution || 0), 0) / L;
      ctx.opaque[comp] = { value, prevValue, newInv };
    });

    const totalValue = ctx.stock.value + ctx.mf.value +
      OPAQUE_COMPONENTS.reduce((s, c) => s + ctx.opaque[c].value, 0);
    const prevTotal = nw['Total']?.values[i - 1] ?? 0;
    const totalNewInv = ctx.stock.newInv + ctx.mf.newInv +
      OPAQUE_COMPONENTS.reduce((s, c) => s + ctx.opaque[c].newInv, 0);

    const forAll = (section, valueFor) => {
      const sec = breakupSummary[section];
      if (!sec) return;
      Object.entries(sec).forEach(([key, e]) => setVal(section, key, i, valueFor(key, e)));
    };

    forAll('net_worth', (key, e) => {
      if (isTotal(e.label)) return totalValue;
      const src = _componentSources(e.label, ctx);
      return src ? src.value : (e.values[i] ?? 0);
    });
    forAll('new_investment', (key, e) => {
      if (isTotal(e.label)) return totalNewInv;
      const src = _componentSources(e.label, ctx);
      return src ? src.newInv : (e.values[i] ?? 0);
    });
    forAll('contribution', (key, e) => {
      if (isTotal(e.label)) return 1;
      const src = _componentSources(e.label, ctx);
      return src && totalValue > 0 ? src.value / totalValue : (e.values[i] ?? 0);
    });
    forAll('net_change', (key, e) => {
      if (isTotal(e.label)) return totalValue - prevTotal;
      const src = _componentSources(e.label, ctx);
      return src ? src.value - src.prevValue : (e.values[i] ?? 0);
    });
    forAll('returns', (key, e) => {
      if (isTotal(e.label)) return (totalValue - prevTotal) - totalNewInv;
      const src = _componentSources(e.label, ctx);
      return src ? (src.value - src.prevValue) - src.newInv : (e.values[i] ?? 0);
    });
    forAll('net_cashflows', (key, e) => {
      if (isTotal(e.label)) return totalNewInv;
      const src = _componentSources(e.label, ctx);
      return src ? src.newInv : (e.values[i] ?? 0);
    });
    forAll('pct_returns', (key, e) => {
      if (isTotal(e.label)) {
        const ret = (totalValue - prevTotal) - totalNewInv;
        return prevTotal > 0 ? ret / prevTotal : 0;
      }
      const src = _componentSources(e.label, ctx);
      if (!src) return e.values[i] ?? 0;
      const ret = (src.value - src.prevValue) - src.newInv;
      return src.prevValue > 0 ? ret / src.prevValue : 0;
    });
  }

  // XIRR last: it needs the fully-updated new_investment/net_worth series.
  // Same seeded-opening construction closeMonth uses, evaluated at each
  // ledger-era column.
  if (breakupSummary.xirr) {
    for (let i = firstLedgerIdx; i < dates.length; i++) {
      Object.entries(breakupSummary.xirr).forEach(([key, e]) => {
        const invSeries = isTotal(e.label)
          ? breakupSummary.new_investment['Total Investment']?.values
          : breakupSummary.new_investment[key]?.values;
        const nwSeries = isTotal(e.label)
          ? breakupSummary.net_worth['Total']?.values
          : breakupSummary.net_worth[key]?.values;
        if (!invSeries || !nwSeries) return;
        const opening = nwSeries[0] || 0;
        const flows = opening > 0 ? [{ date: dates[0], amount: -opening }] : [];
        for (let j = 1; j <= i; j++) {
          const inv = invSeries[j] || 0;
          if (Math.abs(inv) > 1e-6) flows.push({ date: dates[j], amount: -inv });
        }
        flows.push({ date: dates[i], amount: nwSeries[i] });
        const x = computeXirr(flows);
        if (x != null) setVal('xirr', key, i, x);
      });
    }
  }

  if (snapsChanged) {
    try { localStorage.setItem(snapKey, JSON.stringify(colSnaps)); } catch (_) {}
  }
  if (changed) {
    if (typeof buildPortfolioSummary === 'function' && typeof portfolioSummary !== 'undefined') {
      portfolioSummary = buildPortfolioSummary(breakupSummary);
    }
    saveBreakupOverride();
    // NOT markLedgerDirty() here — this function runs on EVERY load via
    // integrateLedger(), purely re-deriving breakup columns from the ledger
    // (rounding drift, XIRR recompute as dates advance, live Gold value, etc.
    // routinely make `changed` true with no user action at all). Calling
    // markLedgerDirty() here was a real regression: once a device's
    // ledger_dirty flag got set by an ordinary page load, loadLedger() would
    // permanently ignore all FUTURE committed updates from other devices
    // (dirty means "prefer my local copy"), even though nothing was actually
    // edited locally — this is exactly what caused "transactions committed
    // from the local/dev version don't show up on the GitHub Pages version"
    // to persist no matter how many times the local device re-committed.
    // Only genuine user mutations (addTransaction/updateTransaction/
    // deleteTransaction/addBalance/updateBalance/deleteBalance/closeMonth)
    // should ever mark the ledger dirty.
  }
  return changed;
}

// Self-heal: an earlier version of closeMonth() built each component's XIRR cash-flow
// series WITHOUT seeding the opening (frozen-base) balance as an initial outflow.
// For any component with a nonzero starting corpus (e.g. PF/PPF carried in from the
// Excel era), that made the terminal value look like pure profit on only the sporadic
// later contributions — an absurd XIRR spike (60%+) on the first real Close Period.
// Recomputes just the LAST xirr column with the corrected construction; safe to call
// on every load (idempotent once already correct).
function repairLastXirrColumn() {
  if (!breakupSummary) return false;
  // One-shot per device: the buggy closeMonth() was fixed long ago, so once this
  // has run (and found nothing or healed the column) there's nothing left to scan.
  const _flagKey = _ledgerPrefix() + 'xirr_repair_done_v1';
  try { if (localStorage.getItem(_flagKey)) return false; } catch (_) {}
  try { localStorage.setItem(_flagKey, '1'); } catch (_) {}
  const dates = breakupSummary.dates || [];
  const xirrSec = breakupSummary.xirr || {};
  if (dates.length < 2) return false;
  const isTotalLabel = label =>
    /^(Total|Total Investment|Total Growth|Total Change|Average|Total Return %)$/.test(label);
  let changed = false;
  Object.entries(xirrSec).forEach(([key, entry]) => {
    if (!entry.values.length) return;
    const niSeries = isTotalLabel(entry.label)
      ? breakupSummary.new_investment['Total Investment']?.values
      : breakupSummary.new_investment[key]?.values;
    const nwSeries = isTotalLabel(entry.label)
      ? breakupSummary.net_worth['Total']?.values
      : breakupSummary.net_worth[key]?.values;
    if (!niSeries || !nwSeries || !nwSeries.length) return;
    const termVal = nwSeries[nwSeries.length - 1];

    // Reconstruct what the OLD buggy formula (no opening-balance outflow) would have
    // produced for this exact column. Only touch the stored value if it matches that
    // artifact — this never overwrites genuine (pre-ledger, Excel-era) historical XIRR,
    // which was computed by a different method entirely and won't coincidentally match.
    const buggyFlows = dates.map((dt, i) => ({ date: dt, amount: -(niSeries[i] || 0) }));
    buggyFlows.push({ date: dates[dates.length - 1], amount: termVal });
    const buggyX = computeXirr(buggyFlows);
    const stored = entry.values[entry.values.length - 1];
    if (buggyX == null || Math.abs(stored - buggyX) > 1e-4) return;

    const opening = nwSeries[0] || 0;
    const flows = opening > 0 ? [{ date: dates[0], amount: -opening }] : [];
    dates.forEach((dt, i) => {
      if (i === 0) return;
      const inv = niSeries[i] || 0;
      if (Math.abs(inv) > 1e-6) flows.push({ date: dt, amount: -inv });
    });
    flows.push({ date: dates[dates.length - 1], amount: termVal });
    const fixedX = computeXirr(flows);
    if (fixedX == null) return;
    entry.values[entry.values.length - 1] = +fixedX.toFixed(6);
    changed = true;
  });
  if (changed) saveBreakupOverride();
  return changed;
}
