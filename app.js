// Tab IDs
const tabIds = ['overview', 'growth', 'stocks', 'mfs', 'benchmark', 'dividends', 'tax', 'monthly'];

// Global state
let portfolioSummary = null;
let breakupSummary = null;
let latestEquity = null;
let latestMf = null;
let historicalHoldings = null;
let dividendData = null;

// Chart references
let allocationChart = null;
let componentXirrChart = null;
let allocationShiftChart = null;
let netWorthGrowthChart = null;
let capitalVsValuationChart = null;
let sectorChart = null;
let mfCategoryChart = null;
let mfValuationChart = null;
let stockHistoricalChart = null;
let mfHistoricalChart = null;
let benchmarkComparisonChart = null;
let rollingReturnsChart = null;
let dividendHistoryChart = null;
let dividendSourceChart = null;
let holdingPeriodChart = null;

// Table sorting state
let stockSortColumn = -1;
let stockSortAsc = true;
let mfSortColumn = -1;
let mfSortAsc = true;

// Benchmark data (simulated historical data for comparison)
const benchmarkData = {
  nifty50: {
    name: 'Nifty 50',
    history: [] // Will be generated based on portfolio dates
  },
  spx: {
    name: 'S&P 500',
    history: []
  },
  gold: {
    name: 'Gold',
    history: []
  }
};

// Indian tax rates
const TAX_RATES = {
  stcg_equity: 0.15,    // Short-term capital gains (equity)
  ltcg_equity: 0.10,    // Long-term capital gains (equity) > 1L exemption
  stcg_debt: 0.30,      // Short-term capital gains (debt) - as per slab
  ltcg_debt: 0.20,      // Long-term capital gains (debt) with indexation
  ltcg_equity_exempt: 100000 // LTCG exemption limit for equity
};

window.addEventListener('DOMContentLoaded', () => {
  // Only load data if auth is not required or already authenticated
  // auth.js handles the auth gate and calls loadData() after successful login
  if (typeof isAuthenticated !== 'function' || isAuthenticated()) {
    loadData();
  }
});

async function loadData() {
  try {
    const [resSummary, resBreakup, resEquity, resMf, resHist] = await Promise.all([
      fetch('data/portfolio_summary.json'),
      fetch('data/breakup_summary.json'),
      fetch('data/latest_equity.json'),
      fetch('data/latest_mf.json'),
      fetch('data/historical_holdings.json')
    ]);

    portfolioSummary = await resSummary.json();
    breakupSummary = await resBreakup.json();
    latestEquity = await resEquity.json();
    latestMf = await resMf.json();
    historicalHoldings = await resHist.json();

    // Generate simulated dividend data
    generateDividendData();

    // Generate benchmark data
    generateBenchmarkData();

    // Populate live badge
    const dates = breakupSummary.dates;
    const latestDate = dates[dates.length - 1];
    document.getElementById('live-time-badge').innerText = `As of: ${formatDateString(latestDate)}`;

    // Initialize UI elements
    updateKpis();
    initOverviewTab();
    initGrowthTab();
    initStocksTab();
    initMfsTab();
    initBenchmarkTab();
    initDividendTab();
    initTaxTab();
    initMonthlyTab();
  } catch (error) {
    console.error("Error loading portfolio data:", error);
    document.getElementById('live-time-badge').innerText = "Error loading data!";
    document.getElementById('live-time-badge').style.borderColor = "#ef4444";
  }
}

// Refresh portfolio data from Zerodha API (called by zerodha-login.js after login)
async function refreshPortfolioFromZerodha() {
  try {
    console.log('Refreshing portfolio from Zerodha...');
    
    // Fetch holdings and summary from the local Express server API
    const [resHoldings, resSummary] = await Promise.all([
      fetch('/api/portfolio/holdings'),
      fetch('/api/portfolio/summary')
    ]);
    
    const holdingsData = await resHoldings.json();
    const summaryData = await resSummary.json();
    
    if (holdingsData.success && holdingsData.data) {
      // Transform Zerodha holdings format to app's latestEquity format
      const zerodhaHoldings = holdingsData.data.net;
      
      // Update latestEquity with real Zerodha data
      latestEquity = zerodhaHoldings.map(h => ({
        instrument: h.tradingsymbol,
        sector: h.exchange === 'NSE' ? 'Equity' : 'Other',
        qty: h.quantity,
        avg_cost: h.average_price,
        ltp: h.last_price,
        cur_val: h.quantity * h.last_price,
        invested: h.quantity * h.average_price,
        pnl: h.pnl,
        gain_pct: ((h.last_price - h.average_price) / h.average_price) * 100
      }));
      
      // Update portfolioSummary with Zerodha summary data
      if (summaryData.success && summaryData.data) {
        portfolioSummary = {
          ...portfolioSummary,
          total_current_value: summaryData.data.totalValue,
          total_invested: summaryData.data.totalInvested,
          total_pnl: summaryData.data.totalPnl,
          total_pnl_pct: summaryData.data.totalPnlPercent,
          cash_balance: summaryData.data.cash
        };
      }
      
      // Re-initialize all UI tabs with updated data
      updateKpis();
      initOverviewTab();
      initGrowthTab();
      initStocksTab();
      initMfsTab();
      initBenchmarkTab();
      initDividendTab();
      initTaxTab();
      initMonthlyTab();
      
      console.log('Portfolio refreshed successfully from Zerodha!');
    }
  } catch (error) {
    console.error('Failed to refresh portfolio from Zerodha:', error);
  }
}

// Helpers
function formatLakhs(value) {
  return '₹' + parseFloat(value).toFixed(2) + ' L';
}

function formatINR(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(value);
}

function formatDateString(dateStr) {
  if (!dateStr || dateStr.startsWith('Period')) return dateStr;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

function getAssetColor(label) {
  const colors = {
    'Stocks': '#3b82f6',
    'Mutual Funds': '#6366f1',
    'Gold': '#f59e0b',
    'NPS E': '#10b981',
    'NPS C': '#8b5cf6',
    'NPS G': '#ec4899',
    'PF': '#14b8a6',
    'PPF': '#f43f5e',
    'Cash': '#6b7280',
    'Crypto': '#f97316',
    'Bonds': '#06b6d4',
    'Equity': '#3b82f6',
    'Debt': '#8b5cf6',
    'Liquid': '#6b7280',
    'Alternate': '#f97316'
  };
  return colors[label] || '#6366f1';
}

// Tab Switching
function switchTab(tabId) {
  tabIds.forEach(id => {
    const btn = document.querySelector(`.tab-btn[onclick="switchTab('${id}')"]`);
    const content = document.getElementById(`${id}-tab`);
    if (id === tabId) {
      btn.classList.add('active');
      content.classList.add('active');
    } else {
      btn.classList.remove('active');
      content.classList.remove('active');
    }
  });
  
  // Re-render charts on visible tab to ensure proper sizing
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    
    // Re-initialize monthly tab charts if switching to it
    if (tabId === 'monthly') {
      renderMonthlyChangeChart();
      renderMonthlyActivityChart();
    }
  }, 100);
}

// Update KPI Values
function updateKpis() {
  document.getElementById('kpi-net-worth').innerText = formatLakhs(portfolioSummary.total_net_worth_lakhs);
  document.getElementById('kpi-equity-val').innerText = formatLakhs(portfolioSummary.equity_lakhs);
  document.getElementById('kpi-equity-pct').innerText = portfolioSummary.allocation_pct.Equity.toFixed(1) + '%';
  document.getElementById('kpi-debt-val').innerText = formatLakhs(portfolioSummary.debt_lakhs);
  document.getElementById('kpi-debt-pct').innerText = portfolioSummary.allocation_pct.Debt.toFixed(1) + '%';
  document.getElementById('kpi-gold-val').innerText = formatLakhs(portfolioSummary.gold_lakhs);
  document.getElementById('kpi-gold-pct').innerText = portfolioSummary.allocation_pct.Gold.toFixed(1) + '%';
}

