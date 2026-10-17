import { connect, type AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCoderPrompt, formatFinal, formatStatus } from "../src/coding/coordinator.js";
import { compareTimestamps, demuxLogs, rfc3339ToDockerSince } from "../src/coding/docker.js";
import { describeTool, parseLogs, RESULT_MARKER } from "../src/coding/events.js";
import { parseCommand } from "../src/core/commands.js";
import { createEgressProxy, isAllowed, parseAllowList } from "../src/egress/proxy.js";
import { branchSlug, type CodingSession } from "../src/store/coding.js";
import { testConfig } from "./helpers.js";

// Real OpenCode 2.0 `run --format json` lines (shortened).
const toolEdit = JSON.stringify({
  type: "tool_use",
  part: { type: "tool", tool: "edit", state: { status: "completed", input: { path: "/workspace/math.js", oldString: "a - b", newString: "a + b" }, title: "edit" } },
});
const toolShell = JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "shell", state: { status: "completed", input: { command: "npm test" }, title: "shell" } } });
const stepFinish = JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 161, output: 83, reasoning: 0, cache: { read: 8634, write: 0 } } } });
const text = JSON.stringify({ type: "text", part: { type: "text", text: "Fixed `add` and committed the change." } });
const error = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Cannot connect to API" } } });

describe("parseLogs", () => {
  it("turns OpenCode events into progress, usage and the final result", () => {
    const res = parseLogs(
      [
        { stream: "stderr", text: "[heinzel-coder] cloning git://x/demo.git" },
        { stream: "stdout", text: toolEdit },
        { stream: "stdout", text: toolShell },
        { stream: "stdout", text: stepFinish },
        { stream: "stdout", text },
        { stream: "stdout", text: `${RESULT_MARKER}{"status":"pushed","branch":"heinzel/1-x","commits":1,"mergeRequestUrl":"https://git/x/-/merge_requests/7"}` },
      ],
      { steps: 2, inputTokens: 100, outputTokens: 10, recent: ["read math.js"] },
    );
    expect(res.progress).toEqual({
      steps: 3,
      inputTokens: 100 + 161 + 8634,
      outputTokens: 10 + 83,
      recent: ["read math.js", "edit math.js", "$ npm test"],
      lastText: "Fixed `add` and committed the change.",
    });
    expect(res.usage).toEqual([{ inputTokens: 8795, outputTokens: 83 }]);
    expect(res.result).toMatchObject({ status: "pushed", mergeRequestUrl: "https://git/x/-/merge_requests/7" });
    expect(res.stderrTail).toEqual(["[heinzel-coder] cloning git://x/demo.git"]);
  });

  it("keeps only recent activity, records agent errors and tolerates junk", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ stream: "stdout", text: JSON.stringify({ type: "tool_use", part: { tool: "read", state: { input: { path: `/workspace/f${i}` } } } }) }));
    const res = parseLogs([...many, { stream: "stdout", text: error }, { stream: "stdout", text: "{not json" }, { stream: "stdout", text: `${RESULT_MARKER}nope` }], {});
    expect(res.progress.recent).toHaveLength(6);
    expect(res.progress.recent!.at(-1)).toBe("read f9");
    expect(res.progress.lastError).toBe("Cannot connect to API");
    expect(res.result).toEqual({ status: "failed", error: "unreadable result from coding container" });
  });

  it("describes tools briefly", () => {
    expect(describeTool("shell", { input: { command: "pnpm test --filter api\nmore" } })).toBe("$ pnpm test --filter api");
    expect(describeTool("grep", { input: { pattern: "TODO" } })).toBe("grep TODO");
    expect(describeTool("edit", { status: "error", input: { path: "/workspace/a.ts" } })).toBe("edit a.ts (failed)");
    expect(describeTool("todowrite", { title: "3 todos" })).toBe("todowrite 3 todos");
  });
});

describe("docker log helpers", () => {
  function frame(stream: 1 | 2, s: string): Buffer {
    const payload = Buffer.from(s);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(payload.length, 4);
    return Buffer.concat([h, payload]);
  }

  it("demultiplexes frames, keeps timestamps and joins lines split across frames", () => {
    const buf = Buffer.concat([
      frame(2, "2026-10-17T01:00:00.1Z [heinzel-coder] cloning\n"),
      frame(1, '2026-10-17T01:00:01.123456789Z {"type":"te'),
      frame(1, 'xt"}\n2026-10-17T01:00:02Z HEINZEL_RESULT {}\n'),
    ]);
    expect(demuxLogs(buf)).toEqual([
      { ts: "2026-10-17T01:00:00.1Z", stream: "stderr", text: "[heinzel-coder] cloning" },
      { ts: "2026-10-17T01:00:01.123456789Z", stream: "stdout", text: '{"type":"text"}' },
      { ts: "2026-10-17T01:00:02Z", stream: "stdout", text: "HEINZEL_RESULT {}" },
    ]);
  });

  it("compares nanosecond timestamps and converts them for `since`", () => {
    expect(compareTimestamps("2026-10-17T01:00:00.000000002Z", "2026-10-17T01:00:00.000000001Z")).toBe(1);
    expect(compareTimestamps("2026-10-17T01:00:00.5Z", "2026-10-17T01:00:00.500000000Z")).toBe(0);
    expect(rfc3339ToDockerSince("1970-01-01T00:00:10.25Z")).toBe("10.250000000");
  });
});

