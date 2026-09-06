/**
 * comms — audit log helper. Modules that need audit take an AuditFn as an
 * injected dependency (composition root passes pi.appendEntry on the
 * "comms-log" channel); the module-level default is a no-op fallback.
 * Never throws.
 */

export type AuditFn = (event: string, extra?: Record<string, any>) => void;

const noop: AuditFn = () => { /* no-op fallback when no sink is injected */ };

export function audit(event: string, extra?: Record<string, any>): void {
	noop(event, extra);
}