// ==================== OVERVIEW TAB ====================
function initOverviewTab() {
  // Destroy existing charts before re-creating
  if (allocationChart) allocationChart.destroy();
  if (componentXirrChart) componentXirrChart.destroy();
  if (allocationShiftChart) allocationShiftChart.destroy();

  // 1. Current Asset Allocation Donut
  const allocData = portfolioSummary.allocation_pct;
  const ctxAlloc = document.getElementById('allocation-donut-chart').getContext('2d');
  
  allocationChart = new Chart(ctxAlloc, {
    type: 'doughnut',
    data: {
      labels: ['Equity', 'Debt', 'Gold', 'Liquid', 'Alternate'],
      datasets: [{
        data: [allocData.Equity, allocData.Debt, allocData.Gold, allocData.Liquid, allocData.Alternate],
        backgroundColor: [
          getAssetColor('Equity'),
          getAssetColor('Debt'),
          getAssetColor('Gold'),
          getAssetColor('Liquid'),
          getAssetColor('Alternate')
        ],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.label}: ${context.raw.toFixed(2)}%`
          }
        }
      }
    }
  });

  // 2. Component XIRR Bar Chart
  const xirrSec = breakupSummary.xirr;
  const xirrLabels = [];
  const xirrValues = [];
  const xirrColors = [];
  
  Object.keys(xirrSec).forEach(key => {
    if (key !== 'Average' && key !== 'Total') {
      const label = xirrSec[key].label;
      const vals = xirrSec[key].values;
      const latestVal = vals[vals.length - 1];
      if (latestVal > 0) {
        xirrLabels.push(label);
        xirrValues.push(latestVal * 100); // Decimals to percentages
        xirrColors.push(getAssetColor(label));
      }
    }
  });
  
  const ctxXirr = document.getElementById('component-xirr-chart').getContext('2d');
  componentXirrChart = new Chart(ctxXirr, {
    type: 'bar',
    data: {
      labels: xirrLabels,
      datasets: [{
        label: 'Annualized Return (XIRR) %',
        data: xirrValues,
        backgroundColor: xirrColors,
        borderRadius: 6,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' }, 
          ticks: { color: '#9ca3af', font: { family: 'Outfit' }, callback: (value) => value + '%' } 
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });

  // 3. Historical Allocation Shift Area Chart
  const dates = breakupSummary.dates;
  const contribSec = breakupSummary.contribution;
  const contribDatasets = [];
  
  Object.keys(contribSec).forEach(key => {
    if (key !== 'Total') {
      const label = contribSec[key].label;
      const vals = contribSec[key].values.map(v => v * 100); // 0.65 -> 65%
      
      contribDatasets.push({
        label: label,
        data: vals,
        backgroundColor: getAssetColor(label) + 'cc', // translucent
        borderColor: getAssetColor(label),
        borderWidth: 1,
        fill: true
      });
    }
  });
  
  const ctxShift = document.getElementById('allocation-shift-chart').getContext('2d');
  allocationShiftChart = new Chart(ctxShift, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: contribDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          stacked: true, 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => value + '%' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });
}

// ==================== HISTORICAL GROWTH TAB ====================
function initGrowthTab() {
  // Destroy existing charts before re-creating
  if (netWorthGrowthChart) netWorthGrowthChart.destroy();
  if (capitalVsValuationChart) capitalVsValuationChart.destroy();

  const dates = breakupSummary.dates;
  const nwSec = breakupSummary.net_worth;
  const nwDatasets = [];
  
  Object.keys(nwSec).forEach(key => {
    if (key !== 'Total') {
      const label = nwSec[key].label;
      const vals = nwSec[key].values;
      
      nwDatasets.push({
        label: label,
        data: vals,
        backgroundColor: getAssetColor(label) + 'b3',
        borderColor: getAssetColor(label),
        borderWidth: 1.5,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4
      });
    }
  });
  
  const ctxGrowth = document.getElementById('net-worth-growth-chart').getContext('2d');
  netWorthGrowthChart = new Chart(ctxGrowth, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: nwDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => '₹' + value + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });

  // Capital vs Valuation Line Chart
  const totalNw = nwSec["Total"].values;
  const cumInvested = portfolioSummary.cumulative_investment_history;
  
  const ctxCap = document.getElementById('capital-vs-valuation-chart').getContext('2d');
  capitalVsValuationChart = new Chart(ctxCap, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Total Portfolio Valuation (Net Worth)',
          data: totalNw,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.05)',
          borderWidth: 3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'Cumulative Capital Invested',
          data: cumInvested,
          borderColor: '#6366f1',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => '₹' + value + ' L' }
        }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f3f4f6' } }
      }
    }
  });
}

function filterGrowthChart() {
  const filter = document.getElementById('growth-time-filter').value;
  const dates = breakupSummary.dates;
  let len = dates.length;
  
  let sliceIdx = 0;
  if (filter === '3Y') {
    sliceIdx = Math.max(0, len - 36);
  } else if (filter === '1Y') {
    sliceIdx = Math.max(0, len - 12);
  }
  
  const filteredLabels = dates.slice(sliceIdx).map(d => formatDateString(d));
  
  // Update Net Worth chart
  netWorthGrowthChart.data.labels = filteredLabels;
  netWorthGrowthChart.data.datasets.forEach((dataset, idx) => {
    const key = Object.keys(breakupSummary.net_worth).filter(k => k !== 'Total')[idx];
    dataset.data = breakupSummary.net_worth[key].values.slice(sliceIdx);
  });
  netWorthGrowthChart.update();
  
  // Update Capital vs Valuation chart
  capitalVsValuationChart.data.labels = filteredLabels;
  capitalVsValuationChart.data.datasets[0].data = breakupSummary.net_worth["Total"].values.slice(sliceIdx);
  capitalVsValuationChart.data.datasets[1].data = portfolioSummary.cumulative_investment_history.slice(sliceIdx);
  capitalVsValuationChart.update();
}

// ==================== STOCKS TAB ====================
function initStocksTab() {
  // Destroy existing chart before re-creating
  if (sectorChart) sectorChart.destroy();
  if (stockHistoricalChart) stockHistoricalChart.destroy();

  // Normalize gain_pct: compute from pnl/invested if missing or zero
  latestEquity.forEach(s => {
    if (!s.gain_pct || s.gain_pct === 0) {
      s.gain_pct = s.invested > 0 ? (s.pnl / s.invested) * 100 : 0;
    }
  });

  // 1. Winners & Losers lists
  const sortedEq = [...latestEquity];
  const winners = sortedEq.sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  const losers = sortedEq.sort((a, b) => a.pnl - b.pnl).slice(0, 5); // sorted ascending, first ones are biggest losses

  const winContainer = document.getElementById('stock-winners-list');
  winContainer.innerHTML = winners.map(w => `
    <div class="performer-item">
      <span class="performer-name">${w.instrument} <span style="font-weight:normal; font-size:0.75rem; color:var(--text-muted)">(${w.sector})</span></span>
      <span class="performer-pnl trend-up">+${formatINR(w.pnl)} (+${w.gain_pct.toFixed(1)}%)</span>
    </div>
  `).join('');

  const loseContainer = document.getElementById('stock-losers-list');
  loseContainer.innerHTML = losers.map(l => `
    <div class="performer-item">
      <span class="performer-name">${l.instrument} <span style="font-weight:normal; font-size:0.75rem; color:var(--text-muted)">(${l.sector})</span></span>
      <span class="performer-pnl trend-down">${formatINR(l.pnl)} (${l.gain_pct.toFixed(1)}%)</span>
    </div>
  `).join('');

  // 2. Sector Chart
  const sectorSums = {};
  latestEquity.forEach(s => {
    sectorSums[s.sector] = (sectorSums[s.sector] || 0) + s.cur_val;
  });
  
  const sortedSectors = Object.keys(sectorSums).map(sec => ({
    name: sec,
    val: sectorSums[sec]
  })).sort((a, b) => b.val - a.val);

  const ctxSec = document.getElementById('stock-sector-chart').getContext('2d');
  sectorChart = new Chart(ctxSec, {
    type: 'bar',
    data: {
      labels: sortedSectors.map(s => s.name),
      datasets: [{
        label: 'Current Valuation (INR)',
        data: sortedSectors.map(s => s.val),
        backgroundColor: 'rgba(99, 102, 241, 0.7)',
        borderColor: '#6366f1',
        borderWidth: 1,
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 10 } } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (value) => formatINR(value) }
        }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 3. Stock Selector List for Historical Explorer
  const sortedByVal = [...latestEquity].sort((a, b) => b.cur_val - a.cur_val);
  const explorerList = document.getElementById('explorer-stock-list');
  
  explorerList.innerHTML = sortedByVal.map((s, idx) => {
    const escapedInstrument = s.instrument.replace(/'/g, "\\'").replace(/&/g, '&').replace(/"/g, '"');
    return `
    <div class="explorer-item ${idx === 0 ? 'active' : ''}" onclick="selectStockExplorer('${escapedInstrument}', this)">
      <span class="name">${escapedInstrument}</span>
      <span class="val">${formatINR(s.cur_val)}</span>
    </div>`;
  }).join('');

  // Populate Stock Sector Dropdown
  const sectors = [...new Set(latestEquity.map(s => s.sector))].sort();
  const sectorDropdown = document.getElementById('stock-sector-filter');
  sectorDropdown.innerHTML = '<option value="ALL">All Sectors</option>' + 
    sectors.map(s => `<option value="${s}">${s}</option>`).join('');

  // Load first stock history
  if (sortedByVal.length > 0) {
    renderStockHistoricalChart(sortedByVal[0].instrument);
  }

  // Populate Table
  renderStocksTable(latestEquity);
}

function selectStockExplorer(symbol, element) {
  document.querySelectorAll('#explorer-stock-list .explorer-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');
  renderStockHistoricalChart(symbol);
}

function renderStockHistoricalChart(symbol) {
  // Build a lookup map from ticker symbols to historical holdings names
  // historical_holdings uses full names (e.g. "Ajanta Pharma Ltd.") while
  // latest_equity uses ticker symbols (e.g. "AJANTPHARM")
  // Build the mapping once and cache it
  if (!window._stockNameMap) {
    window._stockNameMap = {};
    const stockKeys = Object.keys(historicalHoldings.stocks);
    stockKeys.forEach(key => {
      const upper = key.toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      // Exact clean match (e.g., "SUNPHARMA" -> "SUNPHARMA")
      window._stockNameMap[clean] = key;
      // Without "LTD" or "LIMITED" suffix (e.g., "HDFCBANK" -> "HDFC Bank Ltd.")
      const withoutLtd = clean.replace(/LTD$/, '').replace(/LIMITED$/, '').trim();
      if (withoutLtd && withoutLtd !== clean) window._stockNameMap[withoutLtd] = key;
      // First significant word of multi-word names (e.g., "APOLLO" -> "Apollo Tyres Ltd.")
      const words = upper.split(/[^A-Z0-9]+/).filter(w => w.length > 2);
      if (words.length > 1) {
        if (!window._stockNameMap[words[0]]) {
          window._stockNameMap[words[0]] = key;
        }
      }
      // For names with "&", map each part (e.g., "M&M" -> "Mahindra & Mahindra Ltd.")
      if (upper.includes('&')) {
        upper.split('&').forEach(p => {
          const trimmed = p.replace(/[^A-Z0-9]/g, '').trim();
          if (trimmed.length >= 3 && !window._stockNameMap[trimmed]) {
            window._stockNameMap[trimmed] = key;
          }
        });
      }
    });
  }
  
  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stockKey = window._stockNameMap[cleanSymbol] || symbol;
  const stock = historicalHoldings.stocks[stockKey];
  if (!stock) return;
  
  const history = stock.history;
  const labels = history.map(h => formatDateString(h.date));
  const valuations = history.map(h => h.cur_val);
  const investments = history.map(h => h.invested);
  const ltps = history.map(h => h.ltp);

  const ctxStockHist = document.getElementById('stock-historical-chart').getContext('2d');
  
  if (stockHistoricalChart) {
    stockHistoricalChart.destroy();
  }
  
  stockHistoricalChart = new Chart(ctxStockHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (INR)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (INR)',
          data: investments,
          borderColor: '#10b981',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          yAxisID: 'y'
        },
        {
          label: 'LTP (Price in ₹)',
          data: ltps,
          borderColor: '#f59e0b',
          borderWidth: 2,
          fill: false,
          yAxisID: 'yPrice'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: true,
          text: `${symbol} Performance History`,
          color: '#fff',
          font: { family: 'Outfit', size: 16 }
        },
        legend: { labels: { color: '#f3f4f6' } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10 } },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
        },
        yPrice: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val }
        }
      }
    }
  });
}

function renderStocksTable(data) {
  const body = document.getElementById('stocks-table-body');
  body.innerHTML = data.map(s => `
    <tr>
      <td class="instrument-cell">${s.instrument}</td>
      <td><span class="sector-tag">${s.sector}</span></td>
      <td style="text-align: right;">${s.qty.toLocaleString()}</td>
      <td style="text-align: right;">₹${s.avg_cost.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">₹${s.ltp.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
      <td style="text-align: right;">${formatINR(s.invested)}</td>
      <td style="text-align: right;">${formatINR(s.cur_val)}</td>
      <td style="text-align: right;" class="${s.pnl >= 0 ? 'trend-up' : 'trend-down'}">
        ${s.pnl >= 0 ? '+' : ''}${formatINR(s.pnl)}
      </td>
      <td style="text-align: right;" class="${s.gain_pct >= 0 ? 'trend-up' : 'trend-down'}">
        ${s.gain_pct >= 0 ? '+' : ''}${s.gain_pct.toFixed(2)}%
      </td>
    </tr>
  `).join('');
}

function filterStocksTable() {
  const query = document.getElementById('stock-search').value.toLowerCase().trim();
  const sector = document.getElementById('stock-sector-filter').value;
  
  const filtered = latestEquity.filter(s => {
    const matchesQuery = s.instrument.toLowerCase().includes(query) || s.sector.toLowerCase().includes(query);
    const matchesSector = (sector === 'ALL') || (s.sector === sector);
    return matchesQuery && matchesSector;
  });
  
  renderStocksTable(filtered);
}

function sortStocks(colIdx) {
  if (stockSortColumn === colIdx) {
    stockSortAsc = !stockSortAsc;
  } else {
    stockSortColumn = colIdx;
    stockSortAsc = true;
  }

  // Update classes on headers
  const ths = document.querySelectorAll('#stocks-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(stockSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  const query = document.getElementById('stock-search').value.toLowerCase().trim();
  const sector = document.getElementById('stock-sector-filter').value;
  
  const filtered = latestEquity.filter(s => {
    const matchesQuery = s.instrument.toLowerCase().includes(query) || s.sector.toLowerCase().includes(query);
    const matchesSector = (sector === 'ALL') || (s.sector === sector);
    return matchesQuery && matchesSector;
  });

  filtered.sort((a, b) => {
    let valA, valB;
    switch(colIdx) {
      case 0: valA = a.instrument; valB = b.instrument; break;
      case 1: valA = a.sector; valB = b.sector; break;
      case 2: valA = a.qty; valB = b.qty; break;
      case 3: valA = a.avg_cost; valB = b.avg_cost; break;
      case 4: valA = a.ltp; valB = b.ltp; break;
      case 5: valA = a.invested; valB = b.invested; break;
      case 6: valA = a.cur_val; valB = b.cur_val; break;
      case 7: valA = a.pnl; valB = b.pnl; break;
      case 8: valA = a.gain_pct; valB = b.gain_pct; break;
    }
    
    if (typeof valA === 'string') {
      return stockSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return stockSortAsc ? valA - valB : valB - valA;
    }
  });

  renderStocksTable(filtered);
}

// ==================== MUTUAL FUNDS TAB ====================
function initMfsTab() {
  // Destroy existing charts before re-creating
  if (mfCategoryChart) mfCategoryChart.destroy();
  if (mfValuationChart) mfValuationChart.destroy();
  if (mfHistoricalChart) mfHistoricalChart.destroy();

  // 1. Category Donut
  const catSums = {};
  latestMf.forEach(f => {
    catSums[f.scheme_type] = (catSums[f.scheme_type] || 0) + f.cur_val;
  });
  
  const sortedCategories = Object.keys(catSums).map(c => ({
    name: c,
    val: catSums[c]
  })).sort((a, b) => b.val - a.val);

  const ctxMF = document.getElementById('mf-category-chart').getContext('2d');
  mfCategoryChart = new Chart(ctxMF, {
    type: 'doughnut',
    data: {
      labels: sortedCategories.map(c => c.name.replace('Equity : ', '')),
      datasets: [{
        data: sortedCategories.map(c => c.val),
        backgroundColor: [
          '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#14b8a6'
        ],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 10 } }
        }
      }
    }
  });

  // 2. Bar Chart of Top schemes by valuation
  const topMfs = [...latestMf].sort((a, b) => b.cur_val - a.cur_val).slice(0, 10);
  
  const ctxMfVal = document.getElementById('mf-valuation-bar-chart').getContext('2d');
  mfValuationChart = new Chart(ctxMfVal, {
    type: 'bar',
    data: {
      labels: topMfs.map(f => f.scheme.substring(0, 20) + '...'),
      datasets: [{
        label: 'Current Valuation (INR)',
        data: topMfs.map(f => f.cur_val),
        backgroundColor: 'rgba(99, 102, 241, 0.65)',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
        },
        y: { grid: { display: false }, ticks: { color: '#f3f4f6', font: { size: 9 } } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 3. Scheme Selector for Explorer
  const sortedMFsByVal = [...latestMf].sort((a, b) => b.cur_val - a.cur_val);
  const explorerList = document.getElementById('explorer-mf-list');
  
  explorerList.innerHTML = sortedMFsByVal.map((f, idx) => `
    <div class="explorer-item ${idx === 0 ? 'active' : ''}" onclick="selectMfExplorer('${f.scheme}', this)">
      <span class="name">${f.scheme.substring(0, 25) + '...'}</span>
      <span class="val">${formatINR(f.cur_val)}</span>
    </div>
  `).join('');

  // Populate MF Category dropdown filter
  const categories = [...new Set(latestMf.map(f => f.scheme_type))].sort();
  const typeDropdown = document.getElementById('mf-type-filter');
  typeDropdown.innerHTML = '<option value="ALL">All Categories</option>' + 
    categories.map(c => `<option value="${c}">${c}</option>`).join('');

  // Load first MF history
  if (sortedMFsByVal.length > 0) {
    renderMfHistoricalChart(sortedMFsByVal[0].scheme);
  }

  // Populate table
  renderMfsTable(latestMf);
}

function selectMfExplorer(scheme, element) {
  document.querySelectorAll('#explorer-mf-list .explorer-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');
  renderMfHistoricalChart(scheme);
}

function renderMfHistoricalChart(scheme) {
  const mf = historicalHoldings.mfs[scheme];
  if (!mf) return;
  
  const history = mf.history;
  const labels = history.map(h => formatDateString(h.date));
  const valuations = history.map(h => h.cur_val);
  const investments = history.map(h => h.invested);
  const navs = history.map(h => h.ltp);

  const ctxMfHist = document.getElementById('mf-historical-chart').getContext('2d');
  
  if (mfHistoricalChart) {
    mfHistoricalChart.destroy();
  }
  
  mfHistoricalChart = new Chart(ctxMfHist, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Current Valuation (INR)',
          data: valuations,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          borderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Amount Invested (INR)',
          data: investments,
          borderColor: '#10b981',
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          yAxisID: 'y'
        },
        {
          label: 'NAV Price (₹)',
          data: navs,
          borderColor: '#ec4899',
          borderWidth: 2,
          fill: false,
          yAxisID: 'yPrice'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: true,
          text: `${scheme.substring(0, 45)}... History`,
          color: '#fff',
          font: { family: 'Outfit', size: 14 }
        },
        legend: { labels: { color: '#f3f4f6' } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 10 } },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (val) => formatINR(val) }
        },
        yPrice: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#9ca3af', callback: (val) => '₹' + val }
        }
      }
    }
  });
}

function renderMfsTable(data) {
  const body = document.getElementById('mfs-table-body');
  body.innerHTML = data.map(f => `
    <tr>
      <td class="instrument-cell" title="${f.scheme}">${f.scheme}</td>
      <td><span class="category-tag">${f.scheme_type.replace('Equity : ', '')}</span></td>
      <td style="text-align: right;">${f.qty.toLocaleString()}</td>
      <td style="text-align: right;">₹${f.price.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
      <td style="text-align: right;">₹${f.avg_nav.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
      <td style="text-align: right;">${formatINR(f.invested)}</td>
      <td style="text-align: right;">${formatINR(f.cur_val)}</td>
      <td style="text-align: right;" class="${f.pnl >= 0 ? 'trend-up' : 'trend-down'}">
        ${f.pnl >= 0 ? '+' : ''}${formatINR(f.pnl)}
      </td>
      <td style="text-align: right;" class="${f.gain_pct >= 0 ? 'trend-up' : 'trend-down'}">
        ${f.gain_pct >= 0 ? '+' : ''}${f.gain_pct.toFixed(2)}%
      </td>
    </tr>
  `).join('');
}

function filterMfsTable() {
  const query = document.getElementById('mf-search').value.toLowerCase().trim();
  const cat = document.getElementById('mf-type-filter').value;
  
  const filtered = latestMf.filter(f => {
    const matchesQuery = f.scheme.toLowerCase().includes(query) || f.scheme_type.toLowerCase().includes(query);
    const matchesCat = (cat === 'ALL') || (f.scheme_type === cat);
    return matchesQuery && matchesCat;
  });
  
  renderMfsTable(filtered);
}

// ==================== DATA GENERATORS ====================

function generateBenchmarkData() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const firstValue = nwTotal[0];
  
  // Generate simulated benchmark data based on portfolio performance
  // In a real app, this would fetch actual benchmark data from an API
  
  // Nifty 50 - simulated with ~12% annual growth
  benchmarkData.nifty50.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.01, months); // ~12% annual
    const noise = 1 + (Math.sin(i * 0.3) * 0.05); // Some volatility
    return { date: d, value: firstValue * growth * noise };
  });
  
  // S&P 500 - simulated with ~10% annual growth
  benchmarkData.spx.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.0083, months); // ~10% annual
    const noise = 1 + (Math.sin(i * 0.25 + 1) * 0.04);
    return { date: d, value: firstValue * growth * noise };
  });
  
  // Gold - simulated with ~6% annual growth
  benchmarkData.gold.history = dates.map((d, i) => {
    const months = i;
    const growth = Math.pow(1.005, months); // ~6% annual
    const noise = 1 + (Math.sin(i * 0.15 + 2) * 0.03);
    return { date: d, value: firstValue * growth * noise };
  });
}

function generateDividendData() {
  // Generate deterministic dividend data based on holdings
  const dividendHistory = [];
  const dividendByType = { stocks: 0, mfs: 0 };
  const dividendHoldings = [];
  
  // Simulate dividend history (monthly for the past 2 years)
  const dates = breakupSummary.dates;
  const portfolioValue = portfolioSummary.total_net_worth_lakhs * 100000;
  
  dates.forEach((d, i) => {
    // Simulate ~1.5% annual dividend yield, paid quarterly
    if (i % 3 === 0) {
      const monthlyDiv = portfolioValue * 0.015 / 4;
      dividendHistory.push({
        date: d,
        amount: monthlyDiv * (1 + i * 0.02) // Growing over time
      });
    }
  });
  
  // Generate dividend-paying holdings (deterministic - based on PnL performance)
  // Stocks with positive PnL are more likely to pay dividends
  latestEquity.slice(0, 15).forEach((stock, idx) => {
    // Deterministic: use stock name hash and PnL to decide if dividend-paying
    const nameHash = stock.instrument.length + stock.pnl;
    const paysDividend = (nameHash % 10) > 2; // ~70% pay dividends, deterministic
    if (paysDividend) {
      // Yield based on sector: stable sectors get higher yield
      const baseYield = stock.sector.includes('Bank') || stock.sector.includes('Oil') ? 2.5 : 1.5;
      const yield_ = baseYield + (idx % 3) * 0.5; // Deterministic variation
      dividendHoldings.push({
        instrument: stock.instrument,
        type: 'Stock',
        annualDiv: stock.cur_val * yield_ / 100,
        yield: yield_,
        lastDiv: formatDateString(dates[dates.length - 1])
      });
    }
  });
  
  latestMf.slice(0, 10).forEach((fund, idx) => {
    // Deterministic: use scheme name hash
    const nameHash = fund.scheme.length + fund.pnl;
    const paysDividend = (nameHash % 10) > 3; // ~60% pay dividends, deterministic
    if (paysDividend) {
      const yield_ = 1.0 + (idx % 4) * 0.5; // Deterministic: 1.0%, 1.5%, 2.0%, 2.5%
      dividendHoldings.push({
        instrument: fund.scheme.substring(0, 30),
        type: 'Mutual Fund',
        annualDiv: fund.cur_val * yield_ / 100,
        yield: yield_,
        lastDiv: formatDateString(dates[dates.length - 1])
      });
    }
  });
  
  const totalAnnualDiv = dividendHoldings.reduce((sum, h) => sum + h.annualDiv, 0);
  
  dividendData = {
    history: dividendHistory,
    byType: {
      stocks: totalAnnualDiv * 0.65,
      mfs: totalAnnualDiv * 0.35
    },
    holdings: dividendHoldings,
    totalAnnual: totalAnnualDiv,
    ttm: totalAnnualDiv * 0.9, // Trailing 12 months
    yield: (totalAnnualDiv / portfolioValue) * 100,
    growth: 12.5 // YoY growth
  };
}

// ==================== BENCHMARK TAB ====================

function initBenchmarkTab() {
  // Destroy existing charts before re-creating
  if (benchmarkComparisonChart) benchmarkComparisonChart.destroy();
  if (rollingReturnsChart) rollingReturnsChart.destroy();

  renderBenchmarkComparisonChart('nifty50');
  renderRollingReturnsChart();
  updateBenchmarkStats('nifty50');
}

function updateBenchmarkChart() {
  const benchmark = document.getElementById('benchmark-select').value;
  renderBenchmarkComparisonChart(benchmark);
  updateBenchmarkStats(benchmark);
}

function renderBenchmarkComparisonChart(benchmarkKey) {
  const benchmark = benchmarkData[benchmarkKey];
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  const ctx = document.getElementById('benchmark-comparison-chart').getContext('2d');
  
  if (benchmarkComparisonChart) {
    benchmarkComparisonChart.destroy();
  }
  
  // Normalize both to start at 100 for comparison
  const portfolioNormalized = nwTotal.map(v => (v / nwTotal[0]) * 100);
  const benchmarkNormalized = benchmark.history.map(h => (h.value / benchmark.history[0].value) * 100);
  
  benchmarkComparisonChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates.map(d => formatDateString(d)),
      datasets: [
        {
          label: 'Portfolio',
          data: portfolioNormalized,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2.5,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: benchmark.name,
          data: benchmarkNormalized,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#f3f4f6' } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${context.raw.toFixed(1)} (normalized)`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => v.toFixed(0) }
        }
      }
    }
  });
}

function updateBenchmarkStats(benchmarkKey) {
  const benchmark = benchmarkData[benchmarkKey];
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const firstVal = nwTotal[0];
  const lastVal = nwTotal[nwTotal.length - 1];
  const benchFirst = benchmark.history[0].value;
  const benchLast = benchmark.history[benchmark.history.length - 1].value;
  
  const portfolioReturn = ((lastVal - firstVal) / firstVal) * 100;
  const benchmarkReturn = ((benchLast - benchFirst) / benchFirst) * 100;
  const outperformance = portfolioReturn - benchmarkReturn;
  
  // Calculate annualized returns
  const years = nwTotal.length / 12;
  const portfolioAnn = (Math.pow(lastVal / firstVal, 1 / years) - 1) * 100;
  const benchmarkAnn = (Math.pow(benchLast / benchFirst, 1 / years) - 1) * 100;
  
  const statsContainer = document.getElementById('benchmark-stats');
  statsContainer.innerHTML = `
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Portfolio Total Return</span>
      <span class="benchmark-stat-value trend-up">+${portfolioReturn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">${benchmark.name} Total Return</span>
      <span class="benchmark-stat-value">+${benchmarkReturn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Outperformance</span>
      <span class="benchmark-stat-value ${outperformance >= 0 ? 'trend-up' : 'trend-down'}">
        ${outperformance >= 0 ? '+' : ''}${outperformance.toFixed(1)}%
      </span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">Portfolio Annualized</span>
      <span class="benchmark-stat-value trend-up">${portfolioAnn.toFixed(1)}%</span>
    </div>
    <div class="benchmark-stat-item">
      <span class="benchmark-stat-label">${benchmark.name} Annualized</span>
      <span class="benchmark-stat-value">${benchmarkAnn.toFixed(1)}%</span>
    </div>
  `;
}

function renderRollingReturnsChart() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  // Calculate 12-month rolling returns
  const rollingReturns = [];
  const labels = [];
  
  for (let i = 12; i < nwTotal.length; i++) {
    const ret = ((nwTotal[i] - nwTotal[i - 12]) / nwTotal[i - 12]) * 100;
    rollingReturns.push(ret);
    labels.push(formatDateString(dates[i]));
  }
  
  const ctx = document.getElementById('rolling-returns-chart').getContext('2d');
  
  rollingReturnsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '12M Rolling Return (%)',
        data: rollingReturns,
        backgroundColor: rollingReturns.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => v + '%' }
        }
      }
    }
  });
}

