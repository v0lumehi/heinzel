# Notes for coding agents (and humans)

Start here when you pick up work on Heinzel. Read `docs/ARCHITECTURE.md` for the design and `docs/ROADMAP.md` for what is next.

## Current state

- MVP complete for Slack; 42 tests green (unit + Postgres integration).
- The Dockerfile has not been built yet (no Docker daemon in the build environment) — verify `docker compose --profile app up --build` once.
- Not yet run against a live Slack workspace or Requesty — that is the next step (ROADMAP §1).
- Teams adapter not started (ROADMAP §2, detailed plan there).

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                                    # DB tests skip without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://… pnpm test     # full suite; the database is DROPPED and recreated
pnpm dev                                     # needs .env (see .env.example)
pnpm build && pnpm start
```

No Docker? Any local Postgres 14+ works. Create an empty database for tests.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), NodeNext resolution → relative imports end in `.js`.
- Versions in use: TypeScript 7, zod 4, openai SDK 7 (chat completions API), @slack/bolt 5 (default import: `import bolt from "@slack/bolt"`), vitest 5, pino 10.
- Code, comments and docs in English. User-facing chat replies follow the language of the conversation.
- All SQL lives in `src/store`, `src/memory`, `src/queue` and migrations. Schema changes = new numbered file in `src/db/migrations/` (never edit an applied one).
- Adapters translate only; business logic belongs in `src/core/engine.ts`.
- New background work = new job kind in `JobPayloads` (`src/queue/queue.ts`) + handler in `Engine.handlers()`.
- New agent tool = `AgentTool` in `src/agent/tools.ts` with a zod schema and an explicit JSON schema; add to `defaultTools`.
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

- **2026-10-17** — `.env` is now loaded at startup (`loadDotEnv()` via `process.loadEnvFile`, existing env vars win); before, `pnpm dev`/`start`/`migrate` ignored it.

- **2026-10-17** — Apache-2.0 license (personal project). Configurable event retention (`EVENTS_RETENTION_DAYS`, default keep); policy still open.
- **2026-10-17** — Initial build. Slack MVP, ambient triage, follow-ups, memory, heavy-model escalation, tests, docs. Next: live test (ROADMAP §1), then Teams adapter (ROADMAP §2).
