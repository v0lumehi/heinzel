# Architecture

Heinzel is a single Node.js process (TypeScript, ESM) plus Postgres. It can be scaled horizontally: workers coordinate through the job table, and only adapters hold platform connections.

```
 Slack ─┐                    ┌──────────────── Postgres ────────────────┐
        ├─► ChatAdapter ─► Engine.handleIncoming ─► events, channels      │
 Teams ─┘   (normalize)        │                                          │
                               ├─ command? ──► answer immediately         │
                               ├─ addressed? ─► jobs: respond             │
                               └─ ambient / my thread? ─► jobs: triage    │
                                                                          │
 Worker (N loops, SKIP LOCKED) ◄──────────────────────── jobs ───────────┘
   respond  ─► context + memory ─► agent run (tool loop) ─► adapter.send
   triage   ─► small model ─► ignore | remember | follow_up | respond
   followup ─► agent run in "followup" mode ─► post or stay SILENT
   coding_start / coding_watch ─► coding container (see docs/CODING.md)

 LLM gateway (OpenAI-compatible, e.g. Requesty EU) ◄── llm/client.ts
```

## Modules

| Path | Responsibility |
|---|---|
| `src/core/types.ts` | Platform-neutral `ChatEvent`, `ChatAdapter` interface, channel keys |
| `src/core/engine.ts` | The brain: ingest, routing, job handlers, posting, budgets |
| `src/admin/` | Admin UI backend (Fastify): OIDC sign-in, sessions, JSON API, serves the built UI; `types.ts` is shared with `web/` |
| `web/` | Admin UI frontend: React + Vite + Mantine + TanStack Query (pnpm workspace package) |
| `src/core/commands.ts` | `!`-prefixed admin commands (no LLM involved) |
| `src/adapters/slack/` | Bolt + Socket Mode; Slack wire format ⇄ plain text / mrkdwn |
| `src/adapters/teams/` | Teams SDK v2 behind an HTTP endpoint (`/api/messages`); activities ⇄ plain text / markdown (docs/TEAMS.md) |
| `src/agent/` | System prompt, transcript rendering, tool loop, tools (memory, follow-ups, escalate, web fetch) |
| `src/mcp/` | MCP client: config file, connections (stdio / streamable HTTP), MCP tools as agent tools, `pnpm mcp` |
| `src/coding/` | Coding sessions: coordinator (confirm, start, watch, finish), Docker runner, OpenCode event parser, `start_coding_task` tool |
| `src/egress/` | Allowlisting forward proxy for coding containers (runs from the same image) |
| `coder/` | Coding container image (git + OpenCode 2) and its entrypoint (clone, agent, push with privilege split) |
| `src/triage/` | Rule pre-filter, triage prompt + parsing, speak budget |
| `src/llm/client.ts` | `LlmClient` interface and the OpenAI-compatible implementation (Requesty metadata) |
| `src/memory/` | Scoped team memory on Postgres full-text search |
| `src/queue/` | Durable job queue (`FOR UPDATE SKIP LOCKED`, LISTEN/NOTIFY wake-up) and worker |
| `src/store/` | Data access for channels, events, bot posts, usage |
| `src/db/` | Pool and SQL migrations (`src/db/migrations/*.sql`, applied at startup) |

## Key decisions

- **Adapters only translate.** They turn platform events into `ChatEvent` and `OutboundMessage` into platform calls. No business logic. A new platform is a new adapter; nothing else changes.
- **Everything slow happens in jobs.** Handlers for incoming events only store and enqueue, so platform acknowledgements stay fast and work survives restarts.
- **Postgres is the only infrastructure.** Queue, memory, config, audit and usage all live there. One thing to operate, transactional consistency, plenty of headroom for chat volumes.
- **Multi-person transcripts, not chat roles.** The conversation goes to the model as one transcript (`[time] Name: text`), so it knows who said what. Mapping humans to the `user` role would lose that.
- **Default to silence.** Ambient replies, in-thread replies and follow-ups may answer `SILENT`. Triage output that cannot be parsed is treated as "ignore". Budgets are checked twice: before queueing and again before the agent run.
- **No double posts on retry.** After a message is sent, bookkeeping failures are logged but never rethrown.
- **Never act as a user.** Heinzel posts under its own bot identity. Bot messages can never trigger commands or replies (prevents bot loops).
- **External tools through MCP, not custom code.** Integrations (search, GitLab, Jira, …) are MCP servers from a config file; their tools reach the model as `<server>__<tool>`. Only Heinzel-specific tools (memory, follow-ups) and web fetch are built in. Servers that fail at startup are skipped, dropped connections reconnect on the next call. Tool output is treated as untrusted data in the system prompt; web fetch refuses private network addresses (SSRF).
- **Self-hostable end to end.** Everything except the LLM can run in the customer's infrastructure: SearXNG for search, the customer's GitLab, coding containers behind an egress allowlist.
- **Coding in containers, never in Heinzel.** Heinzel only orchestrates: the agent runs in a throwaway container with no internet except the allowlist, and changes leave only as a draft merge request. Long-running work is watched by a chain of short jobs, because the queue re-queues jobs running longer than 10 minutes.

## Model tiers

1. **Triage** (`LLM_MODEL_TRIAGE`) — one short JSON decision per unaddressed message. Must be cheap.
2. **Agent** (`LLM_MODEL_AGENT`) — every answer, with tools.
3. **Heavy** (`LLM_MODEL_HEAVY`, optional) — reached three ways: the agent calls the `escalate` control tool (the run stops and restarts on the heavy model with the same context), triage marks a reply `complexity: "complex"`, or a person writes `!deep …`. Limited by `HEAVY_DAILY_LIMIT` per channel; usage is recorded with purpose `agent_heavy`.

## Data model

See `src/db/migrations/`. Channels are keyed `<platform>:<channel id>`. Threads are identified by their root message id (`thread_ref`); top-level messages are their own thread root.

Memory scopes: `channel` (key = channel key), `org` (key = `*`), `user` (key = `<platform>:<user id>`).
