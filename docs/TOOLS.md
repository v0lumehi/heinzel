# External tools

Heinzel has one built-in external tool, **web fetch**, and can use tools from any [MCP](https://modelcontextprotocol.io) server: web search, GitLab, Jira and anything else that speaks MCP. MCP servers are configured in a JSON file; secrets stay in `.env`.

Everything here is designed to run in your own infrastructure: web search is a self-hosted SearXNG, GitLab is your instance. Only Atlassian Rovo (Jira/Confluence Cloud) is a vendor service by nature.

## Web fetch (built in)

`web__fetch_url` reads a public web page and gives the model its text as markdown, e.g. when someone posts a link. Long pages are read in parts. It needs no account and is on by default (`WEB_FETCH=false` turns it off).

- Only `http`/`https`. Addresses in private, loopback, link-local (cloud metadata) and other reserved ranges are refused, checked on every connection, so redirects and DNS tricks cannot reach internal services.
- Text content only (HTML, plain text, JSON, XML); PDFs and images are not read. At most 3 MB per page, 20 s timeout.
- Fetching a page does not search: for "what is the weather in Berlin" Heinzel also needs the search server (below).

## MCP setup

1. Copy the example and point Heinzel at it:
   ```bash
   cp mcp.example.json mcp.json      # git-ignored
   echo 'MCP_CONFIG=mcp.json' >> .env
   ```
2. Enable the servers you want (`"enabled": true` or remove the line) and put their secrets in `.env` (see below).
3. Check the connections and see which tools Heinzel will get:
   ```bash
   pnpm mcp
   ```
   `✓` = available to Heinzel, `·` = hidden by `tools` / `exclude`, `✗` = server not reachable (with the reason).
4. Start Heinzel (`pnpm dev`). `@Heinzel !status` shows the connected systems.

A server that is down at startup is logged and skipped; Heinzel runs without it. A dropped connection is re-established on the next tool call. Changes to `mcp.json` need a restart.

## Config format

The file uses the common `mcpServers` format (Claude Desktop, Cursor, VS Code), so snippets from server READMEs can be copied:

```json
{
  "mcpServers": {
    "<name>": { "command": "some-mcp-server", "args": ["--flag"], "env": { "TOKEN": "${SOME_TOKEN}" } },
    "<name>": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${SOME_TOKEN}" } }
  }
}
```

| Field | |
|---|---|
| `command`, `args`, `env`, `cwd` | Local server, started as a child process (stdio) |
| `url`, `headers` | Remote server (streamable HTTP) |
| `enabled` | `false` keeps the entry without starting it (its variables need not be set) |
| `tools` | Allowlist of tool names; `*` is a wildcard. Default: all tools of the server |
| `exclude` | Tool names to hide, applied after `tools` |
| `timeoutMs` | Per-call timeout, default 60000 |

- `${VAR}` is replaced with the environment value (from `.env` or the real environment); `${VAR:-default}` falls back to `default`. An unset variable without default stops startup with a clear error.
- The server name becomes the tool prefix the model sees (`gitlab__get_issue`): letters, digits and `-`, at most 20 characters. `web` is reserved.
- Tool results longer than `TOOL_RESULT_MAX_CHARS` (default 16000) are cut.
- For your own infrastructure, prefer servers that run as their own container with an HTTP endpoint (`url`). A `command` like `npx -y …` downloads the server from the npm registry at every start, which needs internet access and is not reproducible.

## Keep the tool list short

Every tool's description and schema is sent with **every** agent call. A GitLab server with 30 tools costs roughly 9,000 tokens per call. Use `tools` to expose only what your team needs, and check the result with `pnpm mcp`.

## Web search: SearXNG (self-hosted)

[SearXNG](https://docs.searxng.org) is an open-source metasearch engine; [`mcp-searxng`](https://github.com/ihor-sokoliuk/mcp-searxng) makes it an MCP server. Both run as containers next to Heinzel, without accounts or API keys.

```bash
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
docker compose --profile tools up -d
pnpm mcp        # search → ✓ search__searxng_web_search
```

- The SearXNG config is [`deploy/searxng/settings.yml`](../deploy/searxng/settings.yml) (JSON API on, internal-only, no public limiter).
- `mcp.json` points at `${SEARCH_MCP_URL:-http://localhost:3000/mcp}`: the default fits `pnpm dev` on the host; in compose, Heinzel gets `SEARCH_MCP_URL=http://mcp-searxng:3000/mcp`.
- What leaves your network: SearXNG forwards the search terms to the public search engines it queries (Google, Bing, DuckDuckGo, …), without an account and without user identity. Choose the engines in `settings.yml`.
- Only `searxng_web_search` is exposed; Heinzel reads result pages with its own web fetch (which has the SSRF protection).

## GitLab: official MCP server

GitLab ships an MCP server at `https://<your-gitlab>/api/v4/mcp` (all tiers, GitLab.com and Self-Managed, generally available since GitLab 19.5). It reads and writes issues, merge requests, notes, pipelines and more.

1. Ideally create a dedicated bot user, so Heinzel acts under its own identity.
2. As that user, create a **fine-grained personal access token** with the permission *MCP tool: Execute* (plus access to the projects Heinzel should see). Legacy personal, project and group access tokens are rejected by the MCP endpoint.
3. `.env`:
   ```bash
   GITLAB_URL=https://gitlab.example.com
   GITLAB_MCP_TOKEN=glpat-…
   ```
4. Enable `gitlab` in `mcp.json` and run `pnpm mcp`.

The example exposes a curated list: reading projects, files, issues, work items, merge requests, commits and pipelines, plus `create_issue` and `save_note` (comment). It deliberately leaves out merging (`accept_merge_request`), approvals, pipeline control, branches and commits: code changes go through [coding sessions](CODING.md) and their draft merge requests, which a human reviews.

## Jira and Confluence: Atlassian Rovo MCP Server

The official remote server from Atlassian, for Atlassian **Cloud**.

1. An organization admin must allow API-token authentication for the Rovo MCP server (Atlassian Administration → Rovo MCP server settings).
2. Ideally use a dedicated Atlassian account for Heinzel. Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens), with read scopes only if you want Heinzel read-only.
3. The header is HTTP Basic auth from email and token:
   ```bash
   printf '%s' 'heinzel@example.com:<api-token>' | base64
   ```
   Put the output in `.env`: `ATLASSIAN_BASIC_AUTH=…`
4. Enable `jira` in `mcp.json` and run `pnpm mcp` to see the tools.

The `exclude` list in the example hides tools that write (`create*`, `edit*`, `update*`, `add*`, `transition*`, `delete*`). Check the `pnpm mcp` output after server updates; the token's scopes are the real safeguard.

## Safety

- **Least privilege first.** Use dedicated bot accounts and narrowly scoped tokens. `tools` / `exclude` are a second line of defense.
- **Prompt injection.** Web pages, tickets and comments can contain text that tries to instruct the model. The system prompt tells Heinzel to treat tool results as data and never to change external systems unless a person in the conversation explicitly asked for it. That lowers the risk, but only permissions remove it.
- **Everyone in a channel can use the tools.** Anyone who can talk to Heinzel can make it read what its tokens can read, and ambient mode can call tools too. Scope tokens to what all channel members may see. A per-channel tool allowlist is on the roadmap.
- **Data leaves your network** only where you configure it: search terms go to the search engines SearXNG queries, Jira/Confluence content goes to Atlassian anyway, and everything the model sees goes to your LLM gateway.
