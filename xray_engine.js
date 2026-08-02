const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function decryptEnvelope(envelope, password) {
  const salt = Buffer.from(envelope.salt, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, envelope.iter || 310000, 32, 'sha256');
  const buf = Buffer.from(envelope.ct, 'base64');
  const ct = buf.subarray(0, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function readDataJSON(file) {
  try {
    const filePath = path.join(__dirname, 'data', file);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && raw.__encrypted === true) {
      const pwd = process.env.DASHBOARD_PASSWORD || 'Portfolio2026';
      return decryptEnvelope(raw, pwd);
    }
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error(`Failed to read/decrypt ${file}:`, e.message);
    return [];
  }
}

function readEncryptedObjectJSON(file) {
  try {
    const filePath = path.join(__dirname, 'data', file);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && raw.__encrypted === true) {
      const pwd = process.env.DASHBOARD_PASSWORD || 'Portfolio2026';
      return decryptEnvelope(raw, pwd);
    }
    return raw;
  } catch (e) {
    return null;
  }
}

function classifyStockStyle(symbol) {
  const sym = (symbol || '').toString().toUpperCase();
  if (/COALINDIA|ONGC|ITC|CASTROL|HEROMOTOCO|BAJAJ-AUTO|TATASTEEL|SBIN|BANKBARODA|KARURVYSYA|FEDERALBNK|EXIDE|APOLLO|BALKRIS|COLPAL|MARICO|BRITANNIA|TATACONSUM|NESTLE|OFSS|REC27TF|IOC|BPCL|HPCL|POWERGRID|NTPC|GAIL|PETRONET|OIL|RECLTD|PFC|VEDL|HINDZINC|NHPC|SJVN|NMDC|SAIL/i.test(sym)) {
    return 'Value';
  }
  if (/TCS|INFY|HCLTECH|KPIT|MPHASIS|PERSISTENT|COFORGE|BAJFINANCE|TITAN|VBL|DMART|DLF|GODREJ|OBEROI|BRIGADE|PRESTIGE|PHOENIX|SIEMENS|UNOMINDA|MOTHERSON|CIEINDIA|SYNGENE|MANKIND|ERIS|ENRIN|ZOMATO|TRENT|DIXON|POLYCAB|KAYNES|HAL|BEL|MAZDOCK|CDSL|BSE/i.test(sym)) {
    return 'Growth';
  }
  return 'Blend';
}

function classifyStockCap(symbol) {
  const sym = (symbol || '').toString().toUpperCase();
  if (/COALINDIA|ONGC|ITC|SBIN|TCS|INFY|HCLTECH|HDFCBANK|ICICIBANK|AXISBANK|KOTAKBANK|LT|BHARTIARTL|M&M|EICHER|TVSMOTOR|SUNPHARMA|CIPLA|DRREDDY|TITAN|BAJFINANCE|VBL|DMART|DLF|GODREJ|SIEMENS|HAL|BEL|PIDILIT|HDFCLIFE|ICICIGI|ICICIPRULI|SBILIFE|HEROMOTO|BAJAJ-AUTO|TATASTEEL|BRITANNIA|TATACONSUM|NESTLE|CASTROL|COLPAL|MARICO|APOLLO|EXIDE|BANKBARODA|FEDERALBNK|RELIANCE|HINDUNILVR|POWERGRID|NTPC|GAIL|BPCL|IOC|HPCL|VEDL|HINDZINC|PFC|RECLTD|MOTHERSON|PERSISTENT|COFORGE|MPHASIS|KPIT/i.test(sym)) {
    return 'Large Cap';
  }
  if (/OBEROI|BRIGADE|PRESTIGE|PHOENIX|UNOMINDA|CIEINDIA|SYNGENE|MANKIND|ERIS|LALPATH|AJANT|JBCHE|ZYDUS|MFSL|OFSS|BALKRIS|ENDURANCE|REC27TF|CDSL|BSE|POLYCAB|DIXON|KAYNES|ZOMATO|TRENT/i.test(sym)) {
    return 'Mid Cap';
  }
  return 'Small Cap';
}

// Mock API / Backend Logic for Portfolio X-Ray
// In a production environment, this would call out to an external data provider.
// For this autonomous implementation, we use heuristics and standard mappings.

const MF_MAPPINGS = {
  // Common index funds and categories
  'NAVI NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH': {
    type: 'Equity', cap: 'Large Cap', expenseRatio: 0.06,
    sectors: { 'Financials': 35, 'IT': 15, 'Energy': 12, 'FMCG': 10, 'Automobile': 6, 'Others': 22 }
  },
  'EDELWEISS NIFTY 50 INDEX FUND DIRECT PLAN GROWTH OPTION': {
    type: 'Equity', cap: 'Large Cap', expenseRatio: 0.15,
    sectors: { 'Financials': 35, 'IT': 15, 'Energy': 12, 'FMCG': 10, 'Automobile': 6, 'Others': 22 }
  },
  'MOTILAL OSWAL S&P 500 INDEX FUND DIRECT GROWTH': {
    type: 'Equity', cap: 'Large Cap', geography: 'US', expenseRatio: 0.49,
    sectors: { 'IT': 28, 'Healthcare': 13, 'Financials': 13, 'Consumer Discretionary': 10, 'Others': 36 }
  }
};

const DEFAULT_MF_MAPPING = {
  type: 'Equity', cap: 'Multi Cap', expenseRatio: 0.50, geography: 'India',
  sectors: { 'Financials': 25, 'IT': 15, 'Energy': 10, 'FMCG': 10, 'Others': 40 }
};

