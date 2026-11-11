// AntiGravity Portfolio — AI Copilot & Natural Language Assistant
// -------------------------------------------------------------------------
// Provides an intelligent financial copilot embedded within the application:
// - Seamlessly references in-memory portfolio holdings & historical ledger
// - Researches live market quotes, 52W range & 5-year price trends
// - Fetches fundamental valuation metrics (P/E ratio, 5Y PE history, EPS, Market Cap, Dividend Yield)
// - Intelligently selects the appropriate Chart.js visualization (line, doughnut, bar, or none)
// - Fast local responses for simple holding lookups & deep AI analysis for complex queries

const PortfolioAssistant = (() => {
  let isProcessing = false;
  let chatHistory = [];
  const MAX_HISTORY = 12;

  // ── Helper: Format Currency in INR ─────────────────────────────────────────
  function fmtVal(val) {
    if (typeof formatINR === 'function') return formatINR(val);
    return '₹' + Number(val).toLocaleString('en-IN');
  }

  // ── Indian Stock & Group Alias Dictionary ─────────────────────────────────
  const STOCK_ALIASES = {
    // ICICI
    'ICICI BANK': { symbols: ['ICICIBANK'], name: 'ICICI Bank' },
    'ICICI GENERAL INSURANCE': { symbols: ['ICICIGI'], name: 'ICICI Lombard General Insurance' },
    'ICICI LOMBARD': { symbols: ['ICICIGI'], name: 'ICICI Lombard General Insurance' },
    'ICICI GI': { symbols: ['ICICIGI'], name: 'ICICI Lombard General Insurance' },
    'ICICI PRUDENTIAL': { symbols: ['ICICIPRULI'], name: 'ICICI Prudential Life Insurance' },
    'ICICI PRU LIFE': { symbols: ['ICICIPRULI'], name: 'ICICI Prudential Life Insurance' },
    'ICICI PRU': { symbols: ['ICICIPRULI'], name: 'ICICI Prudential Life Insurance' },
    'ICICI SECURITIES': { symbols: ['ISEC'], name: 'ICICI Securities' },
    'ICICI': { symbols: ['ICICIBANK', 'ICICIGI', 'ICICIPRULI', 'ISEC'], name: 'ICICI Group', isGroup: true },

    // HDFC
    'HDFC BANK': { symbols: ['HDFCBANK'], name: 'HDFC Bank' },
    'HDFC LIFE': { symbols: ['HDFCLIFE'], name: 'HDFC Life Insurance' },
    'HDFC AMC': { symbols: ['HDFCAMC'], name: 'HDFC AMC' },
    'HDFC': { symbols: ['HDFCBANK', 'HDFCLIFE', 'HDFCAMC'], name: 'HDFC Group', isGroup: true },

    // HUL / Unilever
    'HINDUSTAN UNILEVER': { symbols: ['HINDUNILVR'], name: 'Hindustan Unilever (HUL)' },
    'HINDUNILVR': { symbols: ['HINDUNILVR'], name: 'Hindustan Unilever (HUL)' },
    'HUL': { symbols: ['HINDUNILVR'], name: 'Hindustan Unilever (HUL)' },
    'UNILEVER': { symbols: ['HINDUNILVR'], name: 'Hindustan Unilever (HUL)' },

    // Tata Group
    'TCS': { symbols: ['TCS'], name: 'Tata Consultancy Services' },
    'TATA CONSULTANCY': { symbols: ['TCS'], name: 'Tata Consultancy Services' },
    'TATA MOTORS': { symbols: ['TATAMOTORS'], name: 'Tata Motors' },
    'TATA STEEL': { symbols: ['TATASTEEL'], name: 'Tata Steel' },
    'TATA POWER': { symbols: ['TATAPOWER'], name: 'Tata Power' },
    'TATA CONSUMER': { symbols: ['TATACONSUM'], name: 'Tata Consumer Products' },
    'TATA CHEMICALS': { symbols: ['TATACHEM'], name: 'Tata Chemicals' },
    'TATA ELXSI': { symbols: ['TATAELXSI'], name: 'Tata Elxsi' },
    'TATA TECH': { symbols: ['TATATECH'], name: 'Tata Technologies' },
    'TITAN': { symbols: ['TITAN'], name: 'Titan Company' },
    'VOLTAS': { symbols: ['VOLTAS'], name: 'Voltas' },
    'TRENT': { symbols: ['TRENT'], name: 'Trent' },
    'TATA': { symbols: ['TCS', 'TATAMOTORS', 'TATASTEEL', 'TATAPOWER', 'TATACONSUM', 'TITAN', 'VOLTAS', 'TRENT'], name: 'Tata Group', isGroup: true },

    // Reliance
    'RELIANCE': { symbols: ['RELIANCE'], name: 'Reliance Industries' },
    'RELIANCE INDUSTRIES': { symbols: ['RELIANCE'], name: 'Reliance Industries' },
    'RIL': { symbols: ['RELIANCE'], name: 'Reliance Industries (RIL)' },
    'JIO FINANCIAL': { symbols: ['JIOFIN'], name: 'Jio Financial Services' },
    'JIO': { symbols: ['JIOFIN'], name: 'Jio Financial Services' },

    // State Bank of India
    'STATE BANK OF INDIA': { symbols: ['SBIN'], name: 'State Bank of India' },
    'SBI BANK': { symbols: ['SBIN'], name: 'State Bank of India' },
    'SBI LIFE': { symbols: ['SBILIFE'], name: 'SBI Life Insurance' },
    'SBI CARD': { symbols: ['SBICARD'], name: 'SBI Cards' },
    'SBI CARDS': { symbols: ['SBICARD'], name: 'SBI Cards' },
    'SBIN': { symbols: ['SBIN'], name: 'State Bank of India' },
    'SBI': { symbols: ['SBIN', 'SBILIFE', 'SBICARD'], name: 'SBI Group', isGroup: true },

    // Bajaj Group
    'BAJAJ FINANCE': { symbols: ['BAJFINANCE'], name: 'Bajaj Finance' },
    'BAJAJ FINSERV': { symbols: ['BAJAJFINSV'], name: 'Bajaj Finserv' },
    'BAJAJ AUTO': { symbols: ['BAJAJ-AUTO'], name: 'Bajaj Auto' },
    'BAJAJ HOLDINGS': { symbols: ['BAJAJHLDNG'], name: 'Bajaj Holdings' },
    'BAJAJ': { symbols: ['BAJFINANCE', 'BAJAJFINSV', 'BAJAJ-AUTO', 'BAJAJHLDNG'], name: 'Bajaj Group', isGroup: true },

    // L&T
    'LARSEN & TOUBRO': { symbols: ['LT'], name: 'Larsen & Toubro' },
    'LARSEN AND TOUBRO': { symbols: ['LT'], name: 'Larsen & Toubro' },
    'L&T INFOTECH': { symbols: ['LTIM'], name: 'LTIMindtree' },
    'LTIMINDTREE': { symbols: ['LTIM'], name: 'LTIMindtree' },
    'L&T': { symbols: ['LT', 'LTIM'], name: 'L&T Group', isGroup: true },
    'LT': { symbols: ['LT', 'LTIM'], name: 'Larsen & Toubro' },

    // Mahindra
    'MAHINDRA & MAHINDRA': { symbols: ['M&M'], name: 'Mahindra & Mahindra' },
    'MAHINDRA AND MAHINDRA': { symbols: ['M&M'], name: 'Mahindra & Mahindra' },
    'M&M': { symbols: ['M&M', 'MMFIN'], name: 'Mahindra Group', isGroup: true },
    'MAHINDRA': { symbols: ['M&M', 'MMFIN'], name: 'Mahindra Group', isGroup: true },

    // ITC
    'ITC': { symbols: ['ITC'], name: 'ITC Ltd.' },
    'ITC LTD': { symbols: ['ITC'], name: 'ITC Ltd.' },

    // Infosys
    'INFOSYS': { symbols: ['INFY'], name: 'Infosys' },
    'INFY': { symbols: ['INFY'], name: 'Infosys' },

    // Bharti Airtel
    'BHARTI AIRTEL': { symbols: ['BHARTIARTL'], name: 'Bharti Airtel' },
    'AIRTEL': { symbols: ['BHARTIARTL'], name: 'Bharti Airtel' },

    // Kotak
    'KOTAK BANK': { symbols: ['KOTAKBANK'], name: 'Kotak Mahindra Bank' },
    'KOTAK MAHINDRA BANK': { symbols: ['KOTAKBANK'], name: 'Kotak Mahindra Bank' },
    'KOTAK': { symbols: ['KOTAKBANK'], name: 'Kotak Mahindra Bank' },

    // Axis
    'AXIS BANK': { symbols: ['AXISBANK'], name: 'Axis Bank' },
    'AXIS': { symbols: ['AXISBANK'], name: 'Axis Bank' },

    // Pharma
    'SUN PHARMA': { symbols: ['SUNPHARMA'], name: 'Sun Pharma' },
    'DR REDDY': { symbols: ['DRREDDY'], name: 'Dr. Reddy’s Laboratories' },
    'DR REDDYS': { symbols: ['DRREDDY'], name: 'Dr. Reddy’s Laboratories' },
    'CIPLA': { symbols: ['CIPLA'], name: 'Cipla' },
    'LUPIN': { symbols: ['LUPIN'], name: 'Lupin' },

    // FMCG / Consumer
    'NESTLE': { symbols: ['NESTLEIND'], name: 'Nestlé India' },
    'NESTLE INDIA': { symbols: ['NESTLEIND'], name: 'Nestlé India' },
    'BRITANNIA': { symbols: ['BRITANNIA'], name: 'Britannia Industries' },
    'MARICO': { symbols: ['MARICO'], name: 'Marico' },
    'DABUR': { symbols: ['DABUR'], name: 'Dabur India' },
    'COLGATE': { symbols: ['COLPAL'], name: 'Colgate-Palmolive' },
    'COLPAL': { symbols: ['COLPAL'], name: 'Colgate-Palmolive' },
    'ASIAN PAINTS': { symbols: ['ASIANPAINT'], name: 'Asian Paints' },
    'DMART': { symbols: ['DMART'], name: 'Avenue Supermarts (DMart)' },
    'AVENUE SUPERMARTS': { symbols: ['DMART'], name: 'Avenue Supermarts (DMart)' },

    // Auto
    'MARUTI': { symbols: ['MARUTI'], name: 'Maruti Suzuki' },
    'MARUTI SUZUKI': { symbols: ['MARUTI'], name: 'Maruti Suzuki' },
    'HERO MOTOCORP': { symbols: ['HEROMOTOCO'], name: 'Hero MotoCorp' },
    'HERO': { symbols: ['HEROMOTOCO'], name: 'Hero MotoCorp' },
    'EICHER': { symbols: ['EICHERMOT'], name: 'Eicher Motors' },
    'TVS MOTOR': { symbols: ['TVSMOTOR'], name: 'TVS Motor' },
    'TVS': { symbols: ['TVSMOTOR'], name: 'TVS Motor' },

    // Adani
    'ADANI': { symbols: ['ADANIENT', 'ADANIPORTS', 'ADANIGREEN', 'ATGL', 'ADANIPOWER'], name: 'Adani Group', isGroup: true }
  };

  // ── Helper: Match Query to Portfolio Holdings (Exact, Alias, or Group) ────
  function findMatchingHoldings(query, holdingsList) {
    if (!query || !Array.isArray(holdingsList) || holdingsList.length === 0) {
      return { matches: [], queriedGroup: null, targetSymbols: [], entry: null };
    }

    const q = query.trim().toUpperCase();

    // 1. Check known aliases (sorted by key length descending so specific precedes general)
    const sortedAliases = Object.keys(STOCK_ALIASES).sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      const escaped = alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const rx = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
      if (rx.test(q)) {
        const entry = STOCK_ALIASES[alias];
        const targetSymbols = entry.symbols || [];
        const matched = holdingsList.filter(h => {
          const inst = (h.instrument || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
          return targetSymbols.some(ts => ts === inst || inst.startsWith(ts));
        });
        return {
          matches: matched,
          queriedGroup: alias,
          targetSymbols: targetSymbols,
          entry: entry
        };
      }
    }

    // 2. Direct exact match against instrument in holdingsList
    for (const h of holdingsList) {
      if (!h.instrument) continue;
      const inst = h.instrument.toUpperCase();
      const escaped = inst.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const rx = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
      if (rx.test(q)) {
        return {
          matches: [h],
          queriedGroup: inst,
          targetSymbols: [inst],
          entry: { symbols: [inst], name: inst }
        };
      }
    }

    // 3. Substring / Prefix match: user typed a token that matches part of an instrument
    const tokens = q.match(/[A-Z0-9-]{3,}/g) || [];
    const stopWords = new Set([
      'THE', 'AND', 'FOR', 'ARE', 'CAN', 'YOU', 'ALL', 'ANY', 'NOT', 'GET',
      'WHAT', 'WHEN', 'WHERE', 'SHOW', 'HOW', 'CHART', 'GRAPH', 'PORTFOLIO',
      'STOCKS', 'STOCK', 'FUNDS', 'SHARE', 'SHARES', 'PRICE', 'RESEARCH', 'TOTAL',
      'WORTH', 'VALUE', 'INVEST', 'MONEY', 'GAIN', 'LOSS', 'BANK', 'TECH', 'RATIO',
      'MANY', 'MUCH', 'HAVE', 'HOLD', 'DOES', 'ABOUT', 'CURRENT', 'TREND', 'RANGE',
      'OVERVIEW', 'DETAILS', 'RELATIVE', 'OVERALL', 'PERIOD', 'THIS', 'MOVED'
    ]);

    for (const token of tokens) {
      if (stopWords.has(token) || /^\d+$/.test(token)) continue;
      const matched = holdingsList.filter(h => {
        const inst = (h.instrument || '').toUpperCase();
        return inst.includes(token);
      });
      if (matched.length > 0) {
        return {
          matches: matched,
          queriedGroup: token,
          targetSymbols: matched.map(m => m.instrument),
          entry: { symbols: matched.map(m => m.instrument), name: token }
        };
      }
    }

    return { matches: [], queriedGroup: null, targetSymbols: [], entry: null };
  }

  // ── Build Structured Portfolio Knowledge Context ───────────────────────────
  function buildPortfolioContext(targetStockSymbol, benchmarkData, fundamentalsData, userQueryText) {
    const ctx = {};

    // 1. Total Net Worth
    let totalNw = 0;
    if (typeof breakupSummary !== 'undefined' && breakupSummary.net_worth?.['Total']?.values?.length) {
      const vals = breakupSummary.net_worth['Total'].values;
      totalNw = vals[vals.length - 1]; // In Lakhs
    }
    ctx.netWorth = `₹${totalNw.toFixed(2)} Lakhs`;

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
              val: `₹${v.toFixed(2)}L`
            });
          }
        }
      });
    }

    // 3. Complete Equity Holdings (from latestEquity)
    ctx.portfolioHoldings = [];
    ctx.allOwnedStockSymbols = [];
    let totalEqVal = 0;
    if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
      const sorted = [...latestEquity].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0));
      totalEqVal = sorted.reduce((s, e) => s + (e.cur_val || 0), 0);
      ctx.totalEquityValuation = typeof formatINR === 'function' ? formatINR(totalEqVal) : totalEqVal;
      ctx.totalEquityHoldingsCount = sorted.length;
      ctx.allOwnedStockSymbols = sorted.map(s => s.instrument);

      // ALL stock holdings provided for complete transparency and grounding
      ctx.portfolioHoldings = sorted.map(s => {
        const weightPct = totalEqVal > 0 ? ((s.cur_val || 0) / totalEqVal) * 100 : 0;
        return {
          symbol: s.instrument,
          sector: s.sector || 'General',
          qty: s.qty,
          avgCost: Number((s.avg_cost || 0).toFixed(2)),
          ltp: Number((s.ltp || s.price || 0).toFixed(2)),
          gainPct: Number((s.gain_pct || 0).toFixed(1)),
          weightInEquity: Number(weightPct.toFixed(1)),
          value: typeof formatINR === 'function' ? formatINR(s.cur_val) : s.cur_val
        };
      });

      // Quick reference top 5 stocks by valuation
      ctx.topStocks = ctx.portfolioHoldings.slice(0, 5);

      // Check for holdings matching the user query or target alias (e.g. ICICI -> ICICIBANK and ICICIGI)
      const queryToCheck = userQueryText || targetStockSymbol || '';
      if (queryToCheck) {
        const matchRes = findMatchingHoldings(queryToCheck, latestEquity);
        if (matchRes.matches && matchRes.matches.length > 0) {
          ctx.matchedHoldings = matchRes.matches.map(s => {
            const weight = totalEqVal > 0 ? Number(((s.cur_val / totalEqVal) * 100).toFixed(1)) : 0;
            return {
              symbol: s.instrument,
              sector: s.sector || 'Direct Equity',
              qty: s.qty,
              avgCost: Number((s.avg_cost || 0).toFixed(2)),
              currentPrice: Number((s.ltp || s.price || 0).toFixed(2)),
              holdingGainPct: Number((s.gain_pct || 0).toFixed(2)),
              invested: typeof formatINR === 'function' ? formatINR(s.invested) : s.invested,
              currentValuation: typeof formatINR === 'function' ? formatINR(s.cur_val) : s.cur_val,
              unrealizedPnl: typeof formatINR === 'function' ? formatINR(s.pnl) : s.pnl,
              weightInEquity: weight
            };
          });
        }
      }

      // If a specific stock was queried, provide its complete single holding metrics
      if (targetStockSymbol) {
        const holding = latestEquity.find(s => (s.instrument || '').toUpperCase() === targetStockSymbol.toUpperCase());
        if (holding) {
          const weight = totalEqVal > 0 ? Number(((holding.cur_val / totalEqVal) * 100).toFixed(1)) : 0;
          const targetObj = {
            symbol: holding.instrument,
            sector: holding.sector || 'Direct Equity',
            qty: holding.qty,
            avgCost: Number(holding.avg_cost.toFixed(2)),
            currentPrice: Number((holding.ltp || holding.price || 0).toFixed(2)),
            holdingGainPct: Number((holding.gain_pct || 0).toFixed(2)),
            invested: typeof formatINR === 'function' ? formatINR(holding.invested) : holding.invested,
            currentValuation: typeof formatINR === 'function' ? formatINR(holding.cur_val) : holding.cur_val,
            unrealizedPnl: typeof formatINR === 'function' ? formatINR(holding.pnl) : holding.pnl,
            weightInEquity: weight
          };

          // Historical holding tracking if available
          if (typeof historicalHoldings !== 'undefined' && historicalHoldings) {
            const stockHist = (typeof getStockHistoryKey === 'function' && getStockHistoryKey(holding.instrument)) || historicalHoldings.stocks?.[holding.instrument];
            if (stockHist && Array.isArray(stockHist.history) && stockHist.history.length > 0) {
              targetObj.firstRecordedDate = stockHist.history[0].date;
              targetObj.firstRecordedPrice = stockHist.history[0].ltp;
              targetObj.trackedSnapshotsCount = stockHist.history.length;
            }
          }

          ctx.targetHolding = targetObj;
        }
      }
    }

    // 4. Sector Benchmark Context if available
    if (benchmarkData) {
      ctx.benchmark = {
        name: benchmarkData.name,
        symbol: benchmarkData.symbol,
        currentLevel: benchmarkData.price,
        baselineLevel: benchmarkData.baselinePrice,
        periodReturnPct: benchmarkData.periodReturnPct
      };
    }

    // 5. Fundamental Valuation Metrics (PE, EPS, Mcap, Dividend Yield)
    if (fundamentalsData) {
      ctx.fundamentals = {
        symbol: fundamentalsData.symbol,
        companyName: fundamentalsData.companyName || fundamentalsData.symbol,
        currentPe: fundamentalsData.latestPe,
        fiveYearMedianPe: fundamentalsData.medianPe,
        peRange5Y: (fundamentalsData.minPe != null && fundamentalsData.maxPe != null) ? `${fundamentalsData.minPe} – ${fundamentalsData.maxPe}` : undefined,
        historicalPeTrend: fundamentalsData.peHistory,
        ttmEps: fundamentalsData.latestEps,
        marketCap: fundamentalsData.marketCap,
        dividendYield: fundamentalsData.dividendYield
      };
    }

    // 6. Complete Mutual Funds (from latestMf)
    ctx.portfolioMutualFunds = [];
    ctx.allOwnedMutualFunds = [];
    if (typeof latestMf !== 'undefined' && Array.isArray(latestMf)) {
      const sortedMf = [...latestMf].sort((a, b) => (b.cur_val || 0) - (a.cur_val || 0));
      const totalMfVal = sortedMf.reduce((s, m) => s + (m.cur_val || 0), 0);
      ctx.totalMutualFundsValuation = typeof formatINR === 'function' ? formatINR(totalMfVal) : totalMfVal;
      ctx.allOwnedMutualFunds = sortedMf.map(m => m.scheme);
      ctx.portfolioMutualFunds = sortedMf.map(m => {
        const weightPct = totalMfVal > 0 ? ((m.cur_val || 0) / totalMfVal) * 100 : 0;
        return {
          scheme: m.scheme,
          category: m.category || 'Equity',
          weightInMf: Number(weightPct.toFixed(1)),
          gainPct: Number((m.gain_pct || 0).toFixed(1)),
          value: typeof formatINR === 'function' ? formatINR(m.cur_val) : m.cur_val
        };
      });
      ctx.topMutualFunds = ctx.portfolioMutualFunds.slice(0, 5);
    }

    // 7. Market Cap Concentration (from XRayEngine if available)
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

  // ── Intent Classifiers ─────────────────────────────────────────────────────
  function isAnalyticalOrComparative(query) {
    if (!query) return false;
    return /\b(compare|comparison|relative|vs|versus|against|index|benchmark|fmcg|sector|trend|history|historical|why|analysis|research|recommend|should i|underperform|outperform|cagr|alpha|beta|valuation|pe|p\/e|pb|p\/b|dividend|yield|earnings|eps|growth|outlook|holding period|timeline|multiple)\b/i.test(query);
  }

  function isHoldingLookup(query) {
    if (!query) return false;
    return /\b(how many|how much|quantity|qty|shares|units|do i have|do i own|holding of|my holding|my holdings|holdings of|what is my avg|buy price|cost basis|how much invested|any shares|own any)\b/i.test(query);
  }

  function isValuationQuery(query) {
    if (!query) return false;
    return /\b(pe|p\/e|valuation|earnings|eps|ratio|dividend|yield|mcap|market cap|book value|pb|p\/b|multiple|re-rating|derating)\b/i.test(query);
  }

  // ── Helper: Detect Relevant Sector Benchmark Index ──────────────────────────
  function detectBenchmarkIndex(query, holdingSector) {
    const q = (query || '').toLowerCase();
    const sec = (holdingSector || '').toLowerCase();

    if (q.includes('fmcg') || sec.includes('fmcg') || sec.includes('consumer goods')) {
      if (q.includes('index') || q.includes('fmcg') || q.includes('sector') || q.includes('relative') || q.includes('benchmark')) {
        return { symbol: '^CNXFMCG', name: 'NIFTY FMCG Index', sector: 'FMCG' };
      }
    }
    if (q.includes('it index') || q.includes('tech index') || ((sec.includes('it') || sec.includes('technology')) && (q.includes('index') || q.includes('sector') || q.includes('relative')))) {
      return { symbol: '^CNXIT', name: 'NIFTY IT Index', sector: 'IT' };
    }
    if (q.includes('bank index') || q.includes('bank nifty') || ((sec.includes('bank') || sec.includes('financial')) && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^NSEBANK', name: 'NIFTY Bank Index', sector: 'Banking' };
    }
    if (q.includes('pharma index') || ((sec.includes('pharma') || sec.includes('health')) && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^CNXPHARMA', name: 'NIFTY Pharma Index', sector: 'Pharma' };
    }
    if (q.includes('auto index') || (sec.includes('auto') && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^CNXAUTO', name: 'NIFTY Auto Index', sector: 'Auto' };
    }
    if (q.includes('metal index') || (sec.includes('metal') && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^CNXMETAL', name: 'NIFTY Metal Index', sector: 'Metals' };
    }
    if (q.includes('energy index') || (sec.includes('energy') && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^CNXENERGY', name: 'NIFTY Energy Index', sector: 'Energy' };
    }
    if (q.includes('realty index') || (sec.includes('realty') && (q.includes('index') || q.includes('relative')))) {
      return { symbol: '^CNXREALTY', name: 'NIFTY Realty Index', sector: 'Real Estate' };
    }
    if (q.includes('nifty 50') || q.includes('nifty') || q.includes('broad market') || q.includes('market index')) {
      return { symbol: '^NSEI', name: 'NIFTY 50 Index', sector: 'Broad Market' };
    }
    return null;
  }

  // ── Helper: Detect Ticker Symbol for Research ──────────────────────────────
  function detectTickerQuery(query) {
    if (!query) return null;
    const q = query.trim().toUpperCase();

    // 1. Explicit NSE/BSE suffix (e.g. TRENT.NS or HDFCBANK.BO)
    const suffixMatch = q.match(/\b([A-Z0-9-]{3,12})\.(?:NS|BO)\b/);
    if (suffixMatch) return suffixMatch[1];

    // 2. Check known aliases (sorted by key length descending)
    const sortedAliases = Object.keys(STOCK_ALIASES).sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      const escaped = alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const rx = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
      if (rx.test(q)) {
        const entry = STOCK_ALIASES[alias];
        const syms = entry.symbols || [];
        if (syms.length === 1) return syms[0];
        // If multiple symbols, check if user holds one of them in latestEquity
        if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
          const held = latestEquity.find(e => syms.includes((e.instrument || '').toUpperCase()));
          if (held) return held.instrument;
        }
        return syms[0];
      }
    }

    // 3. Direct match against user's own equity instruments in latestEquity
    if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
      for (const eq of latestEquity) {
        if (eq.instrument && new RegExp(`(^|[^A-Z0-9])${eq.instrument}([^A-Z0-9]|$)`, 'i').test(q)) {
          return eq.instrument;
        }
      }
    }

    // 4. Contextual keyword match: "PE of ITC", "PE ratio of X", "price of X", "research X"
    const keywordMatch = q.match(/(?:RESEARCH|PE\s+RATIO\s+(?:OF|FOR)|PE\s+(?:OF|FOR)|PRICE\s+OF|TREND\s+OF|ABOUT|ANALYZE)\s+([A-Z0-9-]{3,12})\b/);
    if (keywordMatch) {
      const candidate = keywordMatch[1];
      const stopWords = new Set(['THE', 'THIS', 'THAT', 'MY', 'ALL', 'ANY', 'OUR']);
      if (!stopWords.has(candidate)) return candidate;
    }

    // 5. Fallback: Scan uppercase tokens excluding stop words
    const stopWords = new Set([
      'THE', 'AND', 'FOR', 'ARE', 'CAN', 'YOU', 'ALL', 'ANY', 'NOT', 'GET',
      'WHAT', 'WHEN', 'WHERE', 'SHOW', 'HOW', 'CHART', 'GRAPH', 'PORTFOLIO',
      'STOCKS', 'STOCK', 'FUNDS', 'SHARE', 'PRICE', 'RESEARCH', 'TOTAL', 'WORTH',
      'VALUE', 'INVEST', 'MONEY', 'GAIN', 'LOSS', 'BANK', 'TECH', 'RATIO',
      'TELL', 'ABOUT', 'CURRENT', 'TREND', 'RANGE', 'COMPARE', 'OVERVIEW', 'DETAILS',
      'INDEX', 'FMCG', 'RELATIVE', 'OVERALL', 'PERIOD', 'THIS', 'MOVED', 'OVER',
      'MANY', 'MUCH', 'DOES', 'HAVE', 'HOLD', 'UNITS', 'SHARES'
    ]);
    const tokens = q.match(/\b[A-Z0-9-]{3,14}\b/g) || [];
    for (const token of tokens) {
      if (!stopWords.has(token) && !/^\d+$/.test(token)) {
        return token;
      }
    }
    return null;
  }

  // Helper to format proxy URLs for browser fetch calls
  function buildProxyUrl(rawUrl) {
    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (isLocalhost) {
      return `/api/proxy?url=${encodeURIComponent(rawUrl)}`;
    }
    if (typeof _proxyList === 'function') {
      const proxies = _proxyList();
      return proxies[0](rawUrl);
    }
    return `https://feature-portfolio-assistant-chat-portfolio-proxy.aritra2k7.workers.dev/?url=${encodeURIComponent(rawUrl)}`;
  }

  // ── Helper: Fetch Live Market Quote & Price History ────────────────────────
  async function fetchMarketResearch(symbol, range = '1y') {
    const isIndex = symbol.startsWith('^');
    const ticker = isIndex || symbol.endsWith('.NS') || symbol.endsWith('.BO') ? symbol : `${symbol}.NS`;
    const rawUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1mo`;
    const fetchUrl = buildProxyUrl(rawUrl);

    try {
      const res = await fetch(fetchUrl);
      if (!res.ok) return null;
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta || {};
      const timestamps = result.timestamp || [];
      const quoteCloses = result.indicators?.quote?.[0]?.close || [];
      const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || [];
      const closes = (adjCloses && adjCloses.length) ? adjCloses : quoteCloses;

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

  // ── Helper: Fetch Fundamental Valuation Metrics (PE, EPS, Mcap, Dividend) ──
  async function fetchStockFundamentals(symbol) {
    if (!symbol) return null;
    const clean = symbol.replace(/\.(NS|BO)$/i, '').trim().toUpperCase();
    const result = { symbol: clean };

    // 1. Google Finance live exchange fundamentals (Real-time NSE P/E, EPS, Mcap, Div Yield)
    try {
      const gfUrl = buildProxyUrl(`https://www.google.com/finance/quote/${clean}:NSE`);
      const gfRes = await fetch(gfUrl);
      if (gfRes.ok) {
        const html = await gfRes.text();
        const regex = /<div class="(?:SwQK7|mD6t2c)">([^<]+)<\/div>[\s\S]*?<div class="(?:dO6ijd|P6K39c)">([^<]+)<\/div>/g;
        let m;
        const stats = {};
        while ((m = regex.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();

        if (stats['P/E ratio']) {
          const parsedPe = parseFloat(stats['P/E ratio'].replace(/[^0-9.]/g, ''));
          if (!isNaN(parsedPe)) result.latestPe = parsedPe;
        }
        if (stats['EPS']) {
          result.latestEps = stats['EPS'].replace(/^[₹Rs.\s]+/, '');
        }
        if (stats['Mkt. cap']) result.marketCap = stats['Mkt. cap'];
        if (stats['Dividend']) result.dividendYield = stats['Dividend'];
      }
    } catch (e) {
      console.warn('Google Finance fundamentals fetch error:', e);
    }

    // 2. Screener.in search & PE chart (5-year historical PE trajectory & median PE)
    try {
      const searchUrl = buildProxyUrl(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(clean)}`);
      const searchRes = await fetch(searchUrl);
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (Array.isArray(searchData) && searchData.length > 0) {
          const match = searchData.find(c => c.url && c.url.toUpperCase().includes('/' + clean + '/')) || searchData[0];
          if (match && match.id) {
            result.companyName = match.name || clean;
            const chartUrl = buildProxyUrl(`https://www.screener.in/api/company/${match.id}/chart/?q=Price+to+Earning-Median+PE-EPS&days=1825`);
            const chartRes = await fetch(chartUrl);
            if (chartRes.ok) {
              const chartData = await chartRes.json();
              const peDs = chartData.datasets?.find(d => d.metric === 'Price to Earning' || d.label === 'PE');
              const medianDs = chartData.datasets?.find(d => d.metric === 'Median PE' || (d.label && d.label.includes('Median PE')));
              const epsDs = chartData.datasets?.find(d => d.metric === 'EPS' || (d.label && d.label.includes('EPS')));

              if (peDs && Array.isArray(peDs.values) && peDs.values.length > 0) {
                const peVals = peDs.values.filter(v => v[1] != null && !isNaN(v[1]));
                if (peVals.length > 0) {
                  if (!result.latestPe) {
                    result.latestPe = peVals[peVals.length - 1][1];
                  }
                  result.minPe = Math.min(...peVals.map(v => v[1]));
                  result.maxPe = Math.max(...peVals.map(v => v[1]));

                  // Sample ~12 evenly-spaced points for clean presentation & line chart
                  const step = Math.max(1, Math.floor(peVals.length / 12));
                  result.peHistory = [];
                  for (let i = 0; i < peVals.length; i += step) {
                    result.peHistory.push({ date: peVals[i][0].slice(0, 7), pe: Number(peVals[i][1].toFixed(1)) });
                  }
                  // Append current live PE if available
                  if (result.latestPe) {
                    const todayStr = new Date().toISOString().slice(0, 7);
                    result.peHistory.push({ date: todayStr, pe: Number(result.latestPe.toFixed(1)) });
                  }
                }
              }

              if (medianDs && Array.isArray(medianDs.values) && medianDs.values.length > 0) {
                result.medianPe = parseFloat(medianDs.values[medianDs.values.length - 1][1]);
              }
              if (epsDs && Array.isArray(epsDs.values) && epsDs.values.length > 0 && !result.latestEps) {
                result.latestEps = String(epsDs.values[epsDs.values.length - 1][1]);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Screener fundamentals fetch error:', e);
    }

    return result;
  }

  // ── Local Zero-Latency Intent Solver (Offline / Immediate) ────────────────
  function solveLocallyIfPossible(query) {
    const q = query.toLowerCase().trim();

    // Analytical, comparative, valuation, or holding-period questions should ALWAYS be handled
    // by Portfolio Copilot with live market / benchmark index data.
    if (isAnalyticalOrComparative(query)) {
      return null;
    }

    // 1. Specific Stock Holding Query (e.g., "How many ICICI do I own?", "How many HUL stocks do i own?", "Do I own HDFCBANK?", "What is my avg price of ITC?")
    if (isHoldingLookup(q)) {
      // Check Direct Equities first
      let equityMatchResult = { matches: [], targetSymbols: [] };
      if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity) && latestEquity.length > 0) {
        const totalEq = latestEquity.reduce((sum, e) => sum + (e.cur_val || 0), 0);
        equityMatchResult = findMatchingHoldings(query, latestEquity);

        // Case A: Multiple holdings match a group/conglomerate query (e.g. "ICICI" -> ICICIBANK and ICICIGI)
        if (equityMatchResult.matches.length > 1) {
          const groupName = equityMatchResult.entry?.name || equityMatchResult.queriedGroup || 'Matching Group';
          const matched = equityMatchResult.matches;
          const groupCurVal = matched.reduce((sum, s) => sum + (s.cur_val || 0), 0);
          const groupInvested = matched.reduce((sum, s) => sum + (s.invested || 0), 0);
          const groupPnl = groupCurVal - groupInvested;
          const groupGainPct = groupInvested > 0 ? (groupPnl / groupInvested) * 100 : 0;
          const groupWeight = totalEq > 0 ? ((groupCurVal / totalEq) * 100).toFixed(1) : '0';
          const groupGainSign = groupPnl >= 0 ? '+' : '';

          let text = `You currently hold **${matched.length} stocks** in the **${groupName}**:\n\n`;
          matched.forEach((s, idx) => {
            const gainSign = (s.gain_pct || 0) >= 0 ? '+' : '';
            const wt = totalEq > 0 ? ((s.cur_val / totalEq) * 100).toFixed(1) : '0';
            text += `### ${idx + 1}. **${s.instrument}** (${s.sector || 'Direct Equity'})\n`;
            text += `* **Quantity**: **${s.qty.toLocaleString()} shares**\n`;
            text += `* **Average Buy Price**: **₹${(s.avg_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**\n`;
            text += `* **Current Market Price (LTP)**: **₹${(s.ltp || s.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**\n`;
            text += `* **Invested**: **${fmtVal(s.invested)}** | **Valuation**: **${fmtVal(s.cur_val)}** (${wt}% of equity)\n`;
            text += `* **Unrealized P&L**: **${gainSign}${fmtVal(Math.abs(s.pnl || 0))} (${gainSign}${(s.gain_pct || 0).toFixed(2)}%)**\n\n`;
          });

          text += `**Combined ${groupName} Summary**:\n`;
          text += `* **Total Valuation**: **${fmtVal(groupCurVal)}** (${groupWeight}% of total equity)\n`;
          text += `* **Total Invested**: **${fmtVal(groupInvested)}**\n`;
          text += `* **Total Unrealized Gain**: **${groupGainSign}${fmtVal(Math.abs(groupPnl))} (${groupGainSign}${groupGainPct.toFixed(2)}%)**\n`;

          const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
            title: `${groupName}: Holdings Valuation (₹)`,
            labels: matched.map(s => s.instrument),
            data: matched.map(s => Number((s.cur_val || 0).toFixed(0)))
          }, null, 2)}\n\`\`\``;

          return text + chartBlock;
        }

        // Case B: Exactly 1 stock holding matches
        if (equityMatchResult.matches.length === 1) {
          const s = equityMatchResult.matches[0];
          const gainSign = (s.gain_pct || 0) >= 0 ? '+' : '';
          const weight = totalEq > 0 ? ((s.cur_val / totalEq) * 100).toFixed(1) : '0';
          const displayName = equityMatchResult.entry?.name && !equityMatchResult.entry.isGroup
            ? `${equityMatchResult.entry.name} (${s.instrument})`
            : s.instrument;

          let text = `You currently hold **${s.qty.toLocaleString()} shares** of **${displayName}** (${s.sector || 'Direct Equity'}):\n\n`;
          text += `* **Current Quantity**: **${s.qty.toLocaleString()} shares**\n`;
          text += `* **Average Buy Price**: **₹${(s.avg_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**\n`;
          text += `* **Current Market Price (LTP)**: **₹${(s.ltp || s.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**\n`;
          text += `* **Total Invested**: **${fmtVal(s.invested)}**\n`;
          text += `* **Current Valuation**: **${fmtVal(s.cur_val)}** (${weight}% of total equity)\n`;
          text += `* **Unrealized P&L**: **${gainSign}${fmtVal(Math.abs(s.pnl || 0))} (${gainSign}${(s.gain_pct || 0).toFixed(2)}%)**\n`;

          const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
            title: `${s.instrument}: Average Cost vs Current Price (₹)`,
            labels: ['Avg Buy Price', 'Current LTP'],
            data: [Number((s.avg_cost || 0).toFixed(2)), Number((s.ltp || s.price || 0).toFixed(2))]
          }, null, 2)}\n\`\`\``;

          return text + chartBlock;
        }
      }

      // Check Mutual Funds (e.g., "Parag Parikh", "Mirae", "HDFC Top 100")
      if (typeof latestMf !== 'undefined' && Array.isArray(latestMf) && latestMf.length > 0) {
        const totalMf = latestMf.reduce((sum, m) => sum + (m.cur_val || 0), 0);
        for (const m of latestMf) {
          if (!m.scheme) continue;
          const schemeLower = m.scheme.toLowerCase();
          const schemeWords = schemeLower.split(/\s+/).filter(w => w.length > 3 && !['fund', 'direct', 'plan', 'growth', 'equity', 'flexi', 'index'].includes(w));
          const matchesWords = schemeWords.length >= 1 && schemeWords.every(w => q.includes(w));
          if (q.includes(schemeLower) || matchesWords) {
            const gainSign = (m.gain_pct || 0) >= 0 ? '+' : '';
            const weight = totalMf > 0 ? (((m.cur_val || 0) / totalMf) * 100).toFixed(1) : '0';
            const avgNav = m.avg_nav || m.price || 0;
            const curNav = m.price || m.nav || 0;

            let text = `Here are the details for your holding in **${m.scheme}** (${m.category || 'Mutual Fund'}):\n\n`;
            text += `* **Units Held**: **${m.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })} units**\n`;
            text += `* **Average Purchase NAV**: **₹${avgNav.toFixed(2)}**\n`;
            text += `* **Current NAV**: **₹${curNav.toFixed(2)}**\n`;
            text += `* **Total Invested**: **${fmtVal(m.invested)}**\n`;
            text += `* **Current Valuation**: **${fmtVal(m.cur_val)}** (${weight}% of mutual funds)\n`;
            text += `* **Unrealized Gain**: **${gainSign}${fmtVal(Math.abs(m.pnl || 0))} (${gainSign}${(m.gain_pct || 0).toFixed(2)}%)**\n`;

            const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
              title: `${m.scheme.slice(0, 24)}…: Avg NAV vs Current NAV (₹)`,
              labels: ['Avg Purchase NAV', 'Current NAV'],
              data: [Number(avgNav.toFixed(2)), Number(curNav.toFixed(2))]
            }, null, 2)}\n\`\`\``;

            return text + chartBlock;
          }
        }
      }

      // Case C: Neither equity nor MF held, but a known alias/group was queried (e.g. HUL -> HINDUNILVR)
      if (equityMatchResult.targetSymbols && equityMatchResult.targetSymbols.length > 0) {
        const name = equityMatchResult.entry?.name || equityMatchResult.queriedGroup || equityMatchResult.targetSymbols.join(', ');
        const symStr = equityMatchResult.targetSymbols.join(', ');
        if (equityMatchResult.entry?.isGroup) {
          return `You do not currently hold any shares from the **${name}** (${symStr}) in your portfolio.`;
        }
        return `You do not currently hold any shares of **${name}** (${symStr}) in your portfolio.`;
      }

      // Case D: A specific stock ticker token was queried directly (e.g., "Do I own XYZ?")
      const candidateTicker = detectTickerQuery(query);
      if (candidateTicker && typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
        return `You do not currently hold any shares of **${candidateTicker}** in your portfolio.`;
      }
    }

    // 3. Asset Allocation Query
    if (q.includes('asset allocation') || q.includes('allocation') || q.includes('breakdown') || q.includes('distribution')) {
      if (typeof breakupSummary === 'undefined' || !breakupSummary.net_worth) return null;
      const nw = breakupSummary.net_worth;
      const total = nw['Total']?.values?.[nw['Total'].values.length - 1] || 1;
      
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
          summaryText += `* **${it.name}**: **${pct}%** (₹${it.val.toFixed(2)} L)\n`;
        }
      });

      const chartBlock = `\n\`\`\`chart:doughnut\n${JSON.stringify({
        title: 'Asset Allocation Breakdown (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return summaryText + chartBlock;
    }

    // 4. Sector Exposure Queries
    const sectorKeywords = {
      'banking': ['banking', 'banks', 'financial'],
      'technology': ['it', 'tech', 'software', 'technology'],
      'fmcg': ['fmcg', 'consumer goods', 'consumer'],
      'pharma': ['pharma', 'healthcare', 'medical'],
      'auto': ['auto', 'automobile', 'vehicles']
    };
    for (const [secName, kwList] of Object.entries(sectorKeywords)) {
      if (kwList.some(k => q.includes(k)) && (q.includes('sector') || q.includes('exposure') || q.includes('how much') || q.includes('holding') || q.includes('stocks'))) {
        if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
          const matchedStocks = latestEquity.filter(s => (s.sector || '').toLowerCase().includes(secName) || kwList.some(k => (s.sector || '').toLowerCase().includes(k)));
          if (matchedStocks.length) {
            const totalEq = latestEquity.reduce((sum, e) => sum + (e.cur_val || 0), 0);
            const secVal = matchedStocks.reduce((sum, s) => sum + (s.cur_val || 0), 0);
            const secWeight = totalEq > 0 ? ((secVal / totalEq) * 100).toFixed(1) : '0';

            let text = `Your exposure to the **${secName.toUpperCase()}** sector represents **${secWeight}%** of your direct equity portfolio:\n\n`;
            text += `* **Total Valuation**: **${fmtVal(secVal)}**\n`;
            text += `* **Holdings Count**: **${matchedStocks.length} stocks**\n\n`;
            matchedStocks.forEach(s => {
              const wt = totalEq > 0 ? ((s.cur_val / totalEq) * 100).toFixed(1) : '0';
              text += `  - **${s.instrument}**: ${s.qty.toLocaleString()} shares (${wt}% of equity)\n`;
            });

            const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
              title: `${secName.toUpperCase()} Sector Holdings by Weight (%)`,
              labels: matchedStocks.map(s => s.instrument),
              data: matchedStocks.map(s => Number(((s.cur_val / totalEq) * 100).toFixed(1)))
            }, null, 2)}\n\`\`\``;

            return text + chartBlock;
          }
        }
      }
    }

    // 5. Top Stock Holdings Query
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
        text += `${idx + 1}. **${s.instrument}** (${s.sector || 'Stock'}): **${wt}%** of equity | Return: **${gainSign}${s.gain_pct?.toFixed(1)}%** | Value: ${fmtVal(s.cur_val)}\n`;
      });

      const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
        title: 'Top 5 Stocks by Weight (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return text + chartBlock;
    }

    // 6. Top Mutual Funds Query
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
        text += `${idx + 1}. **${m.scheme}**: **${wt}%** | Return: **${gainSign}${m.gain_pct?.toFixed(1)}%** | Value: ${fmtVal(m.cur_val)}\n`;
      });

      const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
        title: 'Top Mutual Funds by Weight (%)',
        labels: labels,
        data: data
      }, null, 2)}\n\`\`\``;

      return text + chartBlock;
    }

    // 7. Top Gainers & Top Losers
    if (q.includes('gainer') || q.includes('best perform') || q.includes('highest return') || q.includes('top profit')) {
      if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
        const sorted = [...latestEquity].sort((a, b) => (b.gain_pct || 0) - (a.gain_pct || 0)).slice(0, 5);
        let text = 'Here are your **Top Performing Stocks** by percentage gain:\n\n';
        sorted.forEach((s, idx) => {
          text += `${idx + 1}. **${s.instrument}**: **+${s.gain_pct?.toFixed(2)}%** (P&L: +${fmtVal(s.pnl)})\n`;
        });
        const chartBlock = `\n\`\`\`chart:bar\n${JSON.stringify({
          title: 'Top Performers by Gain (%)',
          labels: sorted.map(s => s.instrument),
          data: sorted.map(s => Number(s.gain_pct.toFixed(1)))
        }, null, 2)}\n\`\`\``;
        return text + chartBlock;
      }
    }

    // 8. Total Net Worth Query
    if (q.includes('net worth') || q.includes('total wealth') || q.includes('total portfolio value')) {
      if (typeof breakupSummary !== 'undefined' && breakupSummary.net_worth?.['Total']) {
        const vals = breakupSummary.net_worth['Total'].values;
        const curVal = vals[vals.length - 1] || 0;
        let text = `Here is your current **Total Net Worth**:\n\n`;
        text += `* **Total Net Worth**: **₹${curVal.toFixed(2)} Lakhs**\n`;
        text += `* **Asset Distribution**: Active across 9 asset classes (Equity, MFs, Fixed Income, Gold, Real Estate).\n`;
        text += `You can view the full asset breakdown by asking *"Show asset allocation"* or trend by asking *"Show net worth trend"*.\n`;
        return text;
      }
    }

    return null; // Delegate to Portfolio Copilot AI
  }

  // ── Portfolio Copilot AI Dispatcher ───────────────────────────────────────
  async function callCloudflareWorkersAI(promptText, portfolioContext, researchData, benchmarkData, fundamentalsData) {
    const systemPrompt = `You are "Portfolio Copilot", an elite financial intelligence assistant embedded in the AntiGravity Portfolio Analytics app.
Your goals:
1. Provide accurate, insightful, and concise financial commentary (under 250 words). Avoid generic introductory filler or lengthy disclaimers.
2. Ground your answers firmly in the user's provided portfolio context, market fundamentals (PE ratio, EPS, Market Cap, Dividend Yield), and benchmark data.
3. CRITICAL PORTFOLIO HOLDINGS GROUNDING:
   - "portfolioHoldings" contains the user's COMPLETE direct equity portfolio (all owned stocks).
   - "allOwnedStockSymbols" lists all tickers currently owned.
   - If a company or stock is NOT present in "portfolioHoldings", the user DOES NOT own it. State clearly: "You do not currently hold [Company] in your portfolio."
   - NEVER say "as it is not listed in your top stocks holdings" or "not in top holdings". You have the ENTIRE portfolio.
   - Recognize company names, group names, and ticker aliases (e.g., ICICI matches ICICIBANK and ICICIGI; HUL matches HINDUNILVR; HDFC matches HDFCBANK and HDFCLIFE; Tata matches TCS, Tata Motors, Tata Steel, etc.).
   - If the user asks about a conglomerate or group (e.g., "ICICI" or "Tata"), report on ALL matching stocks in the user's holdings.
4. When asked about Valuation or PE ratio movement:
   - CRITICAL GROUNDING: When Market Fundamentals & Valuation Data is provided, you MUST use the exact numbers from that data (e.g. latestPe, latestEps, medianPe, minPe, maxPe, marketCap, dividendYield).
   - NEVER invent or use PE ratios or EPS numbers from your pre-training memory when Market Fundamentals data is provided.
   - State the exact current PE ratio (e.g., 18.8x), TTM EPS (e.g., ₹15.07), 5-year median PE, and historical range.
   - Explain whether the stock is trading at a discount or premium to its 5-year median PE and what drove the valuation changes.
   - Use a Line Chart (\`\`\`chart:line) showing the historical PE trajectory over time based on the provided peHistory.
5. When asked to evaluate performance relative to a benchmark index (e.g. FMCG index vs ITC):
   - Explicitly compare the holding's return percentage against the benchmark index return percentage over the user's holding period.
   - State clearly whether the holding outperformed or underperformed (calculate the alpha in percentage points).
   - Use a Bar Chart (\`\`\`chart:bar) comparing the two returns.
6. Chart Selection Rules (CRITICAL: NEVER default to a vertical bar chart):
   - Line Chart (\`\`\`chart:line): Use for time-series trends (PE ratio movement over time, historical price trends, portfolio growth over time).
   - Doughnut Chart (\`\`\`chart:doughnut): Use for compositions & breakdowns of a whole (Asset allocation, sector split, market cap split).
   - Bar Chart (\`\`\`chart:bar): Use ONLY for comparing discrete category snapshots at a single point in time (Holding Return vs Benchmark Return, Top Performers, Holding Breakdown).
   - No Chart: Omit if the question is purely explanatory, a single factual lookup, or if visual aid is not genuinely useful.

Output format for charts:
\`\`\`chart:line (or doughnut or bar)
{
  "title": "Descriptive Title",
  "labels": ["Label1", "Label2", ...],
  "data": [10.5, 20.3, ...]
}
\`\`\``;

    const userContent = `Portfolio Context:
${JSON.stringify(portfolioContext, null, 2)}
${researchData ? `\nLive Market Price & History Data:\n${JSON.stringify(researchData, null, 2)}` : ''}
${fundamentalsData ? `\nMarket Fundamentals & Valuation Data (PE Ratio, EPS, Mcap):\n${JSON.stringify(fundamentalsData, null, 2)}` : ''}
${benchmarkData ? `\nSector Benchmark Index Data:\n${JSON.stringify(benchmarkData, null, 2)}` : ''}

User Question: ${promptText}`;

    const messages = [
      ...chatHistory.slice(-6),
      { role: 'user', content: userContent }
    ];

    let endpoint = '/api/chat';
    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (!isLocalhost) {
      endpoint = 'https://feature-portfolio-assistant-chat-portfolio-proxy.aritra2k7.workers.dev/api/chat';
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        systemPrompt,
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
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
      mountInlineCharts(bubble);
    }

    row.appendChild(bubble);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  // ── Convert Markdown & Chart Placeholders to Safe HTML ─────────────────────
  function formatMarkdown(text) {
    if (!text) return '';

    // Extract chart code blocks first to protect them from regex mangling
    const chartFences = [];
    let processed = text.replace(/```(?:chart:(line|bar|doughnut)|json)([\s\S]*?)```/gi, (match, chartType, body) => {
      let type = (chartType || '').toLowerCase();
      let jsonStr = body.trim();

      // If code fence was ```json, inspect if body specifies chart type
      if (!type) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && (parsed.chart || parsed.type)) {
            type = (parsed.chart || parsed.type).toLowerCase();
          }
        } catch (_) {}
      }

      if (!type || !['line', 'bar', 'doughnut'].includes(type)) {
        return match;
      }

      const id = `copilot-chart-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      chartFences.push({ id, type, jsonStr });
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
        
        let config = null;
        try {
          config = JSON.parse(rawJson);
        } catch (_) {
          // Fallback parsing for pipe or colon delimited lines (e.g. "2021-11|19.0" or "ITC: 38.01")
          const lines = rawJson.split('\n').map(l => l.trim()).filter(Boolean);
          const labels = [];
          const data = [];
          lines.forEach(l => {
            const parts = l.split(/[|:]/);
            if (parts.length >= 2) {
              const val = parseFloat(parts[parts.length - 1].replace(/[^0-9.-]/g, ''));
              if (!isNaN(val)) {
                labels.push(parts[0].trim());
                data.push(val);
              }
            }
          });
          if (labels.length > 0) {
            config = { labels, data, title: 'Valuation / Return Comparison' };
          }
        }

        if (!config) return;

        // Normalize if config has Chart.js datasets format
        let labels = config.labels || config.data?.labels || [];
        let dataPoints = config.data;
        let chartTitle = config.title || '';

        // Handle array of objects like [{x: '2021-11', y: 19}] or [{date: '2021-11', pe: 19}]
        if (Array.isArray(config.data) && config.data.length > 0 && typeof config.data[0] === 'object' && config.data[0] !== null) {
          labels = config.data.map(p => p.x || p.date || p.label || '');
          dataPoints = config.data.map(p => p.y != null ? p.y : (p.pe != null ? p.pe : (p.value != null ? p.value : p.close)));
        }

        if (Array.isArray(config.data?.datasets) && config.data.datasets.length > 0) {
          dataPoints = config.data.datasets[0].data || [];
          if (!chartTitle && config.data.datasets[0].label) chartTitle = config.data.datasets[0].label;
        } else if (Array.isArray(config.datasets) && config.datasets.length > 0) {
          dataPoints = config.datasets[0].data || [];
          if (!chartTitle && config.datasets[0].label) chartTitle = config.datasets[0].label;
        }
        if (!Array.isArray(dataPoints)) return;

        const ctx = canvas.getContext('2d');
        const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6', '#14b8a6', '#f43f5e'];

        let dataset = {};
        if (type === 'doughnut') {
          dataset = {
            data: dataPoints,
            backgroundColor: colors.slice(0, labels.length),
            borderWidth: 1.5,
            borderColor: '#0f172a'
          };
        } else if (type === 'line') {
          const lineGrad = ctx.createLinearGradient(0, 0, 0, 180);
          lineGrad.addColorStop(0, 'rgba(99, 102, 241, 0.28)');
          lineGrad.addColorStop(1, 'rgba(99, 102, 241, 0.01)');
          dataset = {
            label: chartTitle || 'Trend',
            data: dataPoints,
            borderColor: '#6366f1',
            backgroundColor: lineGrad,
            fill: true,
            borderWidth: 2,
            tension: 0.15,
            pointRadius: 0,
            pointHoverRadius: 5
          };
        } else {
          // Bar
          dataset = {
            label: chartTitle || 'Comparison',
            data: dataPoints,
            backgroundColor: colors.slice(0, labels.length).map(c => c + 'cc'),
            borderColor: colors.slice(0, labels.length),
            borderWidth: 1,
            borderRadius: 4
          };
        }

        new Chart(ctx, {
          type: type,
          data: {
            labels: labels,
            datasets: [dataset]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: !!chartTitle,
                text: chartTitle,
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
                  pointStyle: 'circle',
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
  function showTypingIndicator(statusText = 'Analyzing…') {
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

    // 3. Check for Local Solver Match (Fast offline response)
    const localAnswer = solveLocallyIfPossible(userQuery);
    if (localAnswer) {
      isProcessing = false;
      setTimeout(() => {
        appendMessage('assistant', localAnswer, false);
        chatHistory.push({ role: 'user', content: userQuery });
        chatHistory.push({ role: 'assistant', content: localAnswer });
      }, 150);
      return;
    }

    // 4. Check for Stock Research, Fundamentals & Benchmark Comparison
    showTypingIndicator('Analyzing request…');
    const ticker = detectTickerQuery(userQuery);
    const isComp = isAnalyticalOrComparative(userQuery);
    const isVal = isValuationQuery(userQuery);

    let researchData = null;
    let benchmarkData = null;
    let fundamentalsData = null;

    if (ticker) {
      let holding = null;
      if (typeof latestEquity !== 'undefined' && Array.isArray(latestEquity)) {
        holding = latestEquity.find(s => (s.instrument || '').toUpperCase() === ticker.toUpperCase());
      }

      // Check if a sector benchmark index is relevant
      const benchmarkMeta = detectBenchmarkIndex(userQuery, holding?.sector);

      showTypingIndicator(`Fetching market & valuation data for ${ticker}…`);

      // Fetch stock price history, valuation fundamentals, and benchmark index in parallel
      const promises = [
        fetchMarketResearch(ticker, isComp || isVal ? '5y' : '1y'),
        fetchStockFundamentals(ticker)
      ];
      if (benchmarkMeta) {
        promises.push(fetchMarketResearch(benchmarkMeta.symbol, '5y'));
      }

      const results = await Promise.all(promises);
      researchData = results[0];
      fundamentalsData = results[1];

      if (benchmarkMeta && results[2]) {
        const benchRes = results[2];
        let baselinePrice = benchRes.price;
        if (benchRes.history && benchRes.history.length > 0) {
          baselinePrice = benchRes.history[0].close || benchRes.price;
        }
        const benchReturnPct = baselinePrice > 0 ? Number((((benchRes.price - baselinePrice) / baselinePrice) * 100).toFixed(2)) : 0;
        benchmarkData = {
          name: benchmarkMeta.name,
          symbol: benchmarkMeta.symbol,
          price: benchRes.price,
          baselinePrice: baselinePrice,
          periodReturnPct: benchReturnPct
        };
      }

      // If user ONLY asked for a simple price quote or 52-week range (and NOT comparative/valuation analysis):
      if (researchData && !isComp && !isVal && (userQuery.toLowerCase().includes('52w') || userQuery.toLowerCase().includes('price') || userQuery.toLowerCase().startsWith('research '))) {
        const chgSign = researchData.changePct >= 0 ? '+' : '';
        let quickReply = `Here is the live market data for **${researchData.name}** (${researchData.symbol}):\n\n`;
        quickReply += `* **Current Price**: ₹${researchData.price?.toLocaleString('en-IN') || '—'} (${chgSign}${researchData.changePct?.toFixed(2)}%)\n`;
        quickReply += `* **52-Week Range**: ₹${researchData.low52?.toLocaleString('en-IN') || '—'} – ₹${researchData.high52?.toLocaleString('en-IN') || '—'}\n`;
        quickReply += `* **Previous Close**: ₹${researchData.prevClose?.toLocaleString('en-IN') || '—'}\n`;

        if (researchData.history && researchData.history.length > 2) {
          quickReply += `\n\`\`\`chart:line\n${JSON.stringify({
            title: `${researchData.symbol} Price Trend (₹)`,
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

    // 5. Portfolio Copilot AI Call
    showTypingIndicator('Analyzing with Portfolio Copilot…');
    const context = buildPortfolioContext(ticker, benchmarkData, fundamentalsData, userQuery);

    try {
      const response = await callCloudflareWorkersAI(userQuery, context, researchData, benchmarkData, fundamentalsData);
      hideTypingIndicator();
      appendMessage('assistant', response, false);
      chatHistory.push({ role: 'user', content: userQuery });
      chatHistory.push({ role: 'assistant', content: response });
    } catch (err) {
      hideTypingIndicator();
      console.warn('Portfolio Copilot AI call failed:', err);

      // Synthesize answer directly from available data
      let fallbackMsg = '';
      if (fundamentalsData && fundamentalsData.latestPe) {
        fallbackMsg = `### Valuation Summary for **${fundamentalsData.companyName || ticker}**:\n\n` +
          `* **Current P/E Ratio**: **${fundamentalsData.latestPe}x**\n` +
          `* **5-Year Median P/E**: **${fundamentalsData.medianPe ? fundamentalsData.medianPe + 'x' : '—'}**\n` +
          `* **Historical Range**: ${fundamentalsData.minPe || '—'}x – ${fundamentalsData.maxPe || '—'}x\n` +
          `* **TTM EPS**: ₹${fundamentalsData.latestEps || '—'}\n` +
          `* **Market Cap**: ₹${fundamentalsData.marketCap || '—'}\n` +
          `* **Dividend Yield**: ${fundamentalsData.dividendYield || '—'}\n\n`;
        
        if (fundamentalsData.peHistory && fundamentalsData.peHistory.length > 2) {
          fallbackMsg += `\`\`\`chart:line\n${JSON.stringify({
            title: `${ticker} Historical P/E Ratio Trend`,
            labels: fundamentalsData.peHistory.map(p => p.date),
            data: fundamentalsData.peHistory.map(p => p.pe)
          }, null, 2)}\n\`\`\``;
        }
      } else if (context && context.matchedHoldings && context.matchedHoldings.length > 1) {
        fallbackMsg = `Based on your portfolio records, you hold **${context.matchedHoldings.length} stocks** matching your query:\n\n`;
        context.matchedHoldings.forEach(h => {
          fallbackMsg += `* **${h.symbol}** (${h.sector}): **${h.qty.toLocaleString()} shares** | Valuation: ${h.currentValuation} (${h.weightInEquity}% of equity) | Return: +${h.holdingGainPct}%\n`;
        });
      } else if (context && context.targetHolding) {
        const th = context.targetHolding;
        const benchText = context.benchmark ? `\n* **Benchmark (${context.benchmark.name})**: Return: **+${context.benchmark.periodReturnPct}%**\n* **Alpha**: **+${(th.holdingGainPct - context.benchmark.periodReturnPct).toFixed(2)}%**` : '';
        fallbackMsg = `Based on your portfolio records for **${th.symbol}** (${th.sector}):\n\n` +
          `* **Holding Period Return**: **+${th.holdingGainPct}%** (Avg Cost: ₹${th.avgCost} vs LTP: ₹${th.currentPrice})\n` +
          `* **Quantity Held**: **${th.qty.toLocaleString()} shares** (${th.weightInEquity}% of equity)${benchText}\n\n` +
          `*(Note: Offline fallback mode. Analytical metrics computed directly from in-memory records.)*`;
      } else {
        fallbackMsg = `I am unable to reach the online AI service right now. You can continue asking about your portfolio holdings, asset allocation, or net worth trend offline.`;
      }
      appendMessage('assistant', fallbackMsg, false);
      chatHistory.push({ role: 'user', content: userQuery });
      chatHistory.push({ role: 'assistant', content: fallbackMsg });
    } finally {
      isProcessing = false;
    }
  }

  // ── Public Drawer Controller ──────────────────────────────────────────────
  function openCopilot() {
    const modal = document.getElementById('copilot-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    const input = document.getElementById('copilot-input');
    if (input) setTimeout(() => input.focus(), 100);

    // Add initial welcome if empty
    const container = document.getElementById('copilot-messages');
    if (container && container.children.length === 0) {
      const welcome = `👋 Hello! I am your **Portfolio Copilot**.\n\n` +
        `Ask me anything about your holdings, asset allocation, or research any stock live (e.g. PE ratio trends, valuation, or benchmark performance). What would you like to explore today?`;
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

  return {
    open: openCopilot,
    close: closeCopilot,
    toggle: toggleCopilot,
    ask: submitQuery
  };
})();

// Global hooks for HTML onclick attributes
function openCopilot() { PortfolioAssistant.open(); }
function closeCopilot() { PortfolioAssistant.close(); }
function toggleCopilot() { PortfolioAssistant.toggle(); }
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
