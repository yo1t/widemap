// Connection history: load, append, snapshot, compact
'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // delete after 7 days
const HISTORY_LOG = path.join(__dirname, '..', '.widemap.connections.jsonl');

const connectionHistory = new Map(); // key = `${src}|${dst}|${dport}|${proto}`

// Load history log on startup (JSON Lines, latest line wins)
function loadConnectionHistory() {
  try {
    const data = fs.readFileSync(HISTORY_LOG, 'utf8');
    const cutoff = Date.now() - HISTORY_TTL_MS;
    let total = 0, kept = 0;
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      total++;
      try {
        const e = JSON.parse(line);
        if (!e.src || !e.dst || (e.lastSeen || 0) < cutoff) continue;
        const key = `${e.src}|${e.dst}|${e.dport}|${e.proto}`;
        const existing = connectionHistory.get(key);
        if (!existing) {
          connectionHistory.set(key, e);
        } else {
          existing.lastSeen  = Math.max(existing.lastSeen  || 0, e.lastSeen  || 0);
          existing.firstSeen = Math.min(existing.firstSeen || Infinity, e.firstSeen || Infinity);
          Object.assign(existing, {
            dstHost: e.dstHost || existing.dstHost,
            country: e.country || existing.country,
            org:     e.org     || existing.org,
            lat:     e.lat     ?? existing.lat,
            lon:     e.lon     ?? existing.lon,
            city:    e.city    || existing.city,
            ttl:     e.ttl     ?? existing.ttl,
          });
        }
        kept++;
      } catch {}
    }
    console.log(`[history] Loaded ${kept}/${total} entries → ${connectionHistory.size} unique sessions`);
  } catch {
    console.log('[history] No history log');
  }
}

// Append a single entry to the log (call on new discovery only)
function appendHistoryLog(entry) {
  fs.appendFile(HISTORY_LOG, JSON.stringify(entry) + '\n', err => {
    if (err) console.error('[history] append error:', err.message);
  });
}

// Periodic snapshot: write the latest lastSeen of existing entries to the log
function snapshotHistory() {
  if (connectionHistory.size === 0) return;
  const lines = [];
  for (const e of connectionHistory.values()) {
    lines.push(JSON.stringify(e));
  }
  fs.appendFile(HISTORY_LOG, lines.join('\n') + '\n', err => {
    if (err) console.error('[history] snapshot error:', err.message);
    else console.log(`[history] Snapshot ${lines.length} entries`);
  });
}

// Rewrite the entire old log (deduplicate lines + drop entries past TTL)
function compactHistoryLog() {
  if (connectionHistory.size === 0) return;
  try {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    const lines = [];
    for (const e of connectionHistory.values()) {
      if ((e.lastSeen || 0) >= cutoff) lines.push(JSON.stringify(e));
    }
    fs.writeFileSync(HISTORY_LOG, lines.join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(HISTORY_LOG, 0o600); } catch {}
    console.log(`[history] Compacted to ${lines.length} entries`);
  } catch (e) {
    console.error('[history] compact error:', e.message);
  }
}

// Prune old entries from history
function pruneHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const [k, v] of connectionHistory) {
    if (v.lastSeen < cutoff) connectionHistory.delete(k);
  }
}

function getConnectionHistory() { return connectionHistory; }

module.exports = {
  loadConnectionHistory,
  appendHistoryLog,
  snapshotHistory,
  compactHistoryLog,
  pruneHistory,
  getConnectionHistory,
  HISTORY_TTL_MS,
};
