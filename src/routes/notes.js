// Routes: notes CRUD and on-demand investigation
'use strict';

const { Router } = require('express');
const { isAllowedRouterIp } = require('../utils');

/**
 * @param {{
 *   requireAdmin,
 *   notes: import('../notes'),
 *   io,
 *   yamaha, deviceId
 * }} ctx
 */
module.exports = function notesRoutes(ctx) {
  const { requireAdmin, notes, io, yamaha, deviceId } = ctx;
  const router = Router();

  // GET /api/notes
  router.get('/notes', requireAdmin, (req, res) => {
    res.json({ notes: notes.getAll() });
  });

  // POST /api/notes
  router.post('/notes', requireAdmin, (req, res) => {
    const { ip, mac, note } = req.body || {};
    let key = '';
    if (ip && mac)        key = `${ip}|${mac}`;
    else if (ip)          key = ip;
    else if (mac)         key = mac;
    else if (req.body?.key) key = req.body.key;

    if (!notes.isSafeKey(key)) {
      return res.status(400).json({ error: 'invalid key (IP/MAC形式のみ)' });
    }

    if (typeof note === 'string') {
      const trimmed = note.trim().substring(0, 500);
      if (trimmed) {
        if (ip || mac) notes.clearByIpMac(ip, mac);
        notes.set(key, trimmed);
      } else {
        if (ip || mac) notes.clearByIpMac(ip, mac);
        else           notes.del(key);
      }
    }

    notes.save();
    io.emit('notes-update', { notes: notes.getAll() });
    res.json({ success: true });
  });

  // POST /api/notes/draft  — on-demand investigation
  router.post('/notes/draft', requireAdmin, async (req, res) => {
    const ip = req.body?.ip;
    if (!ip || !isAllowedRouterIp(ip)) {
      return res.status(400).json({ error: '有効なプライベートIPを指定してください' });
    }
    try {
      const result = await deviceId.investigateIp(ip, {
        ouiDb:         deviceId.getOuiDb(),
        yamahaExec:    yamaha.isReady() ? yamaha.yamahaExec : null,
        yamahaEnabled: yamaha.isEnabled(),
        yamahaReady:   yamaha.isReady(),
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
