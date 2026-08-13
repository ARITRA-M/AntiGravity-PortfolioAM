const fs = require('fs');
const crypto = require('crypto').webcrypto;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decryptFile(filePath, password) {
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(envelope.salt), iterations: envelope.iter || 310000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

(async () => {
  try {
    const bals = await decryptFile('data/ledger_balances.json', 'Portfolio2026');
    fs.writeFileSync('dump_bals_latest.json', JSON.stringify(bals, null, 2));
    console.log("Dumped balances to dump_bals_latest.json");
  } catch(e) {
    console.error(e);
  }
})();
