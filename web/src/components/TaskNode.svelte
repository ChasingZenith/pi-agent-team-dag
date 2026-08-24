<script lang="ts">
	import { Handle, Position } from "@xyflow/svelte";
	import type { Node, NodeProps } from "@xyflow/svelte";
	import { STATUS_META } from "../lib/types";
	import type { TaskNodeData } from "../lib/layout";

	type TaskNode = Node<TaskNodeData, "task">;

	interface Props extends NodeProps<TaskNode> {}

	let { data }: Props = $props();

	const gi = $derived(data.gi);
	const meta = $derived(STATUS_META[gi.item.status]);
</script>

{@render hiddenHandle(Position.Top, "target")}
{@render hiddenHandle(Position.Bottom, "source")}

<div class="task-node" class:ready={gi.ready} style="--status:{meta.color}">
	<div class="head">
		<span class="glyph" style="color:{meta.color}">{meta.glyph}</span>
		<span class="title" title={gi.item.title}>{gi.item.title || gi.item.id}</span>
	</div>
	<div class="foot">
		<span class="id">{gi.item.id}</span>
		<span class="chips">
			{#if gi.item.subgraph_deps && gi.item.subgraph_deps.length > 0}
				<span
					class="chip gate-chip"
					title="Subgraph gates — this module's whole subgraph also waits for: {gi.item.subgraph_deps.join(", ")}"
				>⛩ {gi.item.subgraph_deps.join(", ")}</span>
			{/if}
			{#if gi.ready}
				<span class="chip ready-chip" title="All deps satisfied — dispatchable">ready</span>
			{/if}
			<span class="chip status" style="background:{meta.color}">{meta.label}</span>
		</span>
	</div>
</div>

{#snippet hiddenHandle(position: Position, type: "source" | "target")}
	<Handle
		{type}
		{position}
		style={{ visibility: "hidden", width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none" }}
	/>
{/snippet}

<style>
	.task-node {
		width: 200px;
		border: 1.5px solid var(--status);
		border-radius: 8px;
		background: #1e293b;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
		padding: 6px 10px;
		font-family: inherit;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.task-node.ready {
		outline: 2px solid #f59e0b;
		outline-offset: 2px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.glyph {
		flex: none;
	}
	.title {
		font-weight: 600;
		font-size: 13px;
		color: #e2e8f0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	.id {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 11px;
		color: #64748b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chips {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.chip {
		font-size: 10px;
		line-height: 1;
		padding: 3px 6px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.chip.ready-chip {
		background: #f59e0b;
		color: #0f172a;
	}
	.chip.gate-chip {
		background: rgb(168 85 247 / 0.18);
		color: #d8b4fe;
		border: 1px solid #a855f7;
		max-width: 96px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chip.status {
		color: #0f172a;
		font-weight: 700;
	}
</style>
