#!/bin/bash
set -e

CONFIG_PATH="${1:-/etc/mihomo/config.yaml}"
SUB_URL="${2:?Usage: $0 <config-path> <sub-url> [interval]}"
INTERVAL="${3:-5m}"
BIN_PATH="${4:-$HOME/.local/bin/sub-magic}"
BASE_URL="${SUB_URL%/sub/*}"
CONF_FILE="$HOME/.config/sub-magic.conf"

echo "Config path: $CONFIG_PATH"
echo "Interval:   $INTERVAL"

CONFIG_DIR=$(dirname "$CONFIG_PATH")
if [ ! -w "$CONFIG_DIR" ]; then
	mkdir -p "$CONFIG_DIR" 2>/dev/null || true
	chmod u+w "$CONFIG_DIR" 2>/dev/null || true
	echo "Permission fixed: $CONFIG_DIR"
fi

mkdir -p "$(dirname "$BIN_PATH")"
mkdir -p "$(dirname "$CONF_FILE")"
curl -sL "${BASE_URL}/sub-magic.sh" -o "$BIN_PATH"
sed -i "s|__CONFIG_PATH__|${CONFIG_PATH}|g" "$BIN_PATH"
sed -i "s|__SUB_URL__|${SUB_URL}|g" "$BIN_PATH"
chmod +x "$BIN_PATH"

cat > "$CONF_FILE" << CONF
INTERVAL="$INTERVAL"
CONF

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/sub-magic.service << SVC
[Unit]
Description=Sub Magic config updater

[Service]
Type=oneshot
ExecStart=$BIN_PATH
SVC

cat > ~/.config/systemd/user/sub-magic.timer << TIMER
[Unit]
Description=Sub Magic config update timer

[Timer]
OnUnitActiveSec=$INTERVAL
OnBootSec=1m
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
TIMER

systemctl --user daemon-reload
systemctl --user enable --now sub-magic.timer
$BIN_PATH
echo "Installed: timer=$INTERVAL, controller=auto(from config), config=$CONFIG_PATH"
