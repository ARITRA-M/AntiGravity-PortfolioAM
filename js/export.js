// ─────────────────────────────────────────────────────────────────────────
// Backup / export module
//
// Produces two restorable backups of the full portfolio state:
//   1. JSON  — a single machine-restorable snapshot (all in-memory blobs).
//   2. Excel — a workbook mirroring the original "Portfolio Analysis.xlsx"
//              layout with matching structure, number formats, column widths,
//              cell styles, and a new Transactions sheet.
// ─────────────────────────────────────────────────────────────────────────

// ── Number format strings (matching original) ──────────────────────────
const NF_LAKHS   = '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ ';
const NF_LAKHS1D = '_ * #,##0.0_ ;_ * \\-#,##0.0_ ;_ * "-"??_ ;_ @_ ';
const NF_INV     = '#,##0';
const NF_INV2D   = '#,##0.00';
const NF_PCT     = '0%';
const NF_XIRR    = '0.0%';
const NF_DATE    = 'mmm-yy';
const NF_DATE2   = 'dd-mmm-yy';

// ── Breakup section definition ─────────────────────────────────────────
const BREAKUP_SECTIONS = [
  { key: 'net_worth',     title: 'NET WORTH',       totalLabel: 'Total',           nf: NF_LAKHS,   hasType: true  },
  { key: 'contribution',  title: 'CONTRIBUTION',    totalLabel: 'Total',           nf: NF_PCT,     hasType: false },
  { key: 'new_investment',title: 'NEW INVESTMENT',  totalLabel: 'Total Investment', nf: NF_LAKHS1D, hasType: true  },
  { key: 'returns',       title: 'RETURNS',          totalLabel: 'Total Growth',    nf: NF_LAKHS1D, hasType: true  },
  { key: 'net_change',    title: 'NET CHANGE',       totalLabel: 'Total Change',    nf: NF_LAKHS1D, hasType: true  },
  { key: 'net_cashflows', title: 'NET CASHFLOWS',    totalLabel: 'Total Change',    nf: NF_LAKHS1D, hasType: true  },
  { key: 'xirr',          title: 'XIRR',             totalLabel: 'Average',         nf: NF_XIRR,    hasType: true  },
  { key: 'pct_returns',   title: '% RETURNS',        totalLabel: 'Total Return %',  nf: NF_XIRR,    hasType: true  },
];

// Row label order — must match the original Breakup sheet row order
const BREAKUP_ROW_ORDER = [
  'Stocks', 'Mutual Funds', 'Gold', 'NPS E', 'NPS C', 'NPS G',
  'PF', 'PPF', 'Cash', 'Crypto', 'Bonds',
];
// Contribution section has NPS combined
const CONTRIBUTION_ROW_ORDER = [
  'Stocks', 'Mutual Funds', 'Gold', 'NPS', 'PF', 'PPF', 'Cash', 'Crypto', 'Bonds',
];

// ── Cell helpers ────────────────────────────────────────────────────────
function _n(v, nf, bold, fill) {
  const c = { t: 'n', v: v == null ? 0 : Number(v) || 0, z: nf };
  if (bold || fill) c.s = {};
  if (bold) c.s.font = { bold: true };
  if (fill) c.s.fill = { patternType: 'solid', fgColor: { rgb: fill } };
  return c;
}
function _s(v, bold, fill, sz) {
  const c = { t: 's', v: v == null ? '' : String(v) };
  const s = {};
  if (bold) s.font = { bold: true, ...(sz ? { sz } : {}) };
  else if (sz) s.font = { sz };
  if (fill) s.fill = { patternType: 'solid', fgColor: { rgb: fill } };
  if (bold || fill || sz) c.s = s;
  return c;
}
function _d(isoStr, nf) {
  // Convert YYYY-MM-DD to Excel date serial
  const dt = new Date(isoStr + 'T00:00:00');
  const serial = (dt.getTime() - new Date(Date.UTC(1899, 11, 30)).getTime()) / 86400000;
  return { t: 'n', v: serial, z: nf || NF_DATE, s: { numFmt: nf || NF_DATE } };
}

// Apply cell to worksheet at (row, col) — 0-based
function _put(ws, row, col, cell) {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  ws[addr] = cell;
  if (!ws['!ref']) {
    ws['!ref'] = addr + ':' + addr;
  } else {
    const ref = XLSX.utils.decode_range(ws['!ref']);
    if (row < ref.s.r) ref.s.r = row;
    if (col < ref.s.c) ref.s.c = col;
    if (row > ref.e.r) ref.e.r = row;
    if (col > ref.e.c) ref.e.c = col;
    ws['!ref'] = XLSX.utils.encode_range(ref);
  }
}

