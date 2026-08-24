<script lang="ts">
	import { Background, Controls, MiniMap, SvelteFlow } from "@xyflow/svelte";
	import type { Edge, Node } from "@xyflow/svelte";
	import TaskNode from "./TaskNode.svelte";
	import { STATUS_META } from "../lib/types";
	import type { TaskNodeData } from "../lib/layout";

	interface Props {
		nodes: Node<TaskNodeData>[];
		edges: Edge[];
		onNodeClick: (id: string) => void;
		onPaneClick: () => void;
	}

	let { nodes, edges, onNodeClick, onPaneClick }: Props = $props();

	// Must be a stable reference — SvelteFlow would remount node types on change.
	const nodeTypes = { task: TaskNode };

	/** MiniMap node colors: the status color of each node. */
	function nodeColor(n: Node): string {
		const gi = (n.data as TaskNodeData | undefined)?.gi;
		return gi ? STATUS_META[gi.item.status].color : "#334155";
	}
</script>

<SvelteFlow
	{nodes}
	{edges}
	{nodeTypes}
	nodesDraggable={false}
	nodesConnectable={false}
	fitView
	fitViewOptions={{ padding: 0.15 }}
	onnodeclick={(e) => onNodeClick(e.node.id)}
	onpaneclick={onPaneClick}
>
	<Background gap={24} size={1.5} />
	<Controls showZoom showFitView />
	<MiniMap pannable zoomable {nodeColor} />
</SvelteFlow>