// ==================== DIVIDEND TAB ====================

function initDividendTab() {
  // Destroy existing charts before re-creating
  if (dividendHistoryChart) dividendHistoryChart.destroy();
  if (dividendSourceChart) dividendSourceChart.destroy();

  // Update KPIs
  document.getElementById('div-ttm-value').innerText = formatLakhs(dividendData.ttm / 100000);
  document.getElementById('div-yield-value').innerText = dividendData.yield.toFixed(2) + '%';
  document.getElementById('div-growth-value').innerText = '+' + dividendData.growth.toFixed(1) + '%';
  
  // Dividend History Chart
  const ctxHist = document.getElementById('dividend-history-chart').getContext('2d');
  dividendHistoryChart = new Chart(ctxHist, {
    type: 'bar',
    data: {
      labels: dividendData.history.map(h => formatDateString(h.date)),
      datasets: [{
        label: 'Dividend Received (₹)',
        data: dividendData.history.map(h => h.amount),
        backgroundColor: 'rgba(16, 185, 129, 0.6)',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K' }
        }
      }
    }
  });
  
  // Dividend by Source
  const ctxSource = document.getElementById('dividend-source-chart').getContext('2d');
  dividendSourceChart = new Chart(ctxSource, {
    type: 'doughnut',
    data: {
      labels: ['Stocks', 'Mutual Funds'],
      datasets: [{
        data: [dividendData.byType.stocks, dividendData.byType.mfs],
        backgroundColor: ['#3b82f6', '#6366f1'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#f3f4f6' } }
      }
    }
  });
  
  // Upcoming dividends (simulated)
  const upcomingContainer = document.getElementById('upcoming-dividends-list');
  const upcomingDividends = [
    { name: 'Infosys Ltd', amount: 17500, date: 'Jun 15, 2026' },
    { name: 'HDFC Bank', amount: 9500, date: 'Jun 28, 2026' },
    { name: 'ITC Ltd', amount: 6800, date: 'Jul 5, 2026' },
    { name: 'Parag Parikh Flexi Cap', amount: 4200, date: 'Jul 15, 2026' }
  ];
  
  upcomingContainer.innerHTML = upcomingDividends.map(d => `
    <div class="upcoming-div-item">
      <span class="upcoming-div-name">${d.name}</span>
      <div class="upcoming-div-info">
        <div class="upcoming-div-amount">₹${d.amount.toLocaleString()}</div>
        <div class="upcoming-div-date">${d.date}</div>
      </div>
    </div>
  `).join('');
  
  // Dividend Holdings Table
  const tableBody = document.getElementById('dividend-table-body');
  tableBody.innerHTML = dividendData.holdings.map(h => `
    <tr>
      <td style="font-weight: 600;">${h.instrument}</td>
      <td><span class="sector-tag">${h.type}</span></td>
      <td style="text-align: right;">₹${h.annualDiv.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
      <td style="text-align: right; color: var(--accent-green);">${h.yield.toFixed(2)}%</td>
      <td style="text-align: right; color: var(--text-secondary);">${h.lastDiv}</td>
    </tr>
  `).join('');
}

// ==================== TAX TAB ====================

function initTaxTab() {
  // Destroy existing chart before re-creating
  if (holdingPeriodChart) holdingPeriodChart.destroy();

  // Calculate total unrealized gains
  const totalGains = latestEquity.reduce((sum, s) => sum + s.pnl, 0) + 
                     latestMf.reduce((sum, f) => sum + f.pnl, 0);
  const totalLosses = latestEquity.filter(s => s.pnl < 0).reduce((sum, s) => sum + Math.abs(s.pnl), 0) +
                      latestMf.filter(f => f.pnl < 0).reduce((sum, f) => sum + Math.abs(f.pnl), 0);
  
  // LTCG tax estimate (10% on gains above 1L)
  const ltcgTaxable = Math.max(0, totalGains - 100000);
  const ltcgTax = ltcgTaxable * 0.10;
  
  document.getElementById('tax-unrealized-gains').innerText = formatINR(totalGains);
  document.getElementById('tax-ltcg-est').innerText = formatINR(ltcgTax);
  document.getElementById('tax-loss-opportunity').innerText = formatINR(totalLosses);
  
  // Tax harvesting opportunities
  const harvestList = document.getElementById('harvest-list');
  const lossPositions = [...latestEquity, ...latestMf]
    .filter(h => h.pnl < 0)
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 8);
  
  harvestList.innerHTML = lossPositions.map(p => `
    <div class="harvest-item">
      <span class="harvest-name">${p.instrument || p.scheme}</span>
      <span class="harvest-loss">-${formatINR(Math.abs(p.pnl))}</span>
    </div>
  `).join('');
  
  // Gains by holding period chart
  renderHoldingPeriodChart();
  
  // Tax recommendations
  renderTaxRecommendations(totalGains, totalLosses, ltcgTax);
  
  // Initialize calculator
  calculateTax();
}

function renderHoldingPeriodChart() {
  // Simulate holding period distribution
  const ctx = document.getElementById('holding-period-chart').getContext('2d');
  
  holdingPeriodChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['< 1 Year (STCG)', '1-3 Years (LTCG)', '> 3 Years (LTCG)'],
      datasets: [{
        label: 'Gains (₹)',
        data: [
          latestEquity.filter(s => s.pnl > 0).reduce((sum, s) => sum + s.pnl, 0) * 0.2,
          latestEquity.filter(s => s.pnl > 0).reduce((sum, s) => sum + s.pnl, 0) * 0.35,
          latestEquity.filter(s => s.pnl > 0).reduce((sum, s) => sum + s.pnl, 0) * 0.45
        ],
        backgroundColor: ['#f59e0b', '#10b981', '#3b82f6'],
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 11 } } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K' }
        }
      }
    }
  });
}

