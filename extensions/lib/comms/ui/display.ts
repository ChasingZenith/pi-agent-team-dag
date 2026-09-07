/**
 * comms — shared display helpers for the TUI surface.
 *
 * Used by the entry extension (extensions/comms.ts) for its footer status
 * line and belowEditor peers widget (plain-text variants), and by the tool
 * renderers inlined there (theme-coloured variants).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentStatus } from "../protocol.ts";

/**
 * Abbreviate a model id for narrow display: strip a "claude-" prefix and
 * cap at 14 chars. Plain text (no ANSI).
 */
export function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

/** Status dot for peer rows: ● online, ✗ stale, ~ exited. Plain text (no ANSI). */
export function statusDot(status: AgentStatus): string {
	if (status === "online") return "●";
	if (status === "stale") return "✗";
	return "~";
}

/** Status dot with theme colouring: ● success, ✗ error, ~ (muted). */
export function themeStatusDot(theme: Theme, status: AgentStatus): string {
	if (status === "online") return theme.fg("success", "●");
	if (status === "stale") return theme.fg("error", "✗");
	return theme.fg("muted", "~");
}

/** Peer status word with theme colouring (send result target_status). */
export function themeStatusWord(theme: Theme, status: string): string {
	switch (status) {
		case "online": return theme.fg("success", "online");
		case "stale": return theme.fg("error", "stale");
		case "exited": return theme.fg("muted", "exited");
		default: return status;
	}
}
