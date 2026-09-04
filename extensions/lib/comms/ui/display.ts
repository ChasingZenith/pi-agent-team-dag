/**
 * comms — shared display helpers for the TUI surface.
 *
 * Used by the entry extension (extensions/comms.ts) for its footer status
 * line and belowEditor peers widget (plain-text variants), and by the tool
 * renderers inlined there (theme-coloured variants).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

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

/** Status dot for peer rows: ● online, ✗ offline. Plain text (no ANSI). */
export function statusDot(status: "online" | "offline"): string {
	return status === "online" ? "●" : "✗";
}

/** Status dot with theme colouring: ● success, ✗ error. */
export function themeStatusDot(theme: Theme, status: "online" | "offline"): string {
	return status === "online" ? theme.fg("success", "●") : theme.fg("error", "✗");
}

/** Peer status word with theme colouring (send result target_status). */
export function themeStatusWord(theme: Theme, status: string): string {
	return status === "online" ? theme.fg("success", "online") : theme.fg("error", "offline");
}
