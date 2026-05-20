#!/bin/bash
set -e
CONFIG_PATH="__CONFIG_PATH__"
SUB_URL="__SUB_URL__"
CONF_FILE="$HOME/.config/sub-magic.conf"
ETAG_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/sub-magic.etag"
HEADERS_FILE="/tmp/sub-magic-headers.$$"
TEMP_FILE="/tmp/sub-magic-tmp.$$"

mkdir -p "$(dirname "$ETAG_FILE")"

LAST_ETAG=""
[ -f "$ETAG_FILE" ] && LAST_ETAG=$(cat "$ETAG_FILE")

curl -sL -o "$TEMP_FILE" -D "$HEADERS_FILE" -H "If-None-Match: $LAST_ETAG" "$SUB_URL"

if [ -s "$TEMP_FILE" ]; then
	NEW_ETAG=$(grep -i '^etag:' "$HEADERS_FILE" | head -1 | sed 's/.*: *//' | tr -d '\r')
	[ -n "$NEW_ETAG" ] && echo "$NEW_ETAG" > "$ETAG_FILE"
	mv "$TEMP_FILE" "$CONFIG_PATH"
	echo "[$(date)] Config updated: $CONFIG_PATH"

	CONTROLLER=$(grep -m1 '^\s*external-controller:' "$CONFIG_PATH" | sed -e 's/.*: *//' -e "s/^['\"]//" -e "s/['\"]$//")
	SECRET=$(grep -m1 '^\s*secret:' "$CONFIG_PATH" | sed -e 's/.*: *//' -e "s/^['\"]//" -e "s/['\"]$//")

	if [ -n "$CONTROLLER" ]; then
		if [ -n "$SECRET" ]; then
			curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -H "Authorization: Bearer ${SECRET}" -o /dev/null 2>/dev/null
		else
			curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -o /dev/null 2>/dev/null
		fi
		if [ $? -eq 0 ]; then
			echo "[$(date)] Mihomo reloaded via API: $CONTROLLER"
		else
			echo "[$(date)] API reload failed, falling back to restart" >&2
			systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
		fi
	else
		echo "[$(date)] No external-controller found in config, restarting service"
		systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
	fi
else
	rm -f "$TEMP_FILE"
fi
rm -f "$HEADERS_FILE"
