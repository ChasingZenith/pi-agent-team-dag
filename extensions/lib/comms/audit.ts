/**
 * comms — audit log helper. The entry point installs the writer
 * (pi.appendEntry on the "comms-log" channel); modules call audit().
 * Never throws.
 */

type AuditFn = (event: string, extra?: Record<string, any>) => void;

let writer: AuditFn = () => { /* no-op until installed */ };

export function setAudit(fn: AuditFn): void {
	writer = fn;
}

export function audit(event: string, extra?: Record<string, any>): void {
	try {
		writer(event, extra);
	} catch {
		// best-effort
	}
}
