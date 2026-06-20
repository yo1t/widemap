// Unit tests for mcp-server.js — auth middleware and server construction
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before requiring to prevent startup side-effects
process.env.EGRESSVIEW_URL   = process.env.EGRESSVIEW_URL   || 'http://localhost:9999';
process.env.EGRESSVIEW_TOKEN = process.env.EGRESSVIEW_TOKEN || 'test-egressview-token';
// MCP_PORT must be unset so the module does not try to bind a port
delete process.env.MCP_PORT;

const { _createAuthMiddleware, _buildMcpServer } = require('../../mcp-server');

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
