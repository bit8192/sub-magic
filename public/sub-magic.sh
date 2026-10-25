#!/bin/bash
set -e
CONFIG_PATH="__CONFIG_PATH__"
SUB_URL="__SUB_URL__"
ETAG_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/sub-magic.etag"
HEADERS_FILE="/tmp/sub-magic-headers.$$"
TEMP_FILE="/tmp/sub-magic-tmp.$$"
RELOAD_PAYLOAD_FILE="/tmp/sub-magic-payload.$$"
RELOAD_BODY_FILE="/tmp/sub-magic-reload-body.$$"
RELOAD_ERR_FILE="/tmp/sub-magic-reload-err.$$"

cleanup() {
	rm -f "$HEADERS_FILE" "$TEMP_FILE" "$RELOAD_PAYLOAD_FILE" "$RELOAD_BODY_FILE" "$RELOAD_ERR_FILE"
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

restart_mihomo() {
	systemctl --user restart mihomo 2>/dev/null || systemctl restart mihomo 2>/dev/null || service mihomo restart 2>/dev/null || true
}

# Build {"path":"","payload":<config>} with proper JSON escaping.
# jq first, python3 as fallback; empty output when neither exists.
reload_payload_json() {
	if command -v jq >/dev/null 2>&1; then
		jq -Rs '{path: "", payload: .}' "$TEMP_FILE"
	elif command -v python3 >/dev/null 2>&1; then
		python3 -c 'import json,sys; sys.stdout.write(json.dumps({"path":"","payload":open(sys.argv[1],encoding="utf-8").read()}))' "$TEMP_FILE"
	fi
}

# Interpret the last curl result (CURL_RC / HTTP_CODE) and act accordingly.
report_reload_result() {
	local mode="$1"
	if [ "$CURL_RC" -eq 0 ] && [ "$HTTP_CODE" = "204" ]; then
		echo "[$(date)] Mihomo reloaded via API (${mode}): $CONTROLLER"
	elif [ "$CURL_RC" -eq 0 ]; then
		# mihomo answered but refused the config; restarting would load the very
		# same rejected file, so keep the running config and surface the reason.
		echo "[$(date)] Mihomo rejected the new config: HTTP ${HTTP_CODE} $(cat "$RELOAD_BODY_FILE" 2>/dev/null)" >&2
	else
		echo "[$(date)] API unreachable (curl exit ${CURL_RC}), falling back to service restart" >&2
		restart_mihomo
	fi
}

if [ -n "$CONTROLLER" ]; then
	# wildcard binds are not dialable on every platform; normalize to loopback
	case "$CONTROLLER" in
		0.0.0.0:*) CONTROLLER="127.0.0.1:${CONTROLLER#0.0.0.0:}" ;;
	esac

	AUTH_ARGS=()
	if [ -n "$SECRET" ]; then
		AUTH_ARGS=(-H "Authorization: Bearer ${SECRET}")
	fi

	if reload_payload_json > "$RELOAD_PAYLOAD_FILE" && [ -s "$RELOAD_PAYLOAD_FILE" ]; then
		# payload mode: push the freshly downloaded config directly, immune to
		# runtime-path mismatch (distro packages that copy /etc/<pkg>/config.yaml
		# into a state dir and run mihomo with -d there).
		HTTP_CODE=$(curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" \
			"${AUTH_ARGS[@]}" -H 'Content-Type: application/json' \
			--data @"$RELOAD_PAYLOAD_FILE" -o "$RELOAD_BODY_FILE" \
			-w '%{http_code}') 2>"$RELOAD_ERR_FILE"
		CURL_RC=$?
		report_reload_result 'payload'
	else
		# no jq/python3 available: fall back to path mode (mihomo re-reads its own config file)
		echo "[$(date)] jq/python3 not found, using path mode reload" >&2
		HTTP_CODE=$(curl -sS -X PUT "http://${CONTROLLER}/configs?force=true" \
			"${AUTH_ARGS[@]}" -H 'Content-Type: application/json' \
			--data '{"path":"","payload":""}' -o "$RELOAD_BODY_FILE" \
			-w '%{http_code}') 2>"$RELOAD_ERR_FILE"
		CURL_RC=$?
		report_reload_result 'path'
	fi
else
	echo "[$(date)] No external-controller found in config, restarting service"
	restart_mihomo
fi
