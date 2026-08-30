# Pi Agent Team DAG

> **An implementation of a networked agent-team workflow for intelligent agents** — a stack of [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) extensions that turns a fleet of individual agents into a real team: agents talk to each other over a NATS + JetStream message bus, get spawned and killed on demand, register in a central teammate registry, and follow a coordinator orchestration workflow that delegates work and collects results.

> **Documentation**: [docs/0-overview.md](docs/0-overview.md) — architecture overview and doc index

## Key capabilities

The Pi Agent Team DAG feature is composed of five pieces, one per layer of the stack:

### 1. comms — agent-to-agent messaging on NATS + JetStream

`extensions/comms.ts` + `extensions/lib/comms/` · [docs/1-comms.md](docs/1-comms.md)

Networked messaging between agents. Every agent connects to a NATS hub, owns a durable per-agent prompt queue, and gets six tools — `comms_list_peer` (peer roster with status), `comms_send` (message/reply, returns `msg_id`), `comms_outbox`/`comms_inbox` (persistent send/receive history), `comms_dismiss` (stop a send's reminder), `comms_update_profile` (declare `current_task`). Full tool reference: [docs/1-comms.md](docs/1-comms.md).

Reliability is baked in: **JetStream durable consumers** redeliver a crashed agent's unacked messages (nothing is silently lost), every send/receive persists to the `comms_history` KV bucket (24h TTL), and heartbeats let peers detect stale/offline agents. Async by design — no auto-reply (avoids ping-pong loops); optional `remind_s` (seconds) arms a consolidated reminder covering all pending sends.

### 2. agent-lifecycle — on-demand agent spawning

`extensions/agent-lifecycle/` + `extensions/lib/launch-script.ts` · [docs/2-create-and-kill-agent-on-net.md](docs/2-create-and-kill-agent-on-net.md)

Spawns and kills Pi agents in tmux panes with identity flags, model pinning, and auto-exit:

- `agent_spawn` — launch an agent in a tmux pane with a given LLMContext (role, model, name)
- `agent_kill` — kill an agent by closing its tmux pane
- Role-aware spawn via `executeAgentSpawnByRole()` — validate role → unique name → build context → spawn

Spawned agents load the comms extension in their launch script, so they auto-connect to the hub and are immediately reachable by name.

### 3. role-context — roles, context and sessions

`extensions/role-context.ts` + `extensions/lib/role-context/` · [docs/2-role-context.md](docs/2-role-context.md)

Gives agents a role and a context. A `--role` flag picks one of the role templates that get injected into the agent's system prompt: `coordinator` (owns the node handed to it and its subgraph, delegates everything), `planner` (graph decomposition), `scout` (codebase exploration), `web-searcher` (web research), `worker` (general execution), `experts-reviewer` (expert-panel review), `consultor` (suggestions), `requirements-clarifier` (requirements authoring).

Also provides LLMContext builders and SessionManager-backed session creation/fork — agents can fork an existing session into a new agent instead of starting from scratch.

### 4. teammate-provider — the central teammate registry

`extensions/teammate-provider/` + role template `extensions/lib/role-context/roles/manager/teammate-provider.md` · [docs/3-teammate-provider.md](docs/3-teammate-provider.md)

A standalone comms agent registered as `teammate-provider` — the unique, network-wide registry for finding or creating agents. Agents send it structured requests (role, task, collaborators, context); its LLM scans the network, then **matches an existing agent or spawns a new one** via `tp_spawn_agent`, briefs the teammate, and replies with its name — the caller can't tell whether the agent was found or created.

### 5. coordinator — the task management role

Role template `extensions/lib/role-context/roles/manager/coordinator.md` · [docs/5-coordinator.md](docs/5-coordinator.md)

A pure role template (no standalone extension). The coordinator owns the task node handed to it — the goal's task from the user at the top, or a node from a parent coordinator — and the subgraph below it. It does **no actual work**: it delegates everything to specialists obtained through the teammate-provider (research → plan → execute → review), tracks progress through `comms_outbox`/`comms_inbox`, and can recursively spawn sub-coordinators for complex subgraphs. There is no separate top-level role — a top coordinator is just a coordinator whose parent is the user. The full orchestration flow is in [docs/5-coordinator.md](docs/5-coordinator.md).

## Technology stack

| Layer | Technology |
| --- | --- |
| Runtime & language | [Bun](https://bun.sh) ≥ 1.3.2 · TypeScript |
| Messaging backbone | [NATS](https://nats.io) + JetStream — streams, KV buckets, durable consumers (`nats` npm package) |
| Agent host | [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) extension API — tools, flags, lifecycle hooks · `@earendil-works/pi-tui` for the TUI |
| Process orchestration | tmux (panes) |
| Task runner | [just](https://just.systems) |

## Getting started

### Prerequisites

All three are required:

| Tool            | Purpose                   | Install                                                    |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| **Bun** ≥ 1.3.2 | Runtime & package manager | [bun.sh](https://bun.sh)                                   |
| **just**        | Task runner               | `brew install just`                                        |
| **pi**          | Pi Coding Agent CLI       | [Pi docs](https://github.com/mariozechner/pi-coding-agent) |

### Install

```bash
bun install
```

### Quick start — two agents on the local hub

```bash
# Terminal 1 — start the local NATS server (downloads nats-server if not on PATH)
just comms-server

# Terminal 2 & 3 — clients (default nats://127.0.0.1:4222)
just comms --name planner --cname planner
just comms --name coder   --cname coder
```

From either side, an agent can `comms_send(target: "planner", message, remind_s)`; the reply comes back as an inbound turn via `comms_send(target=<you>, reply_to_msg_id=<msg_id>)`.

### Quick start — a full agent team

```bash
# Terminal 1 — the NATS hub
just comms-server

# Terminal 2 — the central teammate registry
# (comms + agent-lifecycle auto-load via extensions/teammate-provider/package.json pi.extensions)
pi -e extensions/teammate-provider --cname teammate-provider

# Terminal 3 — a coordinator that delegates everything to the team
# (task-graph.ts gives it the task graph tools: create/update/set_status/read/list/ready/render)
pi -e extensions/comms.ts -e extensions/task-graph.ts -e extensions/role-context.ts \
   --role coordinator --cname coordinator
```

The coordinator asks the teammate-provider for specialists, which spawns them on demand in tmux panes (spawned agents load `task-graph.ts` automatically). The coordinator drives its task graph in `.pi/tasks/` — dispatching from the ready set and marking items done to unlock their dependents — and announces changes over comms (`comms_send`, fire-and-forget) — see [docs/6-task-graph.md](docs/6-task-graph.md).

### Quick start — across machines (LAN)

```bash
# Terminal 1 — NATS server (binds 0.0.0.0 — requires PI_COMMS_AUTH_TOKEN)
just comms-server-lan

# Terminal 2 & 3 — clients, possibly on different machines
just comms  --name dev
just comms2 --name prod              # …pinned to claude-opus-4-7
```

For remote / cross-LAN: set `PI_COMMS_NATS_URL` and `PI_COMMS_AUTH_TOKEN` in `.env`. Enable NATS TLS for anything beyond a trusted LAN.

### just recipes

```bash
just                     # list all recipes
just comms-server     # start the local NATS server (127.0.0.1:4222, token auto-generated)
just comms-server-lan # start a LAN-visible NATS server (0.0.0.0; requires PI_COMMS_AUTH_TOKEN)
just comms --name dev --cname dev    # Pi client for the comms hub
just comms1 --name x      # …same, pinned to gpt-5.5
just comms2 --name x      # …same, pinned to claude-opus-4-7
just comms3 --name x      # …same, pinned to deepseek-v4-pro
just comms4 --name x      # …same, pinned to glm-5.1
```

The `open` recipe opens a new terminal window with any extension combo (omit `.ts`):

```bash
just open comms
```

## Project Structure

```
agent-team-on-coms-net/
├── extensions/
│   ├── comms.ts         # entry — comms extension (tools, consumers, lifecycle)
│   ├── task-graph.ts       # task graph tools (create/update/set_status/read/list/ready/render)
│   ├── role-context.ts     # --role flag + role-prompt injection (before_agent_start)
│   ├── agent-lifecycle/    # agent_spawn / agent_kill tools (tmux panes)
│   │   └── index.ts        # …entry (package.json pi.extensions declares deps)
│   ├── teammate-provider/  # teammate registry agent
│   │   └── index.ts        # …entry (package.json pi.extensions declares deps)
│   ├── auto-exit.ts        # auto-exit on task completion (used by launch scripts)
│   └── lib/
│       ├── comms/       # protocol, messaging, registry, batch, nats, config, ui
│       ├── role-context/   # template.ts (role templates, LLMContext), fork.ts (SessionManager session create/fork), roles/
│       ├── tasks/       # store.ts + graph.ts (task storage & graph logic)
│       └── launch-script.ts# tmux launch script builder
├── docs/                   # 0-overview · 1-comms · 2-create-and-kill · 3-teammate-provider · 4-coordinator · 5-tasks
├── scripts/comms-nats/      # NATS server launcher (up.sh)
├── tests/                  # unit + e2e tests (fork, auto-exit, lifecycle dedupe, …)
├── .pi/
│   ├── agent-sessions/     # Ephemeral session files (gitignored)
│   └── settings.json       # Pi workspace settings
├── justfile                # just task definitions
├── CLAUDE.md               # Conventions and tooling reference (for agents)
└── .env.sample             # API keys + comms env knobs
```

## Resources

| Doc                                                                                                     | Description                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [README.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)              | Overview and getting started       |
| [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Extension system                   |
| [skills.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)         | Skills (Agent Skills standard)     |
| [settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)     | Configuration                      |
| [providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)   | API keys and provider setup        |
