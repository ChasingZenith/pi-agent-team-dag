/**
 * lib/tasks/graph — pure graph algorithms over Task arrays.
 *
 * The model (see lib/tasks/store for the full definition): a Task at any
 * granularity over a pure DAG. `deps` are the dependency edges — B.deps=[A]
 * means B depends on A having completed (A finishes before B can start).
 * `subgraph_deps` (modules only) are subgraph gates: the WHOLE subgraph of a
 * module — itself plus everything it depends on, transitively — additionally
 * waits for the gate. Gates are expanded HERE at read time (gateDeps /
 * effectiveDeps), so the gate applies to whatever the subgraph contains
 * today: nodes added to the subgraph later are gated automatically, nothing
 * is written into per-node deps. Graph theory (cycle detection, topological
 * traversal) is delegated to the mature `dependency-graph` library; the
 * business derivations below are implemented here as pure functions over
 * plain arrays (zero filesystem, zero pi dependency) so they are
 * unit-testable in memory.
 *
 * Semantics: cancelled counts as satisfied everywhere; the ready set is
 * pending items with all effective deps (deps + gates) satisfied —
 * dispatchable in parallel. Info nodes (kind = "info") are pure shared
 * content, never in the ready set nor dispatchable, and are excluded from
 * orphan detection. Cycles / dangling deps only arise from
 * hand-edited or corrupted files; all functions guard against them (never
 * hang, never crash the read path).
 */

import { DepGraph, DepGraphCycleError } from "dependency-graph";
import type { Task, TaskStatus } from "./store";

// ---------------------------------------------------------------------------
// Subgraph gates (subgraph_deps expansion)
// ---------------------------------------------------------------------------

/**
 * The read-time expansion of subgraph_deps: every node in a module's subgraph —
 * the module itself plus its transitive deps — additionally depends on each
 * of the module's gates. Returns the extra effective deps per node id.
 *
 * The expansion is recomputed from the CURRENT items on every call, which is
 * what makes the gate a standing invariant: a node added to the subgraph
 * later (a new dep of the module) is gated automatically, without any
 * per-node edit. A gate id with no item (corrupted file) is still returned —
 * consumers treat it as an unsatisfied dep, exactly like a dangling dep.
 * The walk never hangs on corrupted cycles (visited set).
 */
