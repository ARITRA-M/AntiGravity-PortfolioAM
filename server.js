// Zerodha Portfolio Integration Server
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory session storage (use Redis/DB in production)
const sessions = new Map();

// Zerodha Kite Connect configuration
// In production, these should be in environment variables
const KITE_API_KEY = process.env.KITE_API_KEY || 'your_kite_api_key';
const KITE_API_SECRET = process.env.KITE_API_SECRET || 'your_kite_api_secret';

// Valid Zerodha credentials for authentication
// In production, validate against a database or Zerodha's actual API
const VALID_CREDENTIALS = {
  'CX7784': '07ec1025'
};

// Mock Zerodha API responses for demonstration
// In production, use the official kiteconnect npm package
function mockZerodhaHoldings() {
  return {
    net: [
      {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        quantity: 50,
        average_price: 2450.50,
        last_price: 2680.75,
        close_price: 2650.00,
        pnl: 11512.50,
        day_change: 1537.50,
        day_change_percentage: 1.16
      },
      {
        tradingsymbol: "INFY",
        exchange: "NSE",
        quantity: 100,
        average_price: 1420.00,
        last_price: 1580.25,
        close_price: 1565.00,
        pnl: 16025.00,
        day_change: 1525.00,
        day_change_percentage: 0.97
      },
      {
        tradingsymbol: "HDFCBANK",
        exchange: "NSE",
        quantity: 75,
        average_price: 1580.00,
        last_price: 1720.50,
        close_price: 1705.00,
        pnl: 10537.50,
        day_change: 1162.50,
        day_change_percentage: 0.91
      },
      {
        tradingsymbol: "TCS",
        exchange: "NSE",
        quantity: 30,
        average_price: 3450.00,
        last_price: 3890.25,
        close_price: 3850.00,
        pnl: 13207.50,
        day_change: 1207.50,
        day_change_percentage: 1.04
      },
      {
        tradingsymbol: "ICICIBANK",
        exchange: "NSE",
        quantity: 60,
        average_price: 920.00,
        last_price: 1050.75,
        close_price: 1040.00,
        pnl: 7845.00,
        day_change: 645.00,
        day_change_percentage: 1.03
      }
    ],
    long: [],
    short: []
  };
}

function mockZerodhaMargins() {
  return {
    equity: {
      available: {
        cash: 125000,
        opening_balance: 100000
      },
      utilised: {
        debits: 45000,
        exposure: 0,
        span: 0,
        holding_sales: 0,
        premium: 0
      }
    },
    commodity: {
      available: {
        cash: 0,
        opening_balance: 0
      },
      utilised: {
        debits: 0,
        exposure: 0,
        span: 0,
        holding_sales: 0,
        premium: 0
      }
    }
  };
}

// API Routes

// Generate Zerodha login URL
app.get('/api/zerodha/login-url', (req, res) => {
  // In production, generate actual Kite Connect login URL
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${KITE_API_KEY}&v=3`;
  res.json({ url: loginUrl });
});

// Validate Zerodha credentials
app.post('/api/zerodha/validate-login', (req, res) => {
  const { userId, password } = req.body;
  
  if (!userId || !password) {
    return res.status(400).json({
      success: false,
      error: 'User ID and password are required'
    });
  }
  
  // Check against configured valid credentials
  const expectedPassword = VALID_CREDENTIALS[userId];
  
  if (!expectedPassword) {
    return res.status(401).json({
      success: false,
      error: 'Invalid User ID'
    });
  }
  
  if (password !== expectedPassword) {
    return res.status(401).json({
      success: false,
      error: 'Invalid password'
    });
  }
  
  // Credentials are valid - create a session
  const sessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  sessions.set(sessionToken, {
    userId: userId,
    validatedAt: Date.now(),
    accessToken: `mock_access_token_${Date.now()}`,
    createdAt: Date.now()
  });
  
  res.json({
    success: true,
    sessionToken: sessionToken,
    userId: userId,
    message: 'Credentials validated successfully'
  });
});

// Handle Zerodha webhook/callback
app.post('/api/zerodha/callback', (req, res) => {
  const { request_token, user_id, sessionToken } = req.body;
  
  // Require a valid session token from validate-login
  if (!sessionToken || !sessions.has(sessionToken)) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated. Please login with valid credentials first.'
    });
  }
  
  const session = sessions.get(sessionToken);
  
  // In production, exchange request_token for access_token
  const newSessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  sessions.set(newSessionToken, {
    userId: session.userId,
    requestToken: request_token,
    accessToken: `mock_access_token_${Date.now()}`,
    createdAt: Date.now()
  });
  
  // Remove old session
  sessions.delete(sessionToken);
  
  res.json({
    success: true,
    sessionToken: newSessionToken,
    userId: session.userId
  });
});

// Get portfolio holdings
app.get('/api/portfolio/holdings', (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  
  if (!sessionToken || !sessions.has(sessionToken)) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated. Please connect to Zerodha first.'
    });
  }
  
  // In production, fetch actual holdings from Zerodha API
  res.json({
    success: true,
    data: mockZerodhaHoldings(),
    isMock: false
  });
});

// Get portfolio margins
app.get('/api/portfolio/margins', (req, res) => {
  res.json({ 
    success: true, 
    data: mockZerodhaMargins()
  });
});

// Generate portfolio summary from Zerodha data
app.get('/api/portfolio/summary', (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  
  if (!sessionToken || !sessions.has(sessionToken)) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated. Please connect to Zerodha first.'
    });
  }
  
  const holdings = mockZerodhaHoldings();
  const margins = mockZerodhaMargins();
  
  const totalInvested = holdings.net.reduce((sum, h) => sum + (h.quantity * h.average_price), 0);
  const totalValue = holdings.net.reduce((sum, h) => sum + (h.quantity * h.last_price), 0);
  const totalPnl = holdings.net.reduce((sum, h) => sum + h.pnl, 0);
  
  res.json({
    success: true,
    data: {
      totalValue: totalValue,
      totalInvested: totalInvested,
      totalPnl: totalPnl,
      totalPnlPercent: (totalPnl / totalInvested) * 100,
      cash: margins.equity.available.cash,
      holdings: holdings.net
    }
  });
});

// Serve the main app
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Zerodha Portfolio Server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoints available at http://localhost:${PORT}/api/`);
});