/**
 * comms — runtime configuration: flags → env → secret file. The subnet
 * (communication domain) comes from the --subnet flag, defaulting to
 * DEFAULT_SUBNET when absent/empty.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import {
	DEFAULT_HEARTBEAT_MS,
	DEFAULT_HISTORY_TTL_MS,
	DEFAULT_MESSAGE_TTL_MS,
	DEFAULT_NATS_URL,
	DEFAULT_OFFLINE_AFTER_MS,
	DEFAULT_RECLAIM_AFTER_MS,
	DEFAULT_SUBNET,
} from "./protocol.ts";
import { SECRET_FILE } from "./paths.ts";

export interface RuntimeConfig {
	natsUrl: string;
	authToken: string | null;
	subnet: string;
	heartbeatMs: number;
	messageTtlMs: number;
	offlineAfterMs: number;
	/** living-profile name reclaim threshold (presumed crashed). */
	reclaimAfterMs: number;
	/** comms_history bucket TTL — how long message content history is kept. */
	historyTtlMs: number;
}

/** Read the server secret only if the file is mode 0600 (single file). */
export function readSecretFile(): string | null {
	try {
		if (!fs.existsSync(SECRET_FILE)) return null;
		const st = fs.statSync(SECRET_FILE);
		const mode = st.mode & 0o777;
		if (mode !== 0o600) return null;
		const parsed = JSON.parse(fs.readFileSync(SECRET_FILE, "utf-8")) as { token?: string };
		if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return parsed.token;
	} catch {
		return null;
	}
}

function numEnv(name: string, def: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : def;
}

export function readConfig(pi: ExtensionAPI): RuntimeConfig {
	const flags = {
		natsUrl: pi.getFlag("nats-url") as string | undefined,
		subnet: pi.getFlag("subnet") as string | undefined,
	};

	const natsUrl =
		(flags.natsUrl && flags.natsUrl.length > 0 ? flags.natsUrl : undefined) ||
		(process.env.PI_COMMS_NATS_URL && process.env.PI_COMMS_NATS_URL.length > 0
			? process.env.PI_COMMS_NATS_URL
			: undefined) ||
		DEFAULT_NATS_URL;

	const authToken =
		(process.env.PI_COMMS_AUTH_TOKEN && process.env.PI_COMMS_AUTH_TOKEN.length > 0
			? process.env.PI_COMMS_AUTH_TOKEN
			: undefined) ||
		readSecretFile();

	return {
		natsUrl: natsUrl.replace(/\/+$/, ""),
		authToken,
		subnet: (flags.subnet && flags.subnet.length > 0 ? flags.subnet : undefined) || DEFAULT_SUBNET,
		heartbeatMs: numEnv("PI_COMMS_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
		messageTtlMs: numEnv("PI_COMMS_MESSAGE_TTL_MS", DEFAULT_MESSAGE_TTL_MS),
		offlineAfterMs: numEnv("PI_COMMS_OFFLINE_AFTER_MS", DEFAULT_OFFLINE_AFTER_MS),
		reclaimAfterMs: numEnv("PI_COMMS_RECLAIM_AFTER_MS", DEFAULT_RECLAIM_AFTER_MS),
		historyTtlMs: numEnv("PI_COMMS_HISTORY_TTL_MS", DEFAULT_HISTORY_TTL_MS),
	};
}

// ━━ Identity resolution: CLI flags > system-prompt frontmatter > defaults ━━━━

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		body: match[2],
	};
}

function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch {
						// fall through
					}
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

/** name/description from the agent's system-prompt frontmatter. */
export function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string } {
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description } = parseFrontmatter(raw);
		return { name, description };
	} catch {
		return {};
	}
}