export function gateDeps(items: Task[]): Map<string, string[]> {
	const byId = new Map(items.map((i) => [i.id, i]));
	const extra = new Map<string, Set<string>>();
	for (const item of items) {
		// `?? []` — tolerant of hand-built/corrupted records missing the field
		const gates = item.subgraph_deps ?? [];
		if (gates.length === 0) continue;
		const seen = new Set<string>();
		const queue = [item.id];
		while (queue.length > 0) {
			const id = queue.pop() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			let s = extra.get(id);
			if (!s) {
				s = new Set<string>();
				extra.set(id, s);
			}
			for (const g of gates) s.add(g);
			const node = byId.get(id);
			if (node) queue.push(...node.deps);
		}
	}
	return new Map([...extra].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Effective deps of one item: its own deps plus the gates of every module
 * whose subgraph contains it — what must actually be done/cancelled before it
 * can start. Sorted like the stored deps arrays.
 */
export function effectiveDeps(items: Task[], item: Task): string[] {
	const gates = gateDeps(items).get(item.id);
	return gates && gates.length > 0 ? [...item.deps, ...gates].sort() : item.deps;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Build a dependency-graph over the items: one node per item (id → item
 * object as node data), plus an edge item → dep for every entry of item.deps
 * and an edge item → gate for every gate whose subgraph contains the item
 * (subgraph_deps read-time expansion) — the graph is validated in its expanded
 * form, so cycles that only arise between gates (A gates B while B gates A)
 * are caught by the same cycle detection. Throws when an item references a
 * dep id that has no node — callers must validate existence first (the store
 * does; validateGraph skips dangling refs itself).
 */
export function buildGraph(items: Task[]): DepGraph<Task> {
	const graph = new DepGraph<Task>();
	for (const item of items) graph.addNode(item.id, item);
	const extra = gateDeps(items);
	for (const item of items) {
		for (const dep of item.deps) graph.addDependency(item.id, dep);
		for (const dep of extra.get(item.id) ?? []) graph.addDependency(item.id, dep);
	}
	return graph;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadySetResult {
	/** Pending with all deps satisfied — dispatchable in parallel. */
	ready: Task[];
	/** Pending items still waiting on deps, with the unsatisfied dep ids. */
	notReady: Array<{ item: Task; missing: string[] }>;
}

/**
 * Partition the pending items into ready / notReady. Non-pending items
 * (dispatched, active, blocked, done, cancelled, worker_offline) are neither: the ready set is
 * about what can be dispatched NOW — a dispatched item is already owned.
 * Missing lists use EFFECTIVE deps (deps + subgraph gates), so a gated node
 * reports its unsatisfied gate among the missing — that is why it cannot be
 * dispatched yet.
 */
export function readySet(items: Task[]): ReadySetResult {
	const byId = new Map(items.map((i) => [i.id, i]));
	const extra = gateDeps(items);
	const ready: Task[] = [];
	const notReady: Array<{ item: Task; missing: string[] }> = [];
	for (const item of items) {
		if (item.kind === "info") continue; // shared info: pure content, never dispatchable
		if (item.status !== "pending") continue;
		const gates = extra.get(item.id);
		const effDeps = gates && gates.length > 0 ? [...item.deps, ...gates] : item.deps;
		const missing = effDeps.filter((depId) => {
			const dep = byId.get(depId);
			if (!dep) return true;
			return dep.status !== "done" && dep.status !== "cancelled";
		});
		if (missing.length === 0) ready.push(item);
		else notReady.push({ item, missing });
	}
	return {
		ready: ready.sort((a, b) => a.id.localeCompare(b.id)),
		notReady: notReady.sort((a, b) => a.item.id.localeCompare(b.item.id)),
	};
}

/**
 * Split the ready set by granularity kind: units, module. Feed it the ready list
 *  from readySet (already sorted by id); the buckets keep that order.
 */
export function readyBuckets(ready: Task[]): { execute: Task[]; modules: Task[] } {
	const execute: Task[] = [];
	const modules: Task[] = [];
	for (const item of ready) {
		if (item.kind === "info") continue; // shared info never dispatches
		if (item.kind === "module") modules.push(item);
		else execute.push(item);
	}
	return { execute, modules };
}

/**
 * Nodes that marking `id` done would newly unlock: a pending node P whose
 * ONLY unsatisfied effective dep is id (all other deps and gates already
 * satisfied). Effective deps include subgraph gates, so completing a gate
 * unlocks every gated frontier node whose only missing dep is the gate. The
 * caller passes the graph state BEFORE id is marked done — the store does,
 * right before the status write. Nodes already ready (id's dep already
 * satisfied in the given state) are naturally excluded: their missing list is
 * empty, not exactly [id].
 */
export function unlockedBy(items: Task[], id: string): string[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const extra = gateDeps(items);
	const unlocked: string[] = [];
	for (const item of items) {
		if (item.id === id) continue;
		if (item.status !== "pending") continue;
		const gates = extra.get(item.id);
		const effDeps = gates && gates.length > 0 ? [...item.deps, ...gates] : item.deps;
		const missing = effDeps.filter((depId) => {
			const dep = byId.get(depId);
			if (!dep) return true;
			return dep.status !== "done" && dep.status !== "cancelled";
		});
		if (missing.length === 1 && missing[0] === id) unlocked.push(item.id);
	}
	return unlocked.sort();
}

/**
 * Reverse lookup: which items depend on `id` (id appears in their deps),
 * sorted by id — the consumers a status change may unblock.
 */
export function dependentsOf(items: Task[], id: string): string[] {
	return items
		.filter((i) => i.deps.includes(id))
		.map((i) => i.id)
		.sort();
}

/**
 * The transitive dependency closure of `id`: every item `id` depends on,
 * directly or through its deps — the ancestors that must complete before it
 * can start. Deps are the edges, so the closure is exactly what a subgraph
 * needs before its root: the scope of "what can I dispatch to advance X".
 * Sorted by id; never hangs on corrupted cycles (visited set); dangling
 * dep ids are included in the closure, then simply have no item.
 */
export function dependencyClosure(items: Task[], id: string): string[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const closure = new Set<string>();
	const queue = [...(byId.get(id)?.deps ?? [])];
	while (queue.length > 0) {
		const depId = queue.pop() as string;
		if (closure.has(depId)) continue;
		closure.add(depId);
		const dep = byId.get(depId);
		if (dep) queue.push(...dep.deps);
	}
	return [...closure].sort();
}

// ---------------------------------------------------------------------------
// Full-graph inspection (corruption check)
// ---------------------------------------------------------------------------

export interface ValidateResult {
	/** Cycle paths found (each path lists the cycle's nodes in traversal order). */
	cycles: string[][];
	/** References to dep ids that have no item. */
	dangling: Array<{ id: string; dep: string }>;
}

/**
 * Full-graph health check for hand-edited / corrupted scenarios: every cycle
 * and every dangling reference. The graph is checked in its EXPANDED form
 * (subgraph_deps included), so gate-created cycles are reported too. Dangling
 * refs — dep or gate ids with no item — are skipped when building the graph
 * (they are reported, not fatal), and cycle detection loops — the library
 * reports one cycle per run, so each found cycle's nodes are removed before
 * the next run.
 */
export function validateGraph(items: Task[]): ValidateResult {
	const ids = new Set(items.map((i) => i.id));
	const graph = new DepGraph<Task>();
	for (const item of items) graph.addNode(item.id, item);
	const dangling: Array<{ id: string; dep: string }> = [];
	const extra = gateDeps(items);
	for (const item of items) {
		for (const dep of item.deps) {
			if (ids.has(dep)) graph.addDependency(item.id, dep);
			else dangling.push({ id: item.id, dep });
		}
		for (const dep of extra.get(item.id) ?? []) {
			if (ids.has(dep)) graph.addDependency(item.id, dep);
			else dangling.push({ id: item.id, dep });
		}
	}
	return { cycles: collectCycles(graph), dangling };
}

/**
 * Orphan graph nodes — units and modules that sit apart from the plan. Only
 * meaningful when the plan has modules: without them every root is a
 * top-level deliverable, so this returns []. Done/cancelled items are never
 * orphans. Sorted by id.
 *
 * A non-module task is an orphan when nothing depends on it (it appears in no
 * other node's deps or subgraph_deps) and it is outside every module's
 * subgraph. A module is an orphan when it has no deps, no subgraph_deps and no
 * dependents.
 */
function graphOrphans(items: Task[]): Task[] {
	if (!items.some((i) => i.kind === "module")) return [];
	const referenced = new Set<string>();
	for (const i of items) {
		for (const d of i.deps) referenced.add(d);
		for (const g of i.subgraph_deps ?? []) referenced.add(g);
	}
	const inSubgraph = new Set<string>();
	for (const m of items.filter((i) => i.kind === "module")) {
		if (m.deps.length > 0 || (m.subgraph_deps ?? []).length > 0) inSubgraph.add(m.id);
		for (const d of dependencyClosure(items, m.id)) inSubgraph.add(d);
	}
	return items
		.filter((i) => i.status !== "done" && i.status !== "cancelled")
		.filter((i) => i.kind !== "info")
		.filter((i) => !referenced.has(i.id) && !inSubgraph.has(i.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Orphan info nodes — kind="info" nodes no task references via info_refs.
 * Independent of modules (an info node is pure content, not a DAG node), so
 * this is not gated by module existence. Sorted by id.
 */
function infoOrphans(items: Task[]): Task[] {
	const referenced = new Set<string>();
	for (const i of items) if (i.kind !== "info") for (const r of i.info_refs ?? []) referenced.add(r);
	return items
		.filter((i) => i.kind === "info" && !referenced.has(i.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * All orphan items — graph orphans (units/modules apart from the plan) and
 * info orphans (unreferenced shared content), combined and sorted by id. For
 * whole-plan splits see {@link disconnectedComponents}.
 */
export function orphanItems(items: Task[]): Task[] {
	return [...graphOrphans(items), ...infoOrphans(items)].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Split the non-info nodes into connected components, treating deps and
 * subgraph_deps as undirected edges (a component therefore follows either edge
 * direction). A single component means the plan is connected; more than one
 * means it is split into separate pieces. This does not pick which component
 * is the intended plan. Components are returned with sorted ids, smallest
 * first. `dependency-graph` exposes no connectivity API, so this uses a
 * union-find over the adjacency lists.
 */
export function disconnectedComponents(items: Task[]): string[][] {
	const nodes = items.filter((i) => i.kind !== "info");
	if (nodes.length <= 1) return nodes.length === 1 ? [[nodes[0].id]] : [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		const root = parent.get(x);
		if (root === undefined || root === x) return x;
		parent.set(x, find(root));
		return parent.get(x) as string;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const n of nodes) {
		for (const d of n.deps) if (byId.has(d)) union(n.id, d);
		for (const g of n.subgraph_deps ?? []) if (byId.has(g)) union(n.id, g);
	}
	const grouped = new Map<string, string[]>();
	for (const n of nodes) {
		const root = find(n.id);
		const list = grouped.get(root);
		if (list) list.push(n.id);
		else grouped.set(root, [n.id]);
	}
	return [...grouped.values()].map((ids) => ids.sort()).sort((a, b) => a.length - b.length);
}

/** Find all cycles by removing each found cycle's nodes and re-running. */
function collectCycles(graph: DepGraph<Task>): string[][] {
	const cycles: string[][] = [];
	for (;;) {
		try {
			graph.overallOrder();
			return cycles;
		} catch (err: unknown) {
			if (!(err instanceof DepGraphCycleError)) throw err;
			cycles.push(err.cyclePath);
			for (const node of err.cyclePath) graph.removeNode(node);
		}
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Single source of truth for the on-disk status glyphs, shared by renderGraph and the shell tools. */
export const STATUS_GLYPHS: Record<TaskStatus, string> = {
	pending: "◻",
	dispatched: "◔",
	active: "◐",
	done: "✓",
	blocked: "⊘",
	cancelled: "✕",
	worker_offline: "✚",
};

/** Shown when the render traversal re-enters a node (corrupted cycle). */
const CYCLE_GLYPH = "↻";

const STATUS_ORDER: TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled", "worker_offline"];

/**
 * Forest render of the dependency structure, top-down from the deliverables:
 * roots are the items NOTHING depends on (sorted by id — the top of the
 * work), and each node's children are its deps (sorted — what the node needs
 * below it), so a milestone renders above the modules above the base tasks.
 * One line per node:
 *   <indent> <glyph> <id> <title> [module] (deps:<n>[, subgraph_deps: <ids>])
 * where the glyph reflects the node's status; the [module] marker tags
 * aggregation nodes (unit is the default and stays unmarked, keeping the
 * tree readable). A module's subgraph gate (subgraph_deps) is rendered ONCE on
 * the module's own line as `subgraph_deps: <ids>` — the gated subgraph nodes are not
 * marked individually, keeping the tree simple (the gate applies to all of
 * them by expansion). A cycle guard shows ↻ instead of recursing into a node
 * already on the current path. A shared dep (diamond) renders once per
 * parent — this is a forest, not a deduped graph.
 *
 * Footer: with opts.showReady a "Ready: <ids>" line; otherwise per-status
 * counts (nonzero only). Info nodes (kind = "info") are rendered as a
 * separate "Shared information" section after the tree — they are pure
 * content, not DAG nodes — and are excluded from the status counts.
 */
export function renderGraph(items: Task[], opts?: { showReady?: boolean }): string {
	const byId = new Map(items.map((i) => [i.id, i]));
	const dependedOn = new Set(items.flatMap((i) => i.deps));
	const roots = items
		.filter((i) => i.kind !== "info") // shared info renders as a separate section, not in the DAG tree
		.filter((i) => !dependedOn.has(i.id))
		.sort((a, b) => a.id.localeCompare(b.id));

	const lines: string[] = [];
	const path = new Set<string>();
	const renderNode = (item: Task, depth: number): void => {
		const inCycle = path.has(item.id);
		const glyph = inCycle ? CYCLE_GLYPH : STATUS_GLYPHS[item.status];
		const title = item.title ? ` ${item.title}` : "";
		const kindMark = item.kind === "module" ? " [module]" : "";
		const gateMark =
			item.subgraph_deps && item.subgraph_deps.length > 0
				? `, subgraph_deps: ${item.subgraph_deps.join(", ")}`
				: "";
		const infoMark =
			item.info_refs && item.info_refs.length > 0
				? `, info_refs: ${item.info_refs.join(", ")}`
				: "";
		lines.push(
			`${"  ".repeat(depth)}${glyph} ${item.id}${title}${kindMark} (deps:${item.deps.length}${gateMark}${infoMark})`,
		);
		if (inCycle) return;
		path.add(item.id);
		for (const depId of [...item.deps].sort()) {
			const dep = byId.get(depId);
			if (dep) renderNode(dep, depth + 1);
		}
		path.delete(item.id);
	};
	const infoNodes = items.filter((i) => i.kind === "info").sort((a, b) => a.id.localeCompare(b.id));

	for (const root of roots) renderNode(root, 0);

	if (infoNodes.length > 0) {
		lines.push("");
		lines.push(`── Shared information (${infoNodes.length}) ──`);
		for (const n of infoNodes) {
			const title = n.title ? ` ${n.title}` : "";
			lines.push(`  § ${n.id}${title} (referenced by ${[...items].filter((i) => i.info_refs?.includes(n.id)).length})`);
		}
	}

	lines.push("");
	if (opts?.showReady) {
		const readyIds = readySet(items).ready.map((i) => i.id);
		lines.push(`Ready: ${readyIds.join(", ") || "(none)"}`);
	} else {
		const counts = new Map<TaskStatus, number>();
		for (const item of items) {
			if (item.kind === "info") continue; // shared info has no lifecycle, excluded from counts
			counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
		}
		const parts = STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0)
			.map((s) => `${s}: ${counts.get(s)}`);
		lines.push(parts.length > 0 ? parts.join(", ") : "no tasks");
	}
	return lines.join("\n") + "\n";
}
