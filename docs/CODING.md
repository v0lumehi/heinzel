# Coding sessions

Heinzel can hand a coding task to a coding agent ([OpenCode](https://opencode.ai) 2). The agent works on a repository in an isolated container in your infrastructure, runs the tests and opens a **draft merge request**. Merging is always left to a human.

```
#dev thread
  Anna:    @Heinzel the login redirect in team/api is broken, can you fix it?
  Heinzel: I'd start a coding session in team/api: … Start it with `@Heinzel !go`.
  Anna:    @Heinzel !go
  Heinzel: 🛠️ Coding session #12 · team/api · running · 3 min      ← edited live
           • `read src/auth/login.ts`
           • `edit src/auth/login.ts`
           • `$ pnpm test`
  Heinzel: ✅ Coding session #12 done – draft merge request: https://gitlab…/merge_requests/41 (2 commits, …)
           <the agent's summary>
```

## How it works

```
Slack thread ─► Heinzel agent: tool start_coding_task (only when addressed directly)
                   │  session "awaiting confirmation" (30 min)
   "!go" by the requester
                   ▼
              job coding_start ─► Docker: container heinzel-coding-<id> (image heinzel-coder)
                                    root:  clone with the git token into /srv/origin (root only)
                                    coder: OpenCode 2 works in /workspace, runs tests, commits
                                    root:  takes the commits as a git bundle, pushes branch heinzel/<id>-<slug>
                                           with GitLab push options → draft merge request
              job coding_watch (every 15 s) ─► reads the container's event log ─► edits the status message
                   ▼
              final message with MR link and the agent's summary, container removed
```

- Watching is a chain of short jobs, not one long job, so Heinzel restarts and multiple Heinzel processes are safe.
- Tokens the agent uses are booked as purpose `coding` in the usage table (`!status` shows the 24h total).
- The agent sees the task Heinzel wrote plus the thread as context. It follows `AGENTS.md`/`CONTRIBUTING`/`README` in the repository.

Commands (in the session's thread; in DMs the newest session):

| | |
|---|---|
| `!go [id]` | Start the prepared session. Only the person who asked can start it. |
| `!stop [id]` | Cancel a waiting or running session. Anyone in the channel can stop one. |
| `!coding` | Recent sessions in this channel |

## Setup (Docker)

1. **Build the coding image.** Extend it with your projects' toolchains (JDK, Python, …) so the agent can run tests:
   ```bash
   docker build -t heinzel-coder:latest coder/
   ```
2. **Git token.** In GitLab, create a *project access token* (or group access token for several projects) with role **Developer** and scope **write_repository**. The token can then push branches but not to protected branches; merge requests come from push options, so no API scope is needed.
3. **Isolation.** Start the egress proxy, the Docker API proxy and the internal network:
   ```bash
   docker compose --profile coding up -d
   ```
4. **`.env`:**
   ```bash
   CODING_ENABLED=true
   GITLAB_URL=https://gitlab.example.com
   CODING_GIT_TOKEN=glpat-…
   CODING_REPOSITORIES=team/*            # which projects sessions may target
   CODING_DOCKER_NETWORK=heinzel-coding
   CODING_PROXY_URL=http://egress-proxy:3128
   # Hosts the coding containers may reach through the proxy: LLM gateway and GitLab (+ package registries if tests need them)
   EGRESS_ALLOW=router.eu.requesty.ai,gitlab.example.com
   # Heinzel on the host (pnpm dev) uses your local Docker socket, e.g. Colima:
   # DOCKER_HOST=unix:///Users/me/.colima/default/docker.sock
   ```
   In compose (`--profile app`), Heinzel talks to Docker through `docker-proxy` (`DOCKER_HOST=tcp://docker-proxy:2375`), never the raw socket.
5. Restart Heinzel. The log says `coding: true`; a missing image is reported at startup.

Further settings (`.env.example`): `CODING_MODEL` (default: `LLM_MODEL_HEAVY`, else `LLM_MODEL_AGENT`), `CODING_LLM_BASE_URL`/`CODING_LLM_API_KEY` (a separate key makes cost and revocation easy), `CODING_TIMEOUT_MIN` (45), `CODING_MAX_RUNNING` (2), `CODING_MEMORY_MB` (4096), `CODING_CPUS` (2), `CODING_NO_PROXY` (e.g. a GitLab on the internal network).

## Setup (Kubernetes)

With the Helm chart (docs/DEPLOYMENT.md), every session runs as a Kubernetes **Job** in a dedicated namespace:

```yaml
config:
  GITLAB_URL: https://gitlab.example.com
  CODING_REPOSITORIES: "team/*"
coding:
  enabled: true
  namespace: heinzel-coding          # create it first; Heinzel may create Jobs and Secrets there
  runtimeClassName: gvisor           # optional, recommended (gVisor or Kata must be installed)
  egress:
    allow: [router.eu.requesty.ai, gitlab.example.com]
# Secret: CODING_GIT_TOKEN (and optionally CODING_LLM_API_KEY)
```

What the chart sets up:
- A **Role** in the coding namespace that lets Heinzel create, watch and delete Jobs, read their pods and logs, and write (never read) Secrets.
- Per session: a Job (one pod, no retries, deadline) and a Secret with its environment (git token, LLM key) owned by the Job, so both disappear together. The pod gets no service account token, a RuntimeDefault seccomp profile, no privilege escalation, `cap-drop ALL` plus the five capabilities needed to drop privileges, and CPU/memory limits.
- The **egress proxy** (same image, `dist/egress/proxy.js`) with the allowlist, and a **NetworkPolicy** that allows coding pods only DNS and the proxy.

NetworkPolicies only work if your cluster's network plugin enforces them (Calico, Cilium, Azure Network Policy Manager, …). Check it once after installing; this must print `BLOCKED`:

```bash
kubectl -n heinzel-coding run nettest --rm -i --restart=Never --labels=heinzel.coding=true \
  --image=ghcr.io/v0lumehi/heinzel-coder:<version> --command -- \
  node -e "fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>console.log('REACHED: not isolated'),()=>console.log('BLOCKED'))"
```

## Security model

The coding agent runs arbitrary commands, and its input (the thread, issue texts, repository content) can contain prompt injections. The design assumes the agent may be tricked and limits what that can achieve:

| Risk | Measure |
|---|---|
| Starting sessions by accident or via injected text | The tool is only offered when a person addresses Heinzel directly (never in ambient mode or follow-ups), and nothing runs before the **requester** confirms with `!go`. Repositories are limited by `CODING_REPOSITORIES`. |
| Exfiltrating code or secrets | Containers sit on an internal network without internet. The only way out is the egress proxy, which allows only `EGRESS_ALLOW` hosts (LLM gateway, GitLab). |
| Stealing the git token | The token is only visible to root in the container. The agent runs as the unprivileged user `coder`, cannot read root's environment or the credentialed clone in `/srv`, and its commits leave `/workspace` only as a git bundle, so hooks or git config it writes never run with the token. |
| Pushing to the wrong place | The push target is fixed by Heinzel (`heinzel/<id>-…` in the configured repository). The project access token cannot push to protected branches. The MR is a draft. |
| Breaking out / hogging the host | `cap-drop ALL` (plus the five capabilities needed to drop privileges), `no-new-privileges`, memory, CPU and PID limits, timeout. Docker: Heinzel reaches Docker only through a filtering socket proxy. Kubernetes: a namespaced Role, no service account token in coding pods, optional gVisor/Kata RuntimeClass. |
| The LLM key | The agent needs it to work. Use a separate key (`CODING_LLM_API_KEY`) with its own budget; it can only be used against the allowed gateway. |

What remains: the agent can read everything in the repository and send it to your LLM gateway, and it can push arbitrary content to its own branch. Review the merge request like any other contribution.

## Limits and next steps

- Runners: Docker (`src/coding/docker.ts`) and Kubernetes Jobs (`src/coding/kubernetes.ts`, `CODING_RUNNER=kubernetes`), both behind `CodingRunner` (`src/coding/runner.ts`). A session whose pod cannot be scheduled waits until `CODING_TIMEOUT_MIN`.
- Backends: OpenCode only. GitLab Duo Agent Platform is planned as a second backend (`backend` column on `coding_sessions`): for customers with DAP, sessions would run on their GitLab runners.
- One task per session; follow-up requests in the same thread start a new session (continuing a session is planned).
- Push options create merge requests on GitLab only. On other hosts the branch is pushed and the final message says so.
- Empty repositories work: Heinzel first pushes an empty "Initialize repository" commit to the default branch (GitLab allows developers this first push), so the merge request has a target.
- A new session starts from the default branch. To build on an unmerged session, merge its MR first or ask for the session's branch as the base (the tool has a `base_branch` argument).