function _emptyWs() {
  return { '!ref': 'A1:A1' };
}

// ── JSON export ──────────────────────────────────────────────────────────
function buildBackupObject() {
  return {
    _backup_meta: {
      app: 'AntiGravity Portfolio',
      exported_at: new Date().toISOString(),
      schema: 2,
    },
    frozen_base: (typeof frozenBase !== 'undefined' && frozenBase) || null,
    transactions: (typeof transactions !== 'undefined' && transactions) || [],
    balances: (typeof balances !== 'undefined' && balances) || [],
    portfolio_summary: portfolioSummary || null,
    breakup_summary: breakupSummary || null,
    latest_equity: latestEquity || [],
    latest_mf: latestMf || [],
    historical_holdings: historicalHoldings || null,
  };
}

function exportBackupJson() {
  const payload = JSON.stringify(buildBackupObject(), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  triggerDownload(blob, `portfolio-backup-${todayStamp()}.json`);
}

// ── Excel export ─────────────────────────────────────────────────────────
// SheetJS (437KB) is not loaded with the page — it would block first paint on
// mobile for a feature used a few times a year. Inject it the first time an
// Excel export is requested; the SW keeps it cached for offline use.
let _xlsxLoadPromise = null;
function ensureXlsxLoaded() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (!_xlsxLoadPromise) {
    _xlsxLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.core.min.js';
      s.onload = resolve;
      s.onerror = () => { _xlsxLoadPromise = null; reject(new Error('Failed to load Excel library')); };
      document.head.appendChild(s);
    });
  }
  return _xlsxLoadPromise;
}

async function exportBackupXlsx() {
  try { await ensureXlsxLoaded(); } catch (_) { alert('Could not load the Excel library (offline?). Try again once online.'); return; }
  if (!breakupSummary || !historicalHoldings) { alert('No data to export yet.'); return; }

  const wb = XLSX.utils.book_new();

  // Sheet order: Annual, Quarterly, Monthly, Breakup, dated sheets, Transactions
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'year'),    'Annual');
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'quarter'), 'Quarterly');
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'month'),   'Monthly');
  XLSX.utils.book_append_sheet(wb, buildBreakupSheet(breakupSummary),           'Breakup');
  appendDatedHoldingSheets(wb, historicalHoldings);
  XLSX.utils.book_append_sheet(wb, buildTransactionsSheet(), 'Transactions');

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
  triggerDownload(
    new Blob([buf], { type: 'application/octet-stream' }),
    `Portfolio Analysis ${todayStamp()}.xlsx`,
  );
}

// ── Breakup sheet ─────────────────────────────────────────────────────────
function buildBreakupSheet(breakup) {
  const ws = _emptyWs();
  const dates = breakup.dates || [];

  // Helper: find section entry by label (label may differ from key)
  const byLabel = (section, label) => {
    if (!breakup[section]) return null;
    return Object.values(breakup[section]).find(e => e.label === label) || null;
  };

  // Col widths: A=21, B=13, data cols=13 each
  ws['!cols'] = [{ wch: 21 }, { wch: 13 }, ...dates.map(() => ({ wch: 13 }))];

  let row = 0;

  // Row 0: header — Instrument | Asset Type | dates
  _put(ws, row, 0, _s('Instrument', true));
  _put(ws, row, 1, _s('Asset Type', true));
  dates.forEach((d, i) => _put(ws, row, i + 2, _d(d, NF_DATE)));
  row++;

  // Row 1: "Value (Lakhs)" sub-header
  dates.forEach((d, i) => _put(ws, row, i + 2, _s('Value (Lakhs)', true)));
  row++;

  // Each section
  BREAKUP_SECTIONS.forEach(sec => {
    const secData = breakup[sec.key] || {};
    const rowOrder = sec.key === 'contribution' ? CONTRIBUTION_ROW_ORDER : BREAKUP_ROW_ORDER;

    // Section title row (blank for B onwards)
    _put(ws, row, 0, _s(sec.title, true));
    row++;

    // Component rows
    rowOrder.forEach(label => {
      const entry = byLabel(sec.key, label);
      _put(ws, row, 0, _s(label));
      if (sec.hasType && entry && entry.asset_type) _put(ws, row, 1, _s(entry.asset_type));
      const vals = entry ? (entry.values || []) : [];
      dates.forEach((_, i) => {
        const v = vals[i];
        _put(ws, row, i + 2, _n(v != null ? v : null, sec.nf));
      });
      row++;
    });

    // Total row
    _put(ws, row, 0, _s(sec.totalLabel, true));
    const totalVals = (() => {
      // Sum up all component rows or use the 'Total' entry directly
      const totalEntry = Object.values(secData).find(e =>
        e.label === 'Total' || e.label === sec.totalLabel);
      if (totalEntry) return totalEntry.values || [];
      // Fallback: sum rowOrder
      return dates.map((_, i) => {
        let s = 0;
        rowOrder.forEach(label => {
          const e2 = byLabel(sec.key, label);
          s += (e2 && e2.values && e2.values[i] != null) ? e2.values[i] : 0;
        });
        return s;
      });
    })();
    dates.forEach((_, i) => _put(ws, row, i + 2, _n(totalVals[i], sec.nf, true)));
    row++;

    // Blank separator row between sections
    row++;
  });

  return ws;
}

