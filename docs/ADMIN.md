# Admin UI

A web UI to look after Heinzel: channel settings, team memory, usage, coding sessions, tools and an audit log. It runs in the same process as Heinzel (port `ADMIN_PORT`, default 3080) and reads and writes the same Postgres database. Changes apply to the next message, without a restart.

| Page | What it does |
|---|---|
| Setup | Readiness checklist, connection status per chat platform (last message received), step-by-step guides for Slack and Teams, Slack manifest and Teams app package as downloads |
| Channels | All channels with activity; per channel: ambient mode, daily limit for unprompted posts, instructions, its memories, coding sessions and change history |
| Memories | Search across all scopes (channel, organization, person) and delete |
| Usage | LLM calls and tokens per channel and per day/model (1, 7, 30, 90 days) |
| Coding sessions | All sessions with status and merge request |
| Tools | Models in use, built-in tools with what they do, an integration catalog (web search, GitLab, Jira/Confluence: fill in URL and token, test, pick tools) and custom MCP servers |
| Settings | Models, ambient defaults, agent limits, data retention, coding sessions — applied immediately on all instances |
| Audit log | Every change, from the UI and from chat commands (`!ambient`, `!limit`, `!instructions`), plus sign-ins |

## Roles

- **Admin** – can change settings and delete memories.
- **Viewer** – reads everything, changes nothing.

Roles come from the identity provider (see below). People without either role cannot sign in.

## Local development

```bash
# .env
ADMIN_DEV_LOGIN=true          # "Development sign-in" button, admin role, works only from this machine

pnpm dev                      # admin UI on http://localhost:3080 (after pnpm build:web)
pnpm dev:web                  # optional: UI with hot reload on http://localhost:5173
```

`ADMIN_DEV_LOGIN` is refused unless `ADMIN_HOST` is a loopback address, and the server additionally checks that the request comes from the same machine.

## Single sign-on with Microsoft Entra ID

1. **App registration:** entra.microsoft.com → *App registrations* → *New registration*, name e.g. "Heinzel admin", single tenant.
   Redirect URI: platform *Web*, `https://<admin host>/auth/callback` (locally: `http://localhost:3080/auth/callback`).
2. **Client secret:** *Certificates & secrets* → *New client secret*.
3. **App roles:** *App roles* → *Create app role* twice, allowed member types *Users/Groups*:
   - value `Heinzel.Admin`
   - value `Heinzel.Viewer`
4. **Assign people:** *Enterprise applications* → "Heinzel admin" → *Users and groups* → add users or groups with a role. Under *Properties*, set *Assignment required* to *Yes*, so nobody else can even start a sign-in.
5. `.env`:
   ```bash
   ADMIN_PUBLIC_URL=https://<admin host>              # http://localhost:3080 locally
   ADMIN_OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
   ADMIN_OIDC_CLIENT_ID=<application (client) id>
   ADMIN_OIDC_CLIENT_SECRET=<secret>
   ```

The assigned app roles arrive in the ID token's `roles` claim. Other providers (Keycloak, Okta, Google Workspace, …) work the same way; set `ADMIN_ROLE_CLAIM` (e.g. `groups`) and `ADMIN_ADMIN_ROLES` / `ADMIN_VIEWER_ROLES` to the values your provider sends.

## Settings and MCP servers: what lives where

| | Where | Changed by |
|---|---|---|
| Database, ports, sign-in of the admin UI, secrets key, coding runner, chat platform credentials, LLM API key | Deployment (env / Helm values / Secret) | Operations |
| Models, ambient defaults, limits, retention, allowed repositories | **Settings** page; the deployment value is the starting point | Admins |
| MCP servers over HTTP | **Tools** page, or `mcp.json` | Admins / operations |
| MCP servers that run a command (stdio) | `mcp.json` only | Operations |

- A value changed in the UI overrides the deployment value until someone presses *Reset*. The page shows where each value comes from.
- **Configuration as code:** list settings in `LOCKED_SETTINGS` (comma-separated, or `*` for all) and the UI shows them read-only; the deployment value always applies.
- Servers in `mcp.json` win over UI servers with the same name and are read-only in the UI.
- **Secrets:** header values of MCP servers (tokens) are encrypted with AES-256-GCM using `SECRETS_KEY` (`openssl rand -base64 32`, keep it in your secret store; without it the UI cannot store tokens). Values are never shown again or written to the audit log; leave a value empty when editing to keep it. Alternatively write `${VAR}` and provide the variable in the deployment.
- Changes are announced through Postgres (LISTEN/NOTIFY), so every replica applies them within moments (and re-reads every 30 seconds as a fallback). MCP servers reconnect when their configuration changes.
- Every change is in the audit log.

## Security

- OpenID Connect authorization code flow with PKCE, state and nonce (`openid-client`).
- Sessions live in Postgres (`admin_sessions`, only a hash of the cookie value), expire after `ADMIN_SESSION_HOURS` and end on sign-out. Several replicas share them.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `ADMIN_PUBLIC_URL` is https.
- Every write needs the admin role and the session's CSRF token (`X-CSRF-Token` header).
- Strict Content Security Policy and the usual security headers (`@fastify/helmet`); rate limits on the sign-in routes.
- By default the server listens on 127.0.0.1 only. In production put it behind a TLS reverse proxy and set `ADMIN_HOST=0.0.0.0` (the Docker Compose file does this and publishes the port on localhost).

## Development notes

- Backend: Fastify in `src/admin/` (`server.ts` routes, `auth.ts` OIDC, `types.ts` API shapes shared with the UI).
- Frontend: React + Vite + Mantine + TanStack Query in `web/` (pnpm workspace). `pnpm build` builds both; the server serves `web/dist`.
- SQL stays in `src/store` and `src/memory` like everywhere else.

## Next

- OAuth sign-in for MCP servers that require it; per-channel tool allowlist.
- Who may use chat commands (channel owners / admin group).
- Delete and export everything about one person (GDPR).
