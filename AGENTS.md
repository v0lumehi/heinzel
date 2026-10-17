# Notes for coding agents (and humans)

Start here when you pick up work on Heinzel. Read `docs/ARCHITECTURE.md` for the design and `docs/ROADMAP.md` for what is next.

## Current state

- MVP complete for Slack; 86 tests green (unit + Postgres integration).
- Not yet run against a live Slack workspace or Requesty — that is the next step (ROADMAP §1).
- Teams adapter not started (ROADMAP §2, detailed plan there).
- External tools: MCP client + built-in web fetch (docs/TOOLS.md). Self-hosted SearXNG verified; GitLab's official MCP server and Atlassian Rovo not tested yet.
- Coding sessions (docs/CODING.md): verified end to end with a real LLM, the Docker runner, OpenCode 2.0.32, the egress proxy and a local git daemon (branch pushed). Not yet against a real GitLab (push options → MR).
- Docker images build: `docker build -t heinzel .` and `docker build -t heinzel-coder coder/`.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                                    # DB tests skip without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://… pnpm test     # full suite; the database is DROPPED and recreated
pnpm dev                                     # needs .env (see .env.example)
pnpm build && pnpm start
pnpm mcp                                     # list tools of the MCP servers in MCP_CONFIG
```

No Docker? Any local Postgres 14+ works. Create an empty database for tests.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), NodeNext resolution → relative imports end in `.js`.
- Versions in use: TypeScript 7, zod 4, openai SDK 7 (chat completions API), @slack/bolt 5 (default import: `import bolt from "@slack/bolt"`), vitest 5, pino 10.
- Code, comments and docs in English. User-facing chat replies follow the language of the conversation.
- All SQL lives in `src/store`, `src/memory`, `src/queue` and migrations. Schema changes = new numbered file in `src/db/migrations/` (never edit an applied one).
- Adapters translate only; business logic belongs in `src/core/engine.ts`.
- New background work = new job kind in `JobPayloads` (`src/queue/queue.ts`) + handler in `Engine.handlers()`. Jobs running longer than 10 minutes are re-queued as stale: long work is a chain of short jobs (see `coding_watch`).
- Coding container: OpenCode 2 only (`@opencode/cli`, pinned in `coder/Dockerfile`); the event parser in `src/coding/events.ts` follows its `run --format json` output.
- New agent tool = `AgentTool` in `src/agent/tools.ts` with a zod schema and an explicit JSON schema; add to `defaultTools`. Integrations with outside systems should be MCP servers in `mcp.json`, not new code.
- Tests: pure logic gets unit tests; engine behaviour is tested end to end in `test/engine.test.ts` with `FakeLlm` (decides responses per request; check `req.model` to tell triage/agent/heavy apart) and `FakeAdapter`, running jobs synchronously with `drain()`.
- Never log or store secrets. `.env` is git-ignored.

## Commit identity

Commits use `v0lumehi <aljic.zijad@gmail.com>`:

```bash
git config user.name "v0lumehi"
git config user.email "aljic.zijad@gmail.com"
```

## Handoff log

Append a short entry when you stop, so the next person or agent can continue.

- **2026-10-17** — Coding sessions (OpenCode 2 in Docker, egress proxy, `!go`/`!stop`/`!coding`), self-hosted SearXNG search (`--profile tools`), GitLab's official MCP server in the example; Exa removed. Next: test against a real GitLab, then DAP backend and Kubernetes runner (ROADMAP §3).
- **2026-10-17** — External tools: MCP client (`src/mcp/`, `mcp.example.json`, `pnpm mcp`, docs/TOOLS.md) and built-in `web__fetch_url` with SSRF protection. Next: per-channel tool allowlist, OAuth login for MCP servers (ROADMAP §3).
- **2026-10-17** — `.env` is now loaded at startup (`loadDotEnv()` via `process.loadEnvFile`, existing env vars win); before, `pnpm dev`/`start`/`migrate` ignored it.
- **2026-10-17** — Apache-2.0 license (personal project). Configurable event retention (`EVENTS_RETENTION_DAYS`, default keep); policy still open.
- **2026-10-17** — Initial build. Slack MVP, ambient triage, follow-ups, memory, heavy-model escalation, tests, docs. Next: live test (ROADMAP §1), then Teams adapter (ROADMAP §2).
