#!/bin/bash
set -e
CONFIG_PATH="__CONFIG_PATH__"
SUB_URL="__SUB_URL__"
ETAG_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/sub-magic.etag"
HEADERS_FILE="/tmp/sub-magic-headers.$$"
TEMP_FILE="/tmp/sub-magic-tmp.$$"

cleanup() {
	rm -f "$HEADERS_FILE" "$TEMP_FILE"
}

get_runtime_config_path() {
	local pid cmdline_path arg next_is_dir dir

	pid=$(pgrep -x mihomo 2>/dev/null | head -n 1 || true)
	[ -n "$pid" ] || return 1

	cmdline_path="/proc/$pid/cmdline"
	[ -r "$cmdline_path" ] || return 1

	next_is_dir=0
	while IFS= read -r -d '' arg; do
		if [ "$next_is_dir" = "1" ]; then
			dir="$arg"
			next_is_dir=0
			break
		fi

		case "$arg" in
			-d)
				next_is_dir=1
				;;
			-d*)
				dir="${arg#-d}"
				break
				;;
		esac
	done < "$cmdline_path"

	[ -n "$dir" ] || return 1
	printf '%s/config.yaml\n' "${dir%/}"
}

sync_runtime_config() {
	local runtime_config_path=""

	runtime_config_path=$(get_runtime_config_path || true)
	[ -n "$runtime_config_path" ] || return 0

	if [ "$runtime_config_path" = "$CONFIG_PATH" ]; then
		return 0
	fi

	if cp "$TEMP_FILE" "$runtime_config_path" 2>/dev/null; then
		echo "[$(date)] Runtime config updated: $runtime_config_path"
	else
		echo "[$(date)] Runtime config update skipped: $runtime_config_path" >&2
	fi
}

trap cleanup EXIT

mkdir -p "$(dirname "$ETAG_FILE")"

LAST_ETAG=""
[ -f "$ETAG_FILE" ] && LAST_ETAG=$(cat "$ETAG_FILE")

HTTP_STATUS=$(curl -sS -L -o "$TEMP_FILE" -D "$HEADERS_FILE" -w "%{http_code}" \
	-H "If-None-Match: $LAST_ETAG" \
	-H "X-Sub-Magic-Long-Poll: 1" \
	"$SUB_URL")

if [ "$HTTP_STATUS" = "304" ]; then
	echo "[$(date)] No config change (304)"
	exit 0
fi

if [ "$HTTP_STATUS" != "200" ]; then
	echo "[$(date)] Subscription fetch failed: HTTP $HTTP_STATUS" >&2
	exit 1
fi

if [ ! -s "$TEMP_FILE" ]; then
	echo "[$(date)] Subscription fetch returned empty config body" >&2
	exit 1
fi

NEW_ETAG=$(grep -i '^etag:' "$HEADERS_FILE" | head -1 | sed 's/.*: *//' | tr -d '\r')
cp "$TEMP_FILE" "$CONFIG_PATH"
echo "[$(date)] Config updated: $CONFIG_PATH"
sync_runtime_config
[ -n "$NEW_ETAG" ] && echo "$NEW_ETAG" > "$ETAG_FILE"

CONTROLLER=$(grep -m1 '^\s*external-controller:' "$CONFIG_PATH" | sed -E -e 's/^[[:space:]]*external-controller:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]$//")
SECRET=$(grep -m1 '^\s*secret:' "$CONFIG_PATH" | sed -E -e 's/^[[:space:]]*secret:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]$//")

if [ -n "$CONTROLLER" ]; then
	if [ -n "$SECRET" ]; then
		if curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -H "Authorization: Bearer ${SECRET}" -H "Content-Type: application/json" --data '{"path":"","payload":""}' -o /dev/null 2>/dev/null; then
			echo "[$(date)] Mihomo reloaded via API: $CONTROLLER"
		else
			echo "[$(date)] API reload failed, falling back to service restart" >&2
			systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
		fi
	else
		if curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -H "Content-Type: application/json" --data '{"path":"","payload":""}' -o /dev/null 2>/dev/null; then
			echo "[$(date)] Mihomo reloaded via API: $CONTROLLER"
		else
			echo "[$(date)] API reload failed, falling back to service restart" >&2
			systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
		fi
	fi
else
	echo "[$(date)] No external-controller found in config, restarting service"
	systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
fi
