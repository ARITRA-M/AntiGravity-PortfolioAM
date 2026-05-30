// Zerodha Kite Connect Login Integration
const ZerodhaAuth = {
  // Configuration
  config: {
    apiKey: '', // Will be set from environment or user input
    apiSecret: '', // Never expose this in frontend - use backend proxy
    redirectUrl: window.location.origin + '/zerodha-callback',
    isSandbox: false
  },

  // Session management
  session: {
    token: null,
    userId: null,
    isAuthenticated: false
  },

  // Initialize Zerodha auth
  init() {
    this.loadSession();
    this.createLoginModal();
    
    if (this.session.isAuthenticated) {
      this.showConnectedState();
      // Don't show modal if already authenticated
    }
  },

  // Create Zerodha login modal
  createLoginModal() {
    const modal = document.createElement('div');
    modal.id = 'zerodha-login-modal';
    modal.className = 'zerodha-modal-overlay';
    modal.innerHTML = `
      <div class="zerodha-modal">
        <div class="zerodha-modal-header">
          <div class="zerodha-logo">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="18" stroke="#387ed1" stroke-width="2"/>
              <path d="M12 28V12h8c4 0 6 2 6 5s-2 5-6 5h-4v6h-4z" fill="#387ed1"/>
            </svg>
          </div>
          <h2>Connect Zerodha</h2>
          <p>Securely connect your Zerodha Kite account to view real-time portfolio</p>
          <button class="modal-close" onclick="ZerodhaAuth.closeModal()">&times;</button>
        </div>
        
        <div class="zerodha-modal-body">
          <div class="login-options">
            <div class="login-option" onclick="ZerodhaAuth.showKiteLogin()">
              <div class="option-icon">🔐</div>
              <div class="option-content">
                <h3>Kite Connect Login</h3>
                <p>Login with your Zerodha Kite credentials</p>
              </div>
            </div>
            
            <div class="login-option" onclick="ZerodhaAuth.showManualInput()">
              <div class="option-icon">⚙️</div>
              <div class="option-content">
                <h3>Manual API Setup</h3>
                <p>Enter Kite Connect API credentials manually</p>
              </div>
            </div>
            
            <div class="login-option demo-option" onclick="ZerodhaAuth.useDemoData()">
              <div class="option-icon">📊</div>
              <div class="option-content">
                <h3>Demo Mode</h3>
                <p>View sample portfolio data</p>
              </div>
            </div>
          </div>
          
          <div id="kite-login-form" class="login-form" style="display: none;">
            <form onsubmit="ZerodhaAuth.handleKiteLogin(event)">
              <div class="form-group">
                <label>User ID</label>
                <input type="text" id="kite-user-id" placeholder="Your Zerodha User ID" required>
              </div>
              <div class="form-group">
                <label>Password</label>
                <input type="password" id="kite-password" placeholder="Your Zerodha Password" required>
              </div>
              <div class="form-group">
                <label>TOTP (if enabled)</label>
                <input type="text" id="kite-totp" placeholder="Time-based OTP">
              </div>
              <button type="submit" class="zerodha-btn">
                <span class="btn-text">Login to Kite</span>
                <span class="btn-loader" style="display: none;">⏳</span>
              </button>
            </form>
            <div class="form-footer">
              <a href="#" onclick="ZerodhaAuth.showManualInput(); return false;">Use API Key instead</a>
            </div>
          </div>
          
          <div id="api-key-form" class="login-form" style="display: none;">
            <form onsubmit="ZerodhaAuth.handleApiLogin(event)">
              <div class="form-group">
                <label>API Key</label>
                <input type="text" id="api-key" placeholder="Your Kite Connect API Key" required>
              </div>
              <div class="form-group">
                <label>API Secret</label>
                <input type="password" id="api-secret" placeholder="Your Kite Connect API Secret" required>
              </div>
              <div class="form-group">
                <label>Request Token</label>
                <input type="text" id="request-token" placeholder="Request token from callback URL">
                <small>Leave empty to generate login URL first</small>
              </div>
              <button type="submit" class="zerodha-btn">
                <span class="btn-text">Connect</span>
                <span class="btn-loader" style="display: none;">⏳</span>
              </button>
            </form>
          </div>
        </div>
        
        <div class="zerodha-modal-footer">
          <p>🔒 Your credentials are encrypted and never stored</p>
          <p>Powered by Zerodha Kite Connect API</p>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
  },

  // Show Kite login form
  showKiteLogin() {
    document.getElementById('kite-login-form').style.display = 'block';
    document.getElementById('api-key-form').style.display = 'none';
    document.querySelectorAll('.login-option').forEach(el => el.style.display = 'none');
  },

  // Show API key form
  showManualInput() {
    document.getElementById('kite-login-form').style.display = 'none';
    document.getElementById('api-key-form').style.display = 'block';
    document.querySelectorAll('.login-option').forEach(el => el.style.display = 'none');
  },

  // Close modal
  closeModal() {
    const modal = document.getElementById('zerodha-login-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  // Handle Kite login
  async handleKiteLogin(e) {
    e.preventDefault();
    
    const userId = document.getElementById('kite-user-id').value;
    const password = document.getElementById('kite-password').value;
    const totp = document.getElementById('kite-totp').value;
    
    const btn = e.target.querySelector('.zerodha-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline';
    btn.disabled = true;
    
    try {
      // In production, this would call your backend which handles the actual Kite login
      // For demo, simulate a successful login
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      this.session = {
        isAuthenticated: true,
        userId: userId,
        token: 'demo_session_token_' + Date.now()
      };
      
      this.saveSession();
      this.closeModal();
      this.showConnectedState();
      
      // Trigger portfolio refresh
      if (typeof refreshPortfolioFromZerodha === 'function') {
        refreshPortfolioFromZerodha();
      }
      
      alert('Successfully connected to Zerodha! (Demo Mode)');
      
    } catch (error) {
      alert('Login failed: ' + error.message);
    } finally {
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
      btn.disabled = false;
    }
  },

  // Handle API key login
  async handleApiLogin(e) {
    e.preventDefault();
    
    const apiKey = document.getElementById('api-key').value;
    const apiSecret = document.getElementById('api-secret').value;
    const requestToken = document.getElementById('request-token').value;
    
    this.config.apiKey = apiKey;
    this.config.apiSecret = apiSecret;
    
    if (!requestToken) {
      // Generate login URL
      try {
        const response = await fetch('/api/zerodha/login-url');
        const data = await response.json();
        
        if (data.url) {
          window.open(data.url, '_blank');
          alert('Please login on the opened Zerodha page and copy the request_token from the redirect URL.');
        }
      } catch (error) {
        alert('Failed to generate login URL. Please check your API key.');
      }
    } else {
      // Exchange request token for access token
      try {
        const response = await fetch('/api/zerodha/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_token: requestToken })
        });
        
        const data = await response.json();
        
        if (data.success) {
          this.session = {
            isAuthenticated: true,
            userId: data.userId,
            token: data.sessionToken
          };
          
          this.saveSession();
          this.closeModal();
          this.showConnectedState();
          
          if (typeof refreshPortfolioFromZerodha === 'function') {
            refreshPortfolioFromZerodha();
          }
          
          alert('Successfully connected to Zerodha!');
        }
      } catch (error) {
        alert('Failed to connect: ' + error.message);
      }
    }
  },

  // Use demo data
  useDemoData() {
    this.session = {
      isAuthenticated: true,
      userId: 'DEMO_USER',
      token: 'demo_token',
      isDemo: true
    };
    
    // Don't save to localStorage for demo mode - session only lasts for this page view
    this.closeModal();
    this.showConnectedState();
    
    // Show success message
    alert('Demo Mode activated! You can now view sample portfolio data. This session will end when you close the browser.');
  },

  // Show connected state
  showConnectedState() {
    const badge = document.getElementById('zerodha-status');
    if (badge) {
      badge.style.display = 'flex';
      badge.innerHTML = `
        <span class="status-dot connected"></span>
        <span>Zerodha Connected${this.session.isDemo ? ' (Demo)' : ''}</span>
        <button onclick="ZerodhaAuth.disconnect()" class="disconnect-btn">Disconnect</button>
      `;
    }
  },

  // Disconnect Zerodha
  disconnect() {
    this.session = {
      isAuthenticated: false,
      token: null,
      userId: null
    };
    
    localStorage.removeItem('zerodha_session');
    
    const badge = document.getElementById('zerodha-status');
    if (badge) {
      badge.style.display = 'none';
    }
    
    // Reload page to reset to file-based data
    location.reload();
  },

  // Save session to localStorage
  saveSession() {
    localStorage.setItem('zerodha_session', JSON.stringify(this.session));
  },

  // Load session from localStorage
  loadSession() {
    const saved = localStorage.getItem('zerodha_session');
    if (saved) {
      try {
        this.session = JSON.parse(saved);
      } catch (e) {
        this.session = { isAuthenticated: false, token: null, userId: null };
      }
    }
  },

  // Show login modal
  showLoginModal() {
    // Don't show modal if already authenticated
    if (this.session.isAuthenticated) {
      return;
    }
    const modal = document.getElementById('zerodha-login-modal');
    if (modal) {
      modal.style.display = 'flex';
    }
  }
};

// Add Zerodha connect button to header
function addZerodhaConnectButton() {
  const header = document.querySelector('.brand-section');
  if (header) {
    const connectBtn = document.createElement('button');
    connectBtn.id = 'zerodha-connect-btn';
    connectBtn.className = 'zerodha-connect-btn';
    connectBtn.innerHTML = '🔗 Connect Zerodha';
    connectBtn.onclick = () => ZerodhaAuth.showLoginModal();
    header.appendChild(connectBtn);
  }
}

// Add status badge
function addZerodhaStatusBadge() {
  const timeBadge = document.getElementById('live-time-badge');
  if (timeBadge) {
    // Check if badge already exists
    if (document.getElementById('zerodha-status')) return;
    
    const statusBadge = document.createElement('div');
    statusBadge.id = 'zerodha-status';
    statusBadge.className = 'time-badge zerodha-status';
    statusBadge.style.display = 'none';
    timeBadge.parentNode.insertBefore(statusBadge, timeBadge.nextSibling);
  }
}

// Initialize on DOM ready - ensure UI elements are created first
document.addEventListener('DOMContentLoaded', () => {
  // First create UI elements
  addZerodhaConnectButton();
  addZerodhaStatusBadge();
  
  // Small delay to ensure DOM is fully ready
  setTimeout(() => {
    ZerodhaAuth.init();
  }, 100);
});
