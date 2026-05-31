// Local-only unlock for the static portfolio dashboard.
const AUTH_CONFIG = {
  password: 'Portfolio2026!',
  storageKey: 'portfolio_unlocked',
  expiryKey: 'portfolio_unlock_expires_at',
  tokenExpiry: 7 * 24 * 60 * 60 * 1000
};

function isAuthenticated() {
  if (localStorage.getItem(AUTH_CONFIG.storageKey) !== 'true') return false;

  const expiresAt = Number(localStorage.getItem(AUTH_CONFIG.expiryKey) || 0);
  if (expiresAt && Date.now() > expiresAt) {
    clearAuthToken();
    return false;
  }

  return true;
}

function getAuthHeaders() {
  return {};
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_CONFIG.storageKey);
  localStorage.removeItem(AUTH_CONFIG.expiryKey);
}

function unlockApp(overlay) {
  localStorage.setItem(AUTH_CONFIG.storageKey, 'true');
  localStorage.setItem(AUTH_CONFIG.expiryKey, String(Date.now() + AUTH_CONFIG.tokenExpiry));

  overlay.remove();
  document.body.style.overflow = '';

  const appContainer = document.querySelector('.app-container');
  if (appContainer) appContainer.style.display = '';

  if (typeof loadData === 'function') loadData();
}

function showLogin() {
  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-icon">🔐</div>
        <h2>Portfolio Dashboard</h2>
        <p class="auth-subtitle">Unlock this browser session to view your local portfolio dashboard.</p>
        <form id="auth-form">
          <input type="password" id="auth-password" placeholder="Dashboard password" autocomplete="current-password" />
          <p id="auth-error" class="auth-error"></p>
          <button type="submit" class="auth-btn">Unlock Dashboard</button>
        </form>
        <p class="auth-note">This is a local browser unlock, not a brokerage login.</p>
      </div>
    </div>
  `;
  document.body.insertBefore(overlay, document.body.firstChild);

  document.getElementById('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const password = document.getElementById('auth-password').value;
    const error = document.getElementById('auth-error');

    if (password !== AUTH_CONFIG.password) {
      error.textContent = 'Incorrect dashboard password.';
      return;
    }

    error.textContent = '';
    unlockApp(overlay);
  });

  document.body.style.overflow = 'hidden';
}

document.addEventListener('DOMContentLoaded', () => {
  if (!isAuthenticated()) {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.style.display = 'none';
    showLogin();
  }
});
