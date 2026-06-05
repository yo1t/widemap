// Connection history: SQLite-backed storage (sql.js — pure JS, no native build)
'use strict';

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');
const JSONL_PATH = path.join(__dirname, '..', '.widemap.connections.jsonl');
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let db = null;

// In-memory cache (same interface as before for Socket.IO emissions)
const connectionHistory = new Map();

function saveDbToFile() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('[history] Failed to save DB:', err.message);
  }
}

async function initDb() {
  const SQL = await initSqlJs();

  // Load existing DB file if present
  if (fs.existsSync(DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
      console.log('[history] SQLite database loaded from file');
    } catch (err) {
      console.error('[history] Failed to load DB, creating new:', err.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS connections (
      src       TEXT NOT NULL,
      dst       TEXT NOT NULL,
      dport     INTEGER NOT NULL,
      proto     TEXT NOT NULL,
      sport     INTEGER,
      ttl       INTEGER,
      srcMac    TEXT,
      srcVendor TEXT,
      srcDnsName  TEXT,
      srcMdnsName TEXT,
      dstHost   TEXT,
      country   TEXT,
      org       TEXT,
      lat       REAL,
      lon       REAL,
      city      TEXT,
      firstSeen INTEGER NOT NULL,
      lastSeen  INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lastSeen ON connections(lastSeen)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_src ON connections(src)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dst ON connections(dst)`);

  console.log('[history] SQLite database initialized');
}

function upsertEntry(entry) {
  if (!db) return;
  db.run(`
    INSERT INTO connections (src, dst, dport, proto, sport, ttl, srcMac, srcVendor, srcDnsName, srcMdnsName, dstHost, country, org, lat, lon, city, firstSeen, lastSeen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(src, dst, dport, proto) DO UPDATE SET
      sport = COALESCE(?, sport),
      ttl = COALESCE(?, ttl),
      srcMac = COALESCE(?, srcMac),
      srcVendor = COALESCE(?, srcVendor),
      srcDnsName = COALESCE(?, srcDnsName),
      srcMdnsName = COALESCE(?, srcMdnsName),
      dstHost = COALESCE(?, dstHost),
      country = COALESCE(?, country),
      org = COALESCE(?, org),
      lat = COALESCE(?, lat),
      lon = COALESCE(?, lon),
      city = COALESCE(?, city),
      firstSeen = MIN(firstSeen, ?),
      lastSeen = MAX(lastSeen, ?)
  `, [
    entry.src, entry.dst, entry.dport ?? 0, entry.proto || 'TCP',
    entry.sport ?? null, entry.ttl ?? null,
    entry.srcMac || null, entry.srcVendor || null,
    entry.srcDnsName || null, entry.srcMdnsName || null,
    entry.dstHost || null, entry.country || null, entry.org || null,
    entry.lat ?? null, entry.lon ?? null, entry.city || null,
    entry.firstSeen || Date.now(), entry.lastSeen || Date.now(),
    // ON CONFLICT values:
    entry.sport ?? null, entry.ttl ?? null,
    entry.srcMac || null, entry.srcVendor || null,
    entry.srcDnsName || null, entry.srcMdnsName || null,
    entry.dstHost || null, entry.country || null, entry.org || null,
    entry.lat ?? null, entry.lon ?? null, entry.city || null,
    entry.firstSeen || Date.now(), entry.lastSeen || Date.now(),
  ]);
}

// Migrate from JSONL to SQLite (one-time)
function migrateFromJsonl() {
  if (!fs.existsSync(JSONL_PATH)) return;

  console.log('[history] Migrating JSONL to SQLite...');
  const data = fs.readFileSync(JSONL_PATH, 'utf8');
  const cutoff = Date.now() - HISTORY_TTL_MS;
  let imported = 0, skipped = 0;

  db.run('BEGIN TRANSACTION');
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.src || !e.dst || (e.lastSeen || 0) < cutoff) { skipped++; continue; }
      upsertEntry(e);
      imported++;
    } catch { skipped++; }
  }
  db.run('COMMIT');
  saveDbToFile();

  // Rename old file
  const migratedPath = JSONL_PATH + '.migrated';
  fs.renameSync(JSONL_PATH, migratedPath);
  console.log(`[history] Migration complete: ${imported} imported, ${skipped} skipped → ${migratedPath}`);
}

// Load all active entries into memory cache
function loadIntoMemory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  const stmt = db.prepare(`SELECT * FROM connections WHERE lastSeen >= ?`);
  stmt.bind([cutoff]);
  connectionHistory.clear();
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const key = `${row.src}|${row.dst}|${row.dport}|${row.proto}`;
    connectionHistory.set(key, row);
  }
  stmt.free();
  console.log(`[history] Loaded ${connectionHistory.size} sessions from SQLite`);
}

// Public API

async function loadConnectionHistory() {
  await initDb();
  migrateFromJsonl();
  loadIntoMemory();
}

function appendHistoryLog(entry) {
  try {
    upsertEntry(entry);
  } catch (err) {
    console.error('[history] upsert error:', err.message);
  }
}

// Batch sync: persist in-memory state to disk
function snapshotHistory() {
  if (!db || connectionHistory.size === 0) return;
  db.run('BEGIN TRANSACTION');
  for (const entry of connectionHistory.values()) {
    upsertEntry(entry);
  }
  db.run('COMMIT');
  saveDbToFile();
  console.log(`[history] Snapshot ${connectionHistory.size} entries to SQLite`);
}

// Delete old entries from both SQLite and memory
function compactHistoryLog() {
  if (!db) return;
  const cutoff = Date.now() - HISTORY_TTL_MS;
  db.run(`DELETE FROM connections WHERE lastSeen < ?`, [cutoff]);
  saveDbToFile();
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const [k, v] of connectionHistory) {
    if (v.lastSeen < cutoff) connectionHistory.delete(k);
  }
}

function getConnectionHistory() { return connectionHistory; }

function closeDb() {
  if (db) {
    try { saveDbToFile(); db.close(); } catch {}
    db = null;
  }
}

module.exports = {
  loadConnectionHistory,
  appendHistoryLog,
  snapshotHistory,
  compactHistoryLog,
  pruneHistory,
  getConnectionHistory,
  closeDb,
  HISTORY_TTL_MS,
};
