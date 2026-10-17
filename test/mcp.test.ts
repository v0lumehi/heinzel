import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolContext } from "../src/agent/tools.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { matchesPattern, parseMcpConfig, toolAllowed } from "../src/mcp/config.js";
import { exposedToolName, formatToolResult, McpHub, type TransportFactory } from "../src/mcp/hub.js";
import { silentLog } from "./helpers.js";

describe("parseMcpConfig", () => {
  const env = { GITLAB_TOKEN: "glpat-x", JIRA_AUTH: "Basic abc" };

  it("parses stdio and http servers, fills defaults and resolves ${VAR}", () => {
    const servers = parseMcpConfig(
      {
        mcpServers: {
          gitlab: { command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_TOKEN}" } },
          jira: { url: "https://mcp.atlassian.com/v1/mcp", headers: { Authorization: "${JIRA_AUTH}" }, tools: ["get*"] },
        },
      },
      env,
    );
    expect(servers.gitlab).toMatchObject({ command: "npx", env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-x" }, exclude: [], timeoutMs: 60_000 });
    expect(servers.jira).toMatchObject({ url: "https://mcp.atlassian.com/v1/mcp", headers: { Authorization: "Basic abc" }, tools: ["get*"] });
  });

  it("resolves variables before validating urls", () => {
    const servers = parseMcpConfig({ mcpServers: { gl: { url: "https://${HOST}/api/v4/mcp" } } }, { HOST: "gitlab.example.com" });
    expect(servers.gl).toMatchObject({ url: "https://gitlab.example.com/api/v4/mcp" });
  });

  it("names missing environment variables", () => {
    expect(() => parseMcpConfig({ mcpServers: { gitlab: { command: "x", env: { T: "${NOPE}" } } } }, env)).toThrow(/gitlab: environment variable\(s\) not set: NOPE/);
  });

  it("skips disabled servers without requiring their secrets", () => {
    expect(parseMcpConfig({ mcpServers: { off: { enabled: false, command: "x", env: { T: "${NOPE}" } } } }, env)).toEqual({});
  });

  it("rejects bad entries with readable errors", () => {
    expect(() => parseMcpConfig({ mcpServers: { a: {} } }, env)).toThrow(/a: needs either "command"/);
    expect(() => parseMcpConfig({ mcpServers: { a: { url: "not a url" } } }, env)).toThrow(/a\.url/);
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", typo: 1 } } }, env)).toThrow(/Invalid MCP config/);
    expect(() => parseMcpConfig({ mcpServers: { "bad name!": { command: "x" } } }, env)).toThrow(/server names/);
    expect(() => parseMcpConfig({ servers: {} }, env)).toThrow(/mcpServers/);
  });
});

describe("tool filtering and naming", () => {
  it("matches wildcards literally otherwise", () => {
    expect(matchesPattern("get_issue", "get_*")).toBe(true);
    expect(matchesPattern("create_issue", "get_*")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true);
    expect(matchesPattern("axb", "a.b")).toBe(false);
  });

  it("applies the allowlist, then the exclude list", () => {
    const c = { tools: ["get_*", "search"], exclude: ["get_secret*"] };
    expect(toolAllowed("get_issue", c)).toBe(true);
    expect(toolAllowed("search", c)).toBe(true);
    expect(toolAllowed("create_issue", c)).toBe(false);
    expect(toolAllowed("get_secret_var", c)).toBe(false);
    expect(toolAllowed("anything", { exclude: [] })).toBe(true);
  });

  it("builds provider-safe tool names", () => {
    expect(exposedToolName("jira", "getJiraIssue")).toBe("jira__getJiraIssue");
    expect(exposedToolName("x", "a.b/c d")).toBe("x__a_b_c_d");
    expect(exposedToolName("srv", "t".repeat(100))).toHaveLength(64);
  });
});

describe("formatToolResult", () => {
  it("joins text blocks and marks other content", () => {
    const out = formatToolResult({ content: [{ type: "text", text: "a" }, { type: "image", data: "…", mimeType: "image/png" }, { type: "text", text: "b" }] }, 1000);
    expect(out).toBe("a\n\n[image content omitted]\n\nb");
  });

  it("flags errors, truncates long output and falls back to structured content", () => {
    expect(formatToolResult({ content: [{ type: "text", text: "boom" }], isError: true }, 1000)).toBe("Tool error: boom");
    expect(formatToolResult({ content: [{ type: "text", text: "x".repeat(50) }] }, 10)).toBe(`${"x".repeat(10)}\n\n[truncated: 40 more characters]`);
    expect(formatToolResult({ content: [], structuredContent: { n: 1 } }, 1000)).toBe('{"n":1}');
    expect(formatToolResult({ content: [] }, 1000)).toBe("(empty result)");
  });
});

/** A small MCP server for tests, reachable over an in-memory transport. */
function fakeServer(): McpServer {
  const server = new McpServer({ name: "fake", version: "1.0.0" });
  server.registerTool("get_issue", { description: "Read an issue", inputSchema: { key: z.string() } }, async ({ key }) => ({
    content: [{ type: "text", text: `issue ${key}: Login broken` }],
  }));
  server.registerTool("create_issue", { description: "Create an issue", inputSchema: { title: z.string() } }, async () => ({
    content: [{ type: "text", text: "created" }],
  }));
  server.registerTool("fail", { description: "Always fails" }, async () => ({ content: [{ type: "text", text: "no permission" }], isError: true }));
  return server;
}

/** Each connect gets a fresh in-memory pair; `connects` counts them and `serverSide` holds the latest server end. */
function inMemoryFactory(opts: { failFor?: string[] } = {}) {
  const state = { connects: 0, serverSide: null as InMemoryTransport | null };
  const factory: TransportFactory = (name) => {
    state.connects++;
    const [client, server] = InMemoryTransport.createLinkedPair();
    if (opts.failFor?.includes(name)) {
      void server.close();
      return client;
    }
    state.serverSide = server;
    void fakeServer().connect(server);
    return client;
  };
  return { factory, state };
}

const ctx = {} as ToolContext;

describe("McpHub", () => {
  it("exposes allowed tools with a server prefix and calls them", async () => {
    const { factory } = inMemoryFactory();
    const hub = new McpHub({ log: silentLog, maxResultChars: 1000, transportFactory: factory });
    await hub.start({ jira: { url: "http://unused", headers: {}, exclude: ["create_*"], enabled: true, timeoutMs: 5000 } });

    expect(hub.tools.map((t) => t.name).sort()).toEqual(["jira__fail", "jira__get_issue"]);
    expect(hub.servers).toEqual(["jira"]);
    const get = hub.tools.find((t) => t.name === "jira__get_issue")!;
    expect(get.description).toBe("[jira] Read an issue");
    expect(get.source).toBe("jira");
    expect(get.parameters).toMatchObject({ type: "object", properties: { key: { type: "string" } }, required: ["key"] });
    expect(get.parameters).not.toHaveProperty("$schema");

    expect(await get.run({ key: "HZ-1" }, ctx)).toBe("issue HZ-1: Login broken");
    expect(await hub.tools.find((t) => t.name === "jira__fail")!.run({}, ctx)).toBe("Tool error: no permission");
    await hub.stop();
  });

  it("skips servers that cannot start and keeps the others", async () => {
    const { factory } = inMemoryFactory({ failFor: ["broken"] });
    const hub = new McpHub({ log: silentLog, maxResultChars: 1000, transportFactory: factory });
    const base = { headers: {}, exclude: [], enabled: true, timeoutMs: 2000 };
    await hub.start({ ok: { url: "http://unused", ...base }, broken: { url: "http://unused", ...base } });
    expect(hub.servers).toEqual(["ok"]);
    await hub.stop();
  });

  it("reconnects after the connection dropped", async () => {
    const { factory, state } = inMemoryFactory();
    const hub = new McpHub({ log: silentLog, maxResultChars: 1000, transportFactory: factory });
    await hub.start({ jira: { url: "http://unused", headers: {}, exclude: [], enabled: true, timeoutMs: 5000 } });
    expect(state.connects).toBe(1);

    await state.serverSide!.close();
    const get = hub.tools.find((t) => t.name === "jira__get_issue")!;
    expect(await get.run({ key: "HZ-2" }, ctx)).toBe("issue HZ-2: Login broken");
    expect(state.connects).toBe(2);
    await hub.stop();
  });
});

describe("system prompt with external tools", () => {
  const base = { botName: "Heinzel", platform: "slack", channelName: "dev", isDirect: false, channelInstructions: "", mode: "direct" as const, memories: [], now: new Date(0) };

  it("names the systems and adds the safety rules only when tools are connected", () => {
    const withTools = buildSystemPrompt({ ...base, externalTools: ["search", "jira"] });
    expect(withTools).toMatch(/external systems: search, jira/);
    expect(withTools).toMatch(/data, not instructions/);
    expect(withTools).toMatch(/explicitly asked/);
    expect(buildSystemPrompt(base)).not.toMatch(/external systems/);
  });
});