// ── Rollup (Monthly / Quarterly / Annual) sheets ─────────────────────────
function buildRollupSheet(breakup, grain) {
  const ws = _emptyWs();
  const dates = breakup.dates || [];
  const nw = breakup.net_worth || {};
  const ni = breakup.new_investment || {};
  const ret = breakup.returns || {};
  const nc = breakup.net_change || {};

  // Map asset_type → super-category
  const superOf = (entry) => {
    const t = (entry.asset_type || '').toLowerCase();
    if (t === 'equity') return 'Equity';
    if (t === 'debt') return 'Debt';
    if (t === 'gold') return 'Gold';
    if (t === 'liquid') return 'Liquid';
    if (t === 'alternate') return 'Alternate';
    return null;
  };

  // Group date indices by period
  const periodKey = (iso) => {
    const d = new Date(iso);
    const y = d.getFullYear();
    if (grain === 'year') return String(y);
    if (grain === 'quarter') return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    return iso.slice(0, 7); // YYYY-MM
  };
  const periods = [];
  const lastIdxOf = {};
  dates.forEach((iso, i) => {
    const k = periodKey(iso);
    if (!(k in lastIdxOf)) periods.push(k);
    lastIdxOf[k] = i;
  });

  const cats = ['Equity', 'Debt', 'Gold', 'Liquid', 'Alternate'];
  const hdrLabel = grain === 'year' ? 'Year' : grain === 'quarter' ? 'Quarter' : 'Month';
  const nCols = periods.length;

  // Sum values for a section + super-category for a period
  const sumCat = (section, cat, pidx) => {
    let s = 0;
    Object.values(section).forEach(e => {
      if (superOf(e) === cat) s += (e.values || [])[pidx] || 0;
    });
    return s;
  };
  const sumAll = (section, pidx) => {
    let s = 0;
    Object.values(section).forEach(e => {
      if (superOf(e) !== null) s += (e.values || [])[pidx] || 0;
    });
    return s;
  };

  ws['!cols'] = [{ wch: 14 }, ...periods.map(() => ({ wch: 12 }))];

  let row = 0;
  // Header row
  _put(ws, row, 0, _s(hdrLabel, true));
  periods.forEach((p, i) => _put(ws, row, i + 1, _s(p, true)));
  row++;
  // Blank separator
  row++;

  const sections = [
    { label: 'NET WORTH',      data: nw,  nf: NF_LAKHS,   totalLabel: 'Total' },
    { label: 'CONTRIBUTION',   data: nw,  nf: NF_PCT,     totalLabel: 'Total', isContrib: true },
    { label: 'NEW INVESTMENT', data: ni,  nf: NF_LAKHS1D, totalLabel: 'Total' },
    { label: 'RETURNS',        data: ret, nf: NF_LAKHS1D, totalLabel: 'Total' },
    { label: 'NET CHANGE',     data: nc,  nf: NF_LAKHS1D, totalLabel: 'Total' },
  ];

  sections.forEach(sec => {
    _put(ws, row, 0, _s(sec.label, true));
    row++;

    // Precompute totals per period for contribution
    const periodTotals = periods.map((_, pi) => sumAll(nw, lastIdxOf[periods[pi]]));

    cats.forEach(cat => {
      _put(ws, row, 0, _s(cat));
      periods.forEach((p, i) => {
        const idx = lastIdxOf[p];
        const raw = sumCat(sec.data, cat, idx);
        const val = sec.isContrib ? (periodTotals[i] ? raw / periodTotals[i] : 0) : raw;
        _put(ws, row, i + 1, _n(val, sec.nf));
      });
      row++;
    });

    // Total row
    _put(ws, row, 0, _s(sec.totalLabel, true));
    periods.forEach((p, i) => {
      const idx = lastIdxOf[p];
      const raw = sumAll(sec.data, idx);
      const val = sec.isContrib ? 1 : raw;
      _put(ws, row, i + 1, _n(val, sec.nf, true));
    });
    row++;
    row++; // blank separator
  });

  return ws;
}

