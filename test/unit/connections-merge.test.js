'use strict';

// Unit tests for mergeConnections() and connectionKey() in public/js/connections-panel.js.
// mergeConnections is called on every socket connections-update and on the background
// 24h fetch; correctness here directly affects whether session history is preserved.
//
// connections-panel.js has top-level DOM references, so we slice only connectionKey
// and mergeConnections and run them in a vm context.
// Run: node --test test/unit/connections-merge.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root   = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/connections-panel.js'), 'utf8');

const start = source.indexOf('function connectionKey');
const end   = source.indexOf('function getTimeRange');
assert.notEqual(start, -1, 'function connectionKey not found');
assert.notEqual(end,   -1, 'function getTimeRange not found');

const fnSrc = source.slice(start, end);

function load() {
  const ctx = vm.createContext({ Map });
  vm.runInContext(fnSrc, ctx);
  // vm returns arrays in a different realm; wrap to normalise
  const orig = ctx.mergeConnections;
  ctx.mergeConnections = (a, b) => JSON.parse(JSON.stringify(orig(a, b)));
  return ctx;
}

const { mergeConnections } = load();

// helper: minimal connection record
const conn = (src, dst, dport, proto, extra = {}) => ({ src, dst, dport, proto, ...extra });

describe('mergeConnections — basic behaviour', () => {
  it('returns [] when both inputs are empty', () => {
    assert.deepEqual(mergeConnections([], []), []);
  });

  it('returns [] when both inputs are null/undefined', () => {
    assert.deepEqual(mergeConnections(null, null), []);
    assert.deepEqual(mergeConnections(undefined, undefined), []);
  });

  it('returns incoming entries when existing is empty', () => {
    const inc = [conn('10.0.0.1', '8.8.8.8', 53, 'UDP')];
    const result = mergeConnections([], inc);
    assert.equal(result.length, 1);
    assert.equal(result[0].dst, '8.8.8.8');
  });

  it('returns existing entries when incoming is empty', () => {
    const ex = [conn('10.0.0.1', '8.8.8.8', 53, 'UDP', { lastSeen: 1000 })];
    const result = mergeConnections(ex, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].lastSeen, 1000);
  });
});

describe('mergeConnections — deduplication', () => {
  it('merges two records with the same key into one', () => {
    const ex  = [conn('a', 'b', 80, 'TCP', { lastSeen: 100 })];
    const inc = [conn('a', 'b', 80, 'TCP', { lastSeen: 200 })];
    const result = mergeConnections(ex, inc);
    assert.equal(result.length, 1);
  });

  it('incoming fields overwrite existing fields on the same key', () => {
    const ex  = [conn('a', 'b', 80, 'TCP', { lastSeen: 100, bytes: 50 })];
    const inc = [conn('a', 'b', 80, 'TCP', { lastSeen: 200 })];
    const result = mergeConnections(ex, inc);
    assert.equal(result[0].lastSeen, 200);
  });

  it('existing fields are preserved when incoming does not include them', () => {
    const ex  = [conn('a', 'b', 80, 'TCP', { bytes: 999, srcDnsName: 'host.local' })];
    const inc = [conn('a', 'b', 80, 'TCP', { lastSeen: 300 })];
    const result = mergeConnections(ex, inc);
    assert.equal(result[0].bytes, 999);
    assert.equal(result[0].srcDnsName, 'host.local');
  });

  it('records with different ports are kept as separate entries', () => {
    const ex  = [conn('a', 'b', 80,  'TCP')];
    const inc = [conn('a', 'b', 443, 'TCP')];
    const result = mergeConnections(ex, inc);
    assert.equal(result.length, 2);
  });

  it('records with different protocols are kept as separate entries', () => {
    const ex  = [conn('a', 'b', 53, 'TCP')];
    const inc = [conn('a', 'b', 53, 'UDP')];
    const result = mergeConnections(ex, inc);
    assert.equal(result.length, 2);
  });
});

describe('mergeConnections — threat flag preservation', () => {
  it('keeps threat flag from existing when incoming has none', () => {
    const ex  = [conn('a', 'b', 80, 'TCP', { threat: 'malware' })];
    const inc = [conn('a', 'b', 80, 'TCP', { threat: null })];
    const result = mergeConnections(ex, inc);
    assert.equal(result[0].threat, 'malware');
  });

  it('incoming threat flag takes precedence when set', () => {
    const ex  = [conn('a', 'b', 80, 'TCP', { threat: null })];
    const inc = [conn('a', 'b', 80, 'TCP', { threat: 'c2' })];
    const result = mergeConnections(ex, inc);
    assert.equal(result[0].threat, 'c2');
  });

  it('threat remains null when neither side has it', () => {
    const ex  = [conn('a', 'b', 80, 'TCP')];
    const inc = [conn('a', 'b', 80, 'TCP')];
    const result = mergeConnections(ex, inc);
    assert.equal(result[0].threat, null);
  });
});

describe('mergeConnections — additive merge', () => {
  it('new incoming entries are added alongside existing ones', () => {
    const ex  = [conn('a', 'b', 80, 'TCP')];
    const inc = [conn('a', 'b', 80, 'TCP'), conn('c', 'd', 443, 'TCP')];
    const result = mergeConnections(ex, inc);
    assert.equal(result.length, 2);
  });

  it('result count equals unique keys across both arrays', () => {
    const ex  = [conn('a', 'b', 80, 'TCP'), conn('c', 'd', 53, 'UDP')];
    const inc = [conn('a', 'b', 80, 'TCP'), conn('e', 'f', 22, 'TCP')];
    const result = mergeConnections(ex, inc);
    assert.equal(result.length, 3); // a→b:80TCP (dedup), c→d:53UDP, e→f:22TCP
  });
});
