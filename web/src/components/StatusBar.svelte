<script lang="ts">
	import { STATUS_META } from "../lib/types";
	import type { GraphResponse, TaskStatus } from "../lib/types";

	interface Props {
		graph: GraphResponse | null;
		live: boolean;
		error: string | null;
	}

	let { graph, live, error }: Props = $props();

	const order: TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled"];
	const total = $derived(graph?.items.length ?? 0);
	const readyCount = $derived(graph?.items.filter((gi) => gi.ready).length ?? 0);
	/** Pending items whose deps are not all satisfied yet — waiting in line, not broken. */
	const waitingCount = $derived(
		graph?.items.filter((gi) => gi.item.status === "pending" && !gi.ready).length ?? 0,
	);
	const warnings = $derived(
		graph
			? graph.warnings.cycles.length + graph.warnings.dangling.length + graph.warnings.orphans.length
			: 0,
	);
</script>

<header class="bar">
	<div class="left">
		<span class="title">Tasks</span>
		{#if graph}
			<span class="count">{total} item{total === 1 ? "" : "s"}</span>
		{/if}
	</div>

	<div class="counts">
		{#if graph}
			{#each order as st}
				<span class="chip" style="--c:{STATUS_META[st].color}">
					<span class="dot"></span>
					{STATUS_META[st].label} {graph.counts[st]}
				</span>
			{/each}
			{#if readyCount > 0}
				<span class="chip ready" title="Ready to dispatch in parallel">Ready {readyCount}</span>
			{/if}
			{#if waitingCount > 0}
				<span class="chip waiting" title="Pending with unsatisfied deps — waiting for prerequisites, not a graph error">Waiting {waitingCount}</span>
			{/if}
			{#if warnings > 0}
				<span class="chip warn" title="Graph warnings (cycles / dangling deps / orphans)">
					⚠ {graph.warnings.cycles.length} cycle{graph.warnings.cycles.length === 1 ? "" : "s"} · {graph.warnings.dangling.length} dangling · {graph.warnings.orphans.length} orphan{graph.warnings.orphans.length === 1 ? "" : "s"}
				</span>
			{/if}
		{/if}
	</div>

	<div class="right">
		{#if error}
			<span class="live err" title={error}>API error</span>
		{:else}
			<span class="live" class:on={live}>
				<span class="dot"></span>
				{live ? "live" : "connecting"}
			</span>
		{/if}
	</div>
</header>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 18px;
		border-bottom: 1px solid #1e293b;
		background: #0f172a;
		position: relative;
		z-index: 10;
	}
	.left {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.title {
		font-weight: 700;
		font-size: 15px;
	}
	.count {
		font-size: 12px;
		color: #64748b;
	}
	.counts {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip {
		font-size: 11px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 999px;
		background: #1e293b;
		color: #cbd5e1;
		white-space: nowrap;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c, #64748b);
	}
	.chip.ready {
		background: rgb(245 158 11 / 0.15);
		color: #fcd34d;
		border: 1px solid #f59e0b;
	}
	.chip.waiting {
		background: rgb(59 130 246 / 0.12);
		color: #93c5fd;
		border: 1px solid #3b82f6;
	}
	.chip.warn {
		background: rgb(239 68 68 / 0.12);
		color: #fca5a5;
		border: 1px solid #ef4444;
	}
	.right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.live {
		font-size: 11px;
		color: #64748b;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.live .dot {
		background: #64748b;
	}
	.live.on .dot {
		background: #22c55e;
		box-shadow: 0 0 6px #22c55e;
	}
	.live.err {
		color: #fca5a5;
	}</style>