describe("egress proxy", () => {
  const rules = parseAllowList("router.eu.requesty.ai, *.corp.local gitlab.local:8443");

  it("matches hosts, wildcards and ports", () => {
    expect(isAllowed(rules, "router.eu.requesty.ai", 443)).toBe(true);
    expect(isAllowed(rules, "ROUTER.EU.REQUESTY.AI.", 443)).toBe(true);
    expect(isAllowed(rules, "router.eu.requesty.ai", 22)).toBe(false);
    expect(isAllowed(rules, "git.corp.local", 443)).toBe(true);
    expect(isAllowed(rules, "corp.local", 443)).toBe(false);
    expect(isAllowed(rules, "evil-corp.local", 443)).toBe(false);
    expect(isAllowed(rules, "gitlab.local", 8443)).toBe(true);
    expect(isAllowed(rules, "gitlab.local", 443)).toBe(false);
    expect(isAllowed(rules, "registry.npmjs.org", 443)).toBe(false);
  });

  describe("server", () => {
    let port: number;
    const server = createEgressProxy(parseAllowList("allowed.test"));
    beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((port = (server.address() as AddressInfo).port), r()))));
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("answers 403 to CONNECT for hosts outside the list", async () => {
      const status = await new Promise<number>((resolve) => {
        const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: "example.com:443" });
        req.on("connect", (res, sock) => (sock.destroy(), resolve(res.statusCode ?? 0)));
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
      expect(status).toBe(403);
    });

    it("refuses plain HTTP to other hosts", async () => {
      const status = await new Promise<number>((resolve) => {
        request({ host: "127.0.0.1", port, method: "GET", path: "http://example.com/" }, (res) => resolve(res.statusCode ?? 0)).end();
      });
      expect(status).toBe(403);
    });

    it("survives clients that reset the connection after a denial", async () => {
      await new Promise<void>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
          sock.resetAndDestroy();
          setTimeout(resolve, 50);
        });
      });
      // Still alive:
      const status = await new Promise<number>((resolve) => {
        request({ host: "127.0.0.1", port, method: "GET", path: "http://example.com/" }, (res) => resolve(res.statusCode ?? 0)).end();
      });
      expect(status).toBe(403);
    });
  });
});

describe("coding helpers", () => {
  const session = (over: Partial<CodingSession> = {}): CodingSession => ({
    id: 7,
    channelKey: "slack:C1",
    threadRef: "t1",
    requestedBy: "slack:U1",
    requestedByName: "Anna",
    backend: "opencode",
    repository: "team/api",
    baseBranch: null,
    branch: "heinzel/7-fix-login",
    title: "Fix login",
    task: "Fix the login redirect.",
    context: "Conversation so far: …",
    status: "running",
    runnerRef: "c1",
    statusMessageRef: "s1",
    logCursor: null,
    progress: { steps: 3, inputTokens: 12_400, outputTokens: 800, recent: ["edit src/login.ts", "$ npm test"], lastText: "Fixed it." },
    result: null,
    error: null,
    createdAt: new Date("2026-10-17T10:00:00Z"),
    startedAt: new Date("2026-10-17T10:00:00Z"),
    finishedAt: null,
    ...over,
  });

  it("slugs branch names", () => {
    expect(branchSlug("Fix Login-Redirect für Ärzte!")).toBe("fix-login-redirect-fur-arzte");
    expect(branchSlug("!!!")).toBe("task");
    expect(branchSlug("a".repeat(60))).toHaveLength(40);
  });

  it("formats the live status and the final message", () => {
    const status = formatStatus(session(), new Date("2026-10-17T10:07:00Z"));
    expect(status).toContain("*Coding session #7* · team/api · running · 7 min");
    expect(status).toContain("• `edit src/login.ts`");
    expect(status).toContain("tokens in/out: 12k/800");
    expect(status).toContain("`!stop 7`");
    expect(formatFinal(session({ status: "succeeded", result: { status: "pushed", commits: 2, diffstat: "3 files changed", mergeRequestUrl: "https://git/mr/1" } }))).toBe(
      "✅ Coding session #7 done – draft merge request: https://git/mr/1 (2 commits, 3 files changed).\n\nFixed it.",
    );
    expect(formatFinal(session({ status: "failed", error: "push failed" }))).toMatch(/failed: push failed\. Nothing was pushed/);
  });

  it("builds a self-contained prompt for the coding agent", () => {
    const p = buildCoderPrompt(session(), "Heinzel");
    expect(p).toContain("Repository: team/api, checked out in /workspace on the new branch heinzel/7-fix-login.");
    expect(p).toContain("## Task\nFix the login redirect.");
    expect(p).toContain("Do not push");
    expect(p).toContain("Conversation so far: …");
  });

  it("parses the coding commands", () => {
    expect(parseCommand("@Heinzel !go")).toEqual({ kind: "go" });
    expect(parseCommand("!go #12")).toEqual({ kind: "go", id: 12 });
    expect(parseCommand("!cancel 3")).toEqual({ kind: "stop", id: 3 });
    expect(parseCommand("!stop now")).toMatchObject({ kind: "unknown" });
    expect(parseCommand("!coding")).toEqual({ kind: "coding" });
  });

  it("requires the git settings when coding is enabled", () => {
    expect(() => testConfig({ CODING_ENABLED: "true" })).toThrow(/GITLAB_URL: required when CODING_ENABLED=true[\s\S]*CODING_GIT_TOKEN/);
    expect(testConfig({ CODING_ENABLED: "true", GITLAB_URL: "https://git.example.com", CODING_GIT_TOKEN: "t" }).CODING_MAX_RUNNING).toBe(2);
  });
});
