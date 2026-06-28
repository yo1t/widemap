'use strict';

// Unit tests for normalizeGraphLinks and linkEndpointId in public/js/graph.js.
// Both functions are pure (no DOM/D3), so we slice them out of the source and
// evaluate in a vm context.  The slice runs from linkEndpointId up to but not
// including currentGraphRangeKey.
// Run: node --test test/unit/graph-filter.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root   = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/graph.js'), 'utf8');

const start = source.indexOf('function linkEndpointId');
const end   = source.indexOf('function currentGraphRangeKey');
assert.notEqual(start, -1, 'function linkEndpointId not found');
assert.notEqual(end,   -1, 'function currentGraphRangeKey not found');

const fnSrc = source.slice(start, end);

function load() {
  const ctx = {};
  vm.runInNewContext(fnSrc, ctx);
  return ctx;
}

const { normalizeGraphLinks } = load();

// helper: build minimal node and link objects
const node  = id => ({ id });
const link  = (source, target, extra = {}) => ({ source, target, ...extra });

describe('normalizeGraphLinks', () => {
  it('returns empty array when both inputs are empty', () => {
    assert.deepEqual(normalizeGraphLinks([], []), []);
  });

  it('keeps links whose source and target are in the node set', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const links = [link('a', 'b'), link('b', 'c')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 2);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('drops links whose source is not in the node set', () => {
    const nodes = [node('b'), node('c')];
    const links = [link('a', 'b'), link('b', 'c')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'b');
  });

  it('drops links whose target is not in the node set', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('a', 'b'), link('b', 'z')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].target, 'b');
  });

  it('drops all links when no matching nodes exist', () => {
    const nodes = [node('x')];
    const links = [link('a', 'b'), link('c', 'd')];
    assert.deepEqual(normalizeGraphLinks(links, nodes), []);
  });

  it('preserves extra properties on kept links', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('a', 'b', { weight: 5, label: 'test' })];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result[0].weight, 5);
    assert.equal(result[0].label, 'test');
  });

  it('resolves object endpoints to their id property', () => {
    const nodes = [node('a'), node('b')];
    // D3 replaces link.source/target strings with the actual node objects after simulation init
    const links = [link({ id: 'a', x: 1 }, { id: 'b', y: 2 })];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('handles mixed object and string endpoints', () => {
    const nodes = [node('a'), node('b')];
    const links = [link({ id: 'a' }, 'b')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('self-loops (source === target) are kept if the node exists', () => {
    const nodes = [node('a')];
    const links = [link('a', 'a')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
  });
});
