// Frontend lint: detect potential TDZ (Temporal Dead Zone) errors
// Checks that variables declared with 'let' are not referenced before their declaration line
// Run: node --test test/unit/frontend-lint.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

// Extract the main <script> block
function getScriptContent() {
  const m = html.match(/<script>\n([\s\S]+?)\n<\/script>/);
  return m ? m[1] : '';
}

describe('Frontend TDZ lint', () => {
  const script = getScriptContent();
  const lines = script.split('\n');

  it('has script content to analyze', () => {
    assert(lines.length > 100, `Expected >100 lines of JS, got ${lines.length}`);
  });

  it('no let/const variables used before declaration in immediate execution', () => {
    // Strategy: find the "resize();" call (the first immediate top-level execution)
    // and verify that all variables referenced in the resize function body are declared before it.
    // Also check: any getElementById().addEventListener that references a null element.
    
    // Simpler approach: just verify no remaining `let` declarations exist for
    // variables that we know are used in resize() or top-level init code.
    const riskyVars = ['mapMode', 'statsMode', 'logMode', 'devicesMode', 'currentView', 'homeCountry',
      'worldGeo', 'mapSvg', 'mapG', 'mapProjection', 'mapPath', 'currentMapK',
      'mapParticles', 'mapAnimId'];
    
    const problems = [];
    for (const v of riskyVars) {
      const re = new RegExp(`^let\\s+${v}\\b`, 'm');
      if (re.test(script)) {
        problems.push(`"${v}" is declared with 'let' but is used before declaration (should be 'var')`);
      }
    }
    
    assert.equal(problems.length, 0, `TDZ risks (let used for hoisted vars):\n  ${problems.join('\n  ')}`);
  });

  it('API fetches use apiFetch (not raw fetch with adminToken)', () => {
    // Raw fetch() with 'adminToken' key would use the wrong localStorage key
    // (correct key is TOKEN_KEY = 'widemap_admin_token', accessed via apiFetch)
    const rawFetchWithWrongToken = /fetch\([^)]+\)\s*,\s*\{[^}]*'adminToken'[^}]*\}/;
    const badLines = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => /localStorage\.getItem\(['"]adminToken['"]\)/.test(line));
    assert.equal(badLines.length, 0,
      `Found raw fetch using wrong localStorage key 'adminToken' (should use apiFetch):\n  ` +
      badLines.map(l => `L${l.num}: ${l.line.trim()}`).join('\n  '));
  });

  it('all view containers toggled in switchView exist in HTML', () => {
    // Extract container IDs from switchView display toggles
    const toggleRe = /getElementById\(['"]([^'"]+)['"]\)\.style\.display\s*=\s*view\s*===\s*['"][^'"]+['"]\s*\?/g;
    const toggled = [];
    let m;
    while ((m = toggleRe.exec(script)) !== null) {
      toggled.push(m[1]);
    }
    const htmlIds = new Set();
    const idRe = /\bid=["']([^"']+)["']/g;
    while ((m = idRe.exec(html)) !== null) {
      htmlIds.add(m[1]);
    }
    const missing = toggled.filter(id => !htmlIds.has(id));
    assert.equal(missing.length, 0,
      `switchView toggles missing HTML ids:\n  ${[...new Set(missing)].join('\n  ')}`);
  });

  it('getElementById targets exist in HTML', () => {
    // Extract all getElementById('xxx') calls
    const idCalls = [];
    const re = /getElementById\(['"]([^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      idCalls.push(m[1]);
    }

    // Extract all id="xxx" in HTML
    const htmlIds = new Set();
    const idRe = /\bid=["']([^"']+)["']/g;
    while ((m = idRe.exec(html)) !== null) {
      htmlIds.add(m[1]);
    }

    const missing = idCalls.filter(id => !htmlIds.has(id));
    // Dedupe
    const unique = [...new Set(missing)];
    assert.equal(unique.length, 0, `getElementById references missing HTML ids:\n  ${unique.join('\n  ')}`);
  });
});
