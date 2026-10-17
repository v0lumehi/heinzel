# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(*Security* → *Report a vulnerability* in this repository). You get an answer within five working days.
Include what you found, how to reproduce it and which version you run.

## Supported versions

Security fixes go into the latest minor release. Run the latest release. Upgrades are designed to be drop-in
(migrations run automatically, breaking changes are announced in CHANGELOG.md).

## Verifying releases

Images are signed keylessly with Sigstore and carry an SBOM and SLSA provenance. Use cosign 3 or later, because the signatures use the current Sigstore bundle format:

```bash
cosign verify ghcr.io/v0lumehi/heinzel:<version> \
  --certificate-identity-regexp 'https://github.com/v0lumehi/heinzel/.github/workflows/release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker buildx imagetools inspect ghcr.io/v0lumehi/heinzel:<version> --format '{{ json .SBOM }}'
```

The Helm chart archive on each GitHub release comes with a Sigstore bundle:

```bash
cosign verify-blob heinzel-<version>.tgz --bundle heinzel-<version>.tgz.sigstore.json \
  --certificate-identity-regexp 'https://github.com/v0lumehi/heinzel/.github/workflows/release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Security model in short

- Heinzel acts only under its own bot identity and never as a user. Bot messages cannot trigger commands (no bot loops).
- Everything except the LLM can run in your infrastructure. Message copies, memories and usage stay in your Postgres.
- Tool output (web pages, MCP results) is treated as untrusted data in the prompt. Web fetch refuses private network addresses.
- Coding agents run in throwaway containers with an egress allowlist and can only open draft merge requests.
- Admin UI: OIDC with PKCE, server-side sessions, CSRF tokens, strict Content Security Policy, roles from your identity provider, audit log.
- Containers run as non-root. The Helm chart sets a read-only root filesystem, drops all capabilities and uses the RuntimeDefault seccomp profile.

See docs/ARCHITECTURE.md, docs/CODING.md and docs/ADMIN.md for details.
