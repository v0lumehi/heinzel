# Contributing to Heinzel

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

## Before you start

- **Bugs and ideas:** open an issue with the templates. For larger changes, open an issue first so we can agree on the approach before you write code.
- **Security issues:** never in public issues. See [SECURITY.md](SECURITY.md).
- **Questions:** use [GitHub Discussions](https://github.com/v0lumehi/heinzel/discussions) or an issue.

## Development setup

Requirements: Node 22+, pnpm 10, Docker (or any Postgres 14+).

```bash
pnpm install
docker compose up -d postgres
docker compose exec postgres createdb -U heinzel heinzel_test

pnpm typecheck
TEST_DATABASE_URL=postgres://heinzel:heinzel@localhost:5432/heinzel_test pnpm test   # the test database is wiped on every run
pnpm test:coverage                                                                    # same, with a coverage report in coverage/
pnpm dev            # the app, with .env (see .env.example)
pnpm dev:web        # the admin UI with hot reload on :5173
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the parts fit together. [AGENTS.md](AGENTS.md) lists the conventions in short form (written for coding agents, useful for people too).

## Making a change

- **Keep adapters thin.** Slack and Teams code only translates; behaviour belongs in `src/core/engine.ts`.
- **SQL lives in `src/store`, `src/memory`, `src/queue` and migrations.** Schema changes are a new numbered file in `src/db/migrations/`; never edit one that was released.
- **Tests:** pure logic gets unit tests; engine behaviour is tested end to end in `test/engine.test.ts` with the fake LLM and adapter. New code comes with tests; CI reports coverage.
- **Dependencies:** pin an exact version that is at least two weeks old, and explain in the PR why it is needed.
- **Docs:** update the docs and `.env.example` in the same PR when behaviour or configuration changes, and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything users notice.
- **Code, comments and docs in English.**

## Pull requests

1. Fork, branch from `main`, keep the PR focused on one thing.
2. Make sure `pnpm typecheck` and the full test suite pass.
3. Fill in the PR template. CI must be green before review.
4. Commits: short imperative subject line ("Add Teams reactions"), body explaining why when it is not obvious.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of the project.
