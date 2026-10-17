import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CodingRunner, LogLine, RunnerState, RunSpec } from "../src/coding/runner.js";
import { RESULT_MARKER } from "../src/coding/events.js";
import { Engine } from "../src/core/engine.js";
import type { Platform } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import type { LlmRequest, LlmResponse } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/memory.js";
import { JobQueue } from "../src/queue/queue.js";
import type { JobHandlers } from "../src/queue/worker.js";
import { CodingStore } from "../src/store/coding.js";
import { Store } from "../src/store/store.js";
import { FakeAdapter, FakeLlm, TEST_DATABASE_URL, freshDb, msg, reply, silentLog, testConfig } from "./helpers.js";

/** Runs every due job synchronously; `future` also runs jobs scheduled later (e.g. the next watch tick). */
async function drain(db: Db, queue: JobQueue, handlers: JobHandlers, opts: { future?: boolean } = {}): Promise<number> {
  let n = 0;
  for (;;) {
    if (opts.future) await db.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
    const job = await queue.claim();
    if (!job) return n;
    const h = handlers[job.kind] as (p: unknown, j: unknown) => Promise<void>;
    await h(job.payload, job);
    await queue.complete(job.id);
    if (++n > 50) throw new Error("job loop does not settle");
  }
}

class FakeRunner implements CodingRunner {
  started: RunSpec[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  lines: LogLine[] = [];
  running = true;
  exitCode = 0;
  imageMissing = false;
  private seq = 0;

  log(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.lines.push({ ts: `2026-10-17T10:00:${String(++this.seq).padStart(2, "0")}Z`, stream, text });
  }
  async checkImage(image: string): Promise<void> {
    if (this.imageMissing) throw new Error(`Coding image "${image}" not found.`);
  }
  async start(spec: RunSpec): Promise<string> {
    this.started.push(spec);
    return "ctr-1";
  }
  async state(): Promise<RunnerState | null> {
    return { running: this.running, exitCode: this.running ? null : this.exitCode, oomKilled: false };
  }
  async logs(_ref: string, since: string | null): Promise<LogLine[]> {
    return since ? this.lines.filter((l) => l.ts > since) : [...this.lines];
  }
  async stop(ref: string): Promise<void> {
    this.stopped.push(ref);
    this.running = false;
    this.exitCode = 137;
  }
  async remove(ref: string): Promise<void> {
    this.removed.push(ref);
  }
}

const startTool = (args: object): LlmResponse =>
  reply("", [{ id: "c1", name: "start_coding_task", arguments: JSON.stringify({ repository: "team/api", title: "Fix login redirect", task: "Users land on /home after login instead of the page they came from. Fix it and add a test.", ...args }) }]);

describe.skipIf(!TEST_DATABASE_URL)("engine: coding sessions", () => {
  let db: Db;
  let adapter: FakeAdapter;
  let llm: FakeLlm;
  let queue: JobQueue;
  let sessions: CodingStore;
  let runner: FakeRunner;
  let engine: Engine;
  let now: Date;
  let agentAnswer: (req: LlmRequest, n: number) => LlmResponse;

  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.end();
  });

  function makeEngine(over: Record<string, string> = {}): Engine {
    return new Engine({
      config: testConfig({
        CODING_ENABLED: "true",
        GITLAB_URL: "https://git.example.com/",
        CODING_GIT_TOKEN: "glpat-secret",
        CODING_REPOSITORIES: "team/*",
        CODING_PROXY_URL: "http://egress-proxy:3128",
        CODING_DOCKER_NETWORK: "heinzel-coding",
        ...over,
      }),
      store: new Store(db),
      memory: new MemoryStore(db),
      queue,
      llm,
      adapters: new Map<Platform, typeof adapter>([["slack", adapter]]),
      coding: { runner, sessions },
      log: silentLog,
      now: () => now,
    });
  }

  beforeEach(async () => {
    await db.query("TRUNCATE channels, events, jobs, memories, bot_posts, llm_usage, coding_sessions RESTART IDENTITY CASCADE");
    adapter = new FakeAdapter();
    now = new Date();
    agentAnswer = (_req, n) => (n === 1 ? startTool({}) : reply("I prepared session #1. Start it with `@Heinzel !go`."));
    llm = new FakeLlm((req, n) => agentAnswer(req, n));
    queue = new JobQueue(db);
    sessions = new CodingStore(db);
    runner = new FakeRunner();
    engine = makeEngine();
  });

