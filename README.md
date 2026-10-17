# Heinzel

An open-source, self-hosted AI teammate for team chat. Tag `@Heinzel` and it works in the thread — or let it follow a channel and speak up on its own when it can clearly help.

- **Chat-platform agnostic.** Slack and Microsoft Teams. Everything below the adapters is platform-neutral.
- **LLM-gateway agnostic.** Any OpenAI-compatible endpoint. Defaults to the [Requesty](https://requesty.ai) EU gateway (Frankfurt) and tags every call with channel metadata for cost tracking.
- **Proactive, but polite.** Ambient mode is off by default and per channel. A cheap triage model decides whether to speak; hard budgets and cooldowns cap unprompted posts.
- **Right model for the job.** A small model triages, a mid-size model does the work, and an optional strong model takes over hard tasks.
- **Team memory.** Remembers decisions, owners and conventions per channel, company-wide and per person — in your own Postgres.
- **Tools.** Reads web pages out of the box; self-hosted web search (SearXNG), GitLab, Jira and any other [MCP](https://modelcontextprotocol.io) server via a config file. See [docs/TOOLS.md](docs/TOOLS.md).
- **Coding sessions.** Hand a coding task to OpenCode in an isolated container in your infrastructure; it opens a draft merge request. See [docs/CODING.md](docs/CODING.md).
- **Admin UI.** Channel settings, team memory, usage, coding sessions and an audit log, with single sign-on (Entra ID or any OIDC provider). See [docs/ADMIN.md](docs/ADMIN.md).
- **Self-hosted.** One Node process plus Postgres. No vendor cloud in the middle.

> Status: early MVP. Slack works end to end; Teams works in the Agents Playground, a real tenant is next ([docs/TEAMS.md](docs/TEAMS.md)). See [docs/ROADMAP.md](docs/ROADMAP.md).

## How it behaves

| Situation | What Heinzel does |
|---|---|
| Someone tags `@Heinzel` or DMs it | Reacts with 👀, reads the thread (or recent channel history), answers in the thread |
| Someone replies in a thread Heinzel took part in | Triage decides whether the reply is meant for Heinzel; answers if so |
| Ambient mode on, nobody tagged Heinzel | Triage decides: ignore (most of the time), remember a fact, schedule a follow-up, or speak up |
| A question is open or someone promised something | Heinzel can schedule a follow-up and check back later |
| A task is hard | The agent model hands over to the strong model (`escalate`), within a daily budget |

### Which model runs when

| Model | Env var | Runs for | Recommended (Requesty EU) |
|---|---|---|---|
| Triage | `LLM_MODEL_TRIAGE` | Every unaddressed message in ambient channels and threads Heinzel is in | Claude Haiku 5.5 (Bedrock) |
| Agent | `LLM_MODEL_AGENT` | Every answer: mentions, DMs, ambient replies, follow-ups | Claude Sonnet 5.5 (Bedrock) |
| Heavy (optional) | `LLM_MODEL_HEAVY` | When the agent calls `escalate`, triage rates a question `complex`, or someone uses `!deep` | Claude Opus 5.5 (Bedrock) |

EU-provider-only alternative: Mistral Small (triage) + Mistral Large 4 (agent). Copy exact model ids from your gateway's model library and restrict your Requesty organisation to EU-region models.

### Chat commands

Mention Heinzel, then:

| Command | Effect |
|---|---|
| `!status` | Settings and 24h usage for this channel |
| `!ambient on` / `!ambient off` | Let Heinzel speak up without being tagged |
| `!limit <n>` / `!limit default` | Max unprompted posts per day in this channel |
| `!instructions <text>` | Standing instructions for this channel (`!instructions` shows, `!instructions clear` removes) |
| `!memories [query]` | What Heinzel remembers here |
| `!deep <question>` | Answer with the strong model right away |
| `!go [id]` / `!stop [id]` / `!coding` | Start, cancel or list [coding sessions](docs/CODING.md) |
| `!help` | Command list |

## Quick start (your own Slack workspace)

Requirements: Node 22+, pnpm, Docker (or any Postgres 14+), a Requesty API key.

1. **Create a test workspace** at [slack.com/get-started](https://slack.com/get-started#/createnew) (the free plan is fine).
2. **Create the Slack app:** [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a manifest* → pick your workspace → paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) → *Create*.
3. **App-level token:** *Basic Information* → *App-Level Tokens* → *Generate* with scope `connections:write`. This is `SLACK_APP_TOKEN` (`xapp-…`).
4. **Install:** *Install App* → *Install to Workspace*. Copy the *Bot User OAuth Token* — this is `SLACK_BOT_TOKEN` (`xoxb-…`).
5. **Configure and run:**
   ```bash
   cp .env.example .env          # fill in LLM_API_KEY, model ids and the two Slack tokens
   pnpm install
   docker compose up -d postgres
   pnpm dev                      # migrates the database and connects via Socket Mode
   ```
6. **Optional, tools:** `cp mcp.example.json mcp.json`, set `MCP_CONFIG=mcp.json` in `.env`, check with `pnpm mcp`. Details: [docs/TOOLS.md](docs/TOOLS.md).
7. **Try it:** invite the bot to a channel (`/invite @Heinzel`), then `@Heinzel !help`, ask it something, or `@Heinzel !ambient on`.

Socket Mode means no public URL is needed — it runs fine from a laptop.

**Admin UI:** `pnpm build:web`, set `ADMIN_DEV_LOGIN=true`, restart, open http://localhost:3080. Single sign-on: [docs/ADMIN.md](docs/ADMIN.md).

**Microsoft Teams:** set `TEAMS_PLAYGROUND=true` and try it locally in the Microsoft 365 Agents Playground, no tenant needed. Setup for a real tenant: [docs/TEAMS.md](docs/TEAMS.md).

### Production

Kubernetes with the Helm chart, signed images, upgrades: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Releases: [CHANGELOG.md](CHANGELOG.md), [docs/RELEASING.md](docs/RELEASING.md). Security: [SECURITY.md](SECURITY.md).

### Run in Docker

```bash
docker compose --profile app up -d --build
```

With MCP tools, mount the config into the container (`volumes: ["./mcp.json:/app/mcp.json:ro"]` on the `heinzel` service) and set `MCP_CONFIG=/app/mcp.json`. The image contains no npm/npx: run MCP servers as their own containers with an HTTP endpoint, or bake stdio servers into a derived image (docs/TOOLS.md).

## Development

```bash
pnpm typecheck
pnpm test                         # unit tests; DB tests are skipped without a database

# everything, against a throwaway database
docker compose exec postgres createdb -U heinzel heinzel_test
TEST_DATABASE_URL=postgres://heinzel:heinzel@localhost:5432/heinzel_test pnpm test
```

The test database is wiped on every run — never point `TEST_DATABASE_URL` at real data.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap and open decisions: [docs/ROADMAP.md](docs/ROADMAP.md)
- Notes for coding agents and contributors: [AGENTS.md](AGENTS.md)

## License

Copyright 2026 v0lumehi. Licensed under the [Apache License 2.0](LICENSE).