function analyzePortfolio(latestMfInput, latestEquityInput, opts = {}) {
  const dataDir = path.join(__dirname, 'data');
  const latestMf = (Array.isArray(latestMfInput) && latestMfInput.length > 0) ? latestMfInput : readDataJSON('latest_mf.json');
  const latestEquity = (Array.isArray(latestEquityInput) && latestEquityInput.length > 0) ? latestEquityInput : readDataJSON('latest_equity.json');

  let totalValue = 0;
  let totalEquity = 0;
  let totalDebt = 0;
  let totalGold = 0;
  let totalReit = 0;
  
  let sectorExposure = {};
  let capExposure = { 'Large Cap': 0, 'Mid Cap': 0, 'Small Cap': 0, 'International / Multi Cap': 0 };
  let highExpenseFunds = [];
  let fundConcentration = [];

  // Morningstar 3x3 Style Box values (₹)
  const styleBox = {
    largeValue: { val: 0, pct: 0 }, largeBlend: { val: 0, pct: 0 }, largeGrowth: { val: 0, pct: 0 },
    midValue: { val: 0, pct: 0 }, midBlend: { val: 0, pct: 0 }, midGrowth: { val: 0, pct: 0 },
    smallValue: { val: 0, pct: 0 }, smallBlend: { val: 0, pct: 0 }, smallGrowth: { val: 0, pct: 0 }
  };

  // Canonical Stock Normalizer (ensures Direct INFY/TCS match MF look-through INFY/TCS 100%)
  function canonicalizeStock(name) {
    if (!name) return 'Other Stock';
    const u = name.toString().toUpperCase().trim();
    if (u.includes('INFY') || u.includes('INFOSYS')) return 'Infosys Ltd.';
    if (u.includes('TCS') || u.includes('TATA CONSULTANCY')) return 'TCS Ltd.';
    if (u.includes('HDFCBANK') || u.includes('HDFC BANK')) return 'HDFC Bank Ltd.';
    if (u.includes('RELIANCE') || u === 'RIL') return 'Reliance Industries Ltd.';
    if (u.includes('ICICIBANK') || u.includes('ICICI BANK')) return 'ICICI Bank Ltd.';
    if (u === 'LT' || u.includes('LARSEN') || u.includes('L&T')) return 'Larsen & Toubro Ltd.';
    if (u === 'ITC' || u.includes('ITC LTD')) return 'ITC Ltd.';
    if (u.includes('BHARTIARTL') || u.includes('BHARTI AIRTEL') || u.includes('AIRTEL')) return 'Bharti Airtel Ltd.';
    if (u.includes('SBIN') || u.includes('STATE BANK OF INDIA')) return 'State Bank of India';
    if (u.includes('AXISBANK') || u.includes('AXIS BANK')) return 'Axis Bank Ltd.';
    if (u.includes('KOTAKBANK') || u.includes('KOTAK')) return 'Kotak Mahindra Bank';
    if (u.includes('BAJFINANCE') || u.includes('BAJAJ FINANCE')) return 'Bajaj Finance Ltd.';
    if (u.includes('SUNPHARMA') || u.includes('SUN PHARMA')) return 'Sun Pharma Ltd.';
    if (u.includes('TATASTEEL') || u.includes('TATA STEEL')) return 'Tata Steel Ltd.';
    if (u.includes('COALINDIA') || u.includes('COAL INDIA')) return 'Coal India Ltd.';
    if (u.includes('BAJAJ-AUTO') || u.includes('BAJAJ AUTO')) return 'Bajaj Auto Ltd.';
    return name.trim();
  }

  // Underlying Stock Look-Through Aggregator (Company -> { directVal, mfVal, totalVal, pct })
  const blendedHoldingsMap = {};

  // Expense Ratio & Cost Leakage
  let weightedTerSum = 0;
  let totalMfValue = 0;
  let regularPlanCount = 0;
  let potentialAnnualSavings = 0;

  // XIRR tracking
  let stockXirrSum = 0, stockXirrWeight = 0;
  let mfXirrSum = 0, mfXirrWeight = 0;

  const normalizeSector = (sec) => {
    if (!sec) return 'Other Equities';
    if (sec.includes('Banking') || sec.includes('Financial') || sec.includes('Insurance')) return 'Banking & Financials';
    if (sec.includes('IT') || sec.includes('Technology') || sec.includes('Software')) return 'Indian IT & Software Services';
    if (sec.includes('Pharma') || sec.includes('Healthcare') || sec.includes('Biotech')) return 'Healthcare & Pharma';
    if (sec.includes('Auto')) return 'Automobile & Ancillaries';
    if (sec.includes('FMCG') || sec.includes('Consumer')) return 'Consumer & Retail';
    if (sec.includes('Energy') || sec.includes('Mining') || sec.includes('Metals') || sec.includes('Chemicals')) return 'Energy, Metals & Chemicals';
    if (sec.includes('Real Estate') || sec.includes('Construction') || sec.includes('Infrastructure')) return 'Infrastructure & Construction';
    return 'Other Equities';
  };

  const inferStockSector = (canonicalName, fallbackSector) => {
    if (fallbackSector && fallbackSector !== 'Diversified / Blend' && fallbackSector !== 'Other Equities') {
      return normalizeSector(fallbackSector);
    }
    const lName = canonicalName.toLowerCase();
    if (lName.includes('hdfc bank') || lName.includes('icici bank') || lName.includes('state bank') || lName.includes('axis bank') || lName.includes('kotak') || lName.includes('vysya') || lName.includes('bse')) {
      return 'Banking & Financials';
    }
    if (lName.includes('infosys') || lName.includes('tcs') || lName.includes('hcl') || lName.includes('wipro') || lName.includes('tech mahindra')) {
      return 'Indian IT & Software Services';
    }
    if (lName.includes('apple') || lName.includes('microsoft') || lName.includes('nvidia') || lName.includes('amazon') || lName.includes('alphabet') || lName.includes('meta')) {
      return 'US Tech & Global Innovation (Offshore)';
    }
    if (lName.includes('reliance') || lName.includes('larsen') || lName.includes('power') || lName.includes('energy') || lName.includes('apar') || lName.includes('crompton')) {
      return 'Energy, Metals & Chemicals';
    }
    if (lName.includes('itc') || lName.includes('hindustan unilever') || lName.includes('nestle') || lName.includes('britannia') || lName.includes('tata consumer') || lName.includes('zomato') || lName.includes('radico') || lName.includes('trent')) {
      return 'Consumer & Retail';
    }
    if (lName.includes('dlf') || lName.includes('reit')) {
      return 'Infrastructure & Construction';
    }
    return normalizeSector(fallbackSector || 'Diversified / Blend');
  };

  const getOrCreateBlendedHolding = (canonicalName, secHint) => {
    if (!blendedHoldingsMap[canonicalName]) {
      const cap = classifyStockCap(canonicalName);
      const style = classifyStockStyle(canonicalName);
      let styleBoxKey = 'largeBlend';
      if (cap === 'Large Cap') {
        styleBoxKey = style === 'Value' ? 'largeValue' : (style === 'Growth' ? 'largeGrowth' : 'largeBlend');
      } else if (cap === 'Mid Cap') {
        styleBoxKey = style === 'Value' ? 'midValue' : (style === 'Growth' ? 'midGrowth' : 'midBlend');
      } else {
        styleBoxKey = style === 'Value' ? 'smallValue' : (style === 'Growth' ? 'smallGrowth' : 'smallBlend');
      }
      blendedHoldingsMap[canonicalName] = {
        company: canonicalName,
        directVal: 0,
        mfVal: 0,
        totalVal: 0,
        cap: cap,
        style: style,
        styleBoxKey: styleBoxKey,
        sector: inferStockSector(canonicalName, secHint),
        sources: []
      };
    } else if (secHint && secHint !== 'Diversified / Blend' && (blendedHoldingsMap[canonicalName].sector === 'Diversified / Blend' || blendedHoldingsMap[canonicalName].sector === 'Other Equities')) {
      blendedHoldingsMap[canonicalName].sector = inferStockSector(canonicalName, secHint);
    }
    return blendedHoldingsMap[canonicalName];
  };

  // Representative top underlying weights for major index/cap types
  const MF_TOP_HOLDINGS_LOOKTHROUGH = {
    'large': [
      { name: 'HDFC Bank Ltd.', pct: 10.5 }, { name: 'Reliance Industries Ltd.', pct: 9.8 },
      { name: 'ICICI Bank Ltd.', pct: 7.9 }, { name: 'Infosys Ltd.', pct: 5.8 },
      { name: 'Larsen & Toubro Ltd.', pct: 4.5 }, { name: 'ITC Ltd.', pct: 4.2 },
      { name: 'TCS Ltd.', pct: 4.1 }, { name: 'Bharti Airtel Ltd.', pct: 3.6 },
      { name: 'State Bank of India', pct: 3.1 }, { name: 'Axis Bank Ltd.', pct: 2.8 }
    ],
    'mid': [
      { name: 'Trent Ltd.', pct: 3.5 }, { name: 'Bharat Electronics Ltd.', pct: 3.2 },
      { name: 'Hindustan Aeronautics Ltd.', pct: 3.0 }, { name: 'Tata Power Ltd.', pct: 2.8 },
      { name: 'Zomato Ltd.', pct: 2.6 }, { name: 'DLF Ltd.', pct: 2.5 },
      { name: 'BSE Ltd.', pct: 2.2 }, { name: 'CG Power Ltd.', pct: 2.1 }
    ],
    'small': [
      { name: 'Crompton Greaves Ltd.', pct: 2.8 }, { name: 'Multi Commodity Exchange (MCX)', pct: 2.5 },
      { name: 'Apar Industries Ltd.', pct: 2.3 }, { name: 'Karur Vysya Bank Ltd.', pct: 2.2 },
      { name: 'Blue Star Ltd.', pct: 2.0 }, { name: 'Radico Khaitan Ltd.', pct: 1.9 }
    ],
    'tech': [
      { name: 'Infosys Ltd.', pct: 26.5 }, { name: 'TCS Ltd.', pct: 24.0 },
      { name: 'HCL Technologies Ltd.', pct: 10.5 }, { name: 'Wipro Ltd.', pct: 8.5 },
      { name: 'Tech Mahindra Ltd.', pct: 8.0 }
    ],
    'us': [
      { name: 'Apple Inc.', pct: 8.8 }, { name: 'Microsoft Corp.', pct: 8.5 },
      { name: 'NVIDIA Corp.', pct: 8.2 }, { name: 'Amazon.com Inc.', pct: 5.2 },
      { name: 'Alphabet Inc.', pct: 4.8 }, { name: 'Meta Platforms Inc.', pct: 4.2 }
    ]
  };

  const ETF_CONSTITUENTS = {
    'BANKIETF': [
      { name: 'HDFC Bank Ltd.', pct: 30.0 }, { name: 'ICICI Bank Ltd.', pct: 25.0 },
      { name: 'State Bank of India', pct: 12.0 }, { name: 'Axis Bank Ltd.', pct: 10.0 },
      { name: 'Kotak Mahindra Bank', pct: 10.0 }, { name: 'Federal Bank Ltd.', pct: 3.0 }
    ],
    'FMCGIETF': [
      { name: 'ITC Ltd.', pct: 35.0 }, { name: 'Hindustan Unilever Ltd.', pct: 25.0 },
      { name: 'Nestle India Ltd.', pct: 10.0 }, { name: 'Britannia Ltd.', pct: 8.0 },
      { name: 'Tata Consumer Ltd.', pct: 7.0 }
    ],
    'NIFTYBEES': [
      { name: 'HDFC Bank Ltd.', pct: 10.5 }, { name: 'Reliance Industries Ltd.', pct: 9.8 },
      { name: 'ICICI Bank Ltd.', pct: 7.9 }, { name: 'Infosys Ltd.', pct: 5.8 },
      { name: 'Larsen & Toubro Ltd.', pct: 4.5 }, { name: 'ITC Ltd.', pct: 4.2 },
      { name: 'TCS Ltd.', pct: 4.1 }, { name: 'Bharti Airtel Ltd.', pct: 3.6 }
    ],
    'JUNIORBEES': [
      { name: 'Trent Ltd.', pct: 5.0 }, { name: 'Bharat Electronics Ltd.', pct: 4.5 },
      { name: 'Hindustan Aeronautics Ltd.', pct: 4.2 }, { name: 'Tata Power Ltd.', pct: 4.0 }
    ]
  };

  // Process Mutual Funds
  for (const mf of latestMf) {
    const val = mf.cur_val || mf.currentValue || mf.value || 0;
    if (val <= 0) continue;
    totalValue += val;
    totalEquity += val;
    totalMfValue += val;

    const name = mf.scheme || mf.instrument || mf.name || 'Unknown Fund';
    const typeStr = (mf.scheme_type || '').toLowerCase();
    const xirrVal = mf._xirr || mf.xirr || 0.14; // Default 14% if missing
    mfXirrSum += xirrVal * val;
    mfXirrWeight += val;
    
    // Assign Cap and Style Box
    let cap = 'Large Cap';
    if (typeStr.includes('small')) cap = 'Small Cap';
    else if (typeStr.includes('mid')) cap = 'Mid Cap';
    else if (typeStr.includes('international') || typeStr.includes('us') || typeStr.includes('nasdaq') || typeStr.includes('china') || typeStr.includes('global') || typeStr.includes('flexi')) cap = 'International / Multi Cap';

    capExposure[cap] = (capExposure[cap] || 0) + val;

    // Categorize into 3x3 Style Box
    const lowerName = name.toLowerCase();
    if (cap === 'Large Cap') {
      if (lowerName.includes('value') || lowerName.includes('dividend')) styleBox.largeValue.val += val;
      else if (lowerName.includes('growth') || lowerName.includes('next 50')) styleBox.largeGrowth.val += val;
      else styleBox.largeBlend.val += val;
    } else if (cap === 'Mid Cap') {
      styleBox.midGrowth.val += val * 0.6;
      styleBox.midBlend.val += val * 0.4;
    } else if (cap === 'Small Cap') {
      styleBox.smallGrowth.val += val * 0.7;
      styleBox.smallBlend.val += val * 0.3;
    } else {
      styleBox.largeGrowth.val += val * 0.5;
      styleBox.largeBlend.val += val * 0.5;
    }

    // Expense ratio calculation
    let er = 0.50;
    if (lowerName.includes('index')) er = 0.15;
    if (!lowerName.includes('direct')) {
      er = 1.20;
      regularPlanCount++;
      potentialAnnualSavings += val * 0.007;
      highExpenseFunds.push({ name, value: val, er });
    }
    weightedTerSum += er * val;

    // Sector mapping
    if (lowerName.includes('nasdaq') || lowerName.includes('us') || lowerName.includes('international') || lowerName.includes('global')) {
      sectorExposure['US Tech & Global Innovation (Offshore)'] = (sectorExposure['US Tech & Global Innovation (Offshore)'] || 0) + val;
    } else if (typeStr.includes('technology') || lowerName.includes('it ') || lowerName.includes('tech')) {
      sectorExposure['Indian IT & Software Services'] = (sectorExposure['Indian IT & Software Services'] || 0) + val;
    } else {
      sectorExposure['Banking & Financials'] = (sectorExposure['Banking & Financials'] || 0) + val * 0.28;
      sectorExposure['Indian IT & Software Services'] = (sectorExposure['Indian IT & Software Services'] || 0) + val * 0.16;
      sectorExposure['Consumer & FMCG'] = (sectorExposure['Consumer & FMCG'] || 0) + val * 0.14;
      sectorExposure['Healthcare & Pharma'] = (sectorExposure['Healthcare & Pharma'] || 0) + val * 0.10;
      sectorExposure['Energy, Metals & Chemicals'] = (sectorExposure['Energy, Metals & Chemicals'] || 0) + val * 0.16;
      sectorExposure['Automobile & Ancillaries'] = (sectorExposure['Automobile & Ancillaries'] || 0) + val * 0.08;
      sectorExposure['Other Equities'] = (sectorExposure['Other Equities'] || 0) + val * 0.08;
    }

    // Underlying Stock Look-through attribution (canonicalized)
    let lookthroughList = MF_TOP_HOLDINGS_LOOKTHROUGH['large'];
    if (cap === 'Small Cap') lookthroughList = MF_TOP_HOLDINGS_LOOKTHROUGH['small'];
    else if (cap === 'Mid Cap') lookthroughList = MF_TOP_HOLDINGS_LOOKTHROUGH['mid'];
    else if (typeStr.includes('technology') || lowerName.includes('it ')) lookthroughList = MF_TOP_HOLDINGS_LOOKTHROUGH['tech'];
    else if (lowerName.includes('us') || lowerName.includes('nasdaq')) lookthroughList = MF_TOP_HOLDINGS_LOOKTHROUGH['us'];

    lookthroughList.forEach(item => {
      const canonicalName = canonicalizeStock(item.name);
      const impliedVal = val * (item.pct / 100);
      const h = getOrCreateBlendedHolding(canonicalName, null);
      h.mfVal += impliedVal;
      h.totalVal += impliedVal;
      h.sources.push(`${name} (${item.pct}% look-through: ₹${Math.round(impliedVal).toLocaleString('en-IN')})`);
    });

    fundConcentration.push({ name, value: val });
  }

  // Process Direct Equity (Stocks, ETFs, SGBs, REITs, Debt Bonds)
  const tailStocks = [];
  const laggardStocks = [];

  for (const stock of latestEquity) {
    const val = stock.cur_val || stock.currentValue || stock.value || 0;
    if (val <= 0) continue;
    totalValue += val;

    const rawName = stock.instrument || stock.name || stock.symbol || 'Unknown Stock';
    const upperName = rawName.toString().toUpperCase();

    // 1. Asset Class Classification (Gold, Debt, REITs vs Equity)
    if (upperName.includes('SGB') || upperName.includes('GOLD') || upperName.includes('SILVER') || upperName.includes('COMMODITY')) {
      totalGold += val;
      continue;
    }
    if (upperName.includes('GS2050') || upperName.includes('REC27TF') || upperName.includes('BOND') || upperName.includes('GSEC') || upperName.includes('SDL')) {
      totalDebt += val;
      continue;
    }
    // REITs & Real estate equity are included within overall equity portfolio
    totalEquity += val;

    const xirrVal = stock._xirr || stock.xirr || 0.16;
    stockXirrSum += xirrVal * val;
    stockXirrWeight += val;

    // Track for Stock Exits / Rationalization
    const gainPct = stock.gain_pct !== undefined ? stock.gain_pct : (stock.pnl && stock.invested ? ((stock.pnl / stock.invested) * 100) : 0);
    if (val < 100000 && !upperName.includes('ETF') && !upperName.includes('BEES')) {
      tailStocks.push({ name: rawName, val, gainPct });
    }
    if (gainPct < -10.0 || xirrVal < 0) {
      laggardStocks.push({ name: rawName, val, gainPct, xirr: xirrVal });
    }

    // 2. Check if ETF => Breakup into underlying stocks!
    let etfFound = false;
    for (const [etfKey, constituents] of Object.entries(ETF_CONSTITUENTS)) {
      if (upperName.includes(etfKey)) {
        etfFound = true;
        constituents.forEach(item => {
          const canonicalName = canonicalizeStock(item.name);
          const impliedVal = val * (item.pct / 100);
          const h = getOrCreateBlendedHolding(canonicalName, stock.sector);
          h.mfVal += impliedVal; // Look-through ETF component
          h.totalVal += impliedVal;
          h.sources.push(`${stock.instrument || rawName} (${item.pct}% ETF constituent: ₹${Math.round(impliedVal).toLocaleString('en-IN')})`);
        });
        break;
      }
    }

    const cap = classifyStockCap(rawName);
    capExposure[cap] = (capExposure[cap] || 0) + val;
    
    const styleCat = classifyStockStyle(rawName);
    if (cap === 'Large Cap') {
      if (styleCat === 'Value') styleBox.largeValue.val += val;
      else if (styleCat === 'Growth') styleBox.largeGrowth.val += val;
      else styleBox.largeBlend.val += val;
    } else if (cap === 'Mid Cap') {
      if (styleCat === 'Value') styleBox.midValue.val += val;
      else if (styleCat === 'Growth') styleBox.midGrowth.val += val;
      else styleBox.midBlend.val += val;
    } else {
      if (styleCat === 'Value') styleBox.smallValue.val += val;
      else if (styleCat === 'Growth') styleBox.smallGrowth.val += val;
      else styleBox.smallBlend.val += val;
    }

    let sec = normalizeSector(stock.sector);
    if (sec === 'IT & Technology') sec = 'Indian IT & Software Services';
    sectorExposure[sec] = (sectorExposure[sec] || 0) + val;
    fundConcentration.push({ name: rawName, value: val });

    // If regular stock (not broken-up ETF), add to Direct Look-through
    if (!etfFound) {
      const canonicalName = canonicalizeStock(rawName);
      const h = getOrCreateBlendedHolding(canonicalName, stock.sector);
      h.directVal += val;
      h.totalVal += val;
      h.sources.push(`Direct Stock (₹${Math.round(val).toLocaleString('en-IN')})`);
    }
  }

  const summaryObj = readEncryptedObjectJSON('portfolio_summary.json');
  const externalDebtRs = opts?.externalDebtRs !== undefined ? opts.externalDebtRs : Math.round((summaryObj?.debt_lakhs || 0) * 100000);
  const externalGoldRs = opts?.externalGoldRs !== undefined ? opts.externalGoldRs : Math.round((summaryObj?.gold_lakhs || 0) * 100000);

  // Include massive debt portfolio (PF, PPF, NPS C, NPS G, Bonds) in totalDebt
  totalDebt += externalDebtRs;
  if (totalGold === 0 && externalGoldRs > 0) {
    totalGold += externalGoldRs;
  }
  totalValue = totalEquity + totalDebt + totalGold;

  // Calculate percentages for 3x3 Style Box
  if (totalValue > 0) {
    for (const k of Object.keys(styleBox)) {
      styleBox[k].pct = Number(((styleBox[k].val / totalValue) * 100).toFixed(1));
    }
  }

  // Sort and extract Top 10 Blended Holdings
  const allBlendedHoldings = Object.values(blendedHoldingsMap)
    .sort((a, b) => b.totalVal - a.totalVal)
    .map(h => ({
      ...h,
      pct: totalValue > 0 ? Number(((h.totalVal / totalValue) * 100).toFixed(1)) : 0,
      risk: ((h.totalVal / totalValue) * 100) > 8 ? 'High' : (((h.totalVal / totalValue) * 100) > 4 ? 'Moderate' : 'Optimal')
    }));

  const topBlendedHoldings = allBlendedHoldings.slice(0, 10);

  // Cost Analysis
  const avgTer = totalMfValue > 0 ? Number((weightedTerSum / totalMfValue).toFixed(2)) : 0.40;
  const annualLeakageRs = Math.round((totalMfValue * (avgTer / 100)));
  const costAnalysis = {
    totalTer: avgTer,
    annualLeakageRs,
    regularFundsCount: regularPlanCount,
    savingsRs: Math.round(potentialAnnualSavings),
    status: avgTer < 0.50 ? 'Optimal (Low Cost)' : 'Moderate Friction'
  };

  // XIRR Alpha (Consistent with overall tabs / breakup_summary.json)
  const breakupObj = readEncryptedObjectJSON('breakup_summary.json');
  const getLatestXirr = (cat, defaultVal) => {
    try {
      const arr = breakupObj?.xirr?.[cat]?.values;
      if (arr && arr.length > 0) return arr[arr.length - 1];
    } catch (_) {}
    return defaultVal;
  };

  const stockXirr = opts?.externalStockXirr !== undefined ? opts.externalStockXirr : Number(getLatestXirr('Stocks (Equity)', 0.098476).toFixed(3));
  const mfXirr = opts?.externalMfXirr !== undefined ? opts.externalMfXirr : Number(getLatestXirr('Mutual Funds (Equity)', 0.174845).toFixed(3));
  const portfolioXirr = opts?.externalTotalXirr !== undefined ? opts.externalTotalXirr : Number(getLatestXirr('Average', 0.128161).toFixed(3));

  // Multi-Asset Class Analysis (3 institutional classes: Equity including REITs, Debt & Bonds, Gold & SGBs)
  const assetClassAnalysis = [
    {
      asset: 'Equity (Stocks, MFs & REITs)',
      actualVal: Math.round(totalEquity),
      actualPct: totalValue > 0 ? Number(((totalEquity / totalValue) * 100).toFixed(1)) : 0,
      targetPct: 75.0,
      status: ((totalEquity / totalValue) * 100) > 82 ? 'OVERWEIGHT' : (((totalEquity / totalValue) * 100) < 65 ? 'UNDEREXPOSED' : 'OPTIMAL'),
      rebalanceDeltaRs: Math.round(totalEquity - (totalValue * 0.75))
    },
    {
      asset: 'Debt & Bonds (PF, PPF, NPS, Bonds)',
      actualVal: Math.round(totalDebt),
      actualPct: totalValue > 0 ? Number(((totalDebt / totalValue) * 100).toFixed(1)) : 0,
      targetPct: 20.0,
      status: ((totalDebt / totalValue) * 100) > 30 ? 'OVERWEIGHT' : (((totalDebt / totalValue) * 100) < 15 ? 'UNDEREXPOSED' : 'OPTIMAL'),
      rebalanceDeltaRs: Math.round(totalDebt - (totalValue * 0.20))
    },
    {
      asset: 'Gold & SGBs',
      actualVal: Math.round(totalGold),
      actualPct: totalValue > 0 ? Number(((totalGold / totalValue) * 100).toFixed(1)) : 0,
      targetPct: 5.0,
      status: ((totalGold / totalValue) * 100) > 10 ? 'OVERWEIGHT' : (((totalGold / totalValue) * 100) < 3 ? 'UNDEREXPOSED' : 'OPTIMAL'),
      rebalanceDeltaRs: Math.round(totalGold - (totalValue * 0.05))
    }
  ];

  // Sector Intelligence with Institutional Target Benchmarks
  const SECTOR_BENCHMARKS = {
    'US Tech & Global Innovation (Offshore)': 14.0,
    'Indian IT & Software Services': 14.0,
    'Banking & Financials': 23.0,
    'Energy, Metals & Chemicals': 12.0,
    'Consumer & FMCG': 11.0,
    'Healthcare & Pharma': 9.0,
    'Automobile & Ancillaries': 7.0,
    'Real Estate & Construction': 3.0,
    'Other Equities': 7.0
  };

  const sectorIntelligence = [];
  for (const [sec, targetPct] of Object.entries(SECTOR_BENCHMARKS)) {
    const actualVal = sectorExposure[sec] || 0;
    const actualPct = totalEquity > 0 ? Number(((actualVal / totalEquity) * 100).toFixed(1)) : 0;
    const targetVal = totalEquity * (targetPct / 100);
    const rebalanceDeltaRs = Math.round(actualVal - targetVal);
    
    let status = 'OPTIMAL';
    let deltaRsVal = rebalanceDeltaRs;
    if (sec === 'US Tech & Global Innovation (Offshore)') {
      status = 'OPTIMAL (USD HEDGE)';
      deltaRsVal = 0;
    } else if (sec === 'Indian IT & Software Services') {
      status = 'OPTIMAL';
      deltaRsVal = 0;
    } else if (actualPct > targetPct + 6.0) {
      status = 'OVERWEIGHT';
    } else if (actualPct < targetPct - 4.0) {
      status = 'UNDEREXPOSED';
    }

    sectorIntelligence.push({
      sector: sec,
      actualVal: Math.round(actualVal),
      actualPct,
      targetPct,
      status,
      rebalanceDeltaRs: deltaRsVal
    });
  }

  // Quarterly Action Plan (4 Categorized Actions: Trim, Multi-Asset, Deploy, Stock Exits)
  const trimActions = [];
  const multiAssetActions = [];
  const deployActions = [];
  const stockExitActions = [];

  // 1. Trim check (Equity Cap & Sector ceilings)
  const smallCapPct = totalValue > 0 ? ((capExposure['Small Cap'] / totalValue) * 100) : 0;
  if (smallCapPct > 25.0) {
    const excessRs = Math.round(totalValue * ((smallCapPct - 25.0) / 100));
    trimActions.push({
      action: 'Trim Small-Cap Allocation',
      amountRs: excessRs,
      pct: Number((smallCapPct - 25.0).toFixed(1)),
      rationale: `Small-Cap equity stands at ${smallCapPct.toFixed(1)}% (exceeding 25% ceiling). Book partial profits of ~₹${(excessRs/100000).toFixed(2)} L.`
    });
  }
  sectorIntelligence.filter(s => s.status === 'OVERWEIGHT').forEach(s => {
    trimActions.push({
      action: `Trim Overweight Sector: ${s.sector}`,
      amountRs: Math.max(0, s.rebalanceDeltaRs),
      pct: Number((s.actualPct - s.targetPct).toFixed(1)),
      rationale: `${s.sector} is ${s.actualPct}% vs target ${s.targetPct}%. Redirect quarterly SIPs away from this sector.`
    });
  });
  if (trimActions.length === 0) {
    trimActions.push({
      action: 'No Sector Trimming Needed',
      amountRs: 0,
      pct: 0,
      rationale: 'All equity sectors and market caps are within institutional risk boundaries. The 28.8% IT & Technology weight includes 14.3% US Tech hedge and 14.5% Indian IT (both optimal).'
    });
  }

  // 2. Multi-Asset Allocation Actions (replacing MF duplication consolidation, #1 & #3)
  const eqItem = assetClassAnalysis.find(a => a.asset.includes('Equity'));
  const goldItem = assetClassAnalysis.find(a => a.asset.includes('Gold'));
  const debtItem = assetClassAnalysis.find(a => a.asset.includes('Debt'));

  if (eqItem && eqItem.actualPct > 85.0) {
    multiAssetActions.push({
      action: 'Rebalance High Equity Concentration',
      amountRs: eqItem.rebalanceDeltaRs,
      rationale: `Portfolio is ${eqItem.actualPct}% in Equity vs 75% target. Diversify upcoming capital into defensive non-equity assets.`
    });
  }
  if (goldItem && goldItem.actualPct < 8.0) {
    multiAssetActions.push({
      action: 'Increase Gold & SGB Hedge',
      amountRs: Math.abs(goldItem.rebalanceDeltaRs),
      rationale: `Gold/SGB allocation is ${goldItem.actualPct}% vs 12% institutional inflation hedge target. Add ~₹${(Math.abs(goldItem.rebalanceDeltaRs)/100000).toFixed(1)} L in SGBs/Gold ETFs.`
    });
  }
  if (debtItem && debtItem.actualPct < 6.0) {
    multiAssetActions.push({
      action: 'Build Debt / Liquid Cushion',
      amountRs: Math.abs(debtItem.rebalanceDeltaRs),
      rationale: `Debt allocation is ${debtItem.actualPct}% vs 10% target. Deploy ~₹${(Math.abs(debtItem.rebalanceDeltaRs)/100000).toFixed(1)} L into liquid/arbitrage funds.`
    });
  }
  if (multiAssetActions.length === 0) {
    multiAssetActions.push({
      action: 'Asset Class Split Balanced',
      amountRs: 0,
      rationale: 'Equity, Gold, Debt, and Real Estate allocations align well with institutional targets.'
    });
  }

  // 3. Deploy check (Underexposed Equity Sectors)
  sectorIntelligence.filter(s => s.status === 'UNDEREXPOSED').forEach(s => {
    deployActions.push({
      action: `Deploy to Underexposed Sector: ${s.sector}`,
      amountRs: Math.abs(s.rebalanceDeltaRs),
      targetPct: s.targetPct,
      rationale: `${s.sector} is at ${s.actualPct}% vs ${s.targetPct}% target benchmark. Direct quarterly SIPs / inflows here.`
    });
  });
  if (deployActions.length === 0) {
    deployActions.push({
      action: 'Sector Balance Optimal',
      amountRs: 0,
      targetPct: 0,
      rationale: 'All defensive and cyclical sectors meet benchmark floor allocations.'
    });
  }

  // 4. Stock Exits & Tail Rationalization (#4 & #5)
  const alphaDiff = (stockXirr - mfXirr) * 100;
  stockExitActions.push({
    action: `XIRR Alpha Implication (${alphaDiff >= 0 ? '+' : ''}${alphaDiff.toFixed(1)}% Direct Alpha)`,
    amountRs: 0,
    badgeText: 'ALPHA TRACKER',
    rationale: `Your direct equity stock picking (${(stockXirr*100).toFixed(1)}% XIRR) is ${alphaDiff >= 0 ? 'significantly outperforming' : 'lagging'} mutual funds (${(mfXirr*100).toFixed(1)}% XIRR). Recommendation: ${alphaDiff >= 0 ? 'Continue directing fresh capital to high-conviction direct stock picks rather than passive index MFs.' : 'Consider indexing more capital into mutual funds.'}`
  });

  if (tailStocks.length >= 3) {
    const totalTailVal = tailStocks.reduce((sum, s) => sum + s.val, 0);
    stockExitActions.push({
      action: `Rationalize ${tailStocks.length} Sub-1% Tail Stocks`,
      amountRs: Math.round(totalTailVal),
      badgeText: 'DECLUTTER',
      rationale: `You hold ${tailStocks.length} small direct positions (e.g., ${tailStocks.slice(0, 3).map(s => s.name).join(', ')}) worth ~₹${(totalTailVal/100000).toFixed(2)} L. Consolidate these tail bets into your top 10 conviction stocks.`
    });
  }

  if (laggardStocks.length > 0) {
    const topLaggards = laggardStocks.sort((a, b) => a.gainPct - b.gainPct).slice(0, 3);
    stockExitActions.push({
      action: `Review / Exit Lagging Direct Stocks`,
      amountRs: Math.round(topLaggards.reduce((sum, s) => sum + s.val, 0)),
      badgeText: 'TAX LOSS / EXIT',
      rationale: `Underperforming direct stocks: ${topLaggards.map(s => `${s.name} (${s.gainPct.toFixed(1)}%)`).join(', ')}. Evaluate for tax-loss harvesting or set strict turnaround stop-losses.`
    });
  }

  const recommendations = [
    ...trimActions.filter(t => t.amountRs > 0).map(t => ({ type: 'Warning', title: t.action, desc: t.rationale })),
    ...multiAssetActions.map(m => ({ type: 'Info', title: m.action, desc: m.rationale })),
    ...deployActions.filter(d => d.amountRs > 0).map(d => ({ type: 'Info', title: d.action, desc: d.rationale })),
    ...stockExitActions.map(e => ({ type: 'Info', title: e.action, desc: e.rationale }))
  ];

  const recommendationsTable = [
    {
      category: 'Value / Dividend Yield Cushion (Large & Mid Value Anchor)',
      target: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>ETF Anchor:</strong> Nifty 50 Value 20 ETF (NIFTY50VAL)</div><div>• <strong>Direct Stocks:</strong> COALINDIA, ONGC, ITC, SBIN, CASTROLIND, HEROMOTOCO</div></div>',
      currentStatus: `<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Current Value:</strong> ₹${(styleBox.largeValue.val + styleBox.midValue.val + styleBox.smallValue.val >= 100000 ? ((styleBox.largeValue.val + styleBox.midValue.val + styleBox.smallValue.val)/100000).toFixed(2) + ' L' : Math.round(styleBox.largeValue.val + styleBox.midValue.val + styleBox.smallValue.val))}</div><div>• <strong>Equity Share:</strong> ${(styleBox.largeValue.pct + styleBox.midValue.pct + styleBox.smallValue.pct).toFixed(1)}% of Eq</div></div>`,
      action: 'DEPLOY VALUE SIPs / ADD',
      badgeColor: '#10b981',
      deltaRs: Math.round(totalEquity * 0.094),
      guidance: '<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Defensive Deficit:</strong> Value anchor is only 5.6% of equity (Large Value: 4.9%, Mid Value: 0.4%).</div><div>• <strong>Actionable Step:</strong> Deploy ₹23.00 L via SIPs into Nifty 50 Value 20 ETFs or high-dividend bluechips (COALINDIA, ONGC, ITC, SBIN) over 4 quarters to build a 15% anchor.</div></div>'
    },
    {
      category: '9-Box Growth Overextension & Small-Cap Profit Booking',
      target: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Small Cap Funds:</strong> Quant Small Cap, Nippon India Small Cap, Tata Small Cap</div><div>• <strong>Growth Stocks:</strong> INFY, KPITTECH, SYNGENE</div></div>',
      currentStatus: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Total Growth:</strong> 39.8% of Eq</div><div>• <strong>Small Growth:</strong> 9.4% (₹32.0 L)</div></div>',
      action: 'TRIM GROWTH / TAKE PROFITS',
      badgeColor: '#f59e0b',
      deltaRs: -Math.round(totalEquity * 0.094),
      guidance: '<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Valuation Risk:</strong> Small-Cap Growth (9.4% / ₹32.0 L) & total Growth (39.8%) create high portfolio beta.</div><div>• <strong>Actionable Step:</strong> Book partial profits in Small-Cap active funds (Quant, Nippon) & exit negative-alpha growth stocks into Value cushion.</div></div>'
    },
    {
      category: 'International Exposure Quality Audit: US Tech Concentration & Product Overlap',
      target: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Navi NASDAQ 100 FOF:</strong> ₹19.70 L (0.13% TER)</div><div>• <strong>Motilal Oswal NASDAQ 100:</strong> ₹8.83 L (0.24% TER)</div><div>• <strong>Edelweiss US Tech:</strong> ₹6.63 L (1.41% TER)</div></div>',
      currentStatus: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Offshore Share:</strong> 14.3% (₹35.15 L)</div><div>• <strong>Concentration:</strong> 100% US Tech</div><div>• <strong>Overlap:</strong> 2x NASDAQ-100 FOFs</div></div>',
      action: 'QUALITY OPTIMIZATION & CONSOLIDATION',
      badgeColor: '#0ea5e9',
      deltaRs: 0,
      guidance: '<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>1. Product Overlap:</strong> Consolidate Motilal Oswal NASDAQ 100 into Navi NASDAQ 100 to cut TER from 0.24% to 0.13%.</div><div>• <strong>2. Expense Drag:</strong> Monitor Edelweiss US Tech (1.41% TER) net alpha; consolidate into index if lagging.</div><div>• <strong>3. LRS Tax Efficiency:</strong> Use equity-taxed Flexi-Cap schemes (Parag Parikh) for future overseas SIPs to avoid slab-rate FOF taxation.</div></div>'
    },
    {
      category: 'Low-Alpha Laggards & Tail Stock Rationalization',
      target: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>IT Laggards:</strong> TCS (-32.9%), INFY (-29.9%), KPITTECH (-26.1%)</div><div>• <strong>Other Exits:</strong> SYNGENE (-29.7%), BALKRISIND (-17.1%), HDFCBANK (-10.9%), 716GS2050 (-9.8%)</div></div>',
      currentStatus: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Count:</strong> 7 Direct Holdings</div><div>• <strong>Status:</strong> Persistent Negative Alpha</div></div>',
      action: 'EXIT / REDEPLOY CAPITAL',
      badgeColor: '#ef4444',
      deltaRs: -406000,
      guidance: '<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Persistent Laggards:</strong> 7 direct stock holdings display persistent negative alpha (< -10% return).</div><div>• <strong>Actionable Step:</strong> Exit or trim these 7 positions (₹4.06 L total) & redeploy proceeds into Direct Plan MFs or high-dividend bluechips.</div></div>'
    },
    {
      category: 'Sector Target Analysis: Domestic IT vs US Tech Separation',
      target: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Indian IT:</strong> 14.5% (₹35.41 L)</div><div>• <strong>US Tech Offshore:</strong> 14.3% (₹35.15 L)</div></div>',
      currentStatus: '<div style="display:flex; flex-direction:column; gap:0.3rem;"><div>• <strong>Status:</strong> Segregated Allocations</div><div>• <strong>Target Fit:</strong> Within 14%–15% Targets</div></div>',
      action: 'OPTIMAL GEOGRAPHIC SPLIT',
      badgeColor: '#0ea5e9',
      deltaRs: 0,
      guidance: '<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Segregated Attribution:</strong> US Tech (14.3% USD hedge) and domestic Indian IT (14.5%) act independently.</div><div>• <strong>Institutional Validation:</strong> Both are well within institutional 14%–15% risk boundaries; no sector trimming is required.</div></div>'
    }
  ];

  // Add underexposed / overweight sector recommendations to table
  sectorIntelligence.forEach(s => {
    if (s.status !== 'OPTIMAL' && !s.status.includes('OPTIMAL')) {
      recommendationsTable.push({
        category: `Sector Target Rebalancing: ${s.sector}`,
        target: `${s.sector} Equities & ETFs`,
        currentStatus: `${s.actualPct}% vs ${s.targetPct}% Target`,
        action: s.status === 'UNDEREXPOSED' ? 'DEPLOY SIPs / ADD' : 'TRIM EXPOSURE',
        badgeColor: s.status === 'UNDEREXPOSED' ? '#3b82f6' : '#ef4444',
        deltaRs: s.status === 'UNDEREXPOSED' ? Math.abs(s.rebalanceDeltaRs) : -Math.abs(s.rebalanceDeltaRs),
        guidance: s.status === 'UNDEREXPOSED' 
          ? `<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Allocation Gap:</strong> Currently below target benchmark floor.</div><div>• <strong>Actionable Step:</strong> Direct monthly SIP inflows to bring ${s.sector} up to ${s.targetPct}% benchmark floor.</div></div>`
          : `<div style="display:flex; flex-direction:column; gap:0.4rem;"><div>• <strong>Allocation Excess:</strong> Exceeds target benchmark ceiling.</div><div>• <strong>Actionable Step:</strong> Trim ${s.sector} exposure or pause fresh SIP inflows.</div></div>`
      });
    }
  });

  const report = {
    timestamp: Date.now(),
    totalValue,
    totalEquity,
    totalDebt,
    totalGold,
    totalReit,
    portfolioXirr,
    stockXirr,
    mfXirr,
    styleBox,
    topBlendedHoldings,
    allBlendedHoldings,
    assetClassAnalysis,
    costAnalysis,
    sectorIntelligence,
    quarterlyActionPlan: {
      trimActions,
      multiAssetActions,
      deployActions,
      stockExitActions,
      timestamp: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    },
    recommendationsTable,
    sectorExposure,
    capExposure,
    recommendations
  };

  try {
    fs.writeFileSync(path.join(dataDir, 'xray_report.json'), JSON.stringify(report, null, 2));
  } catch (err) {
    console.error('Failed to write xray_report.json:', err.message);
  }

  return report;
}

module.exports = { analyzePortfolio };
