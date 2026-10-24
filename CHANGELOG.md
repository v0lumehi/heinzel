# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org), and upgrade notes say when you need to act.
Database migrations run automatically at startup.

## [Unreleased]

### Security
- body-parser 2.4.0 (CVE-2026-111181, denial of service on the Teams messaging endpoint via compressed request bodies).
- Coding image rebuilt with current Debian security updates (libbrotli, CVE-2026-111497).
- Reviewed and accepted until 2026-11-30: CVE-2026-109461 in @azure/msal-node (authorization code flow, which the Teams SDK does not use) and CVE-2026-109869 in npm's bundled undici in the coding image.

### Changed
- Admin UI dependency updates (Mantine 9.7, Vite 8.3.4).

## [0.1.0] - 2026-10-17

First release: a self-hosted AI teammate for Slack and Microsoft Teams with an admin UI, Helm chart and signed images.

### Added
- Slack adapter (Socket Mode) and Microsoft Teams adapter (Teams SDK v2), `pnpm teams:package` for the Teams app package.
- Ambient triage, follow-ups, team memory, heavy-model escalation, chat commands.
- External tools via MCP and built-in web fetch. Coding sessions with OpenCode in isolated containers.
- Admin UI with OIDC single sign-on, admin/viewer roles and an audit log. Setup page with readiness checks, platform status and guided Slack/Teams setup (manifest and app package downloads). Each check links to its fix or shows the deployment snippet. Recommended checks can be marked as decided.
- Coding sessions on Kubernetes (`CODING_RUNNER=kubernetes`): a Job per session with RBAC, egress proxy and NetworkPolicy from the Helm chart.
- Integration catalog in the admin UI (web search, GitLab, Jira/Confluence) with connection test and tool selection, plus custom MCP servers. Plain-language descriptions of the built-in tools.
- Runtime settings and HTTP MCP servers manageable in the admin UI, applied live on all replicas, with `LOCKED_SETTINGS` and `SECRETS_KEY`.
- `/healthz` and `/readyz` on `HEALTH_PORT` (default 8081).
- Helm chart (`deploy/helm/heinzel`), signed multi-arch images with SBOM and provenance on GHCR, CI.

### Project
- Contributing guide, code of conduct, issue and pull request templates, CODEOWNERS.
- Test coverage in CI (Codecov), CodeQL code scanning, OpenSSF Scorecard, OpenSSF Best Practices badge (passing).
- Property-based tests with fast-check for parsers and security checks. Tests for adapters, worker, Docker runner, LLM client and egress proxy.
- Releases attach the Helm chart with a Sigstore bundle.

### Security
- Images based on Debian 13 (trixie) with current security updates. No known high or critical vulnerabilities in the Heinzel image.
- The Heinzel image contains no npm, npx or corepack. Stdio MCP servers are baked into a derived image (docs/TOOLS.md).
- Base images pinned by digest. Workflow checkouts without persisted credentials, and `main` protected against deletion and force pushes.
- Admin UI: MCP server and header names are validated and stored without prototype (found by CodeQL). Teams text conversion removes nested tag fragments.

[Unreleased]: https://github.com/v0lumehi/heinzel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/v0lumehi/heinzel/releases/tag/v0.1.0