  /** Anna asks for a change; the agent prepares session #1. */
  async function requestSession(): Promise<string> {
    const m = msg({ text: "@Heinzel please fix the login redirect in team/api", mentionsBot: true });
    adapter.history.push(m);
    await engine.handleIncoming(m);
    await drain(db, queue, engine.handlers());
    return m.threadId;
  }

  async function command(text: string, threadId: string, userId = "U1"): Promise<string> {
    const m = msg({ text, mentionsBot: true, threadId, userId, userName: userId === "U1" ? "Anna" : "Ben" });
    await engine.handleIncoming(m);
    return adapter.sent.at(-1)!.text;
  }

  it("prepares a session, starts it on !go by the requester, reports progress and the draft MR", async () => {
    const thread = await requestSession();
    const toolResult = JSON.stringify(llm.requests[1]!.messages.at(-1));
    expect(toolResult).toContain("Prepared coding session #1");
    expect(toolResult).toContain("@Heinzel !go");
    expect(String(llm.requests[0]!.messages[0]!.content)).toContain("start_coding_task");
    expect((await sessions.get(1))!).toMatchObject({ status: "awaiting_confirmation", repository: "team/api", branch: "heinzel/1-fix-login-redirect", requestedByName: "Anna" });
    expect(runner.started).toHaveLength(0);

    expect(await command("@Heinzel !go", thread, "U2")).toBe("Only Anna can start session #1.");
    expect(await command("@Heinzel !go", thread)).toMatch(/^Starting coding session #1 in team\/api/);
    await drain(db, queue, engine.handlers());

    // Container spec: repo URL from GITLAB_URL, proxy, network; the token only goes into the container env, never the prompt.
    const spec = runner.started[0]!;
    expect(spec).toMatchObject({ name: "heinzel-coding-1", network: "heinzel-coding", image: "heinzel-coder:latest" });
    expect(spec.env).toMatchObject({ HEINZEL_REPO_URL: "https://git.example.com/team/api.git", HEINZEL_BRANCH: "heinzel/1-fix-login-redirect", HTTPS_PROXY: "http://egress-proxy:3128", HEINZEL_GIT_TOKEN: "glpat-secret", HEINZEL_MODEL: "agent-model" });
    const prompt = Buffer.from(spec.env.HEINZEL_TASK_B64!, "base64").toString("utf8");
    expect(prompt).toContain("Users land on /home after login");
    expect(prompt).toContain("Anna: please fix the login redirect in team/api");
    expect(prompt).not.toContain("glpat-secret");
    const statusMsg = adapter.sent.at(-1)!;
    expect(statusMsg.text).toContain("Coding session #1");
    expect(statusMsg.threadId).toBe(thread);

    // Progress → the status message is edited in place.
    runner.log(JSON.stringify({ type: "tool_use", part: { tool: "edit", state: { input: { path: "/workspace/src/login.ts" } } } }));
    runner.log(JSON.stringify({ type: "step_finish", part: { tokens: { input: 1000, output: 50, cache: { read: 0, write: 0 } } } }));
    await drain(db, queue, engine.handlers(), { future: true }).catch(() => {});
    expect(adapter.updates.at(-1)).toMatchObject({ messageId: statusMsg.messageId });
    expect(adapter.updates.at(-1)!.text).toContain("`edit src/login.ts`");

    // Done → final message with the MR, container removed, tokens booked as "coding".
    runner.log(JSON.stringify({ type: "text", part: { text: "Redirect fixed, test added, all tests pass." } }));
    runner.log(`${RESULT_MARKER}${JSON.stringify({ status: "pushed", branch: "heinzel/1-fix-login-redirect", commits: 2, diffstat: "2 files changed", mergeRequestUrl: "https://git.example.com/team/api/-/merge_requests/9" })}`);
    runner.running = false;
    await drain(db, queue, engine.handlers(), { future: true });
    expect(adapter.sent.at(-1)!.text).toBe(
      "✅ Coding session #1 done – draft merge request: https://git.example.com/team/api/-/merge_requests/9 (2 commits, 2 files changed).\n\nRedirect fixed, test added, all tests pass.",
    );
    expect(runner.removed).toEqual(["ctr-1"]);
    expect((await sessions.get(1))!.status).toBe("succeeded");
    const { rows } = await db.query(`SELECT purpose, prompt_tokens FROM llm_usage WHERE purpose = 'coding'`);
    expect(rows).toEqual([{ purpose: "coding", prompt_tokens: 1000 }]);
    // The watch chain has ended.
    expect(await drain(db, queue, engine.handlers(), { future: true })).toBe(0);
  });

  it("offers the coding tool only when addressed directly", async () => {
    await engine.handleIncoming(msg({ text: "!ambient on", mentionsBot: true }));
    agentAnswer = () => reply("SILENT");
    llm = new FakeLlm((req) => (req.model === "triage-model" ? reply(JSON.stringify({ action: "reply", confidence: 1, reason: "can help" })) : agentAnswer(req, 0)));
    engine = makeEngine();
    await engine.handleIncoming(msg({ text: "Someone should really fix the login redirect bug in team/api soon" }));
    await drain(db, queue, engine.handlers());
    const ambient = llm.byModel("agent-model");
    expect(ambient.length).toBeGreaterThan(0);
    for (const r of ambient) expect(JSON.stringify(r.tools ?? [])).not.toContain("start_coding_task");
  });

  it("refuses repositories outside CODING_REPOSITORIES", async () => {
    agentAnswer = (_req, n) => (n === 1 ? startTool({ repository: "secret/payroll" }) : reply("ok"));
    await requestSession();
    expect(JSON.stringify(llm.requests[1]!.messages.at(-1))).toContain("not allowed for secret/payroll");
    expect(await sessions.get(1)).toBeNull();
  });

  it("stops a running session on !stop", async () => {
    const thread = await requestSession();
    await command("@Heinzel !go", thread);
    await drain(db, queue, engine.handlers());
    expect(await command("@Heinzel !stop", thread, "U2")).toBe("Stopping coding session #1…");
    await drain(db, queue, engine.handlers(), { future: true });
    expect(runner.stopped).toContain("ctr-1");
    expect((await sessions.get(1))!.status).toBe("cancelled");
    expect(adapter.sent.at(-1)!.text).toBe("⏹️ Coding session #1 was cancelled. Nothing was pushed.");
  });

  it("times out long sessions", async () => {
    const thread = await requestSession();
    await command("@Heinzel !go", thread);
    await drain(db, queue, engine.handlers());
    await db.query(`UPDATE coding_sessions SET started_at = now() - interval '2 hours'`);
    await drain(db, queue, engine.handlers(), { future: true });
    expect(runner.stopped).toContain("ctr-1");
    expect((await sessions.get(1))!.status).toBe("timed_out");
    expect(adapter.sent.at(-1)!.text).toMatch(/ran out of time \(stopped after 45 minutes\)/);
  });

  it("reports agent failures and a missing image", async () => {
    const thread = await requestSession();
    await command("@Heinzel !go", thread);
    await drain(db, queue, engine.handlers());
    runner.log(JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Cannot connect to API" } } }));
    runner.log(`${RESULT_MARKER}{"status":"failed","agentExitCode":1,"error":"coding agent exited with code 1"}`);
    runner.running = false;
    runner.exitCode = 1;
    await drain(db, queue, engine.handlers(), { future: true });
    expect(adapter.sent.at(-1)!.text).toBe("❌ Coding session #1 failed: coding agent exited with code 1. Nothing was pushed.");

    runner.imageMissing = true;
    agentAnswer = (_req, n) => (n % 2 === 1 ? startTool({ title: "Second try" }) : reply("ok"));
    const thread2 = await requestSession();
    await command("@Heinzel !go", thread2);
    await drain(db, queue, engine.handlers());
    expect(adapter.sent.at(-1)!.text).toMatch(/^❌ Coding session #2 could not start: Coding image "heinzel-coder:latest" not found/);
  });

  it("expires unconfirmed sessions and lists sessions", async () => {
    const thread = await requestSession();
    await db.query(`UPDATE coding_sessions SET created_at = now() - interval '1 hour'`);
    await engine.coding!.maintain();
    expect((await sessions.get(1))!.status).toBe("expired");
    expect(await command("@Heinzel !go", thread)).toBe("There is no coding session waiting for confirmation in this thread.");
    expect(await command("@Heinzel !coding", thread)).toBe("*Coding sessions*\n#1 ⌛ expired · team/api · Fix login redirect");
  });
});
