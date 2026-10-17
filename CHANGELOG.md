# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org); upgrade notes say when you need to act.
Database migrations run automatically at startup.

## [Unreleased]

### Added
- Slack adapter (Socket Mode) and Microsoft Teams adapter (Teams SDK v2), `pnpm teams:package` for the Teams app package.
- Ambient triage, follow-ups, team memory, heavy-model escalation, chat commands.
- External tools via MCP and built-in web fetch; coding sessions with OpenCode in isolated containers.
- Admin UI with OIDC single sign-on, admin/viewer roles and an audit log; setup page with readiness checks, platform status and guided Slack/Teams setup (manifest and app package downloads).
- Coding sessions on Kubernetes (`CODING_RUNNER=kubernetes`): a Job per session with RBAC, egress proxy and NetworkPolicy from the Helm chart.
- Runtime settings and HTTP MCP servers manageable in the admin UI, applied live on all replicas; `LOCKED_SETTINGS`, `SECRETS_KEY`.
- `/healthz` and `/readyz` on `HEALTH_PORT` (default 8081).
- Helm chart (`deploy/helm/heinzel`), signed multi-arch images with SBOM and provenance on GHCR, CI.

### Project
- Contributing guide, code of conduct, issue and pull request templates, CODEOWNERS.
- Test coverage in CI (Codecov), CodeQL code scanning, OpenSSF Scorecard.

### Security
- Images based on Debian 13 (trixie) with current security updates; no known high or critical vulnerabilities in the Heinzel image.
- The Heinzel image contains no npm, npx or corepack; stdio MCP servers are baked into a derived image (docs/TOOLS.md).
- Base images pinned by digest; workflow checkouts without persisted credentials; `main` protected against deletion and force pushes.
- Admin UI: MCP server and header names are validated and stored without prototype (found by CodeQL); Teams text conversion removes nested tag fragments.
