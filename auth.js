// Simple Client-Side Authentication for Portfolio Analytics
const AUTH_CONFIG = {
  storageKey: 'portfolio_auth_token',
  expiryKey: 'portfolio_auth_expires_at',
  modeKey: 'portfolio_auth_mode',
  localDemoPrefix: 'local_demo_',
  localDemoExpiry: 7 * 24 * 60 * 60 * 1000
};

// Check if user is authenticated
function isAuthenticated() {
  const token = localStorage.getItem(AUTH_CONFIG.storageKey);
  if (!token) return false;

  const expiresAt = Number(localStorage.getItem(AUTH_CONFIG.expiryKey) || 0);
  if (expiresAt && Date.now() > expiresAt) {
    clearAuthToken();
    return false;
  }

  return true;
}

function getAuthToken() {
  return localStorage.getItem(AUTH_CONFIG.storageKey) || '';
}

function getAuthHeaders() {
  const token = getAuthToken();
  if (isLocalDemoSession()) return {};
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_CONFIG.storageKey);
  localStorage.removeItem(AUTH_CONFIG.expiryKey);
  localStorage.removeItem(AUTH_CONFIG.modeKey);
}

function isLocalDemoSession() {
  return localStorage.getItem(AUTH_CONFIG.modeKey) === 'local-demo' ||
    getAuthToken().startsWith(AUTH_CONFIG.localDemoPrefix);
}

function startLocalDemoSession() {
  const expiresAt = Date.now() + AUTH_CONFIG.localDemoExpiry;
  localStorage.setItem(AUTH_CONFIG.storageKey, AUTH_CONFIG.localDemoPrefix + Date.now());
  localStorage.setItem(AUTH_CONFIG.expiryKey, String(expiresAt));
  localStorage.setItem(AUTH_CONFIG.modeKey, 'local-demo');
}

function unlockApp(overlay) {
  overlay.remove();
  document.body.style.overflow = '';

  const appContainer = document.querySelector('.app-container');
  if (appContainer) {
    appContainer.style.display = '';
  }

  if (typeof loadData === 'function') {
    loadData();
  }
}

async function verifyAuthSession() {
  if (!isAuthenticated()) return false;
  if (isLocalDemoSession()) return true;

  try {
    const response = await fetch('/api/auth/session', {
      headers: getAuthHeaders()
    });
    const data = await response.json();
    if (!data.success) {
      clearAuthToken();
      return false;
    }
    if (data.expiresAt) {
      localStorage.setItem(AUTH_CONFIG.expiryKey, String(data.expiresAt));
    }
    return true;
  } catch (error) {
    return isAuthenticated();
  }
}

async function readJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    await response.text();
    const error = new Error('API_UNAVAILABLE');
    error.code = 'API_UNAVAILABLE';
    throw error;
  }
  return response.json();
}

// Show login overlay
function showLogin() {
  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-icon">🔒</div>
        <h2>Portfolio Analytics</h2>
        <p class="auth-subtitle">Enter password to access your portfolio</p>
        <form id="auth-form">
          <input type="password" id="auth-password" placeholder="Enter password" autocomplete="current-password" />
          <p id="auth-error" class="auth-error"></p>
          <button type="submit" class="auth-btn">Unlock Portfolio</button>
        </form>
        <p class="auth-note">Session expires in 7 days</p>
      </div>
    </div>
  `;
  document.body.insertBefore(overlay, document.body.firstChild);
  
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('auth-password').value;
    const error = document.getElementById('auth-error');
    const button = e.target.querySelector('.auth-btn');
    
    button.disabled = true;
    error.textContent = '';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await readJsonResponse(response);

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Incorrect password');
      }

      localStorage.setItem(AUTH_CONFIG.storageKey, data.token);
      localStorage.setItem(AUTH_CONFIG.expiryKey, String(data.expiresAt || 0));
      localStorage.setItem(AUTH_CONFIG.modeKey, 'server');
      unlockApp(overlay);
    } catch (err) {
      if (err.code === 'API_UNAVAILABLE' || err instanceof TypeError) {
        startLocalDemoSession();
        unlockApp(overlay);
      } else {
        error.textContent = err.message || 'Unable to unlock portfolio.';
      }
    } finally {
      button.disabled = false;
    }
  });
  
  document.body.style.overflow = 'hidden';
}

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', () => {
  if (!isAuthenticated()) {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      appContainer.style.display = 'none';
    }
    showLogin();
  }
});
