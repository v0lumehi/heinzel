// Heinzel coding container: clone → run the coding agent → push a branch (+ draft merge request on GitLab).
// Prints the agent's JSON events on stdout, its own log on stderr, and exactly one "HEINZEL_RESULT {...}" line last.
//
// Privilege split: this script runs as root and is the only process that ever sees the git token. The agent runs as
// the unprivileged user "coder" with a scrubbed environment. Its commits leave /workspace only as a git bundle (a plain
// data file) that root fetches into a pristine clone and pushes from there, so hooks or config the agent writes into
// /workspace/.git never run with the token.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";

const ORIGIN = "/srv/origin"; // pristine clone, root only
const WORK = "/workspace"; // the agent's checkout
const BUNDLE = "/tmp/heinzel-work.bundle";
const AGENT_USER = "coder";

const env = process.env;
const log = (msg) => process.stderr.write(`[heinzel-coder] ${msg}\n`);

function finish(result) {
  process.stdout.write(`HEINZEL_RESULT ${JSON.stringify(result)}\n`);
  process.exit(result.status === "failed" ? 1 : 0);
}

function need(name) {
  const v = env[name];
  if (!v) finish({ status: "failed", error: `${name} is not set` });
  return v;
}

const repoUrl = need("HEINZEL_REPO_URL");
const branch = need("HEINZEL_BRANCH");
const title = need("HEINZEL_TITLE");
const task = Buffer.from(need("HEINZEL_TASK_B64"), "base64").toString("utf8");
const model = need("HEINZEL_MODEL");
const gitToken = need("HEINZEL_GIT_TOKEN");
const gitUser = env.HEINZEL_GIT_USERNAME || "oauth2"; // GitLab: oauth2 + token; GitHub: x-access-token
const authHeader = `http.extraHeader=Authorization: Basic ${Buffer.from(`${gitUser}:${gitToken}`).toString("base64")}`;

/** Runs a command; as `coder` when asked. Never inherits the token: env is built explicitly. */
function run(cmd, args, opts = {}) {
  const asAgent = opts.asAgent === true;
  const full = asAgent ? ["setpriv", ["--reuid", AGENT_USER, "--regid", AGENT_USER, "--init-groups", "--", cmd, ...args]] : [cmd, args];
  const res = spawnSync(full[0], full[1], {
    cwd: opts.cwd ?? "/",
    env: opts.env ?? baseEnv(asAgent ? `/home/${AGENT_USER}` : "/root"),
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? 1, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim() };
}

function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    // Never echo the auth header back.
    const msg = `${cmd} ${args.filter((a) => !a.startsWith("http.extraHeader")).join(" ")} failed: ${r.stderr || r.stdout}`.replaceAll(gitToken, "***");
    throw new Error(msg.slice(0, 2000));
  }
  return r.stdout;
}

function baseEnv(home) {
  const e = { HOME: home, PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) if (env[k]) e[k] = env[k];
  // OpenCode talks to its own local server; that must never go through the proxy.
  const noProxy = ["localhost", "127.0.0.1", "::1", env.NO_PROXY || env.no_proxy].filter(Boolean).join(",");
  e.NO_PROXY = e.no_proxy = noProxy;
  return e;
}

