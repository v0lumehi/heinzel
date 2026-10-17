import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { roleFromClaims } from "../src/admin/auth.js";
import { buildAdminServer } from "../src/admin/server.js";
import type { ChannelDetailResponse, ChannelRow, MeResponse } from "../src/admin/types.js";
import type { Db } from "../src/db/pool.js";
import { MemoryStore } from "../src/memory/memory.js";
import { AdminSessionStore } from "../src/store/admin.js";
import { Store } from "../src/store/store.js";
import { TEST_DATABASE_URL, freshDb, msg, silentLog, testConfig } from "./helpers.js";

describe("roleFromClaims", () => {
  const map = (claims: Record<string, unknown>) => roleFromClaims(claims, "roles", ["Heinzel.Admin"], ["Heinzel.Viewer"]);
  it("maps app roles, admin first, and refuses everyone else", () => {
    expect(map({ roles: ["Heinzel.Viewer", "Heinzel.Admin"] })).toBe("admin");
    expect(map({ roles: ["Heinzel.Viewer"] })).toBe("viewer");
    expect(map({ roles: "Heinzel.Admin" })).toBe("admin");
    expect(map({ roles: ["Other"] })).toBeNull();
    expect(map({})).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("admin server", () => {
  let db: Db;
  let store: Store;
  let memory: MemoryStore;
  let sessions: AdminSessionStore;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await freshDb();
    store = new Store(db);
    memory = new MemoryStore(db);
    sessions = new AdminSessionStore(db);
    const staticDir = mkdtempSync(join(tmpdir(), "heinzel-web-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>app shell</title>");
    app = await buildAdminServer({
      config: testConfig({ ADMIN_DEV_LOGIN: "true", AMBIENT_DAILY_LIMIT: "5" }),
      store,
      memory,
      sessions,
      tools: () => ({ builtin: ["remember"], servers: [{ server: "search", tools: [{ name: "searxng_web_search", exposedAs: "search__searxng_web_search" }] }] }),
      log: silentLog,
      staticDir,
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE channels, events, memories, audit_log, admin_sessions, llm_usage RESTART IDENTITY CASCADE");
    await store.ensureChannel("slack", "C1", "general", false);
    await store.insertEvent(msg());
  });

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const res = await app.inject({ method: "POST", url: "/auth/dev-login" });
    expect(res.statusCode).toBe(200);
    const cookie = `heinzel_session=${res.cookies.find((c) => c.name === "heinzel_session")!.value}`;
    const me = (await app.inject({ url: "/api/me", headers: { cookie } })).json<MeResponse>();
    return { cookie, csrf: me.csrfToken! };
  }

  it("requires a session for the API and tells the UI how to sign in", async () => {
    expect((await app.inject({ url: "/api/channels" })).statusCode).toBe(401);
    const me = (await app.inject({ url: "/api/me" })).json<MeResponse>();
    expect(me).toMatchObject({ user: null, csrfToken: null, login: { oidc: false, dev: true } });
  });

  it("lists channels and updates them with CSRF protection and an audit entry", async () => {
    const { cookie, csrf } = await signIn();
    const list = (await app.inject({ url: "/api/channels", headers: { cookie } })).json<ChannelRow[]>();
    expect(list).toMatchObject([{ channelKey: "slack:C1", name: "general", ambientEnabled: false }]);

    const body = { ambientEnabled: true, dailyUnsolicitedLimit: 3, instructions: "Answer in German." };
    const noCsrf = await app.inject({ method: "PATCH", url: "/api/channels/slack%3AC1", headers: { cookie }, payload: body });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({ method: "PATCH", url: "/api/channels/slack%3AC1", headers: { cookie, "x-csrf-token": csrf }, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(await store.getChannel("slack:C1")).toMatchObject({ ambientEnabled: true, dailyUnsolicitedLimit: 3, instructions: "Answer in German." });

    const reset = await app.inject({ method: "PATCH", url: "/api/channels/slack%3AC1", headers: { cookie, "x-csrf-token": csrf }, payload: { dailyUnsolicitedLimit: null } });
    expect(reset.json<ChannelRow>().dailyUnsolicitedLimit).toBeNull();

    const bad = await app.inject({ method: "PATCH", url: "/api/channels/slack%3AC1", headers: { cookie, "x-csrf-token": csrf }, payload: { dailyUnsolicitedLimit: -1 } });
    expect(bad.statusCode).toBe(400);

    const detail = (await app.inject({ url: "/api/channels/slack%3AC1", headers: { cookie } })).json<ChannelDetailResponse>();
    expect(detail.audit.map((a) => a.action)).toEqual(["channel.update", "channel.update"]);
    expect(detail.audit[1]).toMatchObject({ actor: "admin:dev", details: { ambientEnabled: { from: false, to: true } } });
  });

  it("lets viewers read but not change anything", async () => {
    const id = await sessions.create({ subject: "v1", name: "Vera", role: "viewer", ttlHours: 1 });
    const cookie = `heinzel_session=${id}`;
    const me = (await app.inject({ url: "/api/me", headers: { cookie } })).json<MeResponse>();
    expect(me.user).toMatchObject({ name: "Vera", role: "viewer" });
    expect((await app.inject({ url: "/api/channels", headers: { cookie } })).statusCode).toBe(200);
    const res = await app.inject({ method: "PATCH", url: "/api/channels/slack%3AC1", headers: { cookie, "x-csrf-token": me.csrfToken! }, payload: { ambientEnabled: true } });
    expect(res.statusCode).toBe(403);
  });

  it("searches and deletes memories, and records what was deleted", async () => {
    const { cookie, csrf } = await signIn();
    const m = await memory.add({ scope: "channel", scopeKey: "slack:C1", content: "Deploys happen on Tuesdays", createdBy: "agent" });
    await memory.add({ scope: "org", scopeKey: "*", content: "The company is called ACME", createdBy: "agent" });

    const found = (await app.inject({ url: "/api/memories?q=tuesday", headers: { cookie } })).json<{ id: number; channelName: string }[]>();
    expect(found).toMatchObject([{ id: m.id, channelName: "general" }]);

    const del = await app.inject({ method: "DELETE", url: `/api/memories/${m.id}`, headers: { cookie, "x-csrf-token": csrf } });
    expect(del.statusCode).toBe(200);
    expect(await memory.list()).toHaveLength(1);
    const audit = await store.listAudit({ target: "slack:C1" });
    expect(audit[0]).toMatchObject({ action: "memory.delete", details: { content: "Deploys happen on Tuesdays" } });
    expect((await app.inject({ method: "DELETE", url: `/api/memories/${m.id}`, headers: { cookie, "x-csrf-token": csrf } })).statusCode).toBe(404);
  });

  it("signs out by deleting the session", async () => {
    const { cookie, csrf } = await signIn();
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, "x-csrf-token": csrf } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/channels", headers: { cookie } })).statusCode).toBe(401);
  });

  it("serves the web UI for client-side routes, with security headers", async () => {
    const res = await app.inject({ url: "/channels/slack%3AC1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("app shell");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await app.inject({ url: "/api/nope" })).statusCode).toBe(404);
  });
});
