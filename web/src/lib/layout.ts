/**
 * Graph → SvelteFlow nodes/edges with a dagre layout.
 *
 * Direction: B.deps=[A] means A completes before B — the edge is drawn
 * dep → dependent (A on top, B below), i.e. the natural reading direction
 * of the renderGraph tree (roots = deliverables, children = their deps).
 * dagre gets the edge reversed from the stored form for that.
 *
 * Node data carries the full GraphItem so the custom node component
 * (TaskNode.svelte) can render status and ready markers without any
 * lookup tables.
 */
import dagre from "dagre";
import type { Edge, Node } from "@xyflow/svelte";
import type { GraphItem, GraphResponse } from "./types";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 64;

/** Type alias (not interface) so it satisfies xyflow's Record constraint. */
export type TaskNodeData = {
	gi: GraphItem;
};

export interface TaskLayout {
	nodes: Node<TaskNodeData>[];
	edges: Edge[];
}

export function buildNodesEdges(graph: GraphResponse): TaskLayout {
	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });

	const itemIds = new Set(graph.items.map((gi) => gi.item.id));
	for (const gi of graph.items) {
		g.setNode(gi.item.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const gi of graph.items) {
		for (const dep of gi.item.deps) {
			// dagre draws edge source→target with source ranked above target.
			g.setEdge(dep, gi.item.id);
		}
		// Subgraph gates participate in layout too (the gate completes above
		// the module) — a dangling gate (corrupted file) has no node to rank.
		for (const gate of gi.item.subgraph_deps ?? []) {
			if (itemIds.has(gate)) g.setEdge(gate, gi.item.id);
		}
	}
	dagre.layout(g);

	const nodes: Node<TaskNodeData>[] = graph.items.map((gi) => {
		const pos = g.node(gi.item.id);
		return {
			id: gi.item.id,
			type: "task",
			position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
			data: { gi },
		};
	});

	// Warning edges (from hand-edited / corrupted files): mark cycle edges red.
	// Dangling deps have no target node — they cannot be drawn, the status bar
	// lists them instead.
	const cycleEdges = new Set<string>();
	for (const cycle of graph.warnings.cycles) {
		for (let i = 0; i < cycle.length; i++) {
			cycleEdges.add(`${cycle[i]}→${cycle[(i + 1) % cycle.length]}`);
		}
	}

	const depEdges: Edge[] = graph.items.flatMap((gi) =>
		gi.item.deps.map((dep) => {
			const inCycle = cycleEdges.has(`${gi.item.id}→${dep}`) || cycleEdges.has(`${dep}→${gi.item.id}`);
			return {
				id: `${gi.item.id}→${dep}`,
				source: dep,
				target: gi.item.id,
				type: "smoothstep",
				style: inCycle ? { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "6 4" } : { stroke: "#94a3b8", strokeWidth: 1.5 },
				markerEnd: inCycle ? undefined : { type: "arrowclosed" as const, color: "#94a3b8", width: 14, height: 14 },
			};
		}),
	);

	// Subgraph gate edges (subgraph_deps): drawn only between the module and
	// each gate — NOT expanded into the subgraph's nodes. Same direction as
	// deps (the gate completes above the module) but visibly bolder: the gate
	// is an ordering edge for the module's whole subgraph, not one dep of one
	// node. A gate inside the module's own deps is rejected at write time, so
	// a gate edge never duplicates a dep edge; a dangling gate (corrupted
	// file) has no source node and cannot be drawn — the status bar lists it.
	const gateEdges: Edge[] = graph.items.flatMap((gi) =>
		(gi.item.subgraph_deps ?? []).flatMap((gate) => {
			if (!itemIds.has(gate)) return [];
			const inCycle =
				cycleEdges.has(`${gi.item.id}→${gate}`) || cycleEdges.has(`${gate}→${gi.item.id}`);
			return {
				id: `${gi.item.id}→${gate}`,
				source: gate,
				target: gi.item.id,
				type: "smoothstep",
				style: inCycle ? { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "6 4" } : { stroke: "#a855f7", strokeWidth: 4 },
				markerEnd: inCycle ? undefined : { type: "arrowclosed" as const, color: "#a855f7", width: 18, height: 18 },
			};
		}),
	);

	return { nodes, edges: [...depEdges, ...gateEdges] };
}
