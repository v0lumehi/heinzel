import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { createPool } from "../src/db/pool.js";
import { HealthServer } from "../src/health.js";
import { TEST_DATABASE_URL } from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("health server", () => {
  let db: Db;
  let health: HealthServer;
  let base: string;

  beforeAll(async () => {
    db = createPool(TEST_DATABASE_URL!);
    health = new HealthServer(db);
    await health.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${health.address}`;
  });
  afterAll(async () => {
    await health.close();
    await db.end();
  });

  it("is live at once, ready only after startup and not while shutting down", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    health.setReady(true);
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: "ready" });
    health.setReady(false);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
