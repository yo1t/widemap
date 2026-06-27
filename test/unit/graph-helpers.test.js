'use strict';

// Unit tests for pure graph helpers in public/js/graph.js that are NOT covered by
// graph-link-normalization.test.js: flagEmoji, meshNodeId, currentGraphRangeKey.
// graph.js has heavy top-level DOM/D3 setup, so we slice out just the helper block
// (function flagEmoji … up to function graphSummaryNotice) and evaluate it in an
// isolated context. currentGraphRangeKey reads the optional global currentTimeFilter,
// which we inject per-case (it is guarded by `typeof … !== 'undefined'`).
// Run: node --test test/unit/graph-helpers.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/graph.js'), 'utf8');
const start = source.indexOf('function flagEmoji');
const end = source.indexOf('function graphSummaryNotice');
assert.notEqual(start, -1, 'function flagEmoji not found');
assert.notEqual(end, -1, 'function graphSummaryNotice not found');
const helperSrc = source.slice(start, end);

function loadHelpers(currentTimeFilter) {
  const context = { currentTimeFilter };
  vm.runInNewContext(helperSrc, context);
  return context;
}

const { flagEmoji, meshNodeId, currentGraphRangeKey } = loadHelpers(undefined);

describe('flagEmoji', () => {
  it('converts a 2-letter country code to a flag emoji', () => {
    assert.equal(flagEmoji('JP'), '🇯🇵');
    assert.equal(flagEmoji('US'), '🇺🇸');
  });
  it('returns empty string for missing or wrong-length codes', () => {
    assert.equal(flagEmoji(''), '');
    assert.equal(flagEmoji(null), '');
    assert.equal(flagEmoji('J'), '');
    assert.equal(flagEmoji('JPN'), '');
  });
});

describe('meshNodeId', () => {
  it('wraps a MAC in the mesh-node id form', () => {
    assert.equal(meshNodeId('aa:bb:cc'), '__node_aa:bb:cc__');
  });
});

describe('currentGraphRangeKey', () => {
  it('uses raw from:to when no time filter is active', () => {
    assert.equal(currentGraphRangeKey(100, 200), '100:200');
    assert.equal(currentGraphRangeKey(null, null), ':');
  });
  it('custom filter embeds both bounds', () => {
    const { currentGraphRangeKey: fn } = loadHelpers('custom');
    assert.equal(fn(100, 200), 'custom:100:200');
    assert.equal(fn(null, null), 'custom::');
  });
  it('today/yesterday embed the ISO day of "from"', () => {
    const ts = Date.UTC(2026, 0, 2, 3, 4);
    const today = loadHelpers('today').currentGraphRangeKey;
    assert.equal(today(ts, 0), 'today:2026-01-02:0');
    const yesterday = loadHelpers('yesterday').currentGraphRangeKey;
    assert.match(yesterday(ts, ''), /^yesterday:2026-01-02:/);
  });
  it('other named filters are treated as open-ended', () => {
    const { currentGraphRangeKey: fn } = loadHelpers('7d');
    assert.equal(fn(100, 200), '7d:open');
  });
});
