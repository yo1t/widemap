# AI Agent Access via MCP

EgressView exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants — Claude Desktop, Claude Code, Cursor, Zed, and any MCP-compatible agent — query your network data directly.

> 🇯🇵 [日本語版はこちら](setup-mcp.ja.md)

## Available Tools

| Tool | What it returns |
|---|---|
| `get_threat_summary` | safe / warn / danger session counts for a time period |
| `get_traffic_summary` | total sessions, unique destinations, unique devices |
| `get_top_destinations` | top contacted destinations (ranked by session count, with country, org, threat level) |
| `get_device_traffic` | per-device traffic; pass a src IP to get one device's top destinations |
| `get_new_nodes` | devices and destinations first seen during the period |
| `get_threat_connections` | destinations flagged as threats (low/high confidence) |
| `get_alerts` | detection log entries (threats, new devices, beacons) |
| `get_devices` | all known LAN devices with MAC, vendor, status, last-seen |
| `query_connections` | connection log search with src/dst filters |

All tools accept a `period` parameter: `1h`, `6h`, `24h` (default), `7d`, or `14d`.

---

## Option A — stdio (local, simplest)

Run the MCP server on the same machine as Claude Desktop. It calls EgressView's REST API over HTTP.

**Prerequisites:** Node.js 18+, a running EgressView instance, admin token.

```bash
# 1. Clone (if not already):
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install

# 2. Copy and edit the env file:
cp .env.mcp.example .env.mcp
# Edit EGRESSVIEW_URL and EGRESSVIEW_TOKEN in .env.mcp
```

**Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "egressview": {
      "command": "node",
      "args": ["/absolute/path/to/egressview/mcp-server.js"],
      "env": {
        "EGRESSVIEW_URL":   "http://your-server-ip:3002",
        "EGRESSVIEW_TOKEN": "your-admin-token"
      }
    }
  }
}
```

Restart Claude Desktop after editing. The `egressview` server appears in the MCP tools list.

---

## Option B — HTTP via reverse proxy (remote access)

Run `mcp-server.js` as an HTTP server on the same host as EgressView. A reverse proxy (Apache or nginx) exposes it externally. Claude Desktop connects to the proxy URL — no local Node.js process needed.

### Step 1 — Start the MCP server on your EgressView host

```bash
# Copy and edit:
cp .env.mcp.example .env.mcp
# Set MCP_PORT=3010, EGRESSVIEW_URL=http://localhost:3002, EGRESSVIEW_TOKEN=...
chmod 600 .env.mcp

# Test run:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

### Step 2a — Apache (httpd) config

Add inside your existing `<VirtualHost>` or server config. The MCP block **must come before** the general `/egressview/` ProxyPass rule.

```apache
# ─── EgressView MCP Server ────────────────────────────────────────────────────
<Location /egressview/mcp>
    ProxyPass        http://127.0.0.1:3010/mcp flushpackets=on
    ProxyPassReverse http://127.0.0.1:3010/mcp
    # MCP Streamable HTTP requires both content types in Accept
    RequestHeader set Accept "application/json, text/event-stream"
</Location>

# ─── EgressView Web UI (existing rule — keep below) ──────────────────────────
ProxyPass        /egressview/ http://127.0.0.1:3002/
ProxyPassReverse /egressview/ http://127.0.0.1:3002/
```

Required Apache modules: `mod_proxy`, `mod_proxy_http`, `mod_headers` (usually enabled by default).

```bash
sudo apachectl configtest && sudo systemctl reload httpd
```

### Step 2b — nginx config

Add inside your `server {}` block:

```nginx
location /egressview/mcp {
    proxy_pass         http://127.0.0.1:3010/mcp;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-Proto $scheme;
    # Required for Server-Sent Events (streaming responses)
    proxy_set_header   Accept            "application/json, text/event-stream";
    proxy_set_header   Connection        '';
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 3600s;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Step 3 — Run as a systemd service (optional but recommended)

```ini
# /etc/systemd/system/egressview-mcp.service
[Unit]
Description=EgressView MCP Server
After=network.target egressview.service

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/egressview
EnvironmentFile=/home/ec2-user/egressview/.env.mcp
ExecStart=/usr/bin/node /home/ec2-user/egressview/mcp-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now egressview-mcp
```

### Step 4 — Claude Desktop config (HTTP mode)

```json
{
  "mcpServers": {
    "egressview": {
      "url": "http://your-server-ip/egressview/mcp",
      "headers": {
        "X-Admin-Token": "your-admin-token"
      }
    }
  }
}
```

Use `https://` if your reverse proxy terminates TLS.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `EGRESSVIEW_URL` | ✅ | `http://localhost:3002` | Base URL of the EgressView server |
| `EGRESSVIEW_TOKEN` | ✅ | — | Admin token (shown on first EgressView startup) |
| `MCP_PORT` | HTTP mode | — | Local port for the MCP HTTP server (e.g. `3010`). Omit for stdio mode. |
| `MCP_TOKEN` | — | same as `EGRESSVIEW_TOKEN` | Auth token for the MCP HTTP endpoint. Set to a different value to separate MCP and EgressView auth. |

---

## Security Notes

- The MCP HTTP server listens on `127.0.0.1` only — it is not reachable without the reverse proxy.
- Authentication uses the `X-Admin-Token` header (same mechanism as the EgressView API).
- The MCP server only reads data; it has no write access to EgressView's database.
- Keep `.env.mcp` permissions at `chmod 600`; it contains your admin token.
