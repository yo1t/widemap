// Unit tests for src/notes.js
// Run: node --test test/unit/notes.test.js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Use a temporary in-memory-ish approach: monkey-patch the module's internal
// state via a test-only reset helper. We test all exported functions directly.
const notes = require('../../src/notes');

// Reset internal state between tests by loading from an empty object
// (override the module's NOTES_FILE read to avoid touching disk)
function resetNotes() {
  // Call load() on a non-existent path is caught — notes becomes {}
  // Instead, exercise set/del directly to start clean
  for (const k of Object.keys(notes.getAll())) notes.del(k);
}

describe('notes.isSafeKey', () => {
  it('accepts a valid IPv4 address', () => {
    assert.ok(notes.isSafeKey('192.168.1.1'));
  });

  it('accepts a valid MAC address', () => {
    assert.ok(notes.isSafeKey('aa:bb:cc:dd:ee:ff'));
  });

  it('accepts a composite IP|MAC key', () => {
    assert.ok(notes.isSafeKey('192.168.1.1|aa:bb:cc:dd:ee:ff'));
  });

  it('accepts a composite MAC|IP key', () => {
    assert.ok(notes.isSafeKey('aa:bb:cc:dd:ee:ff|192.168.1.50'));
  });

  it('rejects a path-like string', () => {
    assert.ok(!notes.isSafeKey('../etc/passwd'));
  });

  it('rejects an empty string', () => {
    assert.ok(!notes.isSafeKey(''));
  });

  it('rejects a string over 96 chars', () => {
    assert.ok(!notes.isSafeKey('192.168.1.1|' + 'a'.repeat(90)));
  });

  it('rejects non-string input', () => {
    assert.ok(!notes.isSafeKey(null));
    assert.ok(!notes.isSafeKey(123));
  });
});

describe('notes CRUD', () => {
  beforeEach(resetNotes);

  it('set and get a note', () => {
    notes.set('192.168.1.1', 'hello');
    assert.equal(notes.get('192.168.1.1'), 'hello');
  });

  it('del removes a note', () => {
    notes.set('192.168.1.5', 'bye');
    notes.del('192.168.1.5');
    assert.equal(notes.get('192.168.1.5'), undefined);
  });

  it('getAll returns all notes', () => {
    notes.set('10.0.0.1', 'a');
    notes.set('10.0.0.2', 'b');
    const all = notes.getAll();
    assert.equal(all['10.0.0.1'], 'a');
    assert.equal(all['10.0.0.2'], 'b');
  });
});

describe('notes.has', () => {
  beforeEach(resetNotes);

  it('returns true when IP matches a plain IP key', () => {
    notes.set('192.168.1.10', 'note');
    assert.ok(notes.has('192.168.1.10', null));
  });

  it('returns true when MAC matches a plain MAC key', () => {
    notes.set('aa:bb:cc:dd:ee:ff', 'note');
    assert.ok(notes.has(null, 'aa:bb:cc:dd:ee:ff'));
  });

  it('returns true when IP matches the IP part of a composite key', () => {
    notes.set('192.168.1.20|aa:bb:cc:dd:ee:ff', 'note');
    assert.ok(notes.has('192.168.1.20', null));
  });

  it('returns false when neither ip nor mac is stored', () => {
    assert.ok(!notes.has('10.0.0.99', 'de:ad:be:ef:00:01'));
  });
});

describe('notes.clearByIpMac', () => {
  beforeEach(resetNotes);

  it('removes composite key that matches the IP', () => {
    notes.set('192.168.1.30|aa:bb:cc:dd:ee:ff', 'old');
    notes.clearByIpMac('192.168.1.30', null);
    assert.equal(notes.get('192.168.1.30|aa:bb:cc:dd:ee:ff'), undefined);
  });

  it('leaves unrelated keys intact', () => {
    notes.set('10.0.0.1', 'keep');
    notes.set('192.168.1.30|aa:bb:cc:dd:ee:ff', 'remove');
    notes.clearByIpMac('192.168.1.30', null);
    assert.equal(notes.get('10.0.0.1'), 'keep');
  });
});
