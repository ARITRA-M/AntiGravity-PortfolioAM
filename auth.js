// Simple Client-Side Authentication for Portfolio Analytics
const AUTH_CONFIG = {
  password: 'Portfolio2026!', // Default password - change before deployment
  storageKey: 'portfolio_auth_token',
  tokenExpiry: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// Check if user is authenticated
function isAuthenticated() {
  const token = localStorage.getItem(AUTH_CONFIG.storageKey);
  if (!token) return false;
  
  try {
    const data = JSON.parse(atob(token));
    if (Date.now() > data.expiry) {
      localStorage.removeItem(AUTH_CONFIG.storageKey);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Generate auth token
function generateToken() {
  const expiry = Date.now() + AUTH_CONFIG.tokenExpiry;
  return btoa(JSON.stringify({ expiry }));
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
  
  document.getElementById('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const password = document.getElementById('auth-password').value;
    
    if (password === AUTH_CONFIG.password) {
      localStorage.setItem(AUTH_CONFIG.storageKey, generateToken());
      overlay.remove();
      document.body.style.overflow = '';
      // Initialize the app
      if (typeof loadData === 'function') {
        loadData();
      }
    } else {
      document.getElementById('auth-error').textContent = 'Incorrect password. Please try again.';
    }
  });
  
  document.body.style.overflow = 'hidden';
}

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', () => {
  // Remove the original DOMContentLoaded listener that calls loadData
  // We'll call it after authentication
  
  if (!isAuthenticated()) {
    // Hide the app content
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      appContainer.style.display = 'none';
    }
    showLogin();
  }
});

// Override the original loadData to be called after auth
const originalLoadData = window.loadData;
window.loadData = function() {
  if (isAuthenticated()) {
    if (originalLoadData) originalLoadData();
  }
};