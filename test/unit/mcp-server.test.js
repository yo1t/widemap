// Unit tests for mcp-server.js — auth middleware, apiPost helper, and server construction
'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before requiring to prevent startup side-effects
process.env.EGRESSVIEW_URL   = process.env.EGRESSVIEW_URL   || 'http://localhost:9999';
process.env.EGRESSVIEW_TOKEN = process.env.EGRESSVIEW_TOKEN || 'test-egressview-token';
// MCP_PORT must be unset so the module does not try to bind a port
delete process.env.MCP_PORT;

const { _createAuthMiddleware, _buildMcpServer, _apiPost } = require('../../mcp-server');

// ─── createAuthMiddleware ─────────────────────────────────────────────────────

describe('mcp-server: createAuthMiddleware', () => {
  const TOKEN = 'super-secret-mcp-token';

  function makeReq(headers = {}) { return { headers }; }
  function makeRes() {
    const r = { _status: null, _body: null };
    r.status = (code) => { r._status = code; return r; };
    r.json   = (body) => { r._body  = body; return r; };
    return r;
  }

  it('rejects with 401 when no token provided', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({}), res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
    assert.equal(res._body?.error, 'unauthorized');
  });

  it('rejects with 401 for wrong X-Admin-Token', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    mw(makeReq({ 'x-admin-token': 'wrong-token' }), res, () => {});
    assert.equal(res._status, 401);
  });

  it('rejects with 401 for wrong Bearer token', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    mw(makeReq({ authorization: 'Bearer wrong' }), res, () => {});
    assert.equal(res._status, 401);
  });

  it('accepts valid token via X-Admin-Token header', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': TOKEN }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._status, null, 'should not set status on success');
  });

  it('accepts valid token via Authorization: Bearer header', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ authorization: `Bearer ${TOKEN}` }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('rejects empty provided token (prevents auth bypass when server token non-empty)', () => {
    const mw = _createAuthMiddleware('non-empty-server-token');
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': '' }), res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  it('MCP_TOKEN separation: EgressView token does not work for MCP when tokens differ', () => {
    const egressviewToken = 'egressview-api-token';
    const mcpToken        = 'mcp-only-token';
    const mw = _createAuthMiddleware(mcpToken);
    const res = makeRes();
    mw(makeReq({ 'x-admin-token': egressviewToken }), res, () => {});
    assert.equal(res._status, 401, 'EgressView token must not pass MCP auth when MCP_TOKEN differs');
  });

  it('MCP_TOKEN separation: MCP token is accepted when set separately', () => {
    const mcpToken = 'mcp-only-token';
    const mw = _createAuthMiddleware(mcpToken);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': mcpToken }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

// ─── apiPost helper ───────────────────────────────────────────────────────────

describe('mcp-server: apiPost', () => {
  let originalFetch;

  before(() => { originalFetch = globalThis.fetch; });

  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetch(status, body) {
    globalThis.fetch = async () => ({
      ok:   status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('sends POST with JSON body and X-Admin-Token header', async () => {
    let capturedUrl, capturedOpts;
    globalThis.fetch = async (url, opts) => {
      capturedUrl  = url;
      capturedOpts = opts;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    await _apiPost('/notes', { ip: '192.168.1.1', note: 'test' });
    assert.ok(capturedUrl.endsWith('/api/notes'), 'should POST to /api/notes');
    assert.equal(capturedOpts.method, 'POST');
    assert.equal(capturedOpts.headers['Content-Type'], 'application/json');
    assert.ok(capturedOpts.headers['X-Admin-Token'], 'should include auth token');
    assert.deepEqual(JSON.parse(capturedOpts.body), { ip: '192.168.1.1', note: 'test' });
  });

  it('returns parsed JSON on success', async () => {
    mockFetch(200, { success: true });
    const result = await _apiPost('/notes', {});
    assert.deepEqual(result, { success: true });
  });

  it('throws on non-2xx response', async () => {
    mockFetch(400, { error: 'bad request' });
    await assert.rejects(
      () => _apiPost('/notes', {}),
      /returned 400/
    );
  });

  it('throws on non-JSON response', async () => {
    globalThis.fetch = async () => ({
      ok:   true,
      status: 200,
      json: async () => { throw new SyntaxError('not json'); },
    });
    await assert.rejects(
      () => _apiPost('/notes', {}),
      /non-JSON response/
    );
  });
});

// ─── buildMcpServer ───────────────────────────────────────────────────────────

describe('mcp-server: buildMcpServer', () => {
  it('returns an object with a connect method (valid McpServer)', () => {
    const server = _buildMcpServer();
    assert.ok(server != null, 'should return a server instance');
    assert.equal(typeof server.connect, 'function', 'should expose connect()');
  });

  it('does not throw during construction', () => {
    assert.doesNotThrow(() => _buildMcpServer());
  });
});
