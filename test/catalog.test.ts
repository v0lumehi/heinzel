import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS } from "../src/admin/builtins.js";
import { defaultTools } from "../src/agent/tools.js";
import { CATALOG, buildCatalogServer } from "../src/mcp/catalog.js";
import { parseMcpConfig } from "../src/mcp/config.js";

const entry = (id: string) => CATALOG.find((e) => e.id === id)!;

describe("integration catalog", () => {
  it("builds GitLab and Atlassian connections from the form fields", () => {
    expect(buildCatalogServer(entry("gitlab"), { gitlabUrl: "https://gitlab.example.com/ ", token: " glpat-x " })).toEqual({
      url: "https://gitlab.example.com/api/v4/mcp",
      headers: { Authorization: "Bearer glpat-x" },
    });
    const jira = buildCatalogServer(entry("atlassian"), { email: "bot@example.com", apiToken: "t0k" });
    expect(jira.headers.Authorization).toBe(`Basic ${Buffer.from("bot@example.com:t0k").toString("base64")}`);
  });

  it("uses field defaults and names missing fields", () => {
    expect(buildCatalogServer(entry("searxng"), {})).toEqual({ url: "http://mcp-searxng:3000/mcp", headers: {} });
    expect(() => buildCatalogServer(entry("gitlab"), { gitlabUrl: "https://g.example" })).toThrow("Access token is missing");
  });

  it("every entry produces a valid MCP server config under its default name", () => {
    for (const e of CATALOG) {
      const values = Object.fromEntries(e.fields.map((f) => [f.key, f.default ?? (f.key.toLowerCase().includes("url") ? "https://example.com" : "x")]));
      const conn = buildCatalogServer(e, values);
      const raw = { ...conn, ...(e.tools ? { tools: e.tools } : {}), exclude: e.exclude };
      expect(() => parseMcpConfig({ mcpServers: { [e.defaultName]: raw } }, {})).not.toThrow();
    }
  });

  it("explains every built-in tool", () => {
    const explained = new Set(BUILTIN_TOOLS.map((b) => b.name));
    for (const t of defaultTools) expect(explained).toContain(t.name);
    expect(explained).toContain("web__fetch_url");
  });
});
