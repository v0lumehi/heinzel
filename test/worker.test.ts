import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { JobQueue } from "../src/queue/queue.js";
import { Worker, type JobHandlers } from "../src/queue/worker.js";
import { TEST_DATABASE_URL, freshDb, silentLog } from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("Worker", () => {
  let db: Db;
  let queue: JobQueue;

  beforeAll(async () => {
    db = await freshDb();
    queue = new JobQueue(db);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("runs jobs as soon as they are queued, retries failures with backoff and stops cleanly", async () => {
    const seen: number[] = [];
    const handlers = {
      respond: async (p: { eventId: number }) => {
        seen.push(p.eventId);
      },
      triage: async () => {
        throw new Error("model unavailable");
      },
    } as unknown as JobHandlers;
    const worker = new Worker(queue, handlers, silentLog, { concurrency: 2, pollIntervalMs: 60_000 });
    await worker.start();

    // The long poll interval proves the LISTEN/NOTIFY wake-up works.
    await queue.enqueue("respond", { eventId: 1, mode: "direct" });
    await queue.enqueue("respond", { eventId: 2, mode: "direct" });
    const failing = await queue.enqueue("triage", { eventId: 3, botInThread: false }, { maxAttempts: 2 });
    await expect.poll(() => seen.sort(), { timeout: 5000 }).toEqual([1, 2]);

    await expect
      .poll(async () => (await db.query("SELECT status, attempts, last_error, run_at > now() AS later FROM jobs WHERE id = $1", [failing])).rows[0], { timeout: 5000 })
      .toMatchObject({ status: "queued", attempts: 1, later: true, last_error: expect.stringContaining("model unavailable") });
    const done = await db.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'done'");
    expect(done.rows[0].n).toBe(2);

    await worker.stop();
  });
});
