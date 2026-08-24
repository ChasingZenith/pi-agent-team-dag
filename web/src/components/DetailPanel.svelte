<script lang="ts">
	import { marked } from "marked";
	import { STATUS_META } from "../lib/types";
	import type { GraphItem } from "../lib/types";

	interface Props {
		gi: GraphItem;
		onClose: () => void;
	}

	let { gi, onClose }: Props = $props();

	const meta = $derived(STATUS_META[gi.item.status]);
	const descriptionHtml = $derived(
		gi.item.description
			? (marked.parse(gi.item.description, { async: false }) as string)
			: "",
	);
</script>

<div
	class="scrim"
	role="button"
	aria-label="Close detail panel"
	tabindex="-1"
	onclick={onClose}
	onkeydown={(e) => {
		if (e.key === "Enter" || e.key === " ") onClose();
	}}
></div>
<div class="panel" role="dialog" aria-label={gi.item.id}>
	<header>
		<div>
			<h1>
				<span class="glyph" style="color:{meta.color}">{meta.glyph}</span>
				{gi.item.title}
			</h1>
			<div class="idline">
				<span class="mono">{gi.item.id}</span>
				<span class="tag status" style="background:{meta.color}">{meta.label}</span>
			</div>
		</div>
		<button class="close" onclick={onClose} aria-label="Close">✕</button>
	</header>

	<section class="states">
		{#if gi.ready}
			<div class="callout ready">All deps satisfied — ready to dispatch in parallel.</div>
		{:else if gi.missing.length > 0}
			<div class="callout waiting">Waiting for: {gi.missing.join(", ")}</div>
		{/if}
		{#if gi.item.status === "blocked"}
			<div class="callout blocked">Blocked — reality is blocking progress.</div>
		{/if}
	</section>

	<section class="meta">
		<dl>
			<div>
				<dt>Status</dt>
				<dd>{gi.item.status}</dd>
			</div>
			<div>
				<dt>Kind</dt>
				<dd>{gi.item.kind}</dd>
			</div>
			<div>
				<dt>Version</dt>
				<dd>v{gi.item.version}</dd>
			</div>
			<div>
				<dt>Updated</dt>
				<dd>{gi.item.updated_at.slice(0, 19).replace("T", " ")} by {gi.item.updated_by}</dd>
			</div>
			<div>
				<dt>Created</dt>
				<dd>{gi.item.created_at.slice(0, 19).replace("T", " ")}</dd>
			</div>
		</dl>
	</section>

	<section>
		<h2>Dependencies</h2>
		{#if gi.item.deps.length > 0}
			<ul class="ids">
				{#each gi.item.deps as dep}
					<li><span class="mono">{dep}</span></li>
				{/each}
			</ul>
		{:else}
			<p class="empty">(none)</p>
		{/if}
	</section>

	{#if gi.item.subgraph_deps && gi.item.subgraph_deps.length > 0}
		<section>
			<h2>Subgraph gates</h2>
			<ul class="ids">
				{#each gi.item.subgraph_deps as gate}
					<li><span class="mono">{gate}</span></li>
				{/each}
			</ul>
			<p class="hint">
				This module's whole subgraph — itself plus everything it depends on, transitively —
				also waits for these to complete.
			</p>
		</section>
	{/if}

	<section>
		<h2>Dependents</h2>
		{#if gi.dependents.length > 0}
			<ul class="ids">
				{#each gi.dependents as dep}
					<li><span class="mono">{dep}</span></li>
				{/each}
			</ul>
		{:else}
			<p class="empty">(none)</p>
		{/if}
	</section>

	{#if gi.item.description}
		<section>
			<h2>Description</h2>
			<div class="markdown">{@html descriptionHtml}</div>
		</section>
	{/if}

	<section>
		<h2>Change history</h2>
		{#if gi.item.history.length > 0}
			<ol class="history">
				{#each gi.item.history as h}
					<li>
						<span class="mono">v{h.version}</span>
						<span class="dim">{h.updated_at.slice(0, 19).replace("T", " ")} by {h.updated_by}</span>
						<p>{h.change_summary}</p>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="empty">(none)</p>
		{/if}
	</section>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.45);
		z-index: 40;
	}
	.panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(420px, 90vw);
		background: #0f172a;
		border-left: 1px solid #334155;
		z-index: 50;
		overflow-y: auto;
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: flex-start;
	}
	h1 {
		font-size: 17px;
		margin: 0;
		line-height: 1.3;
		display: flex;
		gap: 8px;
		align-items: baseline;
	}
	.idline {
		margin-top: 6px;
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		color: #94a3b8;
	}
	.tag {
		font-size: 10px;
		line-height: 1;
		padding: 3px 7px;
		border-radius: 999px;
		background: #334155;
		color: #cbd5e1;
		white-space: nowrap;
	}
	.tag.status {
		color: #0f172a;
		font-weight: 700;
	}
	.tag.dim {
		background: #1e293b;
		color: #64748b;
	}
	.close {
		border: none;
		background: none;
		color: #94a3b8;
		font-size: 15px;
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 6px;
	}
	.close:hover {
		background: #1e293b;
		color: #e2e8f0;
	}
	.callout {
		font-size: 13px;
		padding: 10px 12px;
		border-radius: 8px;
	}
	.callout.ready {
		background: rgb(245 158 11 / 0.12);
		border: 1px solid #f59e0b;
		color: #fcd34d;
	}
	.callout.waiting {
		background: rgb(59 130 246 / 0.1);
		border: 1px solid #3b82f6;
		color: #93c5fd;
	}
	.callout.blocked {
		background: rgb(239 68 68 / 0.12);
		border: 1px solid #ef4444;
		color: #fca5a5;
	}
	section h2 {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #64748b;
		margin: 0 0 8px;
	}
	dl {
		margin: 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 14px;
		font-size: 13px;
	}
	dt {
		color: #64748b;
	}
	dd {
		margin: 0;
		color: #e2e8f0;
	}
	.ids {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.empty {
		color: #64748b;
		font-size: 13px;
		margin: 0;
	}
	.hint {
		color: #64748b;
		font-size: 12px;
		line-height: 1.5;
		margin: 6px 0 0;
	}
	.markdown {
		font-size: 13.5px;
		line-height: 1.6;
		color: #cbd5e1;
	}
	.markdown :global(pre) {
		background: #1e293b;
		padding: 10px 12px;
		border-radius: 8px;
		overflow-x: auto;
	}
	.markdown :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
	}
	.markdown :global(a) {
		color: #60a5fa;
	}
	.history {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.history li {
		font-size: 13px;
	}
	.history p {
		margin: 2px 0 0;
		color: #cbd5e1;
	}
	.dim {
		color: #64748b;
		font-size: 12px;
		margin-left: 8px;
	}
</style>
