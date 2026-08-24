/**
 * comms — shared reminder scheduler + FIFO cap helper.
 *
 * messaging.ts drives sender-side "still waiting for a reply" reminders
 * through ONE shared scheduler (a single unref'd setInterval, ~30s tick)
 * instead of one interval loop per awaited send. Each tick the scheduler
 * collects the current pending entries, computes which are due (remindMs
 * configured, not expired, remindMs elapsed since the last reminder), and
 * when at least one is due calls onTick ONCE with the full pending list — a
 * single consolidated reminder turn, no per-message storm. Entries past
 * their TTL (expiresAt) are dropped from reminding and reported once via
 * onExpire.
 *
 * The scheduler is SHARED, so per-key lifecycle (reply arrived, dismissed,
 * FIFO-evicted) needs no per-key teardown: an entry stops being due the
 * moment collect() stops returning it (or returns remindMs 0). Its only
 * per-key state is the last-injection clock and a one-shot onExpire marker.
 */

/** A pending send as the scheduler sees it (timing fields only). */
export interface ReminderEntry {
	msg_id: string;
	/** ms epoch of the send (expiry = sentAt + TTL). */
	sentAt: number;
	/** Reminder cadence in ms; <= 0 → never remind. */
	remindMs: number;
	/** ms epoch of the last injected reminder (seed value; the scheduler tracks updates). */
	lastRemindAt: number;
	/** ms epoch after which the entry is expired (dropped from reminding), or null when no TTL. */
	expiresAt: number | null;
}

export interface ReminderSchedulerHooks {
	/** Tick interval in ms; default 30_000. */
	tickMs?: number;
	/** true → skip this tick (shutting down / injector not wired yet). */
	isSuspended?: () => boolean;
	/** Current pending entries with timing fields populated by the caller. */
	collect: () => ReminderEntry[];
	/** Called at most once per tick, with the FULL pending list, when >= 1 entry is due. */
	onTick: (pending: ReminderEntry[]) => void;
	/** Called once per msg_id the first time it crosses its TTL. Optional. */
	onExpire?: (msgId: string) => void;
}

export interface ReminderScheduler {
	/** (Re-)arm a msg_id: resets its reminder clock to now. */
	arm(msgId: string): void;
	/** Drop a msg_id from the scheduler (reply arrived / dismissed / evicted). */
	cancel(msgId: string): void;
	/** Stop the shared interval. Returns how many msg_ids were armed. */
	stopAll(): number;
}

export function createReminderScheduler(hooks: ReminderSchedulerHooks): ReminderScheduler {
	// Scheduler-side last-injection clock (seeded from the entry's
	// lastRemindAt on first sight; refreshed on arm() and on each due tick).
	const lastRemindAt = new Map<string, number>();
	// One-shot onExpire markers (kept tiny; cleared on cancel).
	const expiredReported = new Set<string>();

	function tick(): void {
		if (hooks.isSuspended?.()) return;
		const pending = hooks.collect();
		if (pending.length === 0) return;
		const now = Date.now();
		const due: ReminderEntry[] = [];
		for (const entry of pending) {
			if (!(entry.remindMs > 0)) continue; // no reminder configured
			// Past TTL: dropped from reminding, reported once.
			if (entry.expiresAt !== null && now >= entry.expiresAt) {
				if (!expiredReported.has(entry.msg_id)) {
					expiredReported.add(entry.msg_id);
					hooks.onExpire?.(entry.msg_id);
				}
				continue;
			}
			const last = lastRemindAt.get(entry.msg_id) ?? entry.lastRemindAt;
			if (now - last >= entry.remindMs) due.push(entry);
		}
		if (due.length === 0) return;
		// Update the reminder clocks FIRST so a re-entrant injector (which may
		// re-read the store) sees the new last-reminded state, then inject once.
		for (const entry of due) lastRemindAt.set(entry.msg_id, now);
		hooks.onTick(pending);
	}

	const timer = setInterval(tick, hooks.tickMs ?? 30_000);
	// Never keep the process alive for a reminder tick.
	try { (timer as any).unref?.(); } catch { /* ignore */ }

	return {
		arm(msgId) {
			lastRemindAt.set(msgId, Date.now());
		},
		cancel(msgId) {
			lastRemindAt.delete(msgId);
			expiredReported.delete(msgId);
		},
		stopAll() {
			try { clearInterval(timer); } catch { /* ignore */ }
			const n = lastRemindAt.size;
			lastRemindAt.clear();
			expiredReported.clear();
			return n;
		},
	};
}

/**
 * FIFO cap on a parked map: when size exceeds cap, evict the oldest key (Map
 * insertion order) and notify via onEvict — the caller audits. Used by the
 * pending-reply map in messaging.ts (PENDING_CAP). The scheduler is shared,
 * so an evicted entry needs no per-key teardown: it simply stops being
 * collected.
 */
export function fifoEvict<T>(map: Map<string, T>, cap: number, onEvict?: (key: string) => void): void {
	if (map.size <= cap) return;
	const oldest = map.keys().next().value;
	if (oldest) {
		onEvict?.(oldest);
		map.delete(oldest);
	}
}
