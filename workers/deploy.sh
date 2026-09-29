#!/usr/bin/env bash
set -euo pipefail

for cmd in git systemctl; do
	if ! command -v "$cmd" >/dev/null; then
		echo "Error: $cmd is not installed." >&2
		exit 1
	fi
done

for cmd in bun java; do
	/usr/bin/$cmd --version 2>/dev/null 1>/dev/null || {
		echo "Error: $cmd is not installed." >&2
		exit 1
	}
done

REPO_DIR="/opt/route-optimization"
WORKERS_DIR="$REPO_DIR/workers"
ENV_DIR="/etc/gtfs"

git -C "$REPO_DIR" pull --ff-only

keys() { grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | sort -u; }
for svc in collector static; do
	actual=$(sudo cat "/etc/gtfs/$svc.env" | keys)
	expected=$(keys <"$WORKERS_DIR/$svc/.env.example")
	if [[ "$actual" != "$expected" ]]; then
		echo "/etc/gtfs/$svc.env is out of sync with $WORKERS_DIR/$svc/env.example:"
		diff <(echo "$actual") <(echo "$expected") || true
		exit 1
	fi
done

cd "$WORKERS_DIR"
/usr/bin/bun install --frozen-lockfile --production

sudo install -m 644 services/*.service services/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gtfs-rt.service
sudo systemctl restart gtfs-rt.service
sudo systemctl enable gtfs-static.timer
sudo systemctl restart gtfs-static.timer

echo "Done."
