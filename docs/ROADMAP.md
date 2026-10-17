# Roadmap

## Done (MVP)

- Slack adapter (Socket Mode): mentions, DMs, threads, 👀 acknowledgement, Slack ⇄ markdown conversion
- Live test with a real Slack workspace and Requesty, including coding sessions
- Microsoft Teams adapter (Teams SDK v2, HTTP endpoint), verified with the Microsoft 365 Agents Playground (docs/TEAMS.md)
- Admin UI (docs/ADMIN.md): OIDC single sign-on with admin/viewer roles, channel settings, memories, usage, coding sessions, audit log (also for chat commands)
- Runtime settings and HTTP MCP servers in the admin UI (encrypted secrets, test connection, live reload on all replicas, LOCKED_SETTINGS for configuration as code)
- Health endpoints, Helm chart, CI, signed multi-arch releases with SBOM (docs/DEPLOYMENT.md, docs/RELEASING.md)
- Engine with durable Postgres job queue (retries, backoff, stale-job recovery, dedupe keys)
- Agent tool loop on any OpenAI-compatible gateway, Requesty metadata for cost attribution
- Ambient mode per channel: rule pre-filter → triage model → budgeted reply
- In-thread awareness: replies in threads Heinzel took part in get triaged even with ambient off
- Follow-ups (`schedule_followup` tool and triage `follow_up`)
- Team memory (channel / org / user scopes, full-text recall, `remember` / `recall` / `forget` tools)
- Heavy-model escalation (`escalate` tool, triage complexity, `!deep`, daily budget)
- Chat commands: `!status`, `!ambient`, `!limit`, `!instructions`, `!memories`, `!deep`, `!help`
- External tools: MCP client (stdio + streamable HTTP, `mcp.json`, allow/exclude lists, `pnpm mcp`), built-in web fetch with SSRF protection. Example config: self-hosted SearXNG, GitLab's official MCP server, Atlassian Rovo (Jira/Confluence)
- Coding sessions with OpenCode 2 in Docker containers: confirmation by the requester, live status, draft MR via push options, egress allowlist proxy, token isolation (docs/CODING.md)
- Tests: unit + integration against real Postgres (fake LLM and fake adapter)

## Next

### 1. Tuning on real conversations
- Tune triage prompt and `AMBIENT_MIN_CONFIDENCE` on real conversations.
- Check how the chosen models handle the `SILENT` convention and tool calls through Requesty.

### 2. Microsoft Teams in a real tenant
The adapter exists (docs/TEAMS.md); what is left needs a tenant:
- Azure Bot registration, dev tunnel, app manifest with RSC permissions `ChannelMessage.Read.Group` / `ChatMessage.Read.Chat`.
- Verify auth, channel threads, ambient mode, 👀 reactions, markdown rendering, proactive posts after a restart.
- `fetchThread` / `fetchRecent` through Microsoft Graph (today the engine uses its stored history).
- Real @-mentions in replies (`<at>` + mention entity).
- If the global service URL fallback is not reliable: store it per channel (`platform_refs` on `channels`).

### 3. Coding sessions, next
- Live test against a real GitLab (push options → draft MR; protected branches).
- GitLab Duo Agent Platform as a second backend for customers who use DAP (sessions run on their GitLab runners).
- Kubernetes runner (Job per session, NetworkPolicy, pod logs) next to the Docker runner.
- Continue a session in the same thread ("also add a test") instead of starting a new one.

### 4. More from tools
- Live-test the GitLab and Atlassian Rovo MCP servers; check the curated `tools` list against the real tool names.
- Per-channel allowlist of tool servers (column on `channels`, chat command). Today every channel gets every tool.
- OAuth login for MCP servers that require it (e.g. GitLab's official server): one-time `pnpm mcp:login <server>` with the SDK's OAuth client, refresh tokens stored encrypted in Postgres, re-login hint on failure. Use a dedicated bot account.
- MCP `tools/list_changed` notifications (servers from the admin UI already reload live; `mcp.json` needs a restart).

### 5. Memory quality
- Nightly consolidation job: merge duplicates, drop stale facts, summarize channels.
- Optional pgvector embeddings behind the same `MemoryStore` interface (embedding model via the gateway).
- Admin view/edit of memories.

### 6. Admin UI and governance
- OAuth sign-in for MCP servers; per-channel tool allowlist.
- Permissions for chat commands (channel owners / admin group).
- Delete and export everything about one person (GDPR).
- Org-wide limits (token budget per day), kill switch, costs in currency.

## Open decisions

- **Data retention** — not decided yet. Message copies (`events`) are kept forever by default; set `EVENTS_RETENTION_DAYS` once a policy exists. Memories are kept independently of events.

## Known limitations

- Memory search is keyword-based (Postgres full-text, `simple` config): synonyms are not matched.
- No streaming: answers are posted once complete.
- Slack name/channel lookups are cached in memory per process and never refreshed.
- Teams: no history from before Heinzel joined (no Graph yet); `@Name` in replies does not notify the person.
- Edits and deletions of messages are ignored (the stored copy keeps the original text).
- File contents and images are not read (also PDFs via web fetch).
- All tool schemas go with every agent call; large MCP servers cost thousands of tokens per call unless `tools` is narrowed.
