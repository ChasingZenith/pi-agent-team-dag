# Pi Agent Team DAG

A pi extension providing Networked agent-to-agent communication (`comms` on NATS + JetStream), on-demand agent spawning (`agent-lifecycle`), and a central teammate registry (`teammate-provider`) with a coordinator orchestration workflow.

## Project Structure
- `extensions/` — Pi extension source files (.ts)
- `extensions/role-context.ts` — Role/context extension: `--role` flag + role-prompt injection
- `extensions/lib/role-context/` — Role templates (`roles/`), LLMContext builders, SessionManager-backed session creation/fork (`fork.ts`)
- `extensions/task-graph.ts` — Task graph tools (task_create/update/set_status/read/list/ready/render) for the graph-driven task workflow
- `extensions/lib/tasks/` — `store.ts` (filesystem task storage) + `graph.ts` (ready-set/unlock derivation), `.pi/tasks/`
- `docs/` — Feature documentation (overview & index: `docs/0-overview.md`; each module doc covers only its own design/function)
- `.pi/agent-sessions/` — Ephemeral session files (gitignored)

## Conventions
- Documentation in `doc/` should only contain description for the latest version. Don't mention any thing about changes.

## Reference
npm package earendil-works/pi-coding-agent in /opt/pi-coding-agent/ 
documentation in /opt/pi-coding-agent/doc/ 
examples in /opt/pi-coding-agent/examples/
source code  in ~/Softwares/pi/
