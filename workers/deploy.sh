#!/usr/bin/env bash
set -euo pipefail

for cmd in git bun java systemctl; do
  if ! command -v "$cmd" >/dev/null; then
	echo "Error: $cmd is not installed." >&2
	exit 1
  fi
done

REPO_DIR="/opt/route-optimization"
WORKERS_DIR="$REPO_DIR/workers"
ENV_DIR="/etc/gtfs"

git -C "$REPO_DIR" pull --ff-only

keys() { grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | sort -u; }
for svc in collector static; do
  if ! diff <(keys "$ENV_DIR/$svc.env") \
            <(keys "$WORKERS_DIR/$svc/.env.example") >/dev/null; then
    echo "$ENV_DIR/$svc.env is out of sync with $svc.env.example"
    exit 1
  fi
done

cd "$WORKERS_DIR"
bun install --frozen-lockfile --production

install -m 644 services/*.service services/*.timer /etc/systemd/system/
systemctl daemon-reload

systemctl enable gtfs-rt.service
systemctl restart gtfs-rt.service

systemctl enable gtfs-static.timer
systemctl restart gtfs-static.timer

echo "Done."