// Unit tests for src/auth-password.js
// Run: node --test test/unit/auth-password.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, generateInitialPassword } = require('../../src/auth-password');

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', () => {
    const { salt, hash } = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', salt, hash), true);
  });

  it('rejects a wrong password', () => {
    const { salt, hash } = hashPassword('right-password');
    assert.equal(verifyPassword('wrong-password', salt, hash), false);
  });

  it('generates a unique salt per call (same password → different hashes)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });

  it('rejects empty / null inputs safely', () => {
    const { salt, hash } = hashPassword('x');
    assert.equal(verifyPassword('', salt, hash), false);
    assert.equal(verifyPassword(null, salt, hash), false);
    assert.equal(verifyPassword('x', '', hash), false);
    assert.equal(verifyPassword('x', salt, ''), false);
  });

  it('rejects malformed stored hash without throwing', () => {
    const { salt } = hashPassword('x');
    assert.equal(verifyPassword('x', salt, 'not-hex!!'), false);
  });
});

describe('generateInitialPassword', () => {
  it('returns a 16-char string', () => {
    const pw = generateInitialPassword();
    assert.equal(typeof pw, 'string');
    assert.equal(pw.length, 16);
  });

  it('avoids ambiguous characters (0/O/o, 1/I/i/l, 2/5/6/8)', () => {
    for (let i = 0; i < 20; i++) {
      assert.doesNotMatch(generateInitialPassword(), /[012568OIoil]/);
    }
  });

  it('is verifiable through the hash round-trip', () => {
    const pw = generateInitialPassword();
    const { salt, hash } = hashPassword(pw);
    assert.equal(verifyPassword(pw, salt, hash), true);
  });
});
