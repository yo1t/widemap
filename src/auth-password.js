// Password hashing for the single-admin login (P2-23).
// Uses Node's built-in scrypt — no external dependency.
'use strict';

const crypto = require('crypto');

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };  // interactive-login strength

/**
 * Hash a password with a fresh random salt.
 * @returns {{ salt: string, hash: string }}  hex-encoded
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_OPTS).toString('hex');
  return { salt, hash };
}

/**
 * Timing-safe verification against a stored salt+hash pair.
 */
function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const candidate = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_OPTS);
    const stored    = Buffer.from(hash, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch {
    return false;
  }
}

/**
 * Generate a readable initial password (no ambiguous characters),
 * printed once to the console on first startup.
 */
function generateInitialPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFHJKLMNPQRTUVWXY3479';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, generateInitialPassword };
