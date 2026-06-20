'use strict';
// EgressView MCP Server
// Exposes network traffic data to AI agents via the Model Context Protocol.
// Run: EGRESSVIEW_DB=/path/to/.egressview.db node mcp-server.js
//
// Claude Desktop config (~/.claude/claude_desktop_config.json):
//   { "mcpServers": { "egressview": {
//       "command": "node",
//       "args": ["/absolute/path/to/egressview/mcp-server.js"],
//       "env": { "EGRESSVIEW_DB": "/absolute/path/to/.egressview.db" }
//   }}}

const path = require('path');
const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const history    = require('./src/history.js');
const devices    = require('./src/devices.js');
const threatIntel = require('./src/threat-intel.js');

const DB_PATH = process.env.EGRESSVIEW_DB
  || path.join(__dirname, '.egressview.db');

// Open DB (WAL mode allows concurrent reads alongside the main server)
history._initForTest(DB_PATH);
devices.initDb(DB_PATH);

// Load threat intel feeds from on-disk cache; don't block startup
threatIntel.fetchThreatIntel().catch(() => {});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PERIOD_MS = {
  '1h':  3_600_000,
  '6h':  21_600_000,
  '24h': 86_400_000,
  '7d':  604_800_000,
  '14d': 1_209_600_000,
};

const PERIOD_ENUM = z.enum(['1h', '6h', '24h', '7d', '14d']);

function periodRange(period) {
  const ms = PERIOD_MS[period] ?? PERIOD_MS['24h'];
  const to = Date.now();
  return { from: to - ms, to };
}

function tsToIso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

function threatLevel(dst, dstHost) {
  const t = threatIntel.matchThreatIntel(dst, dstHost || dst);
  if (!t) return 'safe';
  return t.confidence === 'low' ? 'warn' : 'danger';
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'egressview',
  version: require('./package.json').version,
});

// ① Threat summary ─────────────────────────────────────────────────────────────
server.tool(
  'get_threat_summary',
  'Counts sessions classified as safe / warn / danger for the given time period. ' +
  'Uses server-side GROUP BY for accuracy regardless of dataset size.',
  { period: PERIOD_ENUM.default('24h').describe('Time window') },
  ({ period }) => {
    const { from, to } = periodRange(period);
    const groups = history.groupDstByTimeRange(from, to);
    let safe = 0, warn = 0, danger = 0;
    for (const { dst, dstHost, cnt } of groups) {
      const lvl = threatLevel(dst, dstHost);
      if (lvl === 'safe') safe += cnt;
      else if (lvl === 'warn') warn += cnt;
      else danger += cnt;
    }
    return ok({ period, safe, warn, danger, total: safe + warn + danger });
  }
);

// ② Traffic summary ────────────────────────────────────────────────────────────
server.tool(
  'get_traffic_summary',
  'Returns total session count, unique destination count, and unique device count for the period.',
  { period: PERIOD_ENUM.default('24h').describe('Time window') },
  ({ period }) => {
    const { from, to } = periodRange(period);
    const total   = history.countByTimeRange(from, to);
    const summary = history.summarizeByTimeRange(from, to);
    return ok({
      period,
      totalSessions:      total,
      uniqueDestinations: summary.byDst.length,
      uniqueDevices:      summary.byDevice.length,
    });
  }
);

// ③ Top destinations ───────────────────────────────────────────────────────────
server.tool(
  'get_top_destinations',
  'Returns the most frequently contacted destinations, ranked by session count, with country, org, and threat level.',
  {
    period: PERIOD_ENUM.default('24h'),
    limit:  z.number().int().min(1).max(100).default(20).describe('Max rows to return'),
  },
  ({ period, limit }) => {
    const { from, to } = periodRange(period);
    const { byDst } = history.summarizeByTimeRange(from, to);
    const rows = byDst.slice(0, limit).map(d => ({
      dst:       d.dst,
      host:      d.dstHost  || null,
      country:   d.country  || null,
      org:       d.org      || null,
      sessions:  d.count,
      threat:    threatLevel(d.dst, d.dstHost),
      firstSeen: tsToIso(d.firstSeen),
      lastSeen:  tsToIso(d.lastSeen),
    }));
    return ok({ period, count: rows.length, destinations: rows });
  }
);

// ④ Device traffic ─────────────────────────────────────────────────────────────
server.tool(
  'get_device_traffic',
  'Per-device traffic. Omit src to list all devices. Pass src IP to get that device\'s top destinations.',
  {
    period: PERIOD_ENUM.default('24h'),
    src:    z.string().optional().describe('Source IP (omit for all devices)'),
    limit:  z.number().int().min(1).max(50).default(10),
  },
  ({ period, src, limit }) => {
    const { from, to } = periodRange(period);
    const summary = history.summarizeByTimeRange(from, to, { src: src || null });
    if (src) {
      const topDst = summary.byDst.slice(0, limit).map(d => ({
        dst:      d.dst,
        host:     d.dstHost || null,
        country:  d.country || null,
        org:      d.org     || null,
        sessions: d.count,
        threat:   threatLevel(d.dst, d.dstHost),
      }));
      return ok({ period, src, topDestinations: topDst });
    }
    const devRows = summary.byDevice.slice(0, limit).map(d => ({
      src:       d.src,
      mac:       d.srcMac    || null,
      vendor:    d.srcVendor || null,
      sessions:  d.count,
      firstSeen: tsToIso(d.firstSeen),
      lastSeen:  tsToIso(d.lastSeen),
    }));
    return ok({ period, count: devRows.length, devices: devRows });
  }
);

