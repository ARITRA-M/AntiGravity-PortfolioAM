// Client-side encryption for portfolio data files (WebCrypto).
// Data files in data/*.json are AES-256-GCM envelopes; the key is derived
// from the dashboard password with PBKDF2-SHA256. The password itself is
// never stored — only the derived key is cached so the session survives
// reloads without re-prompting.
//
// Envelope format:
//   { "__encrypted": true, "v": 1, "iter": 310000,
//     "salt": "<b64>", "iv": "<b64>", "ct": "<b64 ciphertext+tag>" }

const PortfolioCrypto = (() => {
  const KEY_STORAGE = 'portfolio_data_key';
  const DEFAULT_ITER = 310000;

  let cachedKey = null;   // CryptoKey
  let cachedSalt = null;  // base64 string the key was derived with
  let cachedIter = DEFAULT_ITER;

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function isEnvelope(obj) {
    return !!(obj && typeof obj === 'object' && obj.__encrypted === true && obj.ct && obj.iv && obj.salt);
  }

  async function deriveKey(password, saltB64, iter) {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: iter || DEFAULT_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true, // extractable so the derived key can be cached across reloads
      ['encrypt', 'decrypt']
    );
  }

  async function persistKey() {
    if (!cachedKey || !cachedSalt) return;
    try {
      const raw = await crypto.subtle.exportKey('raw', cachedKey);
      localStorage.setItem(KEY_STORAGE, JSON.stringify({
        key: bytesToB64(raw), salt: cachedSalt, iter: cachedIter
      }));
    } catch (e) {
      console.warn('Could not persist data key:', e);
    }
  }

  async function restoreKey() {
    if (cachedKey) return true;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY_STORAGE) || 'null');
      if (!stored || !stored.key || !stored.salt) return false;
      cachedKey = await crypto.subtle.importKey(
        'raw', b64ToBytes(stored.key), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
      );
      cachedSalt = stored.salt;
      cachedIter = stored.iter || DEFAULT_ITER;
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearKey() {
    cachedKey = null;
    cachedSalt = null;
    try { localStorage.removeItem(KEY_STORAGE); } catch (_) {}
  }

  async function decryptWithKey(envelope, key) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // Decrypt an envelope with the cached key. Returns the object, or null if
  // no usable key is cached (caller should prompt for the password).
  async function decryptEnvelope(envelope) {
    if (!isEnvelope(envelope)) return envelope; // plaintext passthrough
    if (!cachedKey) await restoreKey();
    if (!cachedKey || cachedSalt !== envelope.salt) return null;
    try {
      return await decryptWithKey(envelope, cachedKey);
    } catch (e) {
      // Key no longer matches (files re-encrypted with a new password)
      clearKey();
      return null;
    }
  }

  // Derive a key from the password and verify it against an envelope.
  // On success the key is cached + persisted. Throws on wrong password.
  async function unlockWithPassword(password, envelope) {
    if (!isEnvelope(envelope)) {
      // Plaintext data: nothing to verify against, no key to cache.
      return null;
    }
    const key = await deriveKey(password, envelope.salt, envelope.iter);
    let data;
    try {
      data = await decryptWithKey(envelope, key);
    } catch (e) {
      throw new Error('Incorrect dashboard password.');
    }
    cachedKey = key;
    cachedSalt = envelope.salt;
    cachedIter = envelope.iter || DEFAULT_ITER;
    await persistKey();
    return data;
  }

  // Encrypt an object with the cached key (same salt as the data files).
  // Used by the commit flow so files on disk stay encrypted.
  async function encryptObject(obj) {
    if (!cachedKey) await restoreKey();
    if (!cachedKey) throw new Error('No data key available — unlock the dashboard first.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, cachedKey, new TextEncoder().encode(JSON.stringify(obj))
    );
    return {
      __encrypted: true, v: 1, iter: cachedIter,
      salt: cachedSalt, iv: bytesToB64(iv), ct: bytesToB64(ct)
    };
  }

  async function hasKey() {
    if (cachedKey) return true;
    return restoreKey();
  }

  return { isEnvelope, decryptEnvelope, unlockWithPassword, encryptObject, clearKey, hasKey };
})();
