// Components that talk to other systems, tested against small local fake servers.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerRunner } from "../src/coding/docker.js";
import { createEgressProxy, parseAllowList } from "../src/egress/proxy.js";
import { OpenAiCompatibleClient } from "../src/llm/client.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** An HTTP server on a random local port; returns its base URL and the requests it saw. */
async function fakeServer(handler: Handler): Promise<{ url: string; port: number; requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] }> {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => server.close() });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, requests };
}

const json = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

describe("egress proxy, allowed traffic", () => {
  it("tunnels CONNECT to allowed hosts and forwards plain HTTP without proxy credentials", async () => {
    // TCP echo as the CONNECT target
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    servers.push({ close: () => echo.close() });
    const echoPort = (echo.address() as AddressInfo).port;
    const upstream = await fakeServer((_req, _body, res) => res.end("hello from upstream"));

    const log: Record<string, unknown>[] = [];
    const proxy = createEgressProxy(parseAllowList(`127.0.0.1:${echoPort}, 127.0.0.1:${upstream.port}`), (e) => log.push(e));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    servers.push({ close: () => proxy.close() });
    const proxyPort = (proxy.address() as AddressInfo).port;

    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxyPort, "127.0.0.1", () => sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`));
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n") && !buf.includes("ping")) sock.write("ping");
        if (buf.endsWith("ping")) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1.1 200/);

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, method: "GET", path: `${upstream.url}/path?q=1`, headers: { "proxy-authorization": "Basic secret", "x-keep": "yes" } },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ status: r.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res).toEqual({ status: 200, body: "hello from upstream" });
    expect(upstream.requests[0]).toMatchObject({ url: "/path?q=1", headers: { "x-keep": "yes" } });
    expect(upstream.requests[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(log.map((e) => e.action)).toEqual(["allow", "allow"]);
  });
});

/** Docker's multiplexed log frame: stream type, 3 bytes padding, uint32 length, payload. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

describe("DockerRunner against a fake Docker Engine API", () => {
  it("checks the image, creates a hardened container idempotently, reads state and logs, stops and removes", async () => {
    let created = false;
    let running = true;
    const docker = await fakeServer((req, body, res) => {
      const url = req.url!;
      if (url.startsWith("/images/missing")) return json(res, 404, { message: "no such image" });
      if (url.startsWith("/images/")) return json(res, 200, {});
      if (req.method === "GET" && url === "/containers/heinzel-coding-1/json") return created ? json(res, 200, { Id: "abc" }) : json(res, 404, { message: "no such container" });
      if (req.method === "POST" && url.startsWith("/containers/create")) {
        created = true;
        return json(res, 201, { Id: "abc" });
      }
      if (url === "/containers/abc/start") return res.writeHead(204).end();
      if (req.method === "GET" && url === "/containers/abc/json") return json(res, 200, { State: { Running: running, ExitCode: running ? 0 : 3, OOMKilled: false } });
      if (url.startsWith("/containers/gone/")) return json(res, 404, { message: "gone" });
      if (url.startsWith("/containers/abc/logs")) {
        res.writeHead(200);
        return res.end(Buffer.concat([frame(1, "2026-10-17T10:00:00.100000000Z {\"a\":1}\n"), frame(2, "2026-10-17T10:00:00.200000000Z oops\n")]));
      }
      if (url.startsWith("/containers/abc/stop")) {
        running = false;
        return res.writeHead(204).end();
      }
      if (req.method === "DELETE") return res.writeHead(204).end();
      json(res, 500, { message: `unexpected ${req.method} ${url} ${body}` });
    });
    const runner = new DockerRunner(docker.url.replace("http:", "tcp:"));

    await expect(runner.checkImage("missing:1")).rejects.toThrow(/not found/);
    await runner.checkImage("heinzel-coder:latest");

    const spec = { name: "heinzel-coding-1", image: "heinzel-coder:latest", env: { A: "1" }, labels: { x: "y" }, network: "coding", memoryMb: 512, cpus: 1.5 };
    expect(await runner.start(spec)).toBe("abc");
    const create = JSON.parse(docker.requests.find((r) => r.url.startsWith("/containers/create"))!.body);
    expect(create).toMatchObject({ Image: "heinzel-coder:latest", Env: ["A=1"], HostConfig: { NetworkMode: "coding", Memory: 512 * 1024 * 1024, NanoCpus: 1.5e9, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] } });
    expect(await runner.start(spec)).toBe("abc"); // found by name, not created twice
    expect(docker.requests.filter((r) => r.url.startsWith("/containers/create"))).toHaveLength(1);

    expect(await runner.state("abc")).toEqual({ running: true, exitCode: null, oomKilled: false });
    expect(await runner.state("gone")).toBeNull();
    const lines = await runner.logs("abc", null);
    expect(lines.map((l) => [l.stream, l.text])).toEqual([["stdout", '{"a":1}'], ["stderr", "oops"]]);
    expect((await runner.logs("abc", "2026-10-17T10:00:00.100000000Z")).map((l) => l.text)).toEqual(["oops"]);
    expect(await runner.logs("gone", null)).toEqual([]);

    await runner.stop("abc");
    expect(await runner.state("abc")).toEqual({ running: false, exitCode: 3, oomKilled: false });
    await runner.remove("abc");
    expect(docker.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/containers/abc?force=1" });
    expect(() => new DockerRunner("ssh://nope")).toThrow(/Unsupported DOCKER_HOST/);
  });
});

describe("OpenAiCompatibleClient against a fake gateway", () => {
  it("sends model, tools, JSON mode and Requesty metadata, and maps tool calls and usage", async () => {
    const gateway = await fakeServer((_req, _body, res) =>
      json(res, 200, {
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "recall", arguments: '{"q":"x"}' } }] },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    );
    const client = new OpenAiCompatibleClient({ baseURL: `${gateway.url}/v1`, apiKey: "k", timeoutMs: 5000, metadataStyle: "requesty", structuredOutput: "json_schema" });
    const res = await client.complete({
      model: "agent-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "recall", parameters: { type: "object" } } }],
      temperature: 0,
      maxTokens: 100,
      json: { name: "triage", schema: { type: "object" } },
      meta: { channelKey: "slack:C1", purpose: "triage", traceId: "event-1" },
    });
    expect(res).toEqual({ content: null, toolCalls: [{ id: "t1", name: "recall", arguments: '{"q":"x"}' }], usage: { promptTokens: 12, completionTokens: 3 }, finishReason: "tool_calls" });
    const sent = JSON.parse(gateway.requests[0]!.body);
    expect(gateway.requests[0]!.headers.authorization).toBe("Bearer k");
    expect(sent).toMatchObject({
      model: "agent-model",
      max_tokens: 100,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "triage", strict: true } },
      requesty: { tags: ["heinzel", "triage"], trace_id: "event-1", extra: { channel: "slack:C1" } },
    });

    const plain = new OpenAiCompatibleClient({ baseURL: `${gateway.url}/v1`, apiKey: "k", timeoutMs: 5000, metadataStyle: "none", structuredOutput: "json_object" });
    await plain.complete({ model: "m", messages: [], json: { name: "x", schema: {} }, meta: { purpose: "agent" } });
    const second = JSON.parse(gateway.requests[1]!.body);
    expect(second.response_format).toEqual({ type: "json_object" });
    expect(second.requesty).toBeUndefined();
  });
});