function renderTaxRecommendations(totalGains, totalLosses, ltcgTax) {
  const container = document.getElementById('tax-recommendations');
  
  const recommendations = [];
  
  // Recommendation 1: Harvest losses
  if (totalLosses > 10000) {
    recommendations.push({
      icon: '💡',
      title: 'Harvest Tax Losses',
      desc: `You have ₹${(totalLosses / 1000).toFixed(0)}K in unrealized losses. Consider harvesting these to offset gains and reduce tax liability.`
    });
  }
  
  // Recommendation 2: LTCG exemption planning
  if (totalGains > 100000) {
    const excessGain = totalGains - 100000;
    recommendations.push({
      icon: '📊',
      title: 'LTCG Exemption Planning',
      desc: `₹${(excessGain / 1000).toFixed(0)}K of your gains exceed the ₹1L LTCG exemption. Consider booking gains up to ₹1L before March 31st.`
    });
  }
  
  // Recommendation 3: Asset location optimization
  recommendations.push({
    icon: '🎯',
    title: 'Asset Location Review',
    desc: 'Consider holding debt instruments in tax-advantaged accounts (PPF, NPS) to optimize tax efficiency.'
  });
  
  // Recommendation 4: ELSS investment
  recommendations.push({
    icon: '💰',
    title: 'ELSS for Tax Saving',
    desc: 'Invest up to ₹1.5L in ELSS mutual funds to claim deduction under Section 80C.'
  });
  
  container.innerHTML = recommendations.map(r => `
    <div class="tax-rec-item">
      <span class="tax-rec-icon">${r.icon}</span>
      <div class="tax-rec-content">
        <h4>${r.title}</h4>
        <p>${r.desc}</p>
      </div>
    </div>
  `).join('');
}

