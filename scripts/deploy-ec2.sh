#!/bin/bash
# Deploy EgressView to EC2 via rsync.
# Production data files (DB, config, notes, certs, logs) are never overwritten.
#
# Usage:
#   ./scripts/deploy-ec2.sh
#
# Environment overrides:
#   EC2_KEY    path to SSH private key   (default: ~/pem/tkywave2014.pem)
#   EC2_USER   SSH user                  (default: ec2-user)
#   EC2_HOST   EC2 host/IP               (default: 10.41.128.183)
#   EC2_DIR    remote app directory      (default: ~/egressview)

set -euo pipefail

EC2_KEY="${EC2_KEY:-$HOME/pem/tkywave2014.pem}"
EC2_USER="${EC2_USER:-ec2-user}"
EC2_HOST="${EC2_HOST:-10.41.128.183}"
EC2_DIR="${EC2_DIR:-~/egressview}"
SSH_OPTS="-i $EC2_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15"

echo "=== Deploying to $EC2_USER@$EC2_HOST:$EC2_DIR ==="

rsync -avz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.egressview.json' \
  --exclude='.egressview.db' \
  --exclude='.egressview.db-shm' \
  --exclude='.egressview.db-wal' \
  --exclude='.egressview-upload-temp.db' \
  --exclude='.egressview-backups/' \
  --exclude='.egressview.notes.json' \
  --exclude='.egressview-cert.pem' \
  --exclude='.egressview-key.pem' \
  --exclude='.env' \
  --exclude='.env.mcp' \
  --exclude='server.log' \
  --exclude='backlog.md' \
  --exclude='test-results' \
  --exclude='.egressview.pid' \
  -e "ssh $SSH_OPTS" \
  "$(dirname "$0")/../" \
  "$EC2_USER@$EC2_HOST:$EC2_DIR/"

echo "=== Files synced — restarting server ==="

# shellcheck disable=SC2029
ssh $SSH_OPTS "$EC2_USER@$EC2_HOST" "
  set -e
  cd $EC2_DIR

  # Kill only the EgressView main server (identified by port from .env)
  PORT=\$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
  PORT=\${PORT:-3002}
  PID=\$(ss -tlnp 2>/dev/null | grep \":\$PORT \" | grep -o 'pid=[0-9]*' | grep -o '[0-9]*' | head -1)
  if [ -n \"\$PID\" ]; then
    kill \"\$PID\" && sleep 2 && echo \"Stopped server (PID \$PID, port \$PORT)\"
  else
    echo 'No server found on port '\$PORT', starting fresh'
  fi

  nohup node server.js > server.log 2>&1 < /dev/null &
  sleep 5
  echo '--- server.log (last 10 lines) ---'
  tail -10 server.log
"

echo "=== Deploy complete ==="
