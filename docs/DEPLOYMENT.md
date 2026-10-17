# Deployment

Heinzel is one container (`ghcr.io/v0lumehi/heinzel`) plus Postgres 14+. Optional: the coding image (`ghcr.io/v0lumehi/heinzel-coder`), SearXNG for web search, MCP servers.

| Port | Purpose | Expose |
|---|---|---|
| 3978 | Microsoft Teams messaging endpoint (`/api/messages`) | public HTTPS, only if you use Teams |
| 3080 | Admin UI | HTTPS for admins (internal network or SSO-protected) |
| 8081 | `/healthz`, `/readyz` | cluster-internal only |

Slack uses an outgoing WebSocket (Socket Mode) and needs no inbound port.

## Kubernetes (Helm)

```bash
kubectl create namespace heinzel
kubectl -n heinzel create secret generic heinzel \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=LLM_API_KEY='…' \
  --from-literal=TEAMS_APP_PASSWORD='…' \
  --from-literal=ADMIN_OIDC_CLIENT_SECRET='…' \
  --from-literal=SECRETS_KEY="$(openssl rand -base64 32)"

helm install heinzel oci://ghcr.io/v0lumehi/charts/heinzel --version <version> -n heinzel -f values.yaml
```

A minimal `values.yaml`:

```yaml
secrets:
  existingSecret: heinzel
config:
  LLM_MODEL_AGENT: bedrock/claude-sonnet-5@eu-central-1
  LLM_MODEL_TRIAGE: bedrock/claude-haiku-5-5@eu-central-1
  TEAMS_APP_ID: <bot app id>
  TEAMS_TENANT_ID: <tenant id>
  ADMIN_PUBLIC_URL: https://heinzel-admin.example.com
  ADMIN_OIDC_ISSUER: https://login.microsoftonline.com/<tenant id>/v2.0
  ADMIN_OIDC_CLIENT_ID: <client id>
ingress:
  className: nginx
  admin: { enabled: true, host: heinzel-admin.example.com, tlsSecretName: heinzel-admin-tls }
  teams: { enabled: true, host: heinzel-teams.example.com, tlsSecretName: heinzel-teams-tls }
```

Models, limits and HTTP MCP servers can also be managed in the admin UI; to keep them in Git only, set `LOCKED_SETTINGS: "*"` under `config` (docs/ADMIN.md). All settings are the environment variables from `.env.example`: non-secret ones under `config`, secret ones in the Secret. MCP servers go under `mcp` (the content of `mcp.json`). See `deploy/helm/heinzel/values.yaml` for everything else (replicas, resources, NetworkPolicy, scheduling).

What the chart does for you:
- Non-root, read-only root filesystem, no capabilities, RuntimeDefault seccomp; the service account token is only mounted when coding sessions run on Kubernetes.
- Startup, liveness and readiness probes; pods restart on config changes (checksums).
- Several replicas work (jobs are coordinated in Postgres, migrations take a lock); a PodDisruptionBudget is added for `replicaCount > 1`.
- Ingress only for what you enable; the Teams ingress exposes only `/api/messages`.

### Postgres

Use a managed Postgres (Azure Database for PostgreSQL, Amazon RDS, Cloud SQL) or an operator such as CloudNativePG. Heinzel needs one database and a user that may create tables. Back it up like any production database; it holds memories, settings, the audit log and (unless `EVENTS_RETENTION_DAYS` is set) message copies.

## Docker Compose

For a single machine: `docker compose --profile app up -d` (see README). Admin UI and Teams endpoint are published on localhost; put a TLS reverse proxy in front.

## Upgrades

1. Read CHANGELOG.md for the target version.
2. `helm upgrade heinzel oci://ghcr.io/v0lumehi/charts/heinzel --version <new> -n heinzel -f values.yaml` (or pull the new image with Compose).
3. Migrations run when the first new pod starts; the others wait for them. Migrations are additive within a major version, so old pods keep working during a rolling update.

Back up the database before major version upgrades.

## Verifying images

See SECURITY.md (`cosign verify`, SBOM, provenance).
