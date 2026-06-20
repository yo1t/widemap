'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function loadStatsLayoutHelpers() {
  const source = fs.readFileSync(path.join(root, 'public/js/stats.js'), 'utf8');
  const start = source.indexOf('function chartInnerWidth');
  const end = source.indexOf('function drawBarChart');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const context = {};
  vm.runInNewContext(source.slice(start, end), context);
  return context;
}

describe('stats chart layout', () => {
  it('keeps bar chart width positive when the container is narrower than margins', () => {
    const { chartInnerWidth } = loadStatsLayoutHelpers();

    assert.equal(chartInnerWidth(120, { left: 180, right: 40 }), 1);
  });

  it('uses the available inner width when margins fit', () => {
    const { chartInnerWidth } = loadStatsLayoutHelpers();

    assert.equal(chartInnerWidth(600, { left: 180, right: 40 }), 380);
  });
});
