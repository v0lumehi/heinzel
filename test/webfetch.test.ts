import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/agent/tools.js";
import { createWebFetchTool, htmlToMarkdown, isBlockedAddress } from "../src/agent/webfetch.js";

const ctx = {} as ToolContext;

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and special ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("web__fetch_url without private access", () => {
  const tool = createWebFetchTool({ maxChars: 1000 });

  it("refuses internal targets, by IP and by name", async () => {
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://localhost:8080/"]) {
      expect(await tool.run({ url, start: 0 }, ctx), url).toMatch(/^Refused: /);
    }
  });

  it("rejects other schemes and URLs with credentials", async () => {
    await expect(tool.run({ url: "file:///etc/passwd", start: 0 }, ctx)).rejects.toThrow(/Only http and https/);
    await expect(tool.run({ url: "https://user:pw@example.com/", start: 0 }, ctx)).rejects.toThrow(/credentials/);
    await expect(tool.run({ url: "not a url", start: 0 }, ctx)).rejects.toThrow(/Not a valid URL/);
  });
});

describe("web__fetch_url against a local server", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(body);
      };
      switch (req.url) {
        case "/page":
          return send(200, "text/html; charset=utf-8", "<html><head><title>Release notes</title><script>alert(1)</script></head><body><nav>menu</nav><h1>v2.0</h1><p>Adds <b>SSO</b>.</p></body></html>");
        case "/long":
          return send(200, "text/plain", "abcdefghij".repeat(30));
        case "/redirect":
          return send(302, "text/plain", "", { location: "/page" });
        case "/loop":
          return send(302, "text/plain", "", { location: "/loop" });
        case "/to-ftp":
          return send(301, "text/plain", "", { location: "ftp://example.com/file" });
        case "/pdf":
          return send(200, "application/pdf", "%PDF-1.4");
        default:
          return send(404, "text/plain", "nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const tool = createWebFetchTool({ maxChars: 100, allowPrivateHosts: true });

  it("converts HTML to markdown with title, without scripts and navigation", async () => {
    const out = await tool.run({ url: `${base}/page`, start: 0 }, ctx);
    expect(out).toContain("Title: Release notes");
    expect(out).toContain("# v2.0");
    expect(out).toContain("Adds **SSO**.");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("menu");
  });

  it("pages through long content", async () => {
    const first = await tool.run({ url: `${base}/long`, start: 0 }, ctx);
    expect(first).toContain("[characters 0–100 of 300; call again with start=100 to continue]");
    const last = await tool.run({ url: `${base}/long`, start: 200 }, ctx);
    expect(last).not.toContain("call again");
    expect(await tool.run({ url: `${base}/long`, start: 999 }, ctx)).toMatch(/past the end/);
  });

  it("follows redirects but re-checks them", async () => {
    expect(await tool.run({ url: `${base}/redirect`, start: 0 }, ctx)).toContain(`URL: ${base}/page`);
    await expect(tool.run({ url: `${base}/loop`, start: 0 }, ctx)).rejects.toThrow(/Too many redirects/);
    await expect(tool.run({ url: `${base}/to-ftp`, start: 0 }, ctx)).rejects.toThrow(/Only http and https/);
  });

  it("refuses binary content and reports HTTP errors", async () => {
    await expect(tool.run({ url: `${base}/pdf`, start: 0 }, ctx)).rejects.toThrow(/Cannot read application\/pdf/);
    await expect(tool.run({ url: `${base}/missing`, start: 0 }, ctx)).rejects.toThrow(/HTTP 404/);
  });
});

describe("htmlToMarkdown", () => {
  it("handles pages without a title", () => {
    expect(htmlToMarkdown("<p>hi</p>")).toEqual({ title: null, markdown: "hi" });
  });
});
