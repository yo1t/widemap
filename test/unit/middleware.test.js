// Unit tests for requireAdmin middleware behavior
// Verifies token auth without starting the full server.
// Run: node --test test/unit/middleware.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ─── Recreate requireAdmin from server.js logic ───────────────────────────────
// We don't import server.js (it starts the server on require).
// Instead we inline the identical logic so the test stays fast/offline.

function makeRequireAdmin(getAdminToken) {
  return function requireAdmin(req, res, next) {
    const provided    = (req.headers?.['x-admin-token']) || '';
    const adminToken  = getAdminToken();
    if (!adminToken) return res.status(503).json({ error: '管理トークン未初期化' });
    const a = Buffer.from(provided);
    const b = Buffer.from(adminToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: '管理トークン不正' });
    }
    next();
  };
}

// Minimal mock res / req helpers
function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (code) => { r._status = code; return r; };
  r.json   = (body) => { r._body  = body;  return r; };
  return r;
}
function mockReq(token) {
  return { headers: token != null ? { 'x-admin-token': token } : {} };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  it('returns 503 when adminToken is not yet initialised', () => {
    const mw  = makeRequireAdmin(() => '');
    const res = mockRes();
    mw(mockReq('anything'), res, () => {});
    assert.equal(res._status, 503);
  });

  it('returns 401 when no token is provided', () => {
    const token = crypto.randomBytes(24).toString('hex');
    const mw    = makeRequireAdmin(() => token);
    const res   = mockRes();
    mw(mockReq(''), res, () => {});
    assert.equal(res._status, 401);
  });

  it('returns 401 when wrong token is provided', () => {
    const token = crypto.randomBytes(24).toString('hex');
    const mw    = makeRequireAdmin(() => token);
    const res   = mockRes();
    mw(mockReq('wrong-token'), res, () => {});
    assert.equal(res._status, 401);
  });

  it('calls next() when the correct token is provided', () => {
    const token   = crypto.randomBytes(24).toString('hex');
    const mw      = makeRequireAdmin(() => token);
    const res     = mockRes();
    let nextCalled = false;
    mw(mockReq(token), res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should have been called');
    assert.equal(res._status, 200);   // untouched
  });
});