// ── Dated equity + MF sheets ──────────────────────────────────────────────
function appendDatedHoldingSheets(wb, hist) {
  // Grey fills matching the original
  const FILL_HDR_E  = 'B0B3B2'; // equity header
  const FILL_ROW_E  = 'D4D4D4'; // equity instrument cell
  const FILL_HDR_MF = '4B5B6D'; // MF header (dark blue-grey)

  const E_COLS  = ['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Invested', 'Cur. val', 'P&L', 'Gain %'];
  const MF_COLS = ['Scheme', 'Scheme Type', 'Quantity', 'Current Price', 'Average Buy NAV',
                   'Amount Invested', 'Current Valuation', 'Unrealised Gain/Loss', 'Gain/ Loss %'];

  // Collect all dated snapshots
  const byDateE  = {};
  const byDateMf = {};

  Object.values(hist.stocks || {}).forEach(info => {
    (info.history || []).forEach(h => {
      const key = h.date.replace(/-/g, '');
      (byDateE[key] = byDateE[key] || []).push({
        instrument: info.instrument, qty: h.qty, avg_cost: h.avg_cost,
        ltp: h.ltp, invested: h.invested, cur_val: h.cur_val, pnl: h.pnl, gain_pct: h.gain_pct,
      });
    });
  });

  Object.values(hist.mfs || {}).forEach(info => {
    (info.history || []).forEach(h => {
      const key = h.date.replace(/-/g, '');
      (byDateMf[key] = byDateMf[key] || []).push({
        scheme: info.instrument, category: info.category || '',
        qty: h.qty, ltp: h.ltp, avg_cost: h.avg_cost,
        invested: h.invested, cur_val: h.cur_val, pnl: h.pnl, gain_pct: h.gain_pct,
      });
    });
  });

  // Latest holdings (from latestEquity/latestMf) added for the most recent date
  const today = localDateStr().replace(/-/g, '');
  if (typeof latestEquity !== 'undefined' && latestEquity && latestEquity.length) {
    const key = today;
    byDateE[key] = latestEquity.map(s => ({
      instrument: s.instrument, qty: s.qty, avg_cost: s.avg_cost,
      ltp: s.ltp, invested: s.invested, cur_val: s.cur_val, pnl: s.pnl,
      gain_pct: s.gain_pct,
    }));
  }
  if (typeof latestMf !== 'undefined' && latestMf && latestMf.length) {
    byDateMf[today] = latestMf.map(f => ({
      scheme: f.scheme, category: f.scheme_type || '',
      qty: f.qty, ltp: f.price, avg_cost: f.avg_nav,
      invested: f.invested, cur_val: f.cur_val, pnl: f.pnl, gain_pct: f.gain_pct,
    }));
  }

  // Newest first
  const eDates  = Object.keys(byDateE).sort((a, b) => b.localeCompare(a));
  const mfDates = Object.keys(byDateMf).sort((a, b) => b.localeCompare(a));

  eDates.forEach(d => {
    const ws = _emptyWs();
    ws['!cols'] = [
      { wch: 42 }, { wch: 12 }, { wch: 17 }, { wch: 23 },
      { wch: 23 }, { wch: 21 }, { wch: 22 }, { wch: 13 },
    ];
    // Header row (grey fill, bold, size 8)
    E_COLS.forEach((h, c) => _put(ws, 0, c, { t: 's', v: h, s: {
      font: { bold: true, sz: 8 }, fill: { patternType: 'solid', fgColor: { rgb: FILL_HDR_E } },
    }}));

    const rows = byDateE[d];
    rows.sort((a, b) => a.instrument.localeCompare(b.instrument));
    let totInvested = 0, totCurVal = 0, totPnl = 0;
    rows.forEach((r, i) => {
      const row = i + 1;
      totInvested += r.invested || 0;
      totCurVal   += r.cur_val  || 0;
      totPnl      += r.pnl      || 0;
      _put(ws, row, 0, { t: 's', v: r.instrument, s: { font: { bold: true, sz: 8 }, fill: { patternType: 'solid', fgColor: { rgb: FILL_ROW_E } } } });
      _put(ws, row, 1, _n(r.qty,      '#,##0.####', false, null));
      _put(ws, row, 2, _n(r.avg_cost, '#,##0.00',   false, null));
      _put(ws, row, 3, _n(r.ltp,      '#,##0.00',   false, null));
      _put(ws, row, 4, _n(r.invested, NF_INV,       false, null));
      _put(ws, row, 5, _n(r.cur_val,  NF_INV,       false, null));
      _put(ws, row, 6, _n(r.pnl,      NF_INV,       false, null));
      _put(ws, row, 7, _n(r.invested ? r.pnl / r.invested : 0, NF_PCT, false, null));
    });
    // Total row
    const totalRow = rows.length + 1;
    _put(ws, totalRow, 0, _s('Total', true));
    _put(ws, totalRow, 4, _n(totInvested, NF_INV, true));
    _put(ws, totalRow, 5, _n(totCurVal,   NF_INV, true));
    _put(ws, totalRow, 6, _n(totPnl,      NF_INV, true));
    _put(ws, totalRow, 7, _n(totInvested ? totPnl / totInvested : 0, NF_PCT, true));

    XLSX.utils.book_append_sheet(wb, ws, `${d} E`);
  });

  mfDates.forEach(d => {
    const ws = _emptyWs();
    ws['!cols'] = [
      { wch: 56 }, { wch: 25 }, { wch: 12 }, { wch: 12 },
      { wch: 15 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 12 },
    ];
    // Header (dark blue-grey, bold, size 11, white text)
    MF_COLS.forEach((h, c) => _put(ws, 0, c, { t: 's', v: h, s: {
      font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: FILL_HDR_MF } },
    }}));

    const rows = byDateMf[d];
    rows.sort((a, b) => a.scheme.localeCompare(b.scheme));
    let totInv = 0, totCur = 0, totPnl = 0;
    rows.forEach((r, i) => {
      const row = i + 1;
      totInv  += r.invested || 0;
      totCur  += r.cur_val  || 0;
      totPnl  += r.pnl      || 0;
      _put(ws, row, 0, _s(r.scheme));
      _put(ws, row, 1, _s(r.category));
      _put(ws, row, 2, _n(r.qty,      NF_INV2D, false, null));
      _put(ws, row, 3, _n(r.ltp,      '#,##0.0000', false, null));
      _put(ws, row, 4, _n(r.avg_cost, '#,##0.0000', false, null));
      _put(ws, row, 5, _n(r.invested, NF_INV2D, false, null));
      _put(ws, row, 6, _n(r.cur_val,  NF_INV2D, false, null));
      _put(ws, row, 7, _n(r.pnl,      NF_INV2D, false, null));
      _put(ws, row, 8, _n(r.invested ? r.pnl / r.invested : 0, NF_PCT, false, null));
    });
    // Total row
    const totalRow = rows.length + 1;
    _put(ws, totalRow, 0, _s('Total', true));
    _put(ws, totalRow, 5, _n(totInv,  NF_INV2D, true));
    _put(ws, totalRow, 6, _n(totCur,  NF_INV2D, true));
    _put(ws, totalRow, 7, _n(totPnl,  NF_INV2D, true));
    _put(ws, totalRow, 8, _n(totInv ? totPnl / totInv : 0, NF_PCT, true));

    XLSX.utils.book_append_sheet(wb, ws, `${d} MF`);
  });
}