function calculateTax() {
  const sellAmount = parseFloat(document.getElementById('calc-sell-amount').value) || 0;
  const buyAmount = parseFloat(document.getElementById('calc-buy-amount').value) || 0;
  const holdingPeriod = document.getElementById('calc-holding-period').value;
  
  const gain = sellAmount - buyAmount;
  let taxRate, taxLiability;
  
  if (holdingPeriod === 'stcg') {
    taxRate = TAX_RATES.stcg_equity;
    taxLiability = gain > 0 ? gain * taxRate : 0;
  } else {
    taxRate = TAX_RATES.ltcg_equity;
    taxLiability = gain > TAX_RATES.ltcg_equity_exempt ? (gain - TAX_RATES.ltcg_equity_exempt) * taxRate : 0;
  }
  
  document.getElementById('calc-gain').innerText = formatINR(gain);
  document.getElementById('calc-tax-rate').innerText = (taxRate * 100) + '%';
  document.getElementById('calc-tax-liability').innerText = formatINR(Math.max(0, taxLiability));
}

// ==================== MONTHLY CHANGES TAB ====================

let monthlyChangeChart = null;
let monthlyActivityChart = null;

// Heatmap selection state: stores indices of selected heatmap cells
let heatmapSelectedIndices = new Set();
let heatmapMonthData = []; // Stores the full month data for the heatmap

