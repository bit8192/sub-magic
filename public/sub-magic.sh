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

trap cleanup EXIT

mkdir -p "$(dirname "$ETAG_FILE")"

LAST_ETAG=""
[ -f "$ETAG_FILE" ] && LAST_ETAG=$(cat "$ETAG_FILE")

HTTP_STATUS=$(curl -sS -L -o "$TEMP_FILE" -D "$HEADERS_FILE" -w "%{http_code}" \
	-H "If-None-Match: $LAST_ETAG" \
	-H "X-Sub-Magic-Long-Poll: 1" \
	"$SUB_URL")

if [ "$HTTP_STATUS" = "304" ]; then
	exit 0
fi

if [ "$HTTP_STATUS" = "204" ]; then
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
[ -n "$NEW_ETAG" ] && echo "$NEW_ETAG" > "$ETAG_FILE"

CONTROLLER=$(grep -m1 '^\s*external-controller:' "$CONFIG_PATH" | sed -e 's/.*: *//' -e "s/^['\"]//" -e "s/['\"]$//")
SECRET=$(grep -m1 '^\s*secret:' "$CONFIG_PATH" | sed -e 's/.*: *//' -e "s/^['\"]//" -e "s/['\"]$//")

if [ -n "$CONTROLLER" ]; then
	if [ -n "$SECRET" ]; then
		if curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -H "Authorization: Bearer ${SECRET}" -o /dev/null 2>/dev/null; then
			echo "[$(date)] Mihomo reloaded via API: $CONTROLLER"
		else
			echo "[$(date)] API reload failed, falling back to restart" >&2
			systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
		fi
	else
		if curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" -o /dev/null 2>/dev/null; then
			echo "[$(date)] Mihomo reloaded via API: $CONTROLLER"
		else
			echo "[$(date)] API reload failed, falling back to restart" >&2
			systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
		fi
	fi
else
	echo "[$(date)] No external-controller found in config, restarting service"
	systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
fi
