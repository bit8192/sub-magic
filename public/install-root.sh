#!/bin/bash
set -e

CONFIG_PATH="${1:-/etc/mihomo/config.yaml}"
SUB_URL="${2:?Usage: $0 <config-path> <sub-url> [bin-path]}"
INTERVAL="30s"
BIN_PATH="${3:-/usr/local/bin/sub-magic}"
BASE_URL="${SUB_URL%/sub/*}"

if [ "$(id -u)" -ne 0 ]; then
	echo "This installer must run as root."
	echo "Example: curl -sL ${BASE_URL}/install-root.sh | sudo bash -s -- \"${CONFIG_PATH}\" \"${SUB_URL}\""
	exit 1
fi

echo "Config path: $CONFIG_PATH"
echo "Interval:   $INTERVAL"

mkdir -p "$(dirname "$BIN_PATH")"
curl -sL "${BASE_URL}/sub-magic.sh" -o "$BIN_PATH"
sed -i "s|__CONFIG_PATH__|${CONFIG_PATH}|g" "$BIN_PATH"
sed -i "s|__SUB_URL__|${SUB_URL}|g" "$BIN_PATH"
chmod 755 "$BIN_PATH"

cat > /etc/systemd/system/sub-magic.service << SVC
[Unit]
Description=Sub Magic config updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN_PATH
SVC

cat > /etc/systemd/system/sub-magic.timer << TIMER
[Unit]
Description=Sub Magic config update timer

[Timer]
OnUnitActiveSec=$INTERVAL
OnBootSec=$INTERVAL

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now sub-magic.timer
systemctl start sub-magic.service

echo "Installed: timer=$INTERVAL, mode=system-root, config=$CONFIG_PATH"
