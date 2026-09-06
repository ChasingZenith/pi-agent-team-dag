#!/usr/bin/env bash
# scripts/comms-nats/up.sh
#
# comms — NATS server launcher.
#
# Responsibilities:
#  - locate nats-server (PATH first, else download a pinned release into
#    ~/.pi/comms/bin/, SHA256-verified);
#  - write ~/.pi/comms/nats-server.conf (port/host/token/jetstream store);
#  - token policy: PI_COMMS_AUTH_TOKEN set → use it, never
#    write server.secret.json; unset → generate random, write
#    ~/.pi/comms/server.secret.json (0600);
#  - spawn `nats-server -js -c <conf>`, wait until it accepts TCP
#    connections on the port, print banner;
#  - SIGINT/SIGTERM: stop the child, unlink the secret only if we own it.
#
# Paths mirror extensions/lib/comms/paths.ts — that module is the
# single source of truth for the DIRECTORY LAYOUT; COMMS_DIR here is the
# only duplicated literal (default ~/.pi/comms). Both sides honour the
# PI_COMMS_DIR override, and `just check-paths` verifies they stayed in
# sync. Keep the derived names identical to paths.ts when changing them.
#
# Env:
#   PI_COMMS_DIR         (override the ~/.pi/comms root; default)
#   PI_COMMS_HOST        (default 127.0.0.1)
#   PI_COMMS_PORT        (default 4222)
#   PI_COMMS_AUTH_TOKEN  (optional; generated + persisted otherwise)
#   PI_COMMS_NATS_VERSION (pin download version; default latest known)
#   NATS_SERVER_BIN         (explicit binary path, bypasses PATH/download)

set -euo pipefail

COMMS_DIR="${PI_COMMS_DIR:-${HOME}/.pi/comms}"
BIN_DIR="${COMMS_DIR}/bin"
JETSTREAM_DIR="${COMMS_DIR}/jetstream"
SECRET_FILE="${COMMS_DIR}/server.secret.json"
SERVER_CONF_FILE="${COMMS_DIR}/nats-server.conf"

HOST="${PI_COMMS_HOST:-127.0.0.1}"
PORT="${PI_COMMS_PORT:-4222}"
ENV_TOKEN="${PI_COMMS_AUTH_TOKEN:-}"
VERSION="${PI_COMMS_NATS_VERSION:-2.14.4}"
CUSTOM_BIN="${NATS_SERVER_BIN:-}"

# Port probe via bash /dev/tcp (no NATS client needed). A server bound to
# 0.0.0.0 can't be connected to directly, so probe through loopback.
PROBE_HOST="$HOST"
if [[ "$HOST" == "0.0.0.0" ]]; then PROBE_HOST="127.0.0.1"; fi

# `--paths`: print the five path constants (one per line) and exit — used by
# `just check-paths` to diff against protocol.ts. Also handy for debugging.
if [[ "${1:-}" == "--paths" ]]; then
	printf '%s\n' "$COMMS_DIR" "$BIN_DIR" "$JETSTREAM_DIR" "$SECRET_FILE" "$SERVER_CONF_FILE"
	exit 0
fi

port_open() {
	timeout 1 bash -c "exec 3<>/dev/tcp/'$PROBE_HOST'/'$PORT'" 2>/dev/null
}

