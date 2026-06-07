#!/bin/bash
# Widemap server control script
# Usage: start.sh [start|stop|status]
# On EC2, delegates to systemd. Locally, manages a PID file.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.widemap.pid"
CMD="${1:-start}"

# On EC2 with systemd service, delegate
if systemctl list-units --type=service 2>/dev/null | grep -q 'widemap.service'; then
  exec sudo systemctl "$CMD" widemap
fi

# Local fallback (PID file based)
case "$CMD" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "widemap is already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    cd "$SCRIPT_DIR"
    if [ -f .env ]; then
      set -o allexport
      # shellcheck disable=SC1091
      source .env
      set +o allexport
    fi
    nohup node server.js >> /tmp/widemap.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "widemap started (PID $!)"
    ;;
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
      echo "widemap stopped"
    else
      echo "widemap is not running"
      rm -f "$PID_FILE"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "widemap is running (PID $(cat "$PID_FILE"))"
    else
      echo "widemap is not running"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