// ── Transactions sheet ─────────────────────────────────────────────────────
// Merges three sources into one dated log:
//   1. Ledger transactions (post-base, full qty/price/amount) — source "Ledger"
//   2. Historical xirr_flows from transaction_history.json (2012→base; buy/sell/
//      dividend with signed amount) — source "History"
//   3. Corporate actions (splits / bonus issues, qty added) — source "History"
function buildTransactionsSheet() {
  const ws = _emptyWs();
  ws['!cols'] = [
    { wch: 12 }, // Date
    { wch: 10 }, // Type
    { wch: 32 }, // Instrument / Ticker
    { wch: 12 }, // Qty
    { wch: 14 }, // Price (₹)
    { wch: 16 }, // Amount (₹)
    { wch: 10 }, // Source
    { wch: 24 }, // Note
  ];

  const FILL_TXN_HDR = '3B4A5B';
  const COLS = ['Date', 'Type', 'Instrument', 'Qty', 'Price (₹)', 'Amount (₹)', 'Source', 'Note'];
  COLS.forEach((h, c) => _put(ws, 0, c, { t: 's', v: h, s: {
    font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
    fill: { patternType: 'solid', fgColor: { rgb: FILL_TXN_HDR } },
  }}));

  const cap = s => s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '';
  const rows = [];

  // 1. Ledger transactions (full detail)
  const ledger = (typeof transactions !== 'undefined' && transactions) || [];
  ledger.forEach(t => rows.push({
    date: t.date || '', type: cap(t.type), instrument: t.instrument || '',
    qty: t.qty || 0, price: t.price || 0, amount: t.amount || 0,
    source: 'Ledger', note: t.note || '',
  }));

  // 2. Historical transaction log from transaction_history.json — use the detailed
  // `transactions` array (full qty/price/amount). Falls back to amount-only
  // `xirr_flows` only if the detailed array is absent (older data file).
  const th = (typeof transactionHistory !== 'undefined' && transactionHistory) || null;
  if (th && Array.isArray(th.transactions) && th.transactions.length) {
    // Total dividend per (date|ticker) from xirr_flows, since the per-row dividend
    // amount in `transactions` is per-share (qty was blank in the source).
    const divTotal = {};
    (th.xirr_flows || []).forEach(f => {
      if (f.type === 'dividend') divTotal[`${f.date}|${f.ticker}`] = (divTotal[`${f.date}|${f.ticker}`] || 0) + (f.amount || 0);
    });
    th.transactions.forEach(t => {
      const isDiv = t.type === 'dividend';
      const isCorp = t.type === 'split' || t.type === 'bonus';
      rows.push({
        date: t.date || '', type: cap(t.type), instrument: t.instrument || '',
        qty: isDiv ? null : (t.qty || 0),
        price: t.price || 0,
        amount: isDiv ? (divTotal[`${t.date}|${t.instrument}`] ?? null)
                      : (isCorp ? null : (t.amount || 0)),
        source: 'History',
        note: isDiv ? `₹${t.price}/share` : (isCorp ? `${t.qty} shares added` : ''),
      });
    });
  } else if (th) {
    (th.xirr_flows || []).forEach(f => rows.push({
      date: f.date || '', type: cap(f.type), instrument: f.ticker || '',
      qty: null, price: null, amount: Math.abs(f.amount || 0),
      source: 'History', note: f.type === 'buy' ? 'cash out' : 'cash in',
    }));
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  rows.forEach((r, i) => {
    const row = i + 1;
    _put(ws, row, 0, _s(r.date));
    _put(ws, row, 1, _s(r.type));
    _put(ws, row, 2, _s(r.instrument));
    if (r.qty != null)    _put(ws, row, 3, _n(r.qty,    '#,##0.####'));
    if (r.price != null)  _put(ws, row, 4, _n(r.price,  '#,##0.00'));
    if (r.amount != null) _put(ws, row, 5, _n(r.amount, '#,##0.00'));
    _put(ws, row, 6, _s(r.source));
    _put(ws, row, 7, _s(r.note));
  });

  // Summary row
  if (rows.length > 0) {
    const sumRow = rows.length + 2;
    const sumBy = type => rows.filter(r => r.type.toLowerCase() === type).reduce((s, r) => s + (r.amount || 0), 0);
    _put(ws, sumRow, 0, _s(`${rows.length} transactions`, true));
    _put(ws, sumRow, 1, _s('Buys:', true));
    _put(ws, sumRow, 2, _n(sumBy('buy'),  NF_INV2D, true));
    _put(ws, sumRow, 3, _s('Sells:', true));
    _put(ws, sumRow, 4, _n(sumBy('sell'), NF_INV2D, true));
    _put(ws, sumRow, 5, _s('Dividends:', true));
    _put(ws, sumRow, 6, _n(sumBy('dividend'), NF_INV2D, true));
  }

  return ws;
}

// ── Import (restore from JSON backup) ──────────────────────────────────────
async function importBackupJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || !data.breakup_summary || !data.historical_holdings) {
    throw new Error('Not a valid portfolio backup file.');
  }
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function todayStamp() {
  return localDateStr();
}
