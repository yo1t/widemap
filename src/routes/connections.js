// Routes: connection history query
'use strict';

const { Router } = require('express');

/**
 * @param {{ requireAdmin, history }} ctx
 */
module.exports = function connectionsRoutes(ctx) {
  const { requireAdmin, history } = ctx;
  const router = Router();

  router.get('/connections', requireAdmin, (req, res) => {
    const from = req.query.from != null && req.query.from !== '' ? parseInt(req.query.from) : null;
    const to   = req.query.to   != null && req.query.to   !== '' ? parseInt(req.query.to)   : null;
    const connections = history.queryByTimeRange(from, to);
    res.json({ connections, serverTime: Date.now() });
  });

  return router;
};