// ⑤ New nodes ──────────────────────────────────────────────────────────────────
server.tool(
  'get_new_nodes',
  'Lists devices and destinations that were seen for the very first time during the period ' +
  '(i.e. their global first-seen timestamp falls within the window).',
  { period: PERIOD_ENUM.default('24h') },
  ({ period }) => {
    const { from, to } = periodRange(period);
    const result = history.queryNewNodes(from, to);
    return ok({
      period,
      deviceCount:      result.deviceCount,
      destinationCount: result.destinationCount,
      newDevices:       result.newDevices.map(d => ({
        src:       d.src,
        mac:       d.srcMac     || null,
        vendor:    d.srcVendor  || null,
        dnsName:   d.srcDnsName || d.srcMdnsName || null,
        firstSeen: tsToIso(d.firstSeen),
      })),
      newDestinations: result.newDestinations.map(d => ({
        dst:       d.dst,
        host:      d.dstHost || null,
        country:   d.country || null,
        org:       d.org     || null,
        threat:    threatLevel(d.dst, d.dstHost),
        firstSeen: tsToIso(d.firstSeen),
      })),
    });
  }
);

// ⑥ Threat connections ─────────────────────────────────────────────────────────
server.tool(
  'get_threat_connections',
  'Lists destinations flagged as threats. confidence: "low"=warn, "high"=danger, "all"=both.',
  {
    period:     PERIOD_ENUM.default('24h'),
    confidence: z.enum(['low', 'high', 'all']).default('all'),
    limit:      z.number().int().min(1).max(200).default(50),
  },
  ({ period, confidence, limit }) => {
    const { from, to } = periodRange(period);
    const groups = history.groupDstByTimeRange(from, to);
    const hits = [];
    for (const { dst, dstHost, cnt } of groups) {
      const t = threatIntel.matchThreatIntel(dst, dstHost || dst);
      if (!t) continue;
      if (confidence === 'low'  && t.confidence !== 'low')  continue;
      if (confidence === 'high' && t.confidence !== 'high') continue;
      hits.push({
        dst,
        host:       dstHost       || null,
        sessions:   cnt,
        confidence: t.confidence,
        feed:       t.feed        || null,
        category:   t.category    || null,
      });
      if (hits.length >= limit) break;
    }
    hits.sort((a, b) => b.sessions - a.sessions);
    return ok({ period, confidence, count: hits.length, threats: hits });
  }
);

// ⑦ Alerts ────────────────────────────────────────────────────────────────────
server.tool(
  'get_alerts',
  'Returns recent detection alerts from the notification log (threats, new devices, beacons).',
  {
    period: PERIOD_ENUM.default('24h'),
    limit:  z.number().int().min(1).max(200).default(50),
  },
  ({ period, limit }) => {
    const { from, to } = periodRange(period);
    const rows = history.queryNotificationLog(from, to).slice(0, limit);
    const alerts = rows.map(r => ({
      type:       r.type,
      detectedAt: tsToIso(r.detectedAt),
      dst:        r.dst        || null,
      src:        r.src        || null,
      feed:       r.feed       || null,
      confidence: r.confidence || null,
      detail:     r.detail     || null,
    }));
    return ok({ period, count: alerts.length, alerts });
  }
);

// ⑧ Devices ───────────────────────────────────────────────────────────────────
server.tool(
  'get_devices',
  'Lists all known devices with MAC address, vendor, names, status, and last-seen time.',
  {
    include_archived: z.boolean().default(false).describe('Include archived/merged devices'),
  },
  ({ include_archived }) => {
    const devs = devices.getAll({ includeArchived: include_archived }).map(d => ({
      deviceId:  d.deviceId,
      ip:        d.ip,
      mac:       d.mac       || null,
      vendor:    d.vendor    || null,
      dnsName:   d.dnsName   || null,
      mdnsName:  d.mdnsName  || null,
      status:    d.status,
      firstSeen: tsToIso(d.firstSeen),
      lastSeen:  tsToIso(d.lastSeen),
    }));
    return ok({ count: devs.length, devices: devs });
  }
);

// ⑨ Query connections ─────────────────────────────────────────────────────────
server.tool(
  'query_connections',
  'Searches the connection log with optional src/dst filters. Returns matching rows with threat assessment.',
  {
    period: PERIOD_ENUM.default('24h'),
    src:    z.string().optional().describe('Filter by source IP or hostname (contains match)'),
    dst:    z.string().optional().describe('Filter by destination IP or hostname (contains match)'),
    limit:  z.number().int().min(1).max(500).default(100),
  },
  ({ period, src, dst, limit }) => {
    const { from, to } = periodRange(period);
    const filters = {};
    if (src) filters.src = { mode: 'contains', value: src };
    if (dst) filters.dst = { mode: 'contains', value: dst };
    const rows = history.queryByTimeRangePaged(from, to, limit, 0, { filters });
    const out = rows.map(r => ({
      src:       r.src,
      dst:       r.dst,
      host:      r.dstHost  || null,
      dport:     r.dport,
      proto:     r.proto,
      country:   r.country  || null,
      org:       r.org      || null,
      threat:    threatLevel(r.dst, r.dstHost),
      firstSeen: tsToIso(r.firstSeen),
      lastSeen:  tsToIso(r.lastSeen),
    }));
    return ok({ period, src: src || null, dst: dst || null, count: out.length, connections: out });
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[egressview-mcp] ${err.message}\n`);
  process.exit(1);
});
