// ─────────────────────────────────────────────────────────────────────────
// Backup / export module
//
// Produces two restorable backups of the full portfolio state:
//   1. JSON  — a single machine-restorable snapshot (all in-memory blobs).
//   2. Excel — a workbook mirroring the original "Portfolio Analysis.xlsx"
//              layout (dated `YYYYMMDD E` / `MF` sheets + Breakup + Monthly /
//              Quarterly / Annual roll-ups), so the data stays human-readable
//              even though Excel is no longer an input.
//
// Everything here runs on the already-decrypted runtime objects
// (breakupSummary, historicalHoldings, latestEquity, latestMf,
// portfolioSummary) plus the new ledger blobs (transactions, balances,
// frozenBase). It never touches the encrypted files on disk.
// ─────────────────────────────────────────────────────────────────────────

// ── Section row order for the Breakup sheet (inverse of parseBreakupSheet) ──
// Each Breakup metric section lists the 11 components in this fixed order,
// then a total row. We rebuild from breakupSummary[section] keys, which were
// parsed in this same order, so insertion order already matches.
const BREAKUP_SECTION_TITLES = {
  net_worth: 'NET WORTH',
  contribution: 'CONTRIBUTION',
  new_investment: 'NEW INVESTMENT',
  returns: 'RETURNS',
  net_change: 'NET CHANGE',
  net_cashflows: 'NET CASHFLOWS',
  xirr: 'XIRR',
  pct_returns: '% RETURNS',
};
const BREAKUP_SECTION_ORDER = [
  'net_worth', 'contribution', 'new_investment', 'returns',
  'net_change', 'net_cashflows', 'xirr', 'pct_returns',
];

// Build the full JSON backup object from current global state.
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

// ── JSON export ──
function exportBackupJson() {
  const payload = JSON.stringify(buildBackupObject(), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  triggerDownload(blob, `portfolio-backup-${todayStamp()}.json`);
}

// ── Excel export ──
function exportBackupXlsx() {
  if (typeof XLSX === 'undefined') {
    alert('Excel library not loaded — cannot export .xlsx');
    return;
  }
  if (!breakupSummary || !historicalHoldings) {
    alert('No data to export yet.');
    return;
  }
  const wb = XLSX.utils.book_new();

  // 1. Breakup sheet (first, like the analytics backbone)
  XLSX.utils.book_append_sheet(wb, buildBreakupSheet(breakupSummary), 'Breakup');

  // 2. Roll-up sheets derived from Breakup net-worth values
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'month'), 'Monthly');
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'quarter'), 'Quarterly');
  XLSX.utils.book_append_sheet(wb, buildRollupSheet(breakupSummary, 'year'), 'Annual');

  // 3. Dated equity + MF holding sheets (newest first, matching original order)
  appendDatedHoldingSheets(wb, historicalHoldings);

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  triggerDownload(new Blob([buf], { type: 'application/octet-stream' }),
    `Portfolio Analysis ${todayStamp()}.xlsx`);
}

// Rebuild the Breakup sheet as an array-of-arrays matching the original layout.
function buildBreakupSheet(breakup) {
  const dates = breakup.dates || [];
  const rows = [];
  // Header row: Instrument | Asset Type | <date> | <date> | ...
  rows.push(['Instrument', 'Asset Type', ...dates]);
  rows.push(['', '', ...dates.map(() => 'Value (Lakhs)')]);

  BREAKUP_SECTION_ORDER.forEach(section => {
    const sec = breakup[section] || {};
    rows.push([BREAKUP_SECTION_TITLES[section]]); // section title row
    Object.values(sec).forEach(entry => {
      rows.push([entry.label, entry.asset_type || '', ...(entry.values || [])]);
    });
    rows.push([]); // blank separator like the original
  });

  return XLSX.utils.aoa_to_sheet(rows);
}

