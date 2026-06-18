// TLS certificate loading / self-signed generation for HTTPS opt-in
'use strict';
const logger = require('./logger');

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_CERT = '.egressview-cert.pem';
const DEFAULT_KEY  = '.egressview-key.pem';

/**
 * Return `{ key, cert }` for https.createServer, or null on failure.
 *
 * - If `certPath` / `keyPath` are set, load those files (user-provided cert).
 * - Otherwise use (or create) a self-signed cert in `appRoot`.  Generation
 *   uses the `openssl` CLI so no extra npm dependency is needed; the result
 *   is reused across restarts (10-year validity).
 *
 * @param {{certPath?: string, keyPath?: string}} cfg
 * @param {string} appRoot
 */
function loadOrCreate(cfg = {}, appRoot = process.cwd()) {
  let certFile = cfg.certPath || path.join(appRoot, DEFAULT_CERT);
  let keyFile  = cfg.keyPath  || path.join(appRoot, DEFAULT_KEY);
  const userProvided = Boolean(cfg.certPath || cfg.keyPath);

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    if (userProvided) {
      logger.error(`[tls] Certificate not found: ${certFile} / ${keyFile}`);
      return null;
    }
    try {
      logger.info('[tls] Generating self-signed certificate (2-year validity)…');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-nodes',
        '-keyout', keyFile, '-out', certFile,
        '-days', '730', '-subj', '/CN=egressview',
      ], { stdio: 'pipe' });
      fs.chmodSync(keyFile, 0o600);
      logger.info(`[tls] Created ${path.basename(certFile)} / ${path.basename(keyFile)}`);
    } catch (e) {
      logger.error('[tls] Self-signed certificate generation failed:', e.message);
      return null;
    }
  }

  try {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch (e) {
    logger.error('[tls] Failed to read certificate files:', e.message);
    return null;
  }
}

module.exports = { loadOrCreate };
