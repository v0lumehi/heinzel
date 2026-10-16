import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore, ORG_SCOPE_KEY } from "../src/memory/memory.js";
import { JobQueue } from "../src/queue/queue.js";
import { Store } from "../src/store/store.js";
import { TEST_DATABASE_URL, freshDb, msg } from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("database", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.end();
  });

  it("migrations are idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("queue: claims each job once, dedupes, retries with backoff and fails after max attempts", async () => {
    const q = new JobQueue(db);
    const a = await q.enqueue("triage", { eventId: 1, botInThread: false });
    const b = await q.enqueue("triage", { eventId: 2, botInThread: false });
    expect(a).not.toBeNull();

    const claimed = await Promise.all([q.claim(), q.claim(), q.claim()]);
    const ids = claimed.filter(Boolean).map((j) => j!.id).sort();
    expect(ids).toEqual([a, b].sort());

    expect(await q.enqueue("followup", { channelKey: "slack:C", threadRef: "t", note: "n", scheduledAfterEventId: 1 }, { dedupeKey: "k" })).not.toBeNull();
    expect(await q.enqueue("followup", { channelKey: "slack:C", threadRef: "t", note: "n", scheduledAfterEventId: 1 }, { dedupeKey: "k" })).toBeNull();
    expect(await q.cancelByDedupeKey("k")).toBe(1);
    expect(await q.enqueue("followup", { channelKey: "slack:C", threadRef: "t", note: "n", scheduledAfterEventId: 1 }, { dedupeKey: "k" })).not.toBeNull();
    await q.cancelByDedupeKey("k");

    const job = claimed.find((j) => j?.id === a)!;
    expect(await q.fail(job, new Error("boom"))).toBe("retry");
    expect(await q.claim()).toBeNull(); // backoff: not due yet
    await db.query(`UPDATE jobs SET run_at = now(), attempts = max_attempts - 1 WHERE id = $1`, [a]);
    const again = (await q.claim())!;
    expect(again.id).toBe(a);
    expect(await q.fail(again, "boom")).toBe("failed");
    await q.complete(b!);
    const { rows } = await db.query(`SELECT id, status FROM jobs WHERE id = ANY($1) ORDER BY id`, [[a, b]]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "done"]);
  });

  it("queue: future jobs wait and stale running jobs are recovered", async () => {
    const q = new JobQueue(db);
    const id = await q.enqueue("triage", { eventId: 9, botInThread: false }, { runAt: new Date(Date.now() + 60_000) });
    expect(await q.claim()).toBeNull();
    await db.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);
    const j = (await q.claim())!;
    await db.query(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1`, [j.id]);
    expect(await q.recoverStale(10)).toBe(1);
    expect((await q.claim())?.id).toBe(id);
  });

  it("store: dedupes events and tracks budgets", async () => {
    const s = new Store(db);
    await s.ensureChannel("slack", "C1", "general", false);
    const e = msg({ messageId: "x1" });
    expect(await s.insertEvent(e)).not.toBeNull();
    expect(await s.insertEvent(e)).toBeNull();
    await s.recordBotPost("slack:C1", "x1", "b1", "ambient");
    await s.recordBotPost("slack:C1", "x1", "b2", "reply");
    expect(await s.unsolicitedPostsLast24h("slack:C1")).toBe(1);
    expect(await s.botParticipatedInThread("slack:C1", "x1")).toBe(true);
    expect(await s.botParticipatedInThread("slack:C1", "other")).toBe(false);
    const ch = await s.updateChannel("slack:C1", { ambientEnabled: true, dailyUnsolicitedLimit: 2 });
    expect(ch).toMatchObject({ ambientEnabled: true, dailyUnsolicitedLimit: 2, name: "general" });
    expect((await s.updateChannel("slack:C1", { dailyUnsolicitedLimit: null })).dailyUnsolicitedLimit).toBeNull();
    expect((await s.ensureChannel("slack", "C1", undefined, false)).ambientEnabled).toBe(true); // existing settings survive
  });

  it("housekeeping: prunes old events only when retention is set, and old finished jobs", async () => {
    const s = new Store(db);
    const m = new MemoryStore(db);
    await s.ensureChannel("slack", "CR", "retention", false);
    const old = (await s.insertEvent(msg({ channelId: "CR", messageId: "old", sentAt: new Date(Date.now() - 40 * 86_400_000) })))!;
    await s.insertEvent(msg({ channelId: "CR", messageId: "new" }));
    const mem = await m.add({ scope: "channel", scopeKey: "slack:CR", content: "Old but important fact.", createdBy: "agent", sourceEvent: old.id });
    await db.query(`INSERT INTO jobs (kind, payload, status, finished_at) VALUES ('triage', '{}', 'done', now() - interval '8 days')`);

    const keepAll = await s.pruneOldData(0);
    expect(keepAll.events).toBe(0);
    expect(keepAll.jobs).toBeGreaterThanOrEqual(1); // finished jobs are pruned regardless of event retention
    expect((await s.pruneOldData(30)).events).toBe(1);
    const left = await db.query(`SELECT message_ref FROM events WHERE channel_key = 'slack:CR'`);
    expect(left.rows).toEqual([{ message_ref: "new" }]);
    const kept = await db.query(`SELECT source_event FROM memories WHERE id = $1`, [mem.id]);
    expect(kept.rows).toEqual([{ source_event: null }]);
  });

  it("memory: scoped full-text recall, dedupe and forget", async () => {
    const m = new MemoryStore(db);
    const a = await m.add({ scope: "channel", scopeKey: "slack:C1", content: "Deployments go through ArgoCD, owner is Team Opal.", createdBy: "agent" });
    const dup = await m.add({ scope: "channel", scopeKey: "slack:C1", content: "deployments go through argocd, owner is team opal.", createdBy: "agent" });
    expect(dup.id).toBe(a.id);
    await m.add({ scope: "org", scopeKey: ORG_SCOPE_KEY, content: "Company holidays are listed in Confluence.", createdBy: "agent" });
    await m.add({ scope: "channel", scopeKey: "slack:C2", content: "ArgoCD is not used in this other channel.", createdBy: "agent" });

    const scopes = [{ scope: "channel" as const, scopeKey: "slack:C1" }, { scope: "org" as const, scopeKey: ORG_SCOPE_KEY }];
    const hits = await m.search({ scopes, text: "how does argocd deployment work?" });
    expect(hits.map((h) => h.content)).toEqual(["Deployments go through ArgoCD, owner is Team Opal."]);
    expect((await m.search({ scopes })).length).toBe(2);
    expect(await m.search({ scopes, text: "?!" })).toHaveLength(2);
    expect(await m.forget(a.id, [{ scope: "channel", scopeKey: "slack:C2" }])).toBe(false);
    expect(await m.forget(a.id, scopes)).toBe(true);
  });
});