try {
  // 1. Pristine clone with the token (root only).
  mkdirSync(ORIGIN, { recursive: true });
  chmodSync("/srv", 0o700);
  const base = env.HEINZEL_BASE_BRANCH || null;
  log(`cloning ${repoUrl}${base ? ` (${base})` : ""}`);
  must("git", ["-c", authHeader, "clone", "--quiet", "--no-tags", "--single-branch", "--depth", "200", ...(base ? ["--branch", base] : []), repoUrl, ORIGIN]);
  const empty = run("git", ["-C", ORIGIN, "rev-parse", "--verify", "--quiet", "HEAD"]).code !== 0;
  const baseBranch = base ?? (empty ? must("git", ["-C", ORIGIN, "symbolic-ref", "--short", "HEAD"]) : must("git", ["-C", ORIGIN, "rev-parse", "--abbrev-ref", "HEAD"]));
  if (empty) {
    // A merge request needs a target branch: give the empty repository an empty root commit on its default branch.
    // GitLab lets developers make this first push to a new project's default branch.
    log(`repository is empty: pushing an empty initial commit to ${baseBranch}`);
    const author = ["-c", `user.name=${env.HEINZEL_GIT_AUTHOR_NAME || "Heinzel"}`, "-c", `user.email=${env.HEINZEL_GIT_AUTHOR_EMAIL || "heinzel@localhost"}`];
    must("git", ["-C", ORIGIN, ...author, "commit", "--quiet", "--allow-empty", "-m", "Initialize repository"]);
    must("git", ["-C", ORIGIN, "-c", authHeader, "push", "--quiet", "origin", `HEAD:refs/heads/${baseBranch}`]);
  }

  // 2. The agent's checkout: a local clone without credentials, owned by the agent user.
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
  must("git", ["clone", "--quiet", "--no-local", ORIGIN, WORK]);
  must("git", ["-C", WORK, "remote", "set-url", "origin", repoUrl]);
  must("git", ["-C", WORK, "checkout", "--quiet", "-b", branch]);
  must("git", ["-C", WORK, "config", "user.name", env.HEINZEL_GIT_AUTHOR_NAME || "Heinzel"]);
  must("git", ["-C", WORK, "config", "user.email", env.HEINZEL_GIT_AUTHOR_EMAIL || "heinzel@localhost"]);
  must("chown", ["-R", `${AGENT_USER}:${AGENT_USER}`, WORK]);

  // 3. The agent (unprivileged, no git token in its environment).
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      heinzel: {
        npm: "@ai-sdk/openai-compatible",
        name: "Heinzel LLM gateway",
        options: { baseURL: need("HEINZEL_LLM_BASE_URL"), apiKey: "{env:HEINZEL_LLM_API_KEY}" },
        models: { [model]: { name: model } },
      },
    },
  };
  const agentEnv = {
    ...baseEnv(`/home/${AGENT_USER}`),
    HEINZEL_LLM_API_KEY: need("HEINZEL_LLM_API_KEY"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
  log(`running agent (model ${model})`);
  const agent = run("opencode", ["run", "--standalone", "--format", "json", "--auto", "-m", `heinzel/${model}`, "--title", title, task], {
    asAgent: true,
    cwd: WORK,
    env: agentEnv,
    inherit: true,
  });
  if (agent.code !== 0) finish({ status: "failed", agentExitCode: agent.code, error: `coding agent exited with code ${agent.code}` });

  // 4. Commit what the agent left uncommitted, then hand the commits over as a bundle.
  const asAgent = { asAgent: true, cwd: WORK };
  if (must("git", ["status", "--porcelain"], asAgent)) {
    must("git", ["add", "-A"], asAgent);
    must("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", title], asAgent);
  }
  const ahead = Number(must("git", ["rev-list", "--count", `origin/${baseBranch}..HEAD`], asAgent));
  if (ahead === 0) finish({ status: "no_changes", branch, commits: 0, agentExitCode: 0 });
  must("git", ["bundle", "create", "--quiet", BUNDLE, `origin/${baseBranch}..HEAD`], asAgent);
  must("git", ["-C", ORIGIN, "fetch", "--quiet", BUNDLE, `+HEAD:refs/heads/${branch}`]);
  const commits = Number(must("git", ["-C", ORIGIN, "rev-list", "--count", `${baseBranch}..${branch}`]));
  const diffstat = must("git", ["-C", ORIGIN, "diff", "--shortstat", `${baseBranch}...${branch}`]);

  // 5. Push from the pristine clone. On GitLab, push options open a draft merge request in the same step.
  const description = (env.HEINZEL_MR_DESCRIPTION || "Created by Heinzel.").replace(/[\r\n]+/g, " ");
  const pushOpts = [
    "-o", "merge_request.create",
    "-o", `merge_request.target=${baseBranch}`,
    "-o", `merge_request.title=Draft: ${title.replace(/[\r\n]+/g, " ")}`,
    "-o", `merge_request.description=${description}`,
    "-o", "merge_request.remove_source_branch",
  ];
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  let push = run("git", ["-C", ORIGIN, "-c", authHeader, "push", ...pushOpts, "origin", refspec]);
  if (push.code !== 0 && /push options|push-options/i.test(push.stderr)) {
    log("server does not support push options; pushing the branch only");
    push = run("git", ["-C", ORIGIN, "-c", authHeader, "push", "origin", refspec]);
  }
  if (push.code !== 0) finish({ status: "failed", branch, commits, diffstat, error: `push failed: ${push.stderr.replaceAll(gitToken, "***").slice(0, 1500)}` });
  const mr = /(https?:\/\/\S+\/-\/merge_requests\/\d+)/.exec(push.stderr);
  finish({ status: "pushed", branch, commits, diffstat, mergeRequestUrl: mr ? mr[1] : null, agentExitCode: 0 });
} catch (err) {
  finish({ status: "failed", error: String(err?.message ?? err).replaceAll(gitToken, "***") });
}
