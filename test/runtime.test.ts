import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SettingsError, RuntimeConfig } from "../src/core/runtime.js";
import { SecretBox } from "../src/crypto.js";
import type { Db } from "../src/db/pool.js";
import { McpHub, type TransportFactory } from "../src/mcp/hub.js";
import { SettingsStore } from "../src/store/settings.js";
import { Store } from "../src/store/store.js";
import { TEST_DATABASE_URL, freshDb, silentLog, testConfig } from "./helpers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("SecretBox", () => {
  it("round-trips, uses a fresh IV each time and detects tampering", () => {
    const box = new SecretBox(KEY);
    const a = box.seal("Bearer glpat-secret");
    expect(a).not.toContain("glpat");
    expect(box.seal("Bearer glpat-secret")).not.toBe(a);
    expect(box.open(a)).toBe("Bearer glpat-secret");
    const parts = a.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => box.open(parts.join(":"))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

/** Every connection gets a fresh in-memory MCP server with one tool. */
const factory: TransportFactory = () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const mcp = new McpServer({ name: "fake", version: "1.0.0" });
  mcp.registerTool("lookup", { description: "Look something up", inputSchema: { q: z.string() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  void mcp.connect(server);
  return client;
};

describe.skipIf(!TEST_DATABASE_URL)("RuntimeConfig", () => {
  let db: Db;
  let store: Store;
  let settings: SettingsStore;
  const runtimes: RuntimeConfig[] = [];
  const who = { actor: "admin:anna", actorName: "Anna" };

  beforeAll(async () => {
    db = await freshDb();
    store = new Store(db);
    settings = new SettingsStore(db);
  });
  afterAll(async () => {
    for (const r of runtimes) await r.stop();
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE settings, mcp_servers, audit_log");
  });

  async function setup(env: Record<string, string> = {}, opts: { secrets?: boolean; fileServers?: boolean } = {}) {
    const config = testConfig(env);
    const mcp = new McpHub({ log: silentLog, maxResultChars: 1000, transportFactory: factory });
    const runtime = new RuntimeConfig({
      config,
      env: { LLM_MODEL_AGENT: "agent-model", ...env },
      db,
      settings,
      store,
      mcp,
      fileServers: opts.fileServers ? { search: { url: "http://search/mcp", headers: {}, exclude: [], enabled: true, timeoutMs: 5000 } } : {},
      secrets: opts.secrets === false ? null : new SecretBox(KEY),
      log: silentLog,
      testHub: () => new McpHub({ log: silentLog, maxResultChars: 1000, transportFactory: factory }),
    });
    await runtime.start();
    runtimes.push(runtime);
    return { config, mcp, runtime };
  }

  it("applies settings live, records them and returns to the deployment value on reset", async () => {
    const { config, runtime } = await setup();
    expect(config.AMBIENT_DAILY_LIMIT).toBe(5);
    await runtime.updateSetting("AMBIENT_DAILY_LIMIT", "9", who);
    await runtime.updateSetting("LLM_MODEL_AGENT", "better-model", who);
    expect(config.AMBIENT_DAILY_LIMIT).toBe(9);
    expect(config.LLM_MODEL_AGENT).toBe("better-model");

    const view = runtime.settings();
    expect(view.find((s) => s.key === "AMBIENT_DAILY_LIMIT")).toMatchObject({ value: "9", source: "admin", deploymentValue: "5", updatedBy: "admin:anna" });
    expect(view.find((s) => s.key === "AMBIENT_MIN_CONFIDENCE")).toMatchObject({ source: "default" });
    expect(view.find((s) => s.key === "LLM_MODEL_TRIAGE")).toMatchObject({ source: "default" });

    await runtime.updateSetting("AMBIENT_DAILY_LIMIT", null, who);
    expect(config.AMBIENT_DAILY_LIMIT).toBe(5);
    const audit = await store.listAudit();
    expect(audit.map((a) => a.action)).toEqual(["setting.update", "setting.update", "setting.update"]);
    expect(audit[2]).toMatchObject({ target: "setting:AMBIENT_DAILY_LIMIT", details: { from: "5", to: "9" } });
  });

  it("refuses invalid values, unknown keys and locked settings", async () => {
    const { config, runtime } = await setup({ LOCKED_SETTINGS: "LLM_MODEL_AGENT" });
    await expect(runtime.updateSetting("AMBIENT_MIN_CONFIDENCE", "2", who)).rejects.toThrow(SettingsError);
    await expect(runtime.updateSetting("DATABASE_URL", "postgres://evil", who)).rejects.toThrow(/cannot be changed/);
    await expect(runtime.updateSetting("LLM_MODEL_AGENT", "x", who)).rejects.toThrow(/locked/);
    expect(runtime.settings().find((s) => s.key === "LLM_MODEL_AGENT")).toMatchObject({ locked: true, source: "deployment" });

    // A value stored before the lock is ignored once the setting is locked.
    await settings.set("LLM_MODEL_AGENT", "sneaky", "admin:x");
    await runtime.reload();
    expect(config.LLM_MODEL_AGENT).toBe("agent-model");
  });

  it("stores MCP servers with encrypted headers, connects them and never returns the secrets", async () => {
    const { mcp, runtime } = await setup({}, { fileServers: true });
    const input = { name: "jira", url: "http://jira/mcp", headers: { Authorization: "Basic s3cret" }, tools: null, exclude: [], enabled: true, timeoutMs: 5000 };

    const test = await runtime.testMcpServer(input);
    expect(test.tools.map((t) => t.exposedAs)).toEqual(["jira__lookup"]);

    await runtime.saveMcpServer(input, who);
    const { rows } = await db.query("SELECT headers_enc, header_names FROM mcp_servers");
    expect(rows[0].header_names).toEqual(["Authorization"]);
    expect(rows[0].headers_enc).not.toContain("s3cret");
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(["jira__lookup", "search__lookup"]);

    const listed = await runtime.mcpServers();
    expect(listed.map((s) => [s.name, s.source])).toEqual([["jira", "admin"], ["search", "deployment"]]);
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    const audit = await store.listAudit({ target: "mcp:jira" });
    expect(JSON.stringify(audit)).not.toContain("s3cret");

    // An empty header value keeps the stored secret.
    await runtime.saveMcpServer({ ...input, headers: { Authorization: "" }, exclude: ["lookup"] }, who);
    expect(mcp.tools.map((t) => t.name)).toEqual(["search__lookup"]);
    await runtime.saveMcpServer({ ...input, exclude: [] }, who);

    await expect(runtime.saveMcpServer({ ...input, name: "search" }, who)).rejects.toThrow(/deployment/);
    await expect(runtime.saveMcpServer({ ...input, name: "web" }, who)).rejects.toThrow(/built-in/);

    expect(await runtime.deleteMcpServer("jira", who)).toBe(true);
    expect(mcp.tools.map((t) => t.name)).toEqual(["search__lookup"]);
  });

  it("needs SECRETS_KEY to store headers", async () => {
    const { runtime } = await setup({}, { secrets: false });
    const input = { name: "jira", url: "http://jira/mcp", headers: { Authorization: "x" }, tools: null, exclude: [], enabled: true, timeoutMs: 5000 };
    await expect(runtime.saveMcpServer(input, who)).rejects.toThrow(/SECRETS_KEY/);
    await runtime.saveMcpServer({ ...input, headers: {} }, who);
  });

  it("follows changes made by another replica", async () => {
    const a = await setup();
    const b = await setup();
    await a.runtime.updateSetting("CONTEXT_MESSAGES", "12", who);
    await expect.poll(() => b.config.CONTEXT_MESSAGES, { timeout: 3000 }).toBe(12);
  });
});
