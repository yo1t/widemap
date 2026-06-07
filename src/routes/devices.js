// Routes: device inventory
'use strict';

const { Router } = require('express');

/**
 * @param {{ requireAdmin, devices, yamaha, enrichment }} ctx
 */
module.exports = function devicesRoutes(ctx) {
  const { requireAdmin, devices, yamaha } = ctx;
  const router = Router();

  router.get('/devices', requireAdmin, (req, res) => {
    const all = devices.getAll();
    for (const d of all) {
      d.ipv6Addrs = d.mac ? (yamaha.getNdpByMac(d.mac) || null) : null;
    }
    res.json({ devices: all });
  });

  return router;
};
