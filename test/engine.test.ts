import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/core/engine.js";
import type { Platform } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import type { LlmRequest, LlmResponse } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/memory.js";
import { JobQueue } from "../src/queue/queue.js";
import type { JobHandlers } from "../src/queue/worker.js";
import { Store } from "../src/store/store.js";
import { FakeAdapter, FakeLlm, TEST_DATABASE_URL, freshDb, msg, reply, silentLog, testConfig } from "./helpers.js";

/** Runs every due job synchronously, like the worker would. */
async function drain(queue: JobQueue, handlers: JobHandlers): Promise<number> {
  let n = 0;
  for (;;) {
    const job = await queue.claim();
    if (!job) return n;
    const h = handlers[job.kind] as (p: unknown, j: unknown) => Promise<void>;
    await h(job.payload, job);
    await queue.complete(job.id);
    n++;
  }
}

const triage = (d: object): LlmResponse => reply(JSON.stringify({ memory: "", follow_up_hours: 0, reason: "", ...d }));

describe.skipIf(!TEST_DATABASE_URL)("engine", () => {
  let db: Db;
  let adapter: FakeAdapter;
  let llm: FakeLlm;
  let queue: JobQueue;
  let store: Store;
  let engine: Engine;
  let agentAnswer: (req: LlmRequest, n: number) => LlmResponse;
  let triageAnswer: (req: LlmRequest) => LlmResponse;

  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE channels, events, jobs, memories, bot_posts, llm_usage RESTART IDENTITY CASCADE");
    adapter = new FakeAdapter();
    agentAnswer = () => reply("Here is the answer.");
    triageAnswer = () => triage({ action: "ignore", confidence: 1 });
    llm = new FakeLlm((req, n) => (req.model === "triage-model" ? triageAnswer(req) : agentAnswer(req, n)));
    queue = new JobQueue(db);
    store = new Store(db);
    engine = new Engine({
      config: testConfig({ AMBIENT_DAILY_LIMIT: "2" }),
      store,
      memory: new MemoryStore(db),
      queue,
      llm,
      adapters: new Map<Platform, typeof adapter>([["slack", adapter]]),
      log: silentLog,
    });
  });

  it("answers a mention in the thread and acknowledges it", async () => {
    const m = msg({ text: "@Heinzel how do we deploy?", mentionsBot: true });
    adapter.history.push(m);
    await engine.handleIncoming(m);
    expect(adapter.acks).toEqual([m.messageId]);
    await drain(queue, engine.handlers());

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({ channelId: "C1", threadId: m.messageId, text: "Here is the answer." });
    const agentReq = llm.byModel("agent-model")[0]!;
    expect(agentReq.meta).toMatchObject({ channelKey: "slack:C1", purpose: "agent" });
    expect(JSON.stringify(agentReq.messages)).toContain("Anna: how do we deploy?");
    const { rows } = await db.query("SELECT kind FROM bot_posts");
    expect(rows).toEqual([{ kind: "reply" }]);
  });

  it("ignores duplicate deliveries", async () => {
    const m = msg({ mentionsBot: true });
    await engine.handleIncoming(m);
    await engine.handleIncoming(m);
    expect(await drain(queue, engine.handlers())).toBe(1);
  });

  it("answers DMs top-level", async () => {
    const m = msg({ channelId: "D1", isDirect: true, text: "what's the on-call rotation?" });
    await engine.handleIncoming(m);
    await drain(queue, engine.handlers());
    expect(adapter.sent[0]).toMatchObject({ channelId: "D1", threadId: adapter.sent[0]!.messageId });
  });

  it("handles admin commands without calling the LLM", async () => {
    await engine.handleIncoming(msg({ text: "@Heinzel !ambient on", mentionsBot: true }));
    expect((await store.getChannel("slack:C1"))?.ambientEnabled).toBe(true);
    await engine.handleIncoming(msg({ text: "@Heinzel !instructions Always answer in German.", mentionsBot: true }));
    expect((await store.getChannel("slack:C1"))?.instructions).toBe("Always answer in German.");
    await engine.handleIncoming(msg({ text: "@Heinzel !status", mentionsBot: true }));
    expect(adapter.sent.map((s) => s.text).join("\n")).toMatch(/Ambient mode is \*on\*[\s\S]*Ambient mode: on/);
    expect(llm.requests).toHaveLength(0);
    expect(await drain(queue, engine.handlers())).toBe(0);
  });

  it("does not triage unaddressed messages while ambient mode is off", async () => {
    await engine.handleIncoming(msg({ text: "Who owns the billing service again?" }));
    expect(await drain(queue, engine.handlers())).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it("ambient: speaks up when triage is confident, within the daily budget", async () => {
    await engine.handleIncoming(msg({ text: "@Heinzel !ambient on", mentionsBot: true }));
    adapter.sent.length = 0;
    triageAnswer = () => triage({ action: "reply", confidence: 0.9, reason: "open question about ownership" });
    agentAnswer = () => reply("Team Opal owns billing.");

    for (let i = 0; i < 3; i++) {
      const m = msg({ text: `Who owns the billing service? (${i})` });
      adapter.history.push(m);
      await engine.handleIncoming(m);
      await drain(queue, engine.handlers());
    }
    // Limit is 2 per day: the third question gets triaged but not answered.
    expect(adapter.sent.map((s) => s.text)).toEqual(["Team Opal owns billing.", "Team Opal owns billing."]);
    expect(llm.byModel("triage-model")).toHaveLength(3);
    expect(llm.byModel("agent-model")).toHaveLength(2);
    const system = String(llm.byModel("agent-model")[0]!.messages[0]!.content);
    expect(system).toContain("open question about ownership");
  });

  it("ambient: stays quiet on low confidence, pre-filtered chatter and SILENT answers", async () => {
    await engine.handleIncoming(msg({ text: "@Heinzel !ambient on", mentionsBot: true }));
    adapter.sent.length = 0;

    triageAnswer = () => triage({ action: "reply", confidence: 0.5 });
    await engine.handleIncoming(msg({ text: "Is the staging cluster down for anyone else?" }));
    await engine.handleIncoming(msg({ text: "ok 👍" }));
    await drain(queue, engine.handlers());
    expect(llm.byModel("triage-model")).toHaveLength(1);

    triageAnswer = () => triage({ action: "reply", confidence: 0.95 });
    agentAnswer = () => reply("SILENT");
    await engine.handleIncoming(msg({ text: "Is the production cluster down for anyone else?" }));
    await drain(queue, engine.handlers());
    expect(adapter.sent).toHaveLength(0);
  });

  it("ambient: stores memories suggested by triage", async () => {
    await engine.handleIncoming(msg({ text: "@Heinzel !ambient on", mentionsBot: true }));
    triageAnswer = () => triage({ action: "remember", confidence: 0.8, memory: "Release freeze starts every last Friday of the month." });
    await engine.handleIncoming(msg({ text: "Reminder: release freeze is every last Friday of the month." }));
    await drain(queue, engine.handlers());
    const { rows } = await db.query("SELECT scope, scope_key, content, created_by FROM memories");
    expect(rows).toEqual([{ scope: "channel", scope_key: "slack:C1", content: "Release freeze starts every last Friday of the month.", created_by: "triage" }]);
  });

  it("follows threads it took part in even with ambient mode off", async () => {
    const root = msg({ text: "@Heinzel can you check the deploy?", mentionsBot: true });
    adapter.history.push(root);
    await engine.handleIncoming(root);
    await drain(queue, engine.handlers());
    expect(adapter.sent).toHaveLength(1);

    triageAnswer = () => triage({ action: "reply", confidence: 0.9, reason: "follow-up question to Heinzel" });
    agentAnswer = () => reply("It finished at 10:02.");
    const followUp = msg({ text: "and when did it finish?", threadId: root.messageId });
    adapter.history.push(followUp);
    await engine.handleIncoming(followUp);
    await drain(queue, engine.handlers());

    expect(adapter.sent.map((s) => s.text)).toEqual(["Here is the answer.", "It finished at 10:02."]);
    expect(adapter.sent[1]!.threadId).toBe(root.messageId);
    const { rows } = await db.query("SELECT kind FROM bot_posts ORDER BY id");
    expect(rows.map((r) => r.kind)).toEqual(["reply", "reply"]); // in-thread replies don't eat the ambient budget
  });

  it("schedules a follow-up via tool and posts it when due", async () => {
    const m = msg({ text: "@Heinzel I'll fix the flaky test by tomorrow", mentionsBot: true });
    adapter.history.push(m);
    agentAnswer = (_req, n) =>
      n === 1
        ? reply("", [{ id: "f1", name: "schedule_followup", arguments: JSON.stringify({ hours: 24, note: "check flaky test fix" }) }])
        : n === 2
          ? reply("Great, I'll check back tomorrow.")
          : reply("@Anna did the flaky test fix land?");
    await engine.handleIncoming(m);
    await drain(queue, engine.handlers());
    expect(adapter.sent.map((s) => s.text)).toEqual(["Great, I'll check back tomorrow."]);

    const { rows } = await db.query("SELECT kind, run_at > now() + interval '23 hours' AS later FROM jobs WHERE status = 'queued'");
    expect(rows).toEqual([{ kind: "followup", later: true }]);
    await db.query("UPDATE jobs SET run_at = now() WHERE status = 'queued'");
    await drain(queue, engine.handlers());

    expect(adapter.sent.map((s) => s.text)).toEqual(["Great, I'll check back tomorrow.", "@Anna did the flaky test fix land?"]);
    const system = String(llm.byModel("agent-model").at(-1)!.messages[0]!.content);
    expect(system).toContain("check flaky test fix");
    const posts = await db.query("SELECT kind FROM bot_posts ORDER BY id");
    expect(posts.rows.map((r) => r.kind)).toEqual(["reply", "followup"]);
  });

  it("never reacts to other bots", async () => {
    await engine.handleIncoming(msg({ text: "@Heinzel deploy now", mentionsBot: true, isBot: true }));
    expect(await drain(queue, engine.handlers())).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("engine: heavy model", () => {
  let db: Db;
  let adapter: FakeAdapter;
  let llm: FakeLlm;
  let queue: JobQueue;
  let respond: (req: LlmRequest, n: number) => LlmResponse;

  const make = (overrides: Record<string, string> = {}) =>
    new Engine({
      config: testConfig({ LLM_MODEL_HEAVY: "heavy-model", HEAVY_DAILY_LIMIT: "1", ...overrides }),
      store: new Store(db),
      memory: new MemoryStore(db),
      queue,
      llm,
      adapters: new Map<Platform, typeof adapter>([["slack", adapter]]),
      log: silentLog,
    });

  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE channels, events, jobs, memories, bot_posts, llm_usage RESTART IDENTITY CASCADE");
    adapter = new FakeAdapter();
    respond = () => reply("ok");
    llm = new FakeLlm((req, n) => respond(req, n));
    queue = new JobQueue(db);
  });

  const toolNames = (req: LlmRequest) => (req.tools ?? []).map((t) => (t.type === "function" ? t.function.name : ""));

  it("lets the agent escalate to the heavy model, once per budget", async () => {
    const engine = make();
    respond = (req) =>
      req.model === "agent-model"
        ? toolNames(req).includes("escalate")
          ? reply("", [{ id: "e", name: "escalate", arguments: '{"reason":"needs a migration plan"}' }])
          : reply("default answer")
        : reply("heavy answer");

    await engine.handleIncoming(msg({ text: "@Heinzel plan the Postgres 16 → 17 migration", mentionsBot: true }));
    await drain(queue, engine.handlers());
    expect(adapter.sent.map((s) => s.text)).toEqual(["heavy answer"]);
    const heavyReq = llm.byModel("heavy-model")[0]!;
    expect(toolNames(heavyReq)).not.toContain("escalate");
    expect(String(heavyReq.messages[0]!.content)).toContain("needs a migration plan");
    expect(heavyReq.meta).toMatchObject({ purpose: "agent_heavy" });

    // Budget of 1 heavy run per day is used up: escalate is no longer offered.
    await engine.handleIncoming(msg({ text: "@Heinzel and the rollback plan?", mentionsBot: true }));
    await drain(queue, engine.handlers());
    expect(adapter.sent.map((s) => s.text)).toEqual(["heavy answer", "default answer"]);
    expect(llm.byModel("heavy-model")).toHaveLength(1);
  });

  it("routes !deep straight to the heavy model and strips the prefix", async () => {
    const engine = make();
    respond = (req) => reply(req.model === "heavy-model" ? "deep answer" : "shallow");
    const m = msg({ text: "@Heinzel !deep compare event sourcing and CRUD for billing", mentionsBot: true });
    adapter.history.push(m);
    await engine.handleIncoming(m);
    expect(adapter.acks).toEqual([m.messageId]);
    await drain(queue, engine.handlers());
    expect(adapter.sent.map((s) => s.text)).toEqual(["deep answer"]);
    expect(llm.byModel("agent-model")).toHaveLength(0);
    const transcript = JSON.stringify(llm.byModel("heavy-model")[0]!.messages);
    expect(transcript).toContain("Anna: compare event sourcing and CRUD for billing");
    expect(transcript).not.toContain("!deep");
  });

  it("routes complex ambient questions to the heavy model via triage", async () => {
    const engine = make();
    await engine.handleIncoming(msg({ text: "@Heinzel !ambient on", mentionsBot: true }));
    respond = (req) =>
      req.model === "triage-model"
        ? triage({ action: "reply", confidence: 0.9, complexity: "complex", reason: "architecture question" })
        : reply(req.model === "heavy-model" ? "thorough answer" : "quick answer");
    await engine.handleIncoming(msg({ text: "Should we split the monolith's billing module into its own service?" }));
    await drain(queue, engine.handlers());
    expect(adapter.sent.at(-1)?.text).toBe("thorough answer");
  });

  it("offers no escalation and ignores !deep routing when no heavy model is configured", async () => {
    const engine = make({ LLM_MODEL_HEAVY: "" });
    respond = () => reply("default answer");
    await engine.handleIncoming(msg({ text: "@Heinzel !deep hard question", mentionsBot: true }));
    await engine.handleIncoming(msg({ text: "@Heinzel another question", mentionsBot: true }));
    await drain(queue, engine.handlers());
    expect(adapter.sent.map((s) => s.text)).toEqual(["default answer", "default answer"]);
    for (const req of llm.requests) {
      expect(req.model).toBe("agent-model");
      expect(toolNames(req)).not.toContain("escalate");
    }
  });
});
