// Shared utility functions
'use strict';

// ── SSRF protection: allow only private IP ranges ─────────────────────
function isAllowedRouterIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1]), parseInt(m[2])];
  if (a > 255 || b > 255 || parseInt(m[3]) > 255 || parseInt(m[4]) > 255) return false;
  // Explicitly reject 169.254.0.0/16 (link-local, AWS metadata, etc.)
  if (a === 169 && b === 254) return false;
  // Reject 127.0.0.0/8 (loopback) to prevent attacks on this server
  if (a === 127) return false;
  // Allow only 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ── HTML escape (used for template replacement) ──
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

module.exports = { isAllowedRouterIp, htmlEscape };