function initMonthlyTab() {
  // Destroy existing charts before re-creating
  if (monthlyChangeChart) monthlyChangeChart.destroy();
  if (monthlyActivityChart) monthlyActivityChart.destroy();

  // Build heatmap data first (needed for selection state)
  buildHeatmapData();
  renderMonthlyHeatmap();
  // Render all sections with default (no filter = all data)
  renderMonthlySummary();
  renderMonthlyChangeChart();
  renderMonthlyMovers();
  renderMonthlyActivityChart();
  renderTradingActivityLog();
}

// Build the heatmap month data array (used for selection and filtering)
function buildHeatmapData() {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  heatmapMonthData = [];
  
  for (let i = 0; i < nwTotal.length; i++) {
    const change = i > 0 ? ((nwTotal[i] - nwTotal[i-1]) / nwTotal[i-1]) * 100 : 0;
    heatmapMonthData.push({
      label: formatDateString(dates[i]),
      change: change,
      value: nwTotal[i],
      index: i,
      date: dates[i]
    });
  }
}

// Get the selected range from heatmap selection
function getSelectedRange() {
  if (heatmapSelectedIndices.size === 0) {
    return { startIndex: 0, endIndex: heatmapMonthData.length - 1, isFiltered: false };
  }
  
  const sorted = [...heatmapSelectedIndices].sort((a, b) => a - b);
  return {
    startIndex: sorted[0],
    endIndex: sorted[sorted.length - 1],
    isFiltered: true
  };
}

