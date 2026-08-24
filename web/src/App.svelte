<script lang="ts">
	import { onMount } from "svelte";
	import StatusBar from "./components/StatusBar.svelte";
	import TaskGraph from "./components/TaskGraph.svelte";
	import DetailPanel from "./components/DetailPanel.svelte";
	import { fetchGraph, subscribeChanges } from "./lib/api";
	import { buildNodesEdges } from "./lib/layout";
	import type { GraphItem, GraphResponse } from "./lib/types";

	function findSelected(g: GraphResponse | null, id: string | null): GraphItem | null {
		if (!g || !id) return null;
		return g.items.find((gi) => gi.item.id === id) ?? null;
	}

	let graph: GraphResponse | null = $state(null);
	let selectedId: string | null = $state(null);
	let error: string | null = $state(null);
	let live = $state(false);

	async function load(): Promise<void> {
		try {
			graph = await fetchGraph();
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(() => {
		load();
		return subscribeChanges({
			onChange: () => load(),
			onOpen: () => (live = true),
			onError: () => (live = false),
		});
	});

	const { nodes, edges } = $derived(
		graph ? buildNodesEdges(graph) : { nodes: [], edges: [] },
	);
	const selected = $derived(findSelected(graph, selectedId));
</script>

<StatusBar {graph} {live} {error} />

<main class="stage">
	<TaskGraph
		{nodes}
		{edges}
		onNodeClick={(id) => (selectedId = id)}
		onPaneClick={() => (selectedId = null)}
	/>
</main>

{#if selected}
	<DetailPanel gi={selected} onClose={() => (selectedId = null)} />
{/if}

<style>
	.stage {
		position: absolute;
		inset: 42px 0 0;
	}
</style>
