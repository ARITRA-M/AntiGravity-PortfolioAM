// Authentication for Portfolio Dashboard
// - On local server: uses server-side session auth (/api/session, /api/login)
// - On GitHub Pages: uses client-side localStorage-based auth with password check

let authState = false;

// Detect if running on GitHub Pages (no local backend server)
// Uses the global flag set in index.html for consistency
const IS_GITHUB_PAGES = window.__isGitHubPages === true;

// Client-side auth config (only used on GitHub Pages)
const CLIENT_AUTH_CONFIG = {
  storageKey: 'portfolio_auth_token',
  tokenExpiry: 7 * 24 * 60 * 60 * 1000 // 7 days
};

function isAuthenticated() {
  return authState;
}

function getAuthHeaders() {
  return {};
}

function clearAuthToken() {
  authState = false;
  if (IS_GITHUB_PAGES) {
    localStorage.removeItem(CLIENT_AUTH_CONFIG.storageKey);
  }
  if (typeof PortfolioCrypto !== 'undefined') PortfolioCrypto.clearKey();
}

// Fetch the reference data file used to verify the password (it is an
// AES-GCM envelope after scripts/encrypt-data.js has been run).
async function fetchVerificationEnvelope() {
  const resp = await fetch('data/breakup_summary.json?auth=' + Date.now(), { credentials: 'same-origin' });
  if (!resp.ok) return null;
  try { return await resp.json(); } catch (_) { return null; }
}

// --- Client-side auth helpers (GitHub Pages) ---

function generateClientToken() {
  const expiry = Date.now() + CLIENT_AUTH_CONFIG.tokenExpiry;
  return btoa(JSON.stringify({ expiry }));
}

function isClientAuthenticated() {
  const token = localStorage.getItem(CLIENT_AUTH_CONFIG.storageKey);
  if (!token) return false;
  try {
    const data = JSON.parse(atob(token));
    if (Date.now() > data.expiry) {
      localStorage.removeItem(CLIENT_AUTH_CONFIG.storageKey);
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// --- Server-side auth helpers (local dev) ---

async function checkSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    authState = response.ok;
    return authState;
  } catch (_) {
    authState = false;
    return false;
  }
}

async function unlockApp(overlay, password) {
  const response = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });

  if (!response.ok) {
    throw new Error('Incorrect dashboard password.');
  }

  // Derive the data-decryption key from the same password (data files are
  // encrypted at rest; the server only gates access, it can't decrypt them).
  try {
    const envelope = await fetchVerificationEnvelope();
    if (envelope && PortfolioCrypto.isEnvelope(envelope)) {
      await PortfolioCrypto.unlockWithPassword(password, envelope);
    }
  } catch (e) {
    throw new Error('Login OK, but data files are encrypted with a different password.');
  }

  authState = true;
  overlay.remove();
  document.body.style.overflow = '';

  const appContainer = document.querySelector('.app-container');
  if (appContainer) appContainer.style.display = '';

  if (typeof loadData === 'function') loadData();
}

// --- Client-side unlock (GitHub Pages) ---

async function unlockAppClient(overlay, password) {
  // The password is verified by decrypting the data files — there is no
  // stored password to compare against (and nothing useful to steal: the
  // files on GitHub Pages are AES-256-GCM ciphertext).
  const envelope = await fetchVerificationEnvelope();
  if (!envelope) {
    throw new Error('Could not load portfolio data to verify the password.');
  }
  if (PortfolioCrypto.isEnvelope(envelope)) {
    await PortfolioCrypto.unlockWithPassword(password, envelope); // throws if wrong
  } else {
    console.warn('Data files are not encrypted yet — run scripts/encrypt-data.js and push.');
  }

  localStorage.setItem(CLIENT_AUTH_CONFIG.storageKey, generateClientToken());
  authState = true;
  overlay.remove();
  document.body.style.overflow = '';

  const appContainer = document.querySelector('.app-container');
  if (appContainer) appContainer.style.display = '';

  if (typeof loadData === 'function') loadData();
}

// --- Login overlay ---

function showLogin(message = '') {
  if (document.getElementById('auth-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-icon">Lock</div>
        <h2>Portfolio Dashboard</h2>
        <p class="auth-subtitle">${IS_GITHUB_PAGES ? 'Enter password to access your portfolio dashboard.' : 'Unlock this server session to view your portfolio dashboard.'}</p>
        <form id="auth-form">
          <input type="password" id="auth-password" placeholder="Dashboard password" autocomplete="current-password" />
          <p id="auth-error" class="auth-error">${escapeAuthHtml(message)}</p>
          <button type="submit" class="auth-btn">Unlock Dashboard</button>
        </form>
        <p class="auth-note">${IS_GITHUB_PAGES ? 'Session expires in 7 days.' : 'The portfolio files are served only after this session is unlocked.'}</p>
      </div>
    </div>
  `;
  document.body.insertBefore(overlay, document.body.firstChild);

  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const passwordInput = document.getElementById('auth-password');
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    const error = document.getElementById('auth-error');

    error.textContent = '';
    submitButton.disabled = true;
    submitButton.textContent = 'Unlocking...';

    try {
      if (IS_GITHUB_PAGES) {
        await unlockAppClient(overlay, passwordInput.value);
      } else {
        await unlockApp(overlay, passwordInput.value);
      }
    } catch (err) {
      error.textContent = err.message || 'Unlock failed.';
      passwordInput.select();
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Unlock Dashboard';
    }
  });

  document.body.style.overflow = 'hidden';
}

function escapeAuthHtml(value) {
  return String(value || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&' + '#39;');
}

document.addEventListener('DOMContentLoaded', async () => {
  const appContainer = document.querySelector('.app-container');
  if (appContainer) appContainer.style.display = 'none';

  if (IS_GITHUB_PAGES) {
    // On GitHub Pages, the session is valid only if the token is fresh AND
    // the data-decryption key is still cached.
    if (isClientAuthenticated() && await PortfolioCrypto.hasKey()) {
      authState = true;
      if (appContainer) appContainer.style.display = '';
      if (typeof loadData === 'function') loadData();
    } else {
      showLogin();
    }
  } else {
    // On local server, use server-side session auth
    const unlocked = await checkSession();
    if (unlocked) {
      if (appContainer) appContainer.style.display = '';
      if (typeof loadData === 'function') loadData();
    } else {
      showLogin();
    }
  }
});