// Build a Monthly / Quarterly / Annual roll-up sheet of net-worth values by the
// five super-categories (Equity, Debt, Gold, Liquid, Alternate) + Total.
function buildRollupSheet(breakup, grain) {
  const dates = breakup.dates || [];
  const nw = breakup.net_worth || {};

  // Map each net_worth component to its super-category via asset_type.
  const superOf = (entry) => {
    const t = (entry.asset_type || '').toLowerCase();
    if (t === 'equity') return 'Equity';
    if (t === 'debt') return 'Debt';
    if (t === 'gold') return 'Gold';
    if (t === 'liquid') return 'Liquid';
    if (t === 'alternate') return 'Alternate';
    return null; // 'Total' and unlabelled rows skipped
  };

  // Group date columns into period buckets (month/quarter/year), taking the
  // LAST value in each bucket (period-end balance), matching the original sheets.
  const periodKey = (iso) => {
    const d = new Date(iso);
    const y = d.getFullYear();
    if (grain === 'year') return String(y);
    if (grain === 'quarter') return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const periods = [];
  const lastIdxOfPeriod = {};
  dates.forEach((iso, i) => {
    const k = periodKey(iso);
    if (!(k in lastIdxOfPeriod)) periods.push(k);
    lastIdxOfPeriod[k] = i; // last wins → period-end value
  });

  const cats = ['Equity', 'Debt', 'Gold', 'Liquid', 'Alternate'];
  const label = grain === 'year' ? 'Year' : grain === 'quarter' ? 'Quarter' : 'Month';
  const rows = [[label, ...periods], ['', ...periods.map(() => 'Value (L)')], ['NET WORTH']];

  const catTotalsByPeriod = {}; // period -> total
  cats.forEach(cat => {
    const vals = periods.map(p => {
      const idx = lastIdxOfPeriod[p];
      let sum = 0;
      Object.values(nw).forEach(entry => {
        if (superOf(entry) === cat) sum += (entry.values || [])[idx] || 0;
      });
      catTotalsByPeriod[p] = (catTotalsByPeriod[p] || 0) + sum;
      return +sum.toFixed(6);
    });
    rows.push([cat, ...vals]);
  });
  rows.push(['Total', ...periods.map(p => +(catTotalsByPeriod[p] || 0).toFixed(6))]);

  return XLSX.utils.aoa_to_sheet(rows);
}

// Recreate the dated `YYYYMMDD E` and `YYYYMMDD MF` holding sheets from the
// per-instrument history. Group all history points by date, emit one sheet per
// date. Sheet names sorted newest-first to mirror the original workbook order.
function appendDatedHoldingSheets(wb, hist) {
  const E_HEADER = ['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Invested', 'Cur. val', 'P&L', 'Gain %'];
  const MF_HEADER = ['Scheme', 'Scheme Type', 'Quantity', 'Current Price', 'Average Buy NAV',
    'Amount Invested', 'Current Valuation', 'Unrealised Gain', 'Gain/ Loss %'];

  const byDateE = {}; // 'YYYYMMDD' -> rows[]
  const byDateMf = {};

  Object.values(hist.stocks || {}).forEach(info => {
    (info.history || []).forEach(h => {
      const key = h.date.replace(/-/g, '');
      (byDateE[key] = byDateE[key] || []).push(
        [info.instrument, h.qty, h.avg_cost, h.ltp, h.invested, h.cur_val, h.pnl, h.gain_pct]);
    });
  });
  Object.values(hist.mfs || {}).forEach(info => {
    (info.history || []).forEach(h => {
      const key = h.date.replace(/-/g, '');
      (byDateMf[key] = byDateMf[key] || []).push(
        [info.instrument, info.category || '', h.qty, h.ltp, h.avg_cost, h.invested, h.cur_val, h.pnl, h.gain_pct]);
    });
  });

  // Newest first (descending date) to match the original workbook ordering.
  const eDates = Object.keys(byDateE).sort((a, b) => b.localeCompare(a));
  const mfDates = Object.keys(byDateMf).sort((a, b) => b.localeCompare(a));
  eDates.forEach(d => {
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.aoa_to_sheet([E_HEADER, ...byDateE[d]]), `${d} E`);
  });
  mfDates.forEach(d => {
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.aoa_to_sheet([MF_HEADER, ...byDateMf[d]]), `${d} MF`);
  });
}

// ── Import (restore from JSON backup) ──
async function importBackupJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || !data.breakup_summary || !data.historical_holdings) {
    throw new Error('Not a valid portfolio backup file.');
  }
  return data; // caller applies + persists
}

// ── helpers ──
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
  return new Date().toISOString().slice(0, 10);
}
