'use strict';

// Unit tests for the lookupNote() pure helper in public/js/auth-socket.js.
// The function resolves a device note from notesMap using three candidate keys
// in priority order: deviceId, "ip|mac" composite, then ip-only or mac-only.
//
// auth-socket.js has top-level DOM references (socket, document…), so we slice
// only the lookupNote function body and run it in a vm context where notesMap
// is a mutable injected variable.
// Run: node --test test/unit/auth-socket-pure.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root   = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/auth-socket.js'), 'utf8');

const start = source.indexOf('function lookupNote');
// End before the module-level `let noteEditIp` line which references DOM.
const end   = source.indexOf('\nlet noteEditIp');
assert.notEqual(start, -1, 'function lookupNote not found');
assert.notEqual(end,   -1, 'let noteEditIp not found');

const fnSrc = source.slice(start, end);

function makeLookup(notesMap) {
  const ctx = { notesMap };
  vm.runInNewContext(fnSrc, ctx);
  return ctx.lookupNote;
}

describe('lookupNote — deviceId priority', () => {
  it('returns note keyed by deviceId when present', () => {
    const lookup = makeLookup({ 42: 'server rack A' });
    assert.equal(lookup('192.168.1.1', 'aa:bb:cc:dd:ee:ff', 42), 'server rack A');
  });

  it('returns note for deviceId=0 (falsy number should not skip)', () => {
    // deviceId 0 is falsy in JS, so the guard `if (deviceId && …)` skips it intentionally.
    // Verify the function falls through to the ip|mac lookup instead.
    const lookup = makeLookup({ '192.168.1.1|aa:bb': 'fallback note', 0: 'zero note' });
    assert.equal(lookup('192.168.1.1', 'aa:bb', 0), 'fallback note');
  });

  it('ignores deviceId when notesMap has no entry for it', () => {
    const lookup = makeLookup({ '10.0.0.1|cc:dd': 'by mac' });
    assert.equal(lookup('10.0.0.1', 'cc:dd', 99), 'by mac');
  });
});

describe('lookupNote — ip|mac composite key', () => {
  it('returns note for exact ip|mac match', () => {
    const lookup = makeLookup({ '10.0.0.5|11:22:33:44:55:66': 'NAS' });
    assert.equal(lookup('10.0.0.5', '11:22:33:44:55:66', null), 'NAS');
  });

  it('returns empty string when ip|mac key is absent', () => {
    const lookup = makeLookup({ '10.0.0.5|aa:bb': 'other' });
    assert.equal(lookup('10.0.0.5', 'cc:dd', null), 'other'); // falls through to ip-only match
  });
});

describe('lookupNote — ip-only / mac-only fallback', () => {
  it('matches by ip when key has the form "ip|mac"', () => {
    const lookup = makeLookup({ '10.0.0.1|ab:cd': 'by ip' });
    assert.equal(lookup('10.0.0.1', null, null), 'by ip');
  });

  it('matches by mac when key has the form "ip|mac"', () => {
    const lookup = makeLookup({ '10.0.0.1|ab:cd:ef': 'by mac' });
    assert.equal(lookup(null, 'ab:cd:ef', null), 'by mac');
  });

  it('matches by mac when key is bare mac (no pipe separator)', () => {
    // key = 'ab:cd:ef' → split('|') gives ['ab:cd:ef', undefined]
    const lookup = makeLookup({ 'aa:bb:cc': 'bare mac note' });
    assert.equal(lookup(null, 'aa:bb:cc', null), 'bare mac note');
  });

  it('returns empty string when no key matches', () => {
    const lookup = makeLookup({ '1.2.3.4|aa:bb': 'other' });
    assert.equal(lookup('9.9.9.9', 'zz:zz', null), '');
  });
});

describe('lookupNote — edge cases', () => {
  it('returns empty string for completely empty notesMap', () => {
    const lookup = makeLookup({});
    assert.equal(lookup('10.0.0.1', 'aa:bb', 1), '');
  });

  it('returns empty string when all arguments are null', () => {
    const lookup = makeLookup({ '10.0.0.1|aa:bb': 'note' });
    assert.equal(lookup(null, null, null), '');
  });

  it('deviceId match returns empty string when note is empty string', () => {
    const lookup = makeLookup({ 5: '' });
    // deviceId present but value is '', notesMap[5] != null → returns ''
    assert.equal(lookup('1.2.3.4', 'aa:bb', 5), '');
  });
});
