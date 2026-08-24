/** Thin client for the tasks-server. All /api calls go through the vite
 *  dev-server proxy in dev; a reverse proxy in prod. */
import type { GraphResponse } from "./types";

export async function fetchGraph(): Promise<GraphResponse> {
	const res = await fetch("/api/graph");
	if (!res.ok) throw new Error(`GET /api/graph → ${res.status} ${res.statusText}`);
	return (await res.json()) as GraphResponse;
}

/** Subscribe to agent-side writes. Every "change" event means "refetch the
 *  graph"; onOpen/onError mirror the connection state for the live badge. */
export function subscribeChanges(opts: {
	onChange: () => void;
	onOpen?: () => void;
	onError?: () => void;
}): () => void {
	const es = new EventSource("/api/events");
	es.addEventListener("change", opts.onChange);
	es.onopen = () => opts.onOpen?.();
	es.onerror = () => opts.onError?.();
	return () => es.close();
}
