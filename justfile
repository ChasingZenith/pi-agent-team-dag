set dotenv-load := true

default:
    @just --list


# ------------------------ comms (NATS + JetStream hub) ------------------------

# Start the local NATS server (JetStream) for comms.
# Binds 127.0.0.1:4222 by default; token auto-generated into
# ~/.pi/comms/server.secret.json (0600) unless PI_COMMS_AUTH_TOKEN is set.
comms-server:
    bash scripts/comms-nats/up.sh

# Start a LAN-visible NATS server (binds 0.0.0.0, requires PI_COMMS_AUTH_TOKEN)
comms-server-lan:
    PI_COMMS_HOST=0.0.0.0 bash scripts/comms-nats/up.sh

# Verify up.sh path constants still match extensions/lib/comms/protocol.ts
check-paths:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{justfile_directory()}}"
    from_sh="$(bash "$root/scripts/comms-nats/up.sh" --paths)"
    from_ts="$(node --input-type=module -e "
        import * as p from 'file://$root/extensions/lib/comms/protocol.ts';
        console.log([p.COMMS_DIR, p.BIN_DIR, p.JETSTREAM_DIR, p.SECRET_FILE, p.SERVER_CONF_FILE].join('\n'));
    ")"
    if [[ "$from_sh" != "$from_ts" ]]; then
        echo "PATH MISMATCH: up.sh vs protocol.ts (need node >= 23.6 for .ts import)" >&2
        diff <(echo "$from_sh") <(echo "$from_ts") >&2 || true
        exit 1
    fi
    echo "paths in sync: $(head -1 <<<"$from_sh")"


# ------------------------ work items web ------------------------

# Start the work-items web API server. Serves the .pi/tasks/ of this
# workspace by default; a different workspace goes positionally:
#   just work-items-server /path/to/workspace
# (just overrides recipe parameters positionally, not with `param=value`.)
work-items-server root=justfile_directory():
    cd server && bun src/index.ts --root {{ root }}

# Start the work-items web frontend (dev server, proxies /api to 8787)
work-items-web:
    cd web && bunx vite


# (token comes from PI_COMMS_AUTH_TOKEN or ~/.pi/comms/server.secret.json, not argv)
