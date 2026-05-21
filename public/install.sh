#!/bin/bash
set -e

CONFIG_PATH="${1:-/etc/mihomo/config.yaml}"
SUB_URL="${2:?Usage: $0 <config-path> <sub-url> [bin-path]}"
INTERVAL="30s"
LEGACY_ARG3="${3:-}"
if [ -n "${4:-}" ]; then
	BIN_PATH="$4"
elif [[ "$LEGACY_ARG3" == */* ]]; then
	BIN_PATH="$LEGACY_ARG3"
else
	BIN_PATH="$HOME/.local/bin/sub-magic"
fi
BASE_URL="${SUB_URL%/sub/*}"

echo "Config path: $CONFIG_PATH"
echo "Interval:   $INTERVAL"

CONFIG_DIR=$(dirname "$CONFIG_PATH")

ensure_config_writable() {
	local current_group=""

	if [ -w "$CONFIG_PATH" ]; then
		return 0
	fi

	if [ ! -e "$CONFIG_PATH" ]; then
		if [ -w "$CONFIG_DIR" ]; then
			return 0
		fi

		if ! command -v sudo >/dev/null 2>&1; then
			echo "Cannot write config: $CONFIG_PATH"
			echo "Directory is not writable and sudo is not available: $CONFIG_DIR"
			exit 1
		fi

		sudo mkdir -p "$CONFIG_DIR"
		sudo chown root:"$(id -gn)" "$CONFIG_DIR"
		sudo chmod g+w "$CONFIG_DIR"
		echo "Permission fixed for config directory: $CONFIG_DIR"
		return 0
	fi

	if ! command -v sudo >/dev/null 2>&1; then
		echo "Cannot write config file and sudo is not available: $CONFIG_PATH"
		exit 1
	fi

	current_group="$(id -gn)"
	sudo chgrp "$current_group" "$CONFIG_PATH"
	sudo chmod g+w "$CONFIG_PATH"

	if [ ! -w "$CONFIG_PATH" ]; then
		echo "Failed to acquire write permission for config file: $CONFIG_PATH"
		exit 1
	fi

	echo "Permission fixed for config file: $CONFIG_PATH"
}

if [ ! -d "$CONFIG_DIR" ]; then
	mkdir -p "$CONFIG_DIR" 2>/dev/null || true
fi

ensure_config_writable

mkdir -p "$(dirname "$BIN_PATH")"
curl -sL "${BASE_URL}/sub-magic.sh" -o "$BIN_PATH"
sed -i "s|__CONFIG_PATH__|${CONFIG_PATH}|g" "$BIN_PATH"
sed -i "s|__SUB_URL__|${SUB_URL}|g" "$BIN_PATH"
chmod +x "$BIN_PATH"

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
OnBootSec=$INTERVAL

[Install]
WantedBy=timers.target
TIMER

systemctl --user daemon-reload
systemctl --user enable --now sub-magic.timer
$BIN_PATH
echo "Installed: timer=$INTERVAL, controller=auto(from config), config=$CONFIG_PATH"
