#!/usr/bin/env bash
#
# Prepares notify-server on a fresh host: generates the two secrets, writes
# .env, and optionally installs a systemd unit.
#
#   bash scripts/setup-server.sh              # write .env, print what to do next
#   bash scripts/setup-server.sh --systemd    # also install and start the service
#
# Safe to re-run: an existing .env is never overwritten.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/packages/notify-server"
ENV_FILE="$SERVER_DIR/.env"
SERVICE_NAME="claude-usage-relay"

install_systemd=false
[[ "${1:-}" == "--systemd" ]] && install_systemd=true

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

random_hex() {
  node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"
}

# --- .env ------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  echo "Keeping the existing $ENV_FILE"
  relay_token="$(grep -E '^RELAY_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  ntfy_topic="$(grep -E '^NTFY_TOPIC=' "$ENV_FILE" | cut -d= -f2- || true)"
else
  relay_token="$(random_hex 32)"
  ntfy_topic="claude-$(random_hex 8)"

  cp "$SERVER_DIR/.env.example" "$ENV_FILE"

  # Fill in the two generated values; everything else keeps its documented default.
  node - "$ENV_FILE" "$relay_token" "$ntfy_topic" <<'NODE'
const fs = require('node:fs');
const [file, token, topic] = process.argv.slice(2);
const updated = fs.readFileSync(file, 'utf8')
  .replace(/^RELAY_TOKEN=.*$/m, `RELAY_TOKEN=${token}`)
  .replace(/^NTFY_TOPIC=.*$/m, `NTFY_TOPIC=${topic}`);
fs.writeFileSync(file, updated);
NODE

  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE"
fi

# --- systemd ---------------------------------------------------------------
if $install_systemd; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found - skipping service installation." >&2
    exit 1
  fi

  unit="/etc/systemd/system/${SERVICE_NAME}.service"
  echo "Installing $unit (sudo required)"

  sudo tee "$unit" >/dev/null <<UNIT
[Unit]
Description=claude-usage-relay notify-server
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$SERVER_DIR
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  sleep 1
  sudo systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
fi

# --- what to do next -------------------------------------------------------
cat <<SUMMARY

------------------------------------------------------------------
Server is configured.

  ntfy topic   : ${ntfy_topic}
  relay token  : ${relay_token}

1. On your phone: install the ntfy app and subscribe to the topic above.
2. Send a test notification:

     cd $SERVER_DIR && npm run test:notify

3. Point your reverse proxy at http://127.0.0.1:8787 and give it TLS.
4. On each machine you work on, put this in packages/usage-agent/.env:

     RELAY_URL=https://<your subdomain>
     RELAY_TOKEN=${relay_token}
     DEVICE_NAME=<laptop|desktop|...>

Keep the relay token private: it is the only thing protecting /report.
------------------------------------------------------------------
SUMMARY

if ! $install_systemd; then
  echo "Not running as a service yet. Start it manually with:"
  echo "  cd $SERVER_DIR && npm start"
  echo "or re-run this script with --systemd."
fi
