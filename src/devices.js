// Device inventory: aggregates IP/MAC/name/vendor data from all sources into a single table.
// Sources: connection history (NAT/INSPECT), DHCP events, ARP/NDP, mDNS, investigation results.
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');

let db        = null;
let _dbPath   = DB_PATH;   // remembers the path used, so reopen() uses the same one
let stmtUpsert            = null;
let stmtSelectAll         = null;
let stmtSelectIp          = null;
let stmtSelectMac         = null;
let stmtSelectDeviceId    = null;
let stmtLastObservation   = null;
let stmtInsertObservation = null;

// ─── isStableMac ──────────────────────────────────────────────────────────────

/**
 * Returns true if mac is a globally unique (OUI-assigned) hardware MAC.
 * Returns false for:
 *   - privacy / locally-administered MACs (bit1 of first octet = 1)
 *   - broadcast (ff:ff:ff:ff:ff:ff)
 *   - all-zero (00:00:00:00:00:00)
 *   - invalid / null input
 *
 * Only globally unique MACs are stable enough to use as device-identity anchors.
 */
function isStableMac(mac) {
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) return false;
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') return false;
  const first = parseInt(mac.split(':')[0], 16);
  return (first & 0x02) === 0;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initDb(dbPath) {
  // Re-use connection history DB (same file), or use provided path for tests
  _dbPath = dbPath || DB_PATH;
  db = new Database(_dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // ── Core devices table (legacy schema; deviceId added below via migration) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      ip          TEXT PRIMARY KEY,
      mac         TEXT,
      vendor      TEXT,
      dnsName     TEXT,
      mdnsName    TEXT,
      netbiosName TEXT,
      ipv6Addr    TEXT,
      firstSeen   INTEGER NOT NULL,
      lastSeen    INTEGER NOT NULL,
      sources     TEXT NOT NULL DEFAULT '',
      noteKey     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_mac     ON devices(mac);
    CREATE INDEX IF NOT EXISTS idx_devices_lastSeen ON devices(lastSeen);
  `);

  // Step 1a — migrate: add deviceId column if absent ──────────────────────────
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!cols.includes('deviceId')) {
    db.exec('ALTER TABLE devices ADD COLUMN deviceId TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_deviceId ON devices(deviceId)');

  // Step 1a — backfill: assign UUIDs to rows that predate this migration ───────
  const _backfill = db.transaction(() => {
    const rows = db.prepare('SELECT ip FROM devices WHERE deviceId IS NULL').all();
    const fill = db.prepare('UPDATE devices SET deviceId = ? WHERE ip = ?');
    for (const row of rows) {
      fill.run(crypto.randomUUID(), row.ip);
    }
  });
  _backfill();

  // Step 2 — device_observations table ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId    TEXT    NOT NULL,
      observedAt  INTEGER NOT NULL,
      source      TEXT    NOT NULL,
      ip          TEXT,
      mac         TEXT,
      ipv6        TEXT,
      hostname    TEXT,
      mdnsName    TEXT,
      netbiosName TEXT,
      asusName    TEXT,
      vendor      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_obs_deviceId
      ON device_observations(deviceId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_source
      ON device_observations(source, observedAt DESC);
  `);

  // ── Prepared statements ──────────────────────────────────────────────────────

  // RETURNING deviceId lets us get the canonical deviceId in one round-trip.
  // For new rows:     returns the @deviceId we passed in.
  // For existing rows: COALESCE(deviceId, excluded.deviceId) keeps the stored one.
  stmtUpsert = db.prepare(`
    INSERT INTO devices
      (ip, mac, vendor, dnsName, mdnsName, netbiosName, ipv6Addr,
       firstSeen, lastSeen, sources, noteKey, deviceId)
    VALUES
      (@ip, @mac, @vendor, @dnsName, @mdnsName, @netbiosName, @ipv6Addr,
       @firstSeen, @lastSeen, @sources, @noteKey, @deviceId)
    ON CONFLICT(ip) DO UPDATE SET
      mac         = COALESCE(@mac,         mac),
      vendor      = COALESCE(@vendor,      vendor),
      dnsName     = COALESCE(@dnsName,     dnsName),
      mdnsName    = COALESCE(@mdnsName,    mdnsName),
      netbiosName = COALESCE(@netbiosName, netbiosName),
      ipv6Addr    = COALESCE(@ipv6Addr,    ipv6Addr),
      firstSeen   = MIN(firstSeen, @firstSeen),
      lastSeen    = MAX(lastSeen,  @lastSeen),
      sources     = CASE
        WHEN instr(sources, @newSource) > 0 THEN sources
        WHEN sources = ''                   THEN @newSource
        ELSE sources || ',' || @newSource
      END,
      noteKey     = COALESCE(@noteKey,     noteKey),
      deviceId    = COALESCE(deviceId,     excluded.deviceId)
    RETURNING deviceId
  `);

  stmtSelectAll      = db.prepare('SELECT * FROM devices ORDER BY lastSeen DESC');
  stmtSelectIp       = db.prepare('SELECT * FROM devices WHERE ip = ?');
  stmtSelectMac      = db.prepare('SELECT * FROM devices WHERE mac = ?');
  stmtSelectDeviceId = db.prepare('SELECT * FROM devices WHERE deviceId = ?');

  stmtLastObservation = db.prepare(`
    SELECT ip, mac, ipv6, hostname, mdnsName, netbiosName, asusName, vendor
    FROM   device_observations
    WHERE  deviceId = ? AND source = ?
    ORDER  BY observedAt DESC
    LIMIT  1
  `);

  stmtInsertObservation = db.prepare(`
    INSERT INTO device_observations
      (deviceId, observedAt, source, ip, mac, ipv6, hostname, mdnsName, netbiosName, asusName, vendor)
    VALUES
      (@deviceId, @observedAt, @source,
       @ip, @mac, @ipv6, @hostname, @mdnsName, @netbiosName, @asusName, @vendor)
  `);
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upsert a device observation into the summary devices table.
 * Returns the canonical deviceId for this device (existing or newly assigned).
 *
 * @param {object} d
 * @param {string}  d.ip          Required
 * @param {string}  [d.deviceId]  Pass to preserve a specific deviceId (e.g. from MAC-based lookup)
 * @param {string}  [d.mac]
 * @param {string}  [d.vendor]
 * @param {string}  [d.dnsName]
 * @param {string}  [d.mdnsName]
 * @param {string}  [d.netbiosName]
 * @param {string}  [d.ipv6Addr]
 * @param {number}  [d.firstSeen]
 * @param {number}  [d.lastSeen]
 * @param {string}  [d.source]    Short tag, e.g. 'nat', 'dhcp', 'inspect', 'arp', 'mdns'
 * @param {string}  [d.noteKey]
 * @returns {string|null}  deviceId
 */
function upsert(d) {
  if (!db) return null;
  const now = Date.now();
  const row = stmtUpsert.get({
    ip:          d.ip,
    mac:         d.mac         || null,
    vendor:      d.vendor      || null,
    dnsName:     d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    ipv6Addr:    d.ipv6Addr    || null,
    firstSeen:   d.firstSeen   ?? now,
    lastSeen:    d.lastSeen    ?? now,
    sources:     d.source      || '',
    newSource:   d.source      || '',
    noteKey:     d.noteKey     || null,
    deviceId:    d.deviceId    || crypto.randomUUID(),
  });
  return row?.deviceId || null;
}

// ─── observeDevice ────────────────────────────────────────────────────────────

/**
 * Higher-level device tracking.  In addition to updating the devices summary
 * table (like upsert), it:
 *   1. Attempts stable-MAC auto-linking: if the IP is new but the MAC is
 *      globally unique and matches exactly one known device, the existing
 *      deviceId is reused and the row's IP is migrated.
 *   2. Writes a device_observation only when attributes actually change
 *      (write-on-change policy).
 *
 * @param {object} d  — same shape as upsert(), plus optional `ipv6` / `asusName`
 * @returns {string|null}  deviceId
 */
function observeDevice(d) {
  if (!db) return null;
  const now = Date.now();

  // ── 1. Look up by IP ──────────────────────────────────────────────────────
  let existingDevice = d.ip ? stmtSelectIp.get(d.ip) : null;

  // ── 2. Stable-MAC auto-link (step 4) ──────────────────────────────────────
  // When the IP is new but the MAC is globally-unique and we recognise it,
  // migrate the existing device row to the new IP instead of creating a new one.
  if (!existingDevice && d.mac && isStableMac(d.mac)) {
    const byMac = stmtSelectMac.all(d.mac);
    if (byMac.length === 1 && d.ip) {
      const candidate = byMac[0];
      // Only migrate if the new IP is not already occupied by a different device
      const newIpTaken = stmtSelectIp.get(d.ip);
      if (!newIpTaken) {
        db.prepare('UPDATE devices SET ip = ?, lastSeen = ? WHERE deviceId = ?')
          .run(d.ip, now, candidate.deviceId);
        existingDevice = { ...candidate, ip: d.ip };
      }
    }
  }

  // ── 3. Upsert summary table ───────────────────────────────────────────────
  const deviceId = upsert({
    ip:          d.ip,
    mac:         d.mac         || null,
    vendor:      d.vendor      || null,
    dnsName:     d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    ipv6Addr:    d.ipv6Addr    || d.ipv6 || null,
    firstSeen:   d.firstSeen   ?? now,
    lastSeen:    d.lastSeen    ?? now,
    source:      d.source,
    noteKey:     d.noteKey     || null,
    deviceId:    existingDevice?.deviceId,   // pass canonical id; upsert won't overwrite if row already has one
  });

  // ── 4. Write observation (write-on-change) ────────────────────────────────
  const attrs = {
    ip:          d.ip          || null,
    mac:         d.mac         || null,
    ipv6:        d.ipv6        || d.ipv6Addr || null,
    hostname:    d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    asusName:    d.asusName    || null,
    vendor:      d.vendor      || null,
  };

  if (deviceId && _hasObservationChanged(deviceId, d.source || 'nat', attrs)) {
    stmtInsertObservation.run({
      deviceId,
      observedAt:  now,
      source:      d.source || 'nat',
      ...attrs,
    });
  }

  return deviceId;
}

/** Returns true when the new attribute set differs from the last stored observation. */
function _hasObservationChanged(deviceId, source, attrs) {
  const last = stmtLastObservation.get(deviceId, source);
  if (!last) return true;
  const keys = ['ip', 'mac', 'ipv6', 'hostname', 'mdnsName', 'netbiosName', 'asusName', 'vendor'];
  return keys.some(k => (attrs[k] || null) !== (last[k] || null));
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** @returns {Array} all devices, newest-last-seen first */
function getAll() {
  if (!db) return [];
  return stmtSelectAll.all();
}

/** @returns {object|null} */
function getByIp(ip) {
  if (!db) return null;
  return stmtSelectIp.get(ip) || null;
}

/** @returns {Array} */
function getByMac(mac) {
  if (!db) return [];
  return stmtSelectMac.all(mac);
}

/** @returns {object|null} */
function getByDeviceId(deviceId) {
  if (!db) return null;
  return stmtSelectDeviceId.get(deviceId) || null;
}

// ─── Populate from existing connection history ─────────────────────────────

/**
 * Seed devices table from connection history at startup.
 * Runs once; rows already present are updated (UPSERT is idempotent).
 */
function seedFromConnectionHistory(connectionHistory) {
  if (!db) return;
  const seed = db.transaction(() => {
    for (const entry of connectionHistory.values()) {
      if (!entry.src) continue;
      upsert({
        ip:        entry.src,
        mac:       entry.srcMac      || null,
        vendor:    entry.srcVendor   || null,
        dnsName:   entry.srcDnsName  || null,
        mdnsName:  entry.srcMdnsName || null,
        firstSeen: entry.firstSeen,
        lastSeen:  entry.lastSeen,
        source:    'nat',
      });
    }
  });
  seed();
}

// ─── Reopen (after backup restore) ────────────────────────────────────────────

/**
 * Close the current connection and reopen the DB file.
 * Call this after backup.restoreFromGeneration / restoreFromFile so the module
 * reads the restored data rather than the stale in-memory SQLite connection.
 */
function reopen() {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(_dbPath);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function _initForTest() {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(':memory:');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  reopen,
  upsert,
  observeDevice,
  getAll,
  getByIp,
  getByMac,
  getByDeviceId,
  isStableMac,
  seedFromConnectionHistory,
  _initForTest,
};
