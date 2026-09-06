/**
 * comms — server filesystem layout (deployment-side paths).
 *
 * Not a protocol concern: these are the directories/files the local NATS
 * server lives in. They are shared between the client extension
 * (config.ts reads SECRET_FILE for the auth token) and the bash launcher
 * (scripts/comms-nats/up.sh), which duplicates the same literals. The bash
 * side can't `import` TS, so this module is the TS-side anchor that
 * `just check-paths` reconciles up.sh against.
 *
 * PI_COMMS_DIR overrides the default so tests and up.sh can redirect the
 * whole directory in one place. NOTE: these constants are evaluated at
 * MODULE LOAD (env + homedir are read once, then frozen). Set PI_COMMS_DIR
 * before importing this module — setting it later has no effect.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Root of all comms state. */
export const COMMS_DIR = process.env.PI_COMMS_DIR ?? path.join(os.homedir(), ".pi", "comms");
/** Single secret file for the local NATS server (client reads the token from here). */
export const SECRET_FILE = path.join(COMMS_DIR, "server.secret.json");
/** Where up.sh caches the downloaded nats-server binary. */
export const BIN_DIR = path.join(COMMS_DIR, "bin");
/** Where up.sh writes the nats-server runtime config. */
export const SERVER_CONF_FILE = path.join(COMMS_DIR, "nats-server.conf");
/** Where up.sh points JetStream storage. */
export const JETSTREAM_DIR = path.join(COMMS_DIR, "jetstream");
