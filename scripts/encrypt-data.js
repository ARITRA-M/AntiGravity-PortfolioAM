#!/usr/bin/env node
// Encrypts (or re-encrypts) all data/*.json files with a password.
// Produces AES-256-GCM envelopes compatible with js/crypto.js (WebCrypto).
//
// Usage:  node scripts/encrypt-data.js            (prompts for password)
//         DASHBOARD_PASSWORD=... node scripts/encrypt-data.js
//
// Run this once with your new password, then commit & push so GitHub Pages
// serves only ciphertext. Use the same password as DASHBOARD_PASSWORD for
// the local server so one unlock covers both.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ITER = 310000;

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      char = char + '';
      if (char === '\n' || char === '\r' || char === '') {
        process.stdin.removeListener('data', onData);
      } else {
        // overwrite the echoed char with a mask
        readline.moveCursor(process.stdout, -1, 0);
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function encrypt(obj, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __encrypted: true,
    v: 1,
    iter: ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    // WebCrypto expects ciphertext with the GCM tag appended
    ct: Buffer.concat([ct, tag]).toString('base64')
  };
}

function decrypt(envelope, password) {
  const salt = Buffer.from(envelope.salt, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, envelope.iter || ITER, 32, 'sha256');
  const buf = Buffer.from(envelope.ct, 'base64');
  const ct = buf.subarray(0, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

async function main() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('No JSON files found in data/');
    process.exit(1);
  }

  const password = process.env.DASHBOARD_PASSWORD ||
    await promptHidden('New dashboard password (will encrypt data files): ');
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  // If files are already encrypted, we need the OLD password to read them.
  // Same password re-encrypts in place (new salt/IVs).
  let oldPassword = password;

  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256');

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    let obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (obj && obj.__encrypted === true) {
      try {
        obj = decrypt(obj, oldPassword);
      } catch (e) {
        oldPassword = process.env.OLD_DASHBOARD_PASSWORD ||
          await promptHidden(`Current password for ${file}: `);
        try {
          obj = decrypt(obj, oldPassword);
        } catch (e2) {
          console.error(`Cannot decrypt ${file} — wrong current password. Aborting.`);
          process.exit(1);
        }
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(encrypt(obj, key, salt), null, 2), 'utf8');
    console.log(`Encrypted ${file}`);
  }

  console.log('\nDone. All data files are encrypted with the new password.');
  console.log('Next steps:');
  console.log('  1. Restart the local server with: DASHBOARD_PASSWORD=<same password> npm run dev');
  console.log('  2. Commit & push so GitHub Pages serves the encrypted files.');
}

main().catch((e) => { console.error(e); process.exit(1); });
