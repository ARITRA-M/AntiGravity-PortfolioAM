// Global state
let portfolioSummary = null;
let breakupSummary = null;
let latestEquity = null;
let latestMf = null;
let historicalHoldings = null;

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

// Table sorting state
let stockSortColumn = -1;
let stockSortAsc = true;
let mfSortColumn = -1;
let mfSortAsc = true;

// Active tabs
const tabIds = ['overview', 'growth', 'stocks', 'mfs'];

window.addEventListener('DOMContentLoaded', () => {
  loadData();
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
  } catch (error) {
    console.error("Error loading portfolio data:", error);
    document.getElementById('live-time-badge').innerText = "Error loading data!";
    document.getElementById('live-time-badge').style.borderColor = "#ef4444";
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
  
  explorerList.innerHTML = sortedByVal.map((s, idx) => `
    <div class="explorer-item ${idx === 0 ? 'active' : ''}" onclick="selectStockExplorer('${s.instrument}', this)">
      <span class="name">${s.instrument}</span>
      <span class="val">${formatINR(s.cur_val)}</span>
    </div>
  `).join('');

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
  const stock = historicalHoldings.stocks[symbol];
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
