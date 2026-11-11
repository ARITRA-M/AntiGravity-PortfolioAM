// AntiGravity Portfolio — AI Copilot & Natural Language Assistant
// -------------------------------------------------------------------------
// Provides a natural-language copilot embedded within the application:
// - Powered by Cloudflare Workers AI (@cf/meta/llama-3.3-70b-instruct)
// - Zero Top-Up / Free Tier on Cloudflare edge
// - Client-side Privacy Shield (anonymizes absolute rupees to weights & %)
// - Zero-latency deterministic local answers for core portfolio queries
// - Inline Chart.js dynamic visualizations directly in chat bubbles
// - Real-time market research (Yahoo Finance / NSE) for researched tickers

const PortfolioAssistant = (() => {
  let isProcessing = false;
  let chatHistory = [];
  const MAX_HISTORY = 12;

  // Privacy Shield: 'anonymized' (default) masks raw ₹ figures to % / relative weights
  // 'full' sends actual Lakhs / rupees to the model over TLS
  function getPrivacyMode() {
    try {
      return localStorage.getItem('ag_copilot_privacy_shield') || 'anonymized';
    } catch (_) {
      return 'anonymized';
    }
  }

  function setPrivacyMode(mode) {
    try {
      localStorage.setItem('ag_copilot_privacy_shield', mode);
    } catch (_) {}
    updatePrivacyShieldUI();
  }

  function updatePrivacyShieldUI() {
    const shieldLabel = document.getElementById('copilot-shield-status');
    const shieldPill = document.getElementById('copilot-privacy-pill');
    const isAnon = getPrivacyMode() === 'anonymized';
    if (shieldLabel) {
      shieldLabel.textContent = isAnon ? 'Anonymized (%)' : 'Full Precision (₹)';
    }
    if (shieldPill) {
      shieldPill.classList.toggle('shield-anonymized', isAnon);
      shieldPill.classList.toggle('shield-full', !isAnon);
      shieldPill.title = isAnon
        ? 'Privacy Shield Active: Absolute rupee amounts are converted to relative % before AI processing.'
        : 'Privacy Shield Off: Exact values in Lakhs are included for rupee-level calculations.';
    }
  }

  // ── Helper: Format Currency ────────────────────────────────────────────────
  function fmtVal(val, isAnon) {
    if (isAnon) return '—';
    if (typeof formatINR === 'function') return formatINR(val);
    return '₹' + Number(val).toLocaleString('en-IN');
  }

  // ── Build Structured Portfolio Knowledge ──────────────────────────────────
  function buildPortfolioContext(privacyMode) {
    const isAnon = privacyMode === 'anonymized';
    const ctx = {};

    // 1. Total Net Worth
    let totalNw = 0;
    if (typeof breakupSummary !== 'undefined' && breakupSummary.net_worth?.['Total']?.values?.length) {
      const vals = breakupSummary.net_worth['Total'].values;
      totalNw = vals[vals.length - 1]; // In Lakhs
    }

    ctx.netWorth = isAnon ? 'Normalized to 100% baseline' : `₹${totalNw.toFixed(2)} Lakhs`;

    // 2. Asset Allocation Breakdown
    ctx.allocation = [];
    if (typeof breakupSummary !== 'undefined' && breakupSummary.net_worth) {
      const nw = breakupSummary.net_worth;
      const cats = ['Equity', 'Mutual Funds', 'PF', 'PPF', 'Bonds', 'Gold', 'NPS', 'Real Estate', 'Home Loan'];
      cats.forEach(c => {
        if (nw[c] && nw[c].values?.length) {
          const v = nw[c].values[nw[c].values.length - 1];
          const pct = totalNw > 0 ? (v / totalNw) * 100 : 0;
          if (Math.abs(v) > 0.001) {
            ctx.allocation.push({
              asset: c,
              pct: Number(pct.toFixed(1)),
              val: isAnon ? undefined : `₹${v.toFixed(2)}L`
            });
          }
        }
      });
    }

    // 3. Top Stocks (from latestEquity)
    ctx.topStocks = [];
    if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
      const sorted = [...latestEquity].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0));
      const totalEqVal = sorted.reduce((s, e) => s + (e.cur_val || 0), 0);
      ctx.topStocks = sorted.slice(0, 8).map(s => {
        const weightPct = totalEqVal > 0 ? ((s.cur_val || 0) / totalEqVal) * 100 : 0;
        return {
          symbol: s.instrument,
          sector: s.sector || 'General',
          weightInEquity: Number(weightPct.toFixed(1)),
          gainPct: Number((s.gain_pct || 0).toFixed(1)),
          value: isAnon ? undefined : (typeof formatINR === 'function' ? formatINR(s.cur_val) : s.cur_val)
        };
      });
    }

    // 4. Top Mutual Funds (from latestMf)
    ctx.topMutualFunds = [];
    if (typeof latestMf !== 'undefined' && Array.isArray(latestMf)) {
      const sorted = [...latestMf].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0));
      const totalMfVal = sorted.reduce((s, m) => s + (m.cur_val || 0), 0);
      ctx.topMutualFunds = sorted.slice(0, 6).map(m => {
        const weightPct = totalMfVal > 0 ? ((m.cur_val || 0) / totalMfVal) * 100 : 0;
        return {
          scheme: m.scheme,
          category: m.category || 'Equity',
          weightInMf: Number(weightPct.toFixed(1)),
          gainPct: Number((m.gain_pct || 0).toFixed(1)),
          value: isAnon ? undefined : (typeof formatINR === 'function' ? formatINR(m.cur_val) : m.cur_val)
        };
      });
    }

    // 5. Market Cap Concentration (from XRayEngine if available)
    if (typeof XRayEngine !== 'undefined' && typeof XRayEngine.computePortfolioXRay === 'function') {
      try {
        const xray = XRayEngine.computePortfolioXRay();
        if (xray && xray.marketCap) {
          ctx.marketCapSplit = {
            largeCap: Number((xray.marketCap.large || 0).toFixed(1)),
            midCap: Number((xray.marketCap.mid || 0).toFixed(1)),
            smallCap: Number((xray.marketCap.small || 0).toFixed(1))
          };
        }
      } catch (_) {}
    }

    return ctx;
  }

  // ── Helper: Detect Ticker Symbol for Research ──────────────────────────────
  function detectTickerQuery(query) {
    if (!query) return null;
    const q = query.trim().toUpperCase();

    // 1. Explicit NSE/BSE suffix (e.g. TRENT.NS or HDFCBANK.BO)
    const suffixMatch = q.match(/\b([A-Z0-9-]{3,12})\.(?:NS|BO)\b/);
    if (suffixMatch) return suffixMatch[1];

    // 2. Direct match against user's own equity instruments in latestEquity
    if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
      for (const eq of latestEquity) {
        if (eq.instrument && new RegExp(`\\b${eq.instrument}\\b`, 'i').test(q)) {
          return eq.instrument;
        }
      }
    }

    // 3. Contextual keyword match: "PE ratio of X", "price of X", "research X", "trend of X"
    const keywordMatch = q.match(/(?:RESEARCH|PE\s+RATIO\s+OF|PRICE\s+OF|PE\s+OF|TREND\s+OF|ABOUT|ANALYZE)\s+([A-Z0-9-]{3,12})\b/);
    if (keywordMatch) {
      const candidate = keywordMatch[1];
      const stopWords = new Set(['THE', 'THIS', 'THAT', 'MY', 'ALL', 'ANY', 'OUR']);
      if (!stopWords.has(candidate)) return candidate;
    }

    // 4. Fallback: Scan uppercase tokens excluding stop words
    const stopWords = new Set([
      'THE', 'AND', 'FOR', 'ARE', 'CAN', 'YOU', 'ALL', 'ANY', 'NOT', 'GET',
      'WHAT', 'WHEN', 'WHERE', 'SHOW', 'HOW', 'CHART', 'GRAPH', 'PORTFOLIO',
      'STOCKS', 'STOCK', 'FUNDS', 'SHARE', 'PRICE', 'RESEARCH', 'TOTAL', 'WORTH',
      'VALUE', 'INVEST', 'MONEY', 'GAIN', 'LOSS', 'BANK', 'TECH', 'RATIO',
      'TELL', 'ABOUT', 'CURRENT', 'TREND', 'RANGE', 'COMPARE', 'OVERVIEW', 'DETAILS'
    ]);
    const tokens = q.match(/\b[A-Z0-9-]{3,14}\b/g) || [];
    for (const token of tokens) {
      if (!stopWords.has(token) && !/^\d+$/.test(token)) {
        return token;
      }
    }
    return null;
  }

  // ── Helper: Fetch Live Market Quote & History for Research ─────────────────
  async function fetchMarketResearch(symbol) {
    const ticker = symbol.endsWith('.NS') || symbol.endsWith('.BO') ? symbol : `${symbol}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1mo`;
    
    // Use worker proxy or public fallback via _proxyList if available
    let fetchUrl = url;
    if (typeof _proxyList === 'function') {
      const proxies = _proxyList();
      fetchUrl = proxies[0](url);
    } else {
      fetchUrl = `https://portfolio-proxy.aritra2k7.workers.dev/?url=${encodeURIComponent(url)}`;
    }

    try {
      const res = await fetch(fetchUrl);
      if (!res.ok) return null;
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta || {};
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];

      const historyPoints = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null && !isNaN(closes[i])) {
          const d = new Date(timestamps[i] * 1000);
          const monthStr = d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
          historyPoints.push({ date: monthStr, close: Number(closes[i].toFixed(1)) });
        }
      }

      return {
        symbol: meta.symbol || ticker,
        name: meta.longName || meta.shortName || symbol,
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose,
        changePct: meta.regularMarketChangePercent,
        high52: meta.fiftyTwoWeekHigh,
        low52: meta.fiftyTwoWeekLow,
        currency: meta.currency || 'INR',
        history: historyPoints
      };
    } catch (err) {
      console.warn('Market research fetch failed for', symbol, err);
      return null;
    }
  }

  // ── Local Zero-Latency Intent Solver (Offline / 100% Private) ─────────────
  function solveLocallyIfPossible(query, privacyMode) {
    const q = query.toLowerCase().trim();
    const isAnon = privacyMode === 'anonymized';

    // 1. Asset Allocation Query
    if (q.includes('asset allocation') || q.includes('allocation') || q.includes('breakdown') || q.includes('distribution')) {
      if (typeof breakupSummary === 'undefined' || !breakupSummary.net_worth) return null;
      const nw = breakupSummary.net_worth;
      const total = nw['Total']?.values?.[nw['Total'].values.length - 1] || 1;
      const categories = ['Equity', 'Mutual Funds', 'Fixed Income', 'Gold', 'Real Estate'];
      
      const labels = [];
      const data = [];
      let summaryText = 'Here is your broad **Asset Class Allocation** across your entire portfolio:\n\n';

      const eq = (nw['Equity']?.values?.[nw['Equity'].values.length - 1]) || 0;
      const mf = (nw['Mutual Funds']?.values?.[nw['Mutual Funds'].values.length - 1]) || 0;
      const pf = (nw['PF']?.values?.[nw['PF'].values.length - 1]) || 0;
      const ppf = (nw['PPF']?.values?.[nw['PPF'].values.length - 1]) || 0;
      const bonds = (nw['Bonds']?.values?.[nw['Bonds'].values.length - 1]) || 0;
      const fi = pf + ppf + bonds;
      const gold = (nw['Gold']?.values?.[nw['Gold'].values.length - 1]) || 0;
      const re = (nw['Real Estate']?.values?.[nw['Real Estate'].values.length - 1]) || 0;

      const items = [
        { name: 'Direct Equity', val: eq },
        { name: 'Mutual Funds', val: mf },
        { name: 'Fixed Income (PF/PPF/Bonds)', val: fi },
        { name: 'Gold (SGB/ETFs)', val: gold },
        { name: 'Real Estate (Net Equity)', val: re }
      ];

      items.forEach(it => {
        if (it.val > 0.01) {
          const pct = ((it.val / total) * 100).toFixed(1);
          labels.push(it.name);
          data.push(Number(pct));
          const valDisplay = isAnon ? '' : ` (₹${it.val.toFixed(2)} L)`;
          summaryText += `* **${it.name}**: **${pct}%**${valDisplay}\n`;
        }
      });

      const chartBlock = `\n\`\`\`chart:doughnut\n${JSON.stringify({
        title: 'Asset Allocation Breakdown (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return summaryText + chartBlock;
    }

    // 2. Top Stock Holdings Query
    if (q.includes('top stock') || q.includes('top holding') || q.includes('largest stock') || q.includes('biggest stock')) {
      if (typeof latestEquity === 'undefined' || !latestEquity.length) return null;
      const sorted = [...latestEquity].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0)).slice(0, 5);
      const totalEq = latestEquity.reduce((s, e) => s + (e.cur_val || 0), 0);

      const labels = sorted.map(s => s.instrument);
      const data = sorted.map(s => Number(((s.cur_val / totalEq) * 100).toFixed(1)));

      let text = 'Here are your **Top 5 Direct Equity Holdings** by portfolio weight:\n\n';
      sorted.forEach((s, idx) => {
        const wt = ((s.cur_val / totalEq) * 100).toFixed(1);
        const gainSign = s.gain_pct >= 0 ? '+' : '';
        const valText = isAnon ? '' : ` | Value: ${formatINR(s.cur_val)}`;
        text += `${idx + 1}. **${s.instrument}** (${s.sector || 'Stock'}): **${wt}%** of equity | Return: **${gainSign}${s.gain_pct?.toFixed(1)}%**${valText}\n`;
      });

      const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
        title: 'Top 5 Stocks by Weight (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return text + chartBlock;
    }

    // 3. Top Mutual Funds Query
    if (q.includes('top mutual') || q.includes('top mf') || q.includes('largest mf') || q.includes('best mutual')) {
      if (typeof latestMf === 'undefined' || !latestMf.length) return null;
      const sorted = [...latestMf].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0)).slice(0, 5);
      const totalMf = latestMf.reduce((s, m) => s + (m.cur_val || 0), 0);

      const labels = sorted.map(m => m.scheme.length > 20 ? m.scheme.slice(0, 18) + '…' : m.scheme);
      const data = sorted.map(m => Number(((m.cur_val / totalMf) * 100).toFixed(1)));

      let text = 'Here are your **Top Mutual Fund Holdings** by weight:\n\n';
      sorted.forEach((m, idx) => {
        const wt = ((m.cur_val / totalMf) * 100).toFixed(1);
        const gainSign = m.gain_pct >= 0 ? '+' : '';
        const valText = isAnon ? '' : ` | Value: ${formatINR(m.cur_val)}`;
        text += `${idx + 1}. **${m.scheme}**: **${wt}%** | Return: **${gainSign}${m.gain_pct?.toFixed(1)}%**${valText}\n`;
      });

      const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
        title: 'Top Mutual Funds by Weight (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return text + chartBlock;
    }

    // 4. Net Worth Trend Query
    if (q.includes('net worth trend') || q.includes('net worth growth') || q.includes('how did my portfolio grow') || q.includes('growth history')) {
      if (typeof breakupSummary === 'undefined' || !breakupSummary.dates || !breakupSummary.net_worth?.['Total']) return null;
      const dates = breakupSummary.dates.slice(-12); // Last 12 points
      const vals = breakupSummary.net_worth['Total'].values.slice(-12);

      const labels = dates.map(d => formatDateString(d));
      // In anonymized mode, normalize starting point to 100
      const base = vals[0] || 1;
      const data = isAnon ? vals.map(v => Number(((v / base) * 100).toFixed(1))) : vals.map(v => Number(v.toFixed(2)));

      const labelName = isAnon ? 'Growth Index (Base 100)' : 'Net Worth (₹ Lakhs)';
      let text = `Here is your **Portfolio Growth Trend** over the last ${vals.length} recorded snapshot periods:\n\n`;
      const changePct = (((vals[vals.length - 1] - vals[0]) / vals[0]) * 100).toFixed(1);
      text += `* **Period Return**: **${changePct >= 0 ? '+' : ''}${changePct}%** across this period.\n`;
      if (!isAnon) {
        text += `* **Current Net Worth**: **₹${vals[vals.length - 1].toFixed(2)} Lakhs**\n`;
      }

      const chartBlock = `\n\`\`\`chart:line\n${JSON.stringify({
        title: labelName,
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return text + chartBlock;
    }

    return null; // Delegate to Cloudflare Workers AI
  }

  // ── Cloudflare Workers AI API Dispatcher ──────────────────────────────────
  async function callCloudflareWorkersAI(promptText, portfolioContext, researchData) {
    const privacyMode = getPrivacyMode();

    const systemPrompt = `You are "Portfolio Copilot", an elite financial intelligence assistant embedded in the AntiGravity Portfolio Analytics app.
Your goals:
1. Provide accurate, insightful, and concise financial commentary.
2. Ground your answers firmly in the user's provided portfolio context and market research data.
3. Be structured: use markdown bullet points, bold key figures, and format data cleanly.
4. When comparing or visualizing multi-point trends or breakdowns, ALWAYS include a JSON chart code block at the end in this exact format:
\`\`\`chart:line (or doughnut or bar)
{
  "title": "Short Descriptive Title",
  "labels": ["Label1", "Label2", ...],
  "data": [10.5, 20.3, ...]
}
\`\`\`
Privacy rule: Adhere strictly to the current mode (${privacyMode}). Never hallucinate unmentioned assets.`;

    const userContent = `Portfolio Context:
${JSON.stringify(portfolioContext, null, 2)}
${researchData ? `\nLive Market Research Data:\n${JSON.stringify(researchData, null, 2)}` : ''}

User Question: ${promptText}`;

    // Build messages payload
    const messages = [
      ...chatHistory.slice(-6),
      { role: 'user', content: userContent }
    ];

    // Endpoint: prefer local /api/chat if backend exists, otherwise WORKER_PROXY_URL/api/chat
    let endpoint = 'api/chat';
    if (window.__isGitHubPages || (typeof WORKER_PROXY_URL === 'string' && WORKER_PROXY_URL)) {
      const base = (WORKER_PROXY_URL || 'https://portfolio-proxy.aritra2k7.workers.dev/').replace(/\/+$/, '');
      endpoint = `${base}/api/chat`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        systemPrompt,
        model: '@cf/meta/llama-3.3-70b-instruct'
      })
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `AI endpoint returned HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.response;
  }

  // ── Render Message to DOM with Markdown & Chart.js ────────────────────────
  function appendMessage(role, rawContent, isHtml) {
    const container = document.getElementById('copilot-messages');
    if (!container) return;

    const row = document.createElement('div');
    row.className = `copilot-msg-row copilot-${role}`;

    const bubble = document.createElement('div');
    bubble.className = `copilot-bubble copilot-bubble-${role}`;

    if (isHtml) {
      bubble.innerHTML = rawContent;
    } else {
      bubble.innerHTML = formatMarkdown(rawContent);
      // Scan and initialize charts
      mountInlineCharts(bubble);
    }

    row.appendChild(bubble);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  // ── Simple Markdown Formatter ─────────────────────────────────────────────
  function formatMarkdown(text) {
    if (!text) return '';

    // Extract chart code blocks first to protect them from regex mangling
    const chartFences = [];
    let processed = text.replace(/```chart:(line|bar|doughnut)([\s\S]*?)```/gi, (match, type, body) => {
      const id = `copilot-chart-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      chartFences.push({ id, type: type.toLowerCase(), jsonStr: body.trim() });
      return `<!--CHART_PLACEHOLDER_${id}-->`;
    });

    // Escape basic HTML
    processed = processed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Re-insert chart canvases
    chartFences.forEach(c => {
      const placeholder = `&lt;!--CHART_PLACEHOLDER_${c.id}--&gt;`;
      const html = `
        <div class="copilot-chart-card">
          <div class="copilot-chart-canvas-wrap">
            <canvas id="${c.id}" data-chart-type="${c.type}" data-chart-config="${encodeURIComponent(c.jsonStr)}"></canvas>
          </div>
        </div>
      `;
      processed = processed.replace(placeholder, html);
    });

    // Headers
    processed = processed.replace(/^### (.*$)/gim, '<h4 class="copilot-h3">$1</h4>');
    processed = processed.replace(/^## (.*$)/gim, '<h3 class="copilot-h2">$1</h3>');
    processed = processed.replace(/^# (.*$)/gim, '<h2 class="copilot-h1">$1</h2>');

    // Bold & Italics
    processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Bullet Lists
    processed = processed.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="copilot-li">$1</li>');
    processed = processed.replace(/(<li class="copilot-li">.*<\/li>)/gms, '<ul class="copilot-ul">$1</ul>');

    // Paragraph line breaks
    processed = processed.replace(/\n\n+/g, '<br><br>');

    return processed;
  }

  // ── Mount Inline Chart.js Canvases ────────────────────────────────────────
  function mountInlineCharts(containerEl) {
    const canvases = containerEl.querySelectorAll('canvas[data-chart-config]');
    canvases.forEach(canvas => {
      try {
        const type = canvas.getAttribute('data-chart-type') || 'bar';
        const rawJson = decodeURIComponent(canvas.getAttribute('data-chart-config') || '{}');
        const config = JSON.parse(rawJson);

        const ctx = canvas.getContext('2d');
        const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6', '#14b8a6', '#f43f5e'];

        let dataset = {};
        if (type === 'doughnut') {
          dataset = {
            data: config.data || [],
            backgroundColor: colors.slice(0, (config.labels || []).length),
            borderWidth: 1.5,
            borderColor: '#0f172a'
          };
        } else if (type === 'line') {
          const lineGrad = ctx.createLinearGradient(0, 0, 0, 180);
          lineGrad.addColorStop(0, 'rgba(99, 102, 241, 0.25)');
          lineGrad.addColorStop(1, 'rgba(99, 102, 241, 0.01)');
          dataset = {
            label: config.title || 'Trend',
            data: config.data || [],
            borderColor: '#6366f1',
            backgroundColor: lineGrad,
            fill: true,
            borderWidth: 2,
            tension: 0,
            pointRadius: 0,
            pointHoverRadius: 5
          };
        } else {
          // Bar
          dataset = {
            label: config.title || 'Weight (%)',
            data: config.data || [],
            backgroundColor: colors.slice(0, (config.labels || []).length).map(c => c + 'cc'),
            borderColor: colors.slice(0, (config.labels || []).length),
            borderWidth: 1,
            borderRadius: 4
          };
        }

        new Chart(ctx, {
          type: type,
          data: {
            labels: config.labels || [],
            datasets: [dataset]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: !!config.title,
                text: config.title || '',
                color: '#f3f4f6',
                font: { family: 'Outfit, sans-serif', size: 12, weight: '600' },
                padding: { bottom: 8 }
              },
              legend: {
                display: type === 'doughnut',
                position: 'bottom',
                labels: {
                  color: '#9ca3af',
                  boxWidth: 8,
                  boxHeight: 8,
                  usePointStyle: true,
                  font: { family: 'Outfit, sans-serif', size: 10 }
                }
              },
              tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                borderColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 1,
                titleFont: { family: 'Outfit, sans-serif', size: 11 },
                bodyFont: { family: 'Outfit, sans-serif', size: 11 }
              }
            },
            scales: type === 'doughnut' ? {} : {
              x: {
                grid: { display: false },
                ticks: { color: '#9ca3af', maxTicksLimit: 6, font: { size: 10 } }
              },
              y: {
                grid: { color: 'rgba(255, 255, 255, 0.04)' },
                ticks: { color: '#9ca3af', maxTicksLimit: 4, font: { size: 10 } }
              }
            }
          }
        });
      } catch (err) {
        console.warn('Failed to mount inline copilot chart:', err);
      }
    });
  }

  // ── Typing Indicator ──────────────────────────────────────────────────────
  let typingBubble = null;
  function showTypingIndicator(statusText = 'Copilot is thinking…') {
    const container = document.getElementById('copilot-messages');
    if (!container) return;

    hideTypingIndicator();
    const row = document.createElement('div');
    row.id = 'copilot-typing-row';
    row.className = 'copilot-msg-row copilot-assistant';

    row.innerHTML = `
      <div class="copilot-bubble copilot-bubble-assistant copilot-typing">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-text">${statusText}</span>
      </div>
    `;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    typingBubble = row;
  }

  function hideTypingIndicator() {
    if (typingBubble && typingBubble.parentNode) {
      typingBubble.parentNode.removeChild(typingBubble);
    }
    typingBubble = null;
  }

  // ── Main Query Execution Pipeline ─────────────────────────────────────────
  async function submitQuery(promptText) {
    if (!promptText || !promptText.trim() || isProcessing) return;
    const userQuery = promptText.trim();
    isProcessing = true;

    // 1. Render User Message
    appendMessage('user', userQuery, false);

    // 2. Clear input
    const input = document.getElementById('copilot-input');
    if (input) input.value = '';

    const privacyMode = getPrivacyMode();

    // 3. Check for Local Solver Match (Zero-latency, 100% private)
    const localAnswer = solveLocallyIfPossible(userQuery, privacyMode);
    if (localAnswer) {
      isProcessing = false;
      setTimeout(() => {
        appendMessage('assistant', localAnswer, false);
        chatHistory.push({ role: 'user', content: userQuery });
        chatHistory.push({ role: 'assistant', content: localAnswer });
      }, 150);
      return;
    }

    // 4. Check for Stock Research Requirement
    showTypingIndicator('Analyzing request…');
    const ticker = detectTickerQuery(userQuery);
    let researchData = null;

    if (ticker) {
      showTypingIndicator(`Fetching live market data for ${ticker}…`);
      researchData = await fetchMarketResearch(ticker);
      if (researchData) {
        // If user just wanted the price/research chart for a specific stock:
        if (userQuery.toLowerCase().includes('52w') || userQuery.toLowerCase().includes('pe') || userQuery.toLowerCase().includes('price') || userQuery.toLowerCase().includes('research') || userQuery.toLowerCase().includes('trend')) {
          const chgSign = researchData.changePct >= 0 ? '+' : '';
          let quickReply = `Here is the live market data for **${researchData.name}** (${researchData.symbol}):\n\n`;
          quickReply += `* **Current Price**: ₹${researchData.price?.toLocaleString('en-IN') || '—'} (${chgSign}${researchData.changePct?.toFixed(2)}%)\n`;
          quickReply += `* **52-Week Range**: ₹${researchData.low52?.toLocaleString('en-IN') || '—'} – ₹${researchData.high52?.toLocaleString('en-IN') || '—'}\n`;
          quickReply += `* **Previous Close**: ₹${researchData.prevClose?.toLocaleString('en-IN') || '—'}\n`;

          if (researchData.history && researchData.history.length > 2) {
            quickReply += `\n\`\`\`chart:line\n${JSON.stringify({
              title: `${researchData.symbol} 1-Year Price Trend (₹)`,
              labels: researchData.history.map(h => h.date),
              data: researchData.history.map(h => h.close)
            }, null, 2)}\n\`\`\``;
          }

          hideTypingIndicator();
          appendMessage('assistant', quickReply, false);
          chatHistory.push({ role: 'user', content: userQuery });
          chatHistory.push({ role: 'assistant', content: quickReply });
          isProcessing = false;
          return;
        }
      }
    }

    // 5. Cloudflare Workers AI Call
    showTypingIndicator('Consulting Cloudflare AI…');
    const context = buildPortfolioContext(privacyMode);

    try {
      const response = await callCloudflareWorkersAI(userQuery, context, researchData);
      hideTypingIndicator();
      appendMessage('assistant', response, false);
      chatHistory.push({ role: 'user', content: userQuery });
      chatHistory.push({ role: 'assistant', content: response });
    } catch (err) {
      hideTypingIndicator();
      console.warn('Cloudflare Workers AI call failed:', err);
      // Helpful fallback message with localized assistance
      let fallbackMsg = `⚠️ **Could not connect to Cloudflare AI Worker** (${err.message}).\n\n`;
      fallbackMsg += `You can still explore your portfolio instantly with these built-in local queries:\n`;
      fallbackMsg += `* [Asset Allocation](#) — *Type "Show my asset allocation"*\n`;
      fallbackMsg += `* [Top Holdings](#) — *Type "Show my top stocks"*\n`;
      fallbackMsg += `* [Growth Trend](#) — *Type "Show net worth trend"*\n`;
      fallbackMsg += `* [Live Stock Research](#) — *Type "Research RELIANCE" or "Price of TRENT"*`;
      appendMessage('assistant', fallbackMsg, false);
    } finally {
      isProcessing = false;
    }
  }

  // ── Public Drawer Controller ──────────────────────────────────────────────
  function openCopilot() {
    const modal = document.getElementById('copilot-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    updatePrivacyShieldUI();
    const input = document.getElementById('copilot-input');
    if (input) setTimeout(() => input.focus(), 100);

    // Add initial welcome if empty
    const container = document.getElementById('copilot-messages');
    if (container && container.children.length === 0) {
      const welcome = `👋 Hello! I am your **Portfolio Copilot**, powered by **Cloudflare Workers AI** with zero top-up needed.\n\n` +
        `Ask me anything about your holdings, asset allocation, or research any stock live. What would you like to explore today?`;
      appendMessage('assistant', welcome, false);
    }
  }

  function closeCopilot() {
    const modal = document.getElementById('copilot-modal');
    if (!modal) return;
    modal.style.display = 'none';
  }

  function toggleCopilot() {
    const modal = document.getElementById('copilot-modal');
    if (modal && modal.style.display !== 'none') {
      closeCopilot();
    } else {
      openCopilot();
    }
  }

  function togglePrivacyShield() {
    const cur = getPrivacyMode();
    const next = cur === 'anonymized' ? 'full' : 'anonymized';
    setPrivacyMode(next);
  }

  return {
    open: openCopilot,
    close: closeCopilot,
    toggle: toggleCopilot,
    togglePrivacyShield,
    ask: submitQuery
  };
})();

// Global hooks for HTML onclick attributes
function openCopilot() { PortfolioAssistant.open(); }
function closeCopilot() { PortfolioAssistant.close(); }
function toggleCopilot() { PortfolioAssistant.toggle(); }
function togglePrivacyShield() { PortfolioAssistant.togglePrivacyShield(); }
function askCopilotPrompt(text) { PortfolioAssistant.ask(text); }
function handleCopilotSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const input = document.getElementById('copilot-input');
  if (input) PortfolioAssistant.ask(input.value);
}
function handleCopilotBackdropClick(e) {
  if (e.target && e.target.id === 'copilot-modal') {
    closeCopilot();
  }
}
