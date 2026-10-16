# Roadmap

## Done (MVP)

- Slack adapter (Socket Mode): mentions, DMs, threads, 👀 acknowledgement, Slack ⇄ markdown conversion
- Engine with durable Postgres job queue (retries, backoff, stale-job recovery, dedupe keys)
- Agent tool loop on any OpenAI-compatible gateway, Requesty metadata for cost attribution
- Ambient mode per channel: rule pre-filter → triage model → budgeted reply
- In-thread awareness: replies in threads Heinzel took part in get triaged even with ambient off
- Follow-ups (`schedule_followup` tool and triage `follow_up`)
- Team memory (channel / org / user scopes, full-text recall, `remember` / `recall` / `forget` tools)
- Heavy-model escalation (`escalate` tool, triage complexity, `!deep`, daily budget)
- Chat commands: `!status`, `!ambient`, `!limit`, `!instructions`, `!memories`, `!deep`, `!help`
- Tests: unit + integration against real Postgres (fake LLM and fake adapter)

## Next

### 1. Live test with a real Slack workspace and Requesty
- Tune triage prompt and `AMBIENT_MIN_CONFIDENCE` on real conversations.
- Check how the chosen models handle the `SILENT` convention and tool calls through Requesty.

### 2. Microsoft Teams adapter (`src/adapters/teams/`)
Implement `ChatAdapter` with the Microsoft Teams SDK for TypeScript (`@microsoft/teams.apps`) or Bot Framework.
- Azure Bot registration → `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`.
- Needs a publicly reachable HTTPS messaging endpoint (unlike Slack Socket Mode). For local dev: dev tunnel.
- Reading channel messages without an @-mention requires the RSC permission `ChannelMessage.Read.Group` in the app manifest (`ChatMessage.Read.Chat` for group chats).
- Threads: a Teams channel "conversation" = thread root; replies carry the root id in the conversation id (`…;messageid=<root>`). Map to `threadId`.
- Proactive posts (ambient, follow-ups) need a stored conversation reference per channel → add a `platform_refs` JSONB column on `channels`.
- Teams does not echo the bot's own messages; the engine already records its own posts, so nothing else changes.
- `fetchThread` / `fetchRecent` need Microsoft Graph (`ChannelMessage.Read.Group` via RSC or app permissions). Fallback: the engine already uses stored history when the adapter throws.
- Markdown: Teams renders a markdown subset; convert lists/links as needed in the adapter.

### 3. Tools via MCP
- MCP client so Heinzel can use GitHub, Jira/Linear, Confluence, Google Drive etc. under service accounts.
- Per-channel allowlist of tools (column on `channels`).

### 4. Memory quality
- Nightly consolidation job: merge duplicates, drop stale facts, summarize channels.
- Optional pgvector embeddings behind the same `MemoryStore` interface (embedding model via the gateway).
- Admin view/edit of memories.

### 5. Admin UI and governance
- Small web UI: channels, settings, memories, usage/costs, audit log.
- Org-wide limits (token budget per day), kill switch.

## Open decisions

- **Data retention** — not decided yet. Message copies (`events`) are kept forever by default; set `EVENTS_RETENTION_DAYS` once a policy exists. Memories are kept independently of events.

## Known limitations

- Memory search is keyword-based (Postgres full-text, `simple` config): synonyms are not matched.
- No streaming: answers are posted once complete.
- Slack name/channel lookups are cached in memory per process and never refreshed.
- Edits and deletions of messages are ignored (the stored copy keeps the original text).
- File contents and images are not read.
