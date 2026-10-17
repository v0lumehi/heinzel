# Notes for coding agents (and humans)

Start here when you pick up work on Heinzel. Read `docs/ARCHITECTURE.md` for the design and `docs/ROADMAP.md` for what is next.

## Current state

- MVP complete for Slack, live-tested with a real workspace and Requesty (incl. coding sessions); 95 tests green (unit + Postgres integration).
- Teams adapter (docs/TEAMS.md) works in the Microsoft 365 Agents Playground and was connected to a real M365 trial tenant (Developer Portal bot, dev tunnel); full checklist in docs/TEAMS.md still open (ROADMAP §2).
- Admin UI (docs/ADMIN.md): Fastify backend in `src/admin/`, React/Mantine frontend in `web/`; OIDC sign-in, dev login for local use.
- External tools: MCP client + built-in web fetch (docs/TOOLS.md). Self-hosted SearXNG verified; GitLab's official MCP server and Atlassian Rovo not tested yet.
- Coding sessions (docs/CODING.md): verified end to end with a real LLM, the Docker runner, OpenCode 2.0.32, the egress proxy and a local git daemon (branch pushed). Not yet against a real GitLab (push options → MR).
- Docker images build: `docker build -t heinzel .` and `docker build -t heinzel-coder coder/`.
- Helm chart `deploy/helm/heinzel` verified in kind (2 replicas, non-root, read-only root fs, probes). Kubernetes coding runner verified in kind with the pod's own RBAC (Job + owned Secret, logs, state, cleanup, clone via egress proxy); NetworkPolicy enforcement NOT verified (kindnet on colima cannot enforce it: no nfnetlink_queue) — test on Calico/Cilium. CI and release workflows in `.github/workflows` (not yet run on GitHub). Release steps: docs/RELEASING.md; changelog: CHANGELOG.md (add an entry to `[Unreleased]` for user-visible changes).

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                                    # DB tests skip without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://… pnpm test     # full suite; the database is DROPPED and recreated
pnpm test:coverage                           # same with coverage (coverage/; uploaded to Codecov in CI)
pnpm dev                                     # needs .env (see .env.example)
pnpm build && pnpm start
pnpm mcp                                     # list tools of the MCP servers in MCP_CONFIG
pnpm teams:package                           # Teams app package (heinzel-teams.zip) for TEAMS_APP_ID
pnpm build:web / pnpm dev:web                # admin UI: build into web/dist / hot reload on :5173
```

No Docker? Any local Postgres 14+ works. Create an empty database for tests.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), NodeNext resolution → relative imports end in `.js`.
- Versions in use: TypeScript 7, zod 4, openai SDK 7 (chat completions API), @slack/bolt 5 (namespace import: `import * as bolt from "@slack/bolt"`), Teams SDK 2.1 (`@microsoft/teams.apps`), Fastify 5, openid-client 6, vitest 5, pino 10. Web UI: React 19, Vite 8, Mantine 9, TanStack Query 5, React Router 8.
- pnpm workspace: root = server, `web/` = admin UI. API shapes live in `src/admin/types.ts` (no imports; the UI imports it).
- New dependencies: pin an exact version that is at least two weeks old.
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

- **2026-10-17** — Enterprise/OSS readiness: health endpoints, Helm chart (kind-tested), CI + signed releases, hardened images (Debian 13, no npm, digests), runtime settings + MCP servers in the admin UI (SECRETS_KEY, LOCKED_SETTINGS), Kubernetes coding runner, setup page, README/CONTRIBUTING/templates, coverage (Codecov), CodeQL, Scorecard, ruleset on main. Open: first release tag v0.1.0, Codecov activation, NetworkPolicy check on an enforcing CNI, OpenSSF Best Practices registration.

- **2026-10-17** — Admin UI: Fastify + OIDC (Entra ID app roles Heinzel.Admin/Viewer), Postgres sessions, CSRF header, audit log (migration 004, also for chat commands), React/Mantine UI in `web/` (channels, memories, usage, coding, tools, audit). Docker image builds UI too. Next: MCP servers in the UI, chat command permissions, hosting (Helm/Container Apps), market analysis.

- **2026-10-17** — Slack live test done (incl. coding). Teams adapter on the Teams SDK v2: HTTP endpoint, playground mode, 👀 via reactions API, markdown out; `fetchThread`/`fetchRecent` are now optional (engine falls back to stored history). Verified end to end with the headless Agents Playground and a real LLM. Engine/command texts now use `**bold**` (Slack converts). Next: real tenant (Azure Bot, dev tunnel, manifest with RSC), then Graph history (docs/TEAMS.md, ROADMAP §2).
- **2026-10-17** — Coding sessions (OpenCode 2 in Docker, egress proxy, `!go`/`!stop`/`!coding`), self-hosted SearXNG search (`--profile tools`), GitLab's official MCP server in the example; Exa removed. Next: test against a real GitLab, then DAP backend and Kubernetes runner (ROADMAP §3).
- **2026-10-17** — External tools: MCP client (`src/mcp/`, `mcp.example.json`, `pnpm mcp`, docs/TOOLS.md) and built-in `web__fetch_url` with SSRF protection. Next: per-channel tool allowlist, OAuth login for MCP servers (ROADMAP §3).
- **2026-10-17** — `.env` is now loaded at startup (`loadDotEnv()` via `process.loadEnvFile`, existing env vars win); before, `pnpm dev`/`start`/`migrate` ignored it.
- **2026-10-17** — Apache-2.0 license (personal project). Configurable event retention (`EVENTS_RETENTION_DAYS`, default keep); policy still open.
- **2026-10-17** — Initial build. Slack MVP, ambient triage, follow-ups, memory, heavy-model escalation, tests, docs. Next: live test (ROADMAP §1), then Teams adapter (ROADMAP §2).