is_loopback() {
	[[ "$1" == "127.0.0.1" || "$1" == "::1" || "$1" == "localhost" ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Token policy: env token wins and is never persisted; otherwise reuse the
# 0600 secret file (a re-run must authenticate to the already-running server,
# and restarting a dead server keeps the same token); otherwise generate.
# ─────────────────────────────────────────────────────────────────────────────

TOKEN=""
TOKEN_OWNED=0
TOKEN_SOURCE=""

# Reads the secret only if it exists and is exactly mode 0600.
read_secret_file() {
	[[ -f "$SECRET_FILE" ]] || return 1
	[[ "$(stat -c '%a' "$SECRET_FILE" 2>/dev/null || true)" == "600" ]] || return 1
	local tok
	tok="$(sed -n 's/^[[:space:]]*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SECRET_FILE" | head -1)"
	[[ -n "$tok" ]] || return 1
	printf '%s' "$tok"
}

ensure_token() {
	if [[ -n "$ENV_TOKEN" ]]; then
		TOKEN="$ENV_TOKEN"
		TOKEN_SOURCE="PI_COMMS_AUTH_TOKEN"
		return
	fi
	local existing
	if existing="$(read_secret_file)"; then
		TOKEN="$existing"
		TOKEN_SOURCE="$SECRET_FILE (0600)"
		return
	fi
	TOKEN="$(openssl rand -hex 32)"
	TOKEN_OWNED=1
	TOKEN_SOURCE="$SECRET_FILE (0600)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Config file
# ─────────────────────────────────────────────────────────────────────────────

write_conf() {
	mkdir -p "$COMMS_DIR"
	cat > "$SERVER_CONF_FILE" <<EOF
port: ${PORT}
host: '${HOST}'
authorization {
  token: '${TOKEN}'
}
jetstream {
  store_dir: '${JETSTREAM_DIR}'
  max_mem_store: 512Mb
  max_file_store: 2Gb
}
EOF
	chmod 600 "$SERVER_CONF_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# Binary discovery: PATH first, else download a pinned release + SHA256 verify
# ─────────────────────────────────────────────────────────────────────────────

find_on_path() {
	command -v nats-server
}

download_binary() {
	mkdir -p "$BIN_DIR"
	local ver="${VERSION#v}"
	local zip="$BIN_DIR/nats-server-v${ver}-linux-amd64.zip"
	local bin="$BIN_DIR/nats-server-v${ver}-linux-amd64"
	if [[ -f "$bin" ]]; then
		printf '%s' "$bin"
		return
	fi
	if [[ ! -f "$zip" ]]; then
		local url="https://github.com/nats-io/nats-server/releases/download/v${ver}/nats-server-v${ver}-linux-amd64.zip"
		echo "comms: downloading $url"
		if ! curl -fsSL -o "$zip" "$url"; then
			echo "comms: download failed — install nats-server yourself (e.g. \`sudo pacman -S nats-server\`) or set PI_COMMS_NATS_VERSION" >&2
			rm -f "$zip"
			return 1
		fi
	fi
	# SHA256 verification against the release checksum file.
	if curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v${ver}/SHA256SUMS" -o "$BIN_DIR/SHA256SUMS" 2>/dev/null; then
		if ! ( cd "$BIN_DIR" && grep -F "nats-server-v${ver}-linux-amd64.zip" SHA256SUMS | sha256sum -c --quiet 2>/dev/null ); then
			echo "comms: checksum mismatch for $zip" >&2
			rm -f "$zip"
			return 1
		fi
	fi
	if ! unzip -o "$zip" -d "$BIN_DIR" >/dev/null; then
		echo "comms: unzip failed — install unzip or set NATS_SERVER_BIN" >&2
		return 1
	fi
	chmod 755 "$bin"
	printf '%s' "$bin"
}

resolve_binary() {
	if [[ -n "$CUSTOM_BIN" ]]; then
		printf '%s' "$CUSTOM_BIN"
		return
	fi
	local on_path
	if on_path="$(find_on_path)"; then
		printf '%s' "$on_path"
		return
	fi
	download_binary
}

# ─────────────────────────────────────────────────────────────────────────────
# Lifecycle: spawn child, wait for it, clean up only what we own
# ─────────────────────────────────────────────────────────────────────────────

CHILD_PID=""
CLEANED=0

cleanup() {
	[[ "$CLEANED" == 1 ]] && return
	CLEANED=1
	if [[ -n "$CHILD_PID" ]]; then
		kill "$CHILD_PID" 2>/dev/null || true
	fi
	if [[ "$TOKEN_OWNED" == 1 ]]; then
		rm -f "$SECRET_FILE"
	fi
	rm -f "$SERVER_CONF_FILE"
}

shutdown() {
	echo "comms: $1 received, stopping NATS"
	cleanup
	exit 0
}

trap 'shutdown SIGINT' INT
trap 'shutdown SIGTERM' TERM
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

# Token policy: binding beyond loopback requires an explicit env token
# (never auto-generate a token for a LAN-exposed server).
if [[ -z "$ENV_TOKEN" ]] && ! is_loopback "$HOST"; then
	echo "comms: refusing to bind $HOST without an explicit PI_COMMS_AUTH_TOKEN." >&2
	exit 1
fi

ensure_token
mkdir -p "$COMMS_DIR"

# Already running on this port with a matching token? Idempotent boot.
if port_open; then
	local_tok="$(read_secret_file || true)"
	if [[ -n "$local_tok" && "$local_tok" == "$TOKEN" ]]; then
		echo "comms: NATS already running at nats://$HOST:$PORT — nothing to do."
		echo "          (token: $TOKEN_SOURCE)"
		exit 0
	fi
	if [[ -n "$ENV_TOKEN" && -z "$local_tok" ]]; then
		# No secret file to verify the env token against — assume it's us.
		echo "comms: NATS already running at nats://$HOST:$PORT — nothing to do."
		echo "          (token: PI_COMMS_AUTH_TOKEN; no local secret to verify)"
		exit 0
	fi
	echo "comms: port $PORT already in use by a nats-server with a different token." >&2
	echo "          stop it first, or fix PI_COMMS_AUTH_TOKEN / remove $SECRET_FILE" >&2
	exit 1
fi

BIN="$(resolve_binary || true)"
if [[ -z "$BIN" ]]; then
	echo "comms: no nats-server binary available" >&2
	exit 1
fi

write_conf

# Persist the secret only when we generated it (0600).
if [[ "$TOKEN_OWNED" == 1 ]]; then
	printf '{\n  "token": "%s"\n}\n' "$TOKEN" > "$SECRET_FILE"
	chmod 600 "$SECRET_FILE"
fi

"$BIN" -js -c "$SERVER_CONF_FILE" &
CHILD_PID=$!

deadline=$((SECONDS + 10))
until port_open; do
	if ! kill -0 "$CHILD_PID" 2>/dev/null; then
		echo "comms: server exited before becoming reachable ($BIN)" >&2
		cleanup
		exit 1
	fi
	if (( SECONDS >= deadline )); then
		echo "comms: server did not become reachable within 10s ($BIN)" >&2
		cleanup
		exit 1
	fi
	sleep 0.25
done

echo "comms: NATS listening on nats://$HOST:$PORT (pid $CHILD_PID, $BIN)"
echo "          jetstream store: $JETSTREAM_DIR"
echo "          config: $SERVER_CONF_FILE"
if [[ "$TOKEN_OWNED" == 1 ]]; then
	echo "          token: $TOKEN_SOURCE (generated)"
else
	echo "          token: $TOKEN_SOURCE"
fi
echo "          ─── events below (Ctrl-C to stop) ───"

wait "$CHILD_PID"
CODE=$?
cleanup
exit "$CODE"
