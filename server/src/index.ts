/**
 * tasks web server — a small read-only HTTP/SSE API over the task
 * graph, the backend for the web frontend (web/).
 *
 * The heavy lifting is NOT reimplemented here: the extension's pure modules
 * (extensions/lib/tasks/store.ts — filesystem storage + state machine,
 * extensions/lib/tasks/graph.ts — ready set / cycle detection) have zero
 * pi dependency, so this process imports them directly.
 * Agents (pi sessions) and this server read and write the SAME
 * <root>/.pi/tasks/ directory — the server never mutates it (read-only
 * first version), it only reflects agent-side writes.
 *
 * Endpoints:
 *   GET /            — health check (service name + current item count)
 *   GET /api/graph   — the WHOLE graph in one response: every item plus the
 *                      computed semantics the UI needs (ready set, not-ready
 *                      with missing deps, cycle/dangling warnings, status
 *                      counts). The UI fetches this once and renders locally;
 *                      it stays thin and never reimplements graph logic.
 *   GET /api/events  — SSE: one "change" event per batch of file writes to
 *                      <root>/.pi/tasks/. The UI re-fetches /api/graph
 *                      on each event. The directory is watched with fs.watch
 *                      (recursive — Linux); when it does not exist yet the
 *                      watch falls back to polling until it appears.
 *
 * Root resolution: --root <dir> flag, else PI_TASKS_ROOT, else cwd.
 * (store.tasksDir() additionally honors PI_TASKS_DIR, which
 * overrides the whole directory — same override as the extension.)
 */

import { serve } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { listTasks, readTask, tasksDir, type Task, type TaskStatus } from "../../extensions/lib/tasks/store";
import { orphanItems, readySet, validateGraph } from "../../extensions/lib/tasks/graph";

// ---------------------------------------------------------------------------
// Root / directory resolution
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The agent workspace this server reflects (its .pi/tasks directory). */
const ROOT = argValue("--root") ?? process.env.PI_TASKS_ROOT ?? process.cwd();
const ITEMS_DIR = tasksDir(ROOT);

// ---------------------------------------------------------------------------
// Graph aggregation (the whole response shape /api/graph returns)
// ---------------------------------------------------------------------------

/** One item with the computed values the UI renders — a fully self-contained node. */
export interface GraphItem {
	item: Task;
	/** In the ready set (pending, all deps satisfied — dispatchable). */
	ready: boolean;
	/** Unsatisfied dep ids when not ready (empty for ready items). */
	missing: string[];
	/** Ids of items depending on this one. */
	dependents: string[];
}

export interface GraphResponse {
	items: GraphItem[];
	warnings: {
		cycles: string[][];
		dangling: Array<{ id: string; dep: string }>;
		orphans: Array<{ id: string; status: string }>;
	};
	counts: Record<TaskStatus, number>;
}

/** Load every parseable item; corrupted files are skipped (never kill the page). */
function loadItems(): Task[] {
	const items: Task[] = [];
	for (const s of listTasks(ROOT)) {
		try {
			const item = readTask(ROOT, s.id);
			if (item) items.push(item);
		} catch {
			// corrupted — skip (listTasks already skips it too)
		}
	}
	return items;
}

function buildGraph(): GraphResponse {
	const items = loadItems();
	const byId = new Map(items.map((i) => [i.id, i]));
	const rs = readySet(items);
	const readyIds = new Set(rs.ready.map((i) => i.id));
	const notReadyMissing = new Map(rs.notReady.map((x) => [x.item.id, x.missing]));
	const dependentsOf = (id: string): string[] =>
		items.filter((i) => i.deps.includes(id)).map((i) => i.id).sort();
	const { cycles, dangling } = validateGraph(items);
	const orphans = orphanItems(items).map((o) => ({ id: o.id, status: o.status }));

	const graphItems: GraphItem[] = items.map((item) => {
		const notReady = notReadyMissing.get(item.id);
		return {
			item,
			ready: readyIds.has(item.id),
			missing: notReady ?? [],
			dependents: dependentsOf(item.id),
		};
	});
	graphItems.sort((a, b) => a.item.id.localeCompare(b.item.id));

	const counts: Record<TaskStatus, number> = { pending: 0, dispatched: 0, active: 0, done: 0, blocked: 0, cancelled: 0 };
	for (const gi of graphItems) counts[gi.item.status]++;

	return { items: graphItems, warnings: { cycles, dangling, orphans }, counts };
}

// ---------------------------------------------------------------------------
// Directory watcher → SSE
// ---------------------------------------------------------------------------

/**
 * Emit one onEvent per write batch to the items directory. fs.watch on the
 * directory itself (recursive — the directory is flat, but recursive also
 * covers subdirs agents might create). The directory may not exist yet
 * (no tasks so far) — poll until it appears, then watch.
 */
function watchItemsDir(onEvent: () => void): () => void {
	let watcher: FSWatcher | null = null;
	let poller: ReturnType<typeof setInterval> | null = null;

	const startWatch = (): void => {
		if (watcher || !existsSync(ITEMS_DIR)) return;
		try {
			watcher = watch(ITEMS_DIR, { recursive: true }, (_event, filename) => {
				// Atomic writes (store.ts: tmp + rename) surface here as a single
				// "rename" event carrying the *tmp* filename on Linux — accept it
				// too, or updates would never push an SSE event.
				if (typeof filename === "string" && (filename.endsWith(".toml") || filename.endsWith(".toml.tmp"))) onEvent();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = null;
			});
		} catch {
			watcher = null;
		}
	};

	startWatch();
	if (!watcher) poller = setInterval(startWatch, 2000);

	return () => {
		if (poller) clearInterval(poller);
		watcher?.close();
	};
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();
app.use("/api/*", cors());

app.get("/", (c) => c.json({ service: "tasks-server", root: ROOT, itemsDir: ITEMS_DIR, items: listTasks(ROOT).length }));

app.get("/api/graph", (c) => c.json(buildGraph()));

/** SSE: "change" (with a timestamp) whenever the items directory is written.
 *  Atomic writes (tmp + rename) fire several fs events — the debounce merges
 *  them into one push. The stream is held open forever; onAbort cleans up. */
app.get("/api/events", (c) =>
	streamSSE(c, async (stream) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = watchItemsDir(() => {
			if (timer) return; // a batch is already scheduled
			timer = setTimeout(() => {
				timer = null;
				stream.writeSSE({ event: "change", data: JSON.stringify({ ts: new Date().toISOString() }) });
			}, 100);
		});
		stream.onAbort(() => {
			if (timer) clearTimeout(timer);
			cleanup();
		});
		stream.writeSSE({ event: "init", data: JSON.stringify({ itemsDir: ITEMS_DIR }) });
		await new Promise(() => {}); // hold the stream open forever
	}),
);

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
console.log(`tasks-server: http://127.0.0.1:${process.env.PORT ?? 8787}  root=${ROOT}`);