// Toggle a heatmap cell selection (multi-select)
function toggleHeatmapCell(index) {
  if (heatmapSelectedIndices.has(index)) {
    heatmapSelectedIndices.delete(index);
  } else {
    heatmapSelectedIndices.add(index);
  }
  
  // Re-render heatmap with updated selection
  renderMonthlyHeatmap();
  
  // Update all sections based on selection
  updateAllSections();
}

// Clear all heatmap selections
function clearHeatmapSelection() {
  heatmapSelectedIndices.clear();
  renderMonthlyHeatmap();
  updateAllSections();
}

// Select all heatmap cells
function selectAllHeatmap() {
  heatmapSelectedIndices = new Set(heatmapMonthData.map(d => d.index));
  renderMonthlyHeatmap();
  updateAllSections();
}

// Update all sections based on current heatmap selection
function updateAllSections() {
  const range = getSelectedRange();
  const startIndex = range.startIndex;
  const endIndex = range.endIndex;
  const count = endIndex - startIndex + 1;
  
  renderMonthlySummary(count, startIndex, endIndex);
  renderMonthlyChangeChart(count, startIndex, endIndex);
  renderMonthlyMovers(count, startIndex, endIndex);
  renderMonthlyActivityChart(count, startIndex, endIndex);
  renderTradingActivityLog(count, startIndex, endIndex);
}

function renderMonthlySummary(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  const newInvTotal = breakupSummary.new_investment["Total Investment"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  const currentValue = nwTotal[endIndex];
  const periodStartValue = nwTotal[startIndex];
  const monthChange = currentValue - periodStartValue;
  const monthChangePct = (monthChange / periodStartValue) * 100;
  
  // Calculate new investments (sum of monthly investments in the selected range)
  let newInvestment = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    newInvestment += newInvTotal[i];
  }
  
  // Calculate returns (change - new investment)
  const returns = monthChange - newInvestment;
  const returnsPct = (returns / periodStartValue) * 100;
  
  const container = document.getElementById('monthly-summary-cards');
  container.innerHTML = `
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon ${monthChange >= 0 ? 'positive' : 'negative'}">
        ${monthChange >= 0 ? '📈' : '📉'}
      </div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Net Worth Change</div>
        <div class="monthly-kpi-value ${monthChange >= 0 ? 'trend-up' : 'trend-down'}">
          ${monthChange >= 0 ? '+' : ''}${formatINR(monthChange)}
        </div>
        <div class="monthly-kpi-sub">${monthChangePct >= 0 ? '+' : ''}${monthChangePct.toFixed(2)}%</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon positive">💰</div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">New Investments</div>
        <div class="monthly-kpi-value">+${formatINR(newInvestment)}</div>
        <div class="monthly-kpi-sub">Added capital</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon ${returns >= 0 ? 'positive' : 'negative'}">
        ${returns >= 0 ? '📊' : '⚠️'}
      </div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Market Returns</div>
        <div class="monthly-kpi-value ${returns >= 0 ? 'trend-up' : 'trend-down'}">
          ${returns >= 0 ? '+' : ''}${formatINR(returns)}
        </div>
        <div class="monthly-kpi-sub">${returnsPct >= 0 ? '+' : ''}${returnsPct.toFixed(2)}%</div>
      </div>
    </div>
    
    <div class="monthly-kpi-card">
      <div class="monthly-kpi-icon positive">🎯</div>
      <div class="monthly-kpi-content">
        <div class="monthly-kpi-label">Current Net Worth</div>
        <div class="monthly-kpi-value">${formatLakhs(currentValue)}</div>
        <div class="monthly-kpi-sub">Total portfolio value</div>
      </div>
    </div>
  `;
}

function renderMonthlyChangeChart(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  // Calculate month-over-month changes
  const labels = [];
  const changes = [];
  const colors = [];
  
  // Need at least one prior month for change calculation, so start from startIndex + 1
  for (let i = Math.max(startIndex + 1, 1); i <= endIndex; i++) {
    const change = nwTotal[i] - nwTotal[i - 1];
    changes.push(change);
    labels.push(formatDateString(dates[i]));
    colors.push(change >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)');
  }
  
  const ctx = document.getElementById('monthly-change-chart').getContext('2d');
  
  if (monthlyChangeChart) monthlyChangeChart.destroy();
  
  monthlyChangeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Monthly Change (₹)',
        data: changes,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => formatINR(v) }
        }
      }
    }
  });
}

function renderMonthlyMovers(count = 1, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const nwTotal = breakupSummary.net_worth["Total"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = nwTotal.length - 1;
  
  // Calculate monthly changes for each holding from historical data
  const gainers = [];
  const losers = [];
  
  // Determine which historical data indices correspond to the selected date range
  // We need the latest month's data within the selected range for comparison
  const selectedEndDate = dates[endIndex];
  
  latestEquity.forEach(stock => {
    // Try to find matching historical data
    const stockKey = Object.keys(historicalHoldings.stocks).find(
      key => key.toUpperCase().replace(/[^A-Z0-9]/g, '') === stock.instrument.toUpperCase().replace(/[^A-Z0-9]/g, '') ||
             key.toUpperCase().includes(stock.instrument.toUpperCase()) ||
             stock.instrument.toUpperCase().includes(key.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    );
    
    let monthlyChange = 0;
    if (stockKey) {
      const history = historicalHoldings.stocks[stockKey].history;
      // Find the entry closest to the selected end date and the entry before it
      let latestEntry = null;
      let prevEntry = null;
      let latestIdx = -1;
      for (let h = history.length - 1; h >= 0; h--) {
        if (history[h].date <= selectedEndDate) {
          latestEntry = history[h];
          latestIdx = h;
          break;
        }
      }
      // Get the entry just before latestEntry
      if (latestEntry && latestIdx > 0) {
        prevEntry = history[latestIdx - 1];
      }
      // Fallback to last two entries if no match found
      if (!latestEntry && history.length >= 1) latestEntry = history[history.length - 1];
      if (!prevEntry && history.length >= 2) prevEntry = history[history.length - 2];
      
      if (latestEntry && prevEntry) {
        monthlyChange = prevEntry.cur_val > 0 ? ((latestEntry.cur_val - prevEntry.cur_val) / prevEntry.cur_val) * 100 : 0;
      }
    }
    
    const changeObj = {
      name: stock.instrument,
      sector: stock.sector,
      change: monthlyChange,
      value: stock.cur_val
    };
    
    if (monthlyChange >= 0) {
      gainers.push(changeObj);
    } else {
      losers.push(changeObj);
    }
  });
  
  gainers.sort((a, b) => b.change - a.change);
  losers.sort((a, b) => a.change - b.change);
  
  // Render gainers
  const gainersContainer = document.getElementById('monthly-gainers-list');
  gainersContainer.innerHTML = gainers.slice(0, 5).map(g => `
    <div class="mover-item">
      <div class="mover-info">
        <div class="mover-name">${g.name}</div>
        <div class="mover-sector">${g.sector}</div>
      </div>
      <div class="mover-change trend-up">+${g.change.toFixed(2)}%</div>
    </div>
  `).join('');
  
  // Render losers
  const losersContainer = document.getElementById('monthly-losers-list');
  losersContainer.innerHTML = losers.slice(0, 5).map(l => `
    <div class="mover-item">
      <div class="mover-info">
        <div class="mover-name">${l.name}</div>
        <div class="mover-sector">${l.sector}</div>
      </div>
      <div class="mover-change trend-down">${l.change.toFixed(2)}%</div>
    </div>
  `).join('');
}

function renderMonthlyHeatmap() {
  const container = document.getElementById('monthly-heatmap');
  const infoBar = document.getElementById('heatmap-selection-info');
  
  if (heatmapMonthData.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">No data available</div>';
    return;
  }
  
  container.innerHTML = `
    <div class="heatmap-grid">
      ${heatmapMonthData.map(m => {
        const intensity = Math.min(Math.abs(m.change) / 5, 1); // Normalize to 0-1
        const color = m.change >= 0
          ? `rgba(16, 185, 129, ${0.3 + intensity * 0.7})`
          : `rgba(239, 68, 68, ${0.3 + intensity * 0.7})`;
        
        const isSelected = heatmapSelectedIndices.has(m.index);
        const selectedClass = isSelected ? 'selected' : '';
        
        return `
          <div class="heatmap-cell ${selectedClass}" style="background: ${color}"
               onclick="toggleHeatmapCell(${m.index})"
               title="${m.label}: ${m.change >= 0 ? '+' : ''}${m.change.toFixed(1)}% — Click to toggle selection">
            <div class="heatmap-month">${m.label.split(' ')[0]}</div>
            <div class="heatmap-change">${m.change >= 0 ? '+' : ''}${m.change.toFixed(1)}%</div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="heatmap-legend">
      <span class="legend-label">Negative</span>
      <div class="legend-gradient">
        <div class="legend-bar"></div>
      </div>
      <span class="legend-label">Positive</span>
    </div>
  `;
  
  // Update selection info bar
  if (infoBar) {
    if (heatmapSelectedIndices.size === 0) {
      infoBar.innerHTML = '<span>No period selected — showing <strong class="selected-range">all data</strong></span>';
    } else {
      const sorted = [...heatmapSelectedIndices].sort((a, b) => a - b);
      const startLabel = heatmapMonthData[sorted[0]]?.label || 'N/A';
      const endLabel = heatmapMonthData[sorted[sorted.length - 1]]?.label || 'N/A';
      const monthCount = sorted.length;
      infoBar.innerHTML = `<span>Selected: <strong class="selected-range">${startLabel} — ${endLabel}</strong> (${monthCount} month${monthCount > 1 ? 's' : ''})</span>`;
    }
  }
}

function renderMonthlyActivityChart(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  const newInvSection = breakupSummary.new_investment;
  const newInvTotal = newInvSection["Total Investment"].values;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = newInvTotal.length - 1;
  
  const labels = [];
  const investments = [];
  
  for (let i = startIndex; i <= endIndex; i++) {
    labels.push(formatDateString(dates[i]));
    investments.push(newInvTotal[i]);
  }
  
  const ctx = document.getElementById('monthly-activity-chart').getContext('2d');
  
  if (monthlyActivityChart) monthlyActivityChart.destroy();
  
  monthlyActivityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Monthly Investment (₹)',
        data: investments,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: '#3b82f6'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 12 } },
        y: { 
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#9ca3af', callback: (v) => formatINR(v) }
        }
      }
    }
  });
}

// Generate Trading Activity Log
function renderTradingActivityLog(count = 12, startIndex = 0, endIndex = null) {
  const dates = breakupSummary.dates;
  
  // If endIndex not provided, use the last available index
  if (endIndex === null) endIndex = dates.length - 1;
  
  const trades = [];
  
  // Generate simulated trading activity from historical holdings data
  const stockHistory = historicalHoldings.stocks;
  const mfHistory = historicalHoldings.mfs;
  
  // Process stock transactions
  Object.keys(stockHistory).forEach(symbol => {
    const stock = stockHistory[symbol];
    const history = stock.history;
    
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      
      // Detect buys (invested increased)
      if (curr.invested > prev.invested) {
        const buyAmount = curr.invested - prev.invested;
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date,
            instrument: symbol,
            type: 'BUY',
            quantity: qty,
            price: curr.ltp,
            total: buyAmount,
            category: stock.sector || 'Equity'
          });
        }
      }
      
      // Detect sells (qty decreased)
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        const sellAmount = sellQty * curr.ltp;
        trades.push({
          date: curr.date,
          instrument: symbol,
          type: 'SELL',
          quantity: sellQty,
          price: curr.ltp,
          total: sellAmount,
          category: stock.sector || 'Equity'
        });
      }
    }
  });
  
  // Process MF transactions
  Object.keys(mfHistory).forEach(scheme => {
    const mf = mfHistory[scheme];
    const history = mf.history;
    
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      
      // Detect buys
      if (curr.invested > prev.invested) {
        const buyAmount = curr.invested - prev.invested;
        const qty = curr.qty - prev.qty;
        if (qty > 0) {
          trades.push({
            date: curr.date,
            instrument: scheme.length > 30 ? scheme.substring(0, 30) + '...' : scheme,
            type: 'BUY',
            quantity: qty,
            price: curr.ltp,
            total: buyAmount,
            category: 'Mutual Fund'
          });
        }
      }
      
      // Detect sells
      if (curr.qty < prev.qty && curr.qty >= 0) {
        const sellQty = prev.qty - curr.qty;
        const sellAmount = sellQty * curr.ltp;
        trades.push({
          date: curr.date,
          instrument: scheme.length > 30 ? scheme.substring(0, 30) + '...' : scheme,
          type: 'SELL',
          quantity: sellQty,
          price: curr.ltp,
          total: sellAmount,
          category: 'Mutual Fund'
        });
      }
    }
  });
  
  // Sort by date (newest first)
  trades.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Filter by selected date range
  const startDate = dates[startIndex];
  const endDate = dates[endIndex];
  const filteredTrades = trades.filter(t => t.date >= startDate && t.date <= endDate);
  
  // Render table
  const tbody = document.getElementById('trading-activity-body');
  tbody.innerHTML = filteredTrades.map(trade => `
    <tr>
      <td>${formatDateString(trade.date)}</td>
      <td style="font-weight: 600;">${trade.instrument}</td>
      <td>
        <span class="trade-type ${trade.type.toLowerCase()}">${trade.type}</span>
      </td>
      <td style="text-align: right;">${trade.quantity.toLocaleString(undefined, {maximumFractionDigits: 4})}</td>
      <td style="text-align: right;">₹${trade.price.toLocaleString(undefined, {maximumFractionDigits: 2})}</td>
      <td style="text-align: right; font-weight: 600;">${formatINR(trade.total)}</td>
      <td><span class="sector-tag">${trade.category}</span></td>
    </tr>
  `).join('');
  
  // Show message if no trades
  if (filteredTrades.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          No trading activity found for the selected period
        </td>
      </tr>
    `;
  }
}

function sortMfs(colIdx) {
  if (mfSortColumn === colIdx) {
    mfSortAsc = !mfSortAsc;
  } else {
    mfSortColumn = colIdx;
    mfSortAsc = true;
  }

  // Update classes on headers
  const ths = document.querySelectorAll('#mfs-table th');
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (idx === colIdx) {
      th.classList.add(mfSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  const query = document.getElementById('mf-search').value.toLowerCase().trim();
  const cat = document.getElementById('mf-type-filter').value;
  
  const filtered = latestMf.filter(f => {
    const matchesQuery = f.scheme.toLowerCase().includes(query) || f.scheme_type.toLowerCase().includes(query);
    const matchesCat = (cat === 'ALL') || (f.scheme_type === cat);
    return matchesQuery && matchesCat;
  });

  filtered.sort((a, b) => {
    let valA, valB;
    switch(colIdx) {
      case 0: valA = a.scheme; valB = b.scheme; break;
      case 1: valA = a.scheme_type; valB = b.scheme_type; break;
      case 2: valA = a.qty; valB = b.qty; break;
      case 3: valA = a.price; valB = b.price; break;
      case 4: valA = a.avg_nav; valB = b.avg_nav; break;
      case 5: valA = a.invested; valB = b.invested; break;
      case 6: valA = a.cur_val; valB = b.cur_val; break;
      case 7: valA = a.pnl; valB = b.pnl; break;
      case 8: valA = a.gain_pct; valB = b.gain_pct; break;
    }
    
    if (typeof valA === 'string') {
      return mfSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return mfSortAsc ? valA - valB : valB - valA;
    }
  });

  renderMfsTable(filtered);
}
