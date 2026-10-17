import { Agent, request, type Dispatcher } from "undici";
import type { CodingRunner, LogLine, RunnerState, RunSpec } from "./runner.js";

/**
 * Runs coding containers through the Docker Engine API (unix socket or tcp, as in DOCKER_HOST).
 * In compose, Heinzel talks to a filtering socket proxy instead of the raw socket.
 */
export class DockerRunner implements CodingRunner {
  private readonly dispatcher: Dispatcher;
  private readonly origin: string;

  constructor(dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock") {
    if (dockerHost.startsWith("unix://")) {
      this.dispatcher = new Agent({ connect: { socketPath: dockerHost.slice("unix://".length) } });
      this.origin = "http://docker";
    } else if (dockerHost.startsWith("tcp://") || dockerHost.startsWith("http://")) {
      this.dispatcher = new Agent();
      this.origin = dockerHost.replace(/^tcp:/, "http:");
    } else {
      throw new Error(`Unsupported DOCKER_HOST: ${dockerHost} (use unix:///path/to/docker.sock or tcp://host:port)`);
    }
  }

  private async call(method: Dispatcher.HttpMethod, path: string, body?: unknown): Promise<{ status: number; data: Buffer }> {
    const res = await request(`${this.origin}${path}`, {
      method,
      dispatcher: this.dispatcher,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = Buffer.from(await res.body.arrayBuffer());
    return { status: res.statusCode, data };
  }

  private async json<T>(method: Dispatcher.HttpMethod, path: string, body?: unknown, ok: number[] = [200, 201, 204]): Promise<T> {
    const res = await this.call(method, path, body);
    if (!ok.includes(res.status)) throw new Error(`Docker ${method} ${path.split("?")[0]} failed (${res.status}): ${dockerMessage(res.data)}`);
    return (res.data.length ? JSON.parse(res.data.toString("utf8")) : {}) as T;
  }

  async checkImage(image: string): Promise<void> {
    const res = await this.call("GET", `/images/${encodeURIComponent(image)}/json`);
    if (res.status === 404) throw new Error(`Coding image "${image}" not found. Build it with: docker build -t ${image} coder/`);
    if (res.status !== 200) throw new Error(`Docker image check failed (${res.status}): ${dockerMessage(res.data)}`);
  }

  async start(spec: RunSpec): Promise<string> {
    // Idempotent by name: a retried start job finds the container it already created.
    const existing = await this.call("GET", `/containers/${encodeURIComponent(spec.name)}/json`);
    let id: string;
    if (existing.status === 200) {
      id = JSON.parse(existing.data.toString("utf8")).Id;
    } else {
      const created = await this.json<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, {
        Image: spec.image,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        Labels: spec.labels,
        Tty: false,
        OpenStdin: false,
        HostConfig: {
          NetworkMode: spec.network ?? "bridge",
          Memory: spec.memoryMb * 1024 * 1024,
          NanoCpus: Math.round(spec.cpus * 1e9),
          PidsLimit: 1024,
          // Root in the container only to set up and push; the agent itself runs unprivileged (see coder/entrypoint.sh).
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
          SecurityOpt: ["no-new-privileges"],
          AutoRemove: false,
        },
      });
      id = created.Id;
    }
    await this.json("POST", `/containers/${id}/start`, undefined, [204, 304]);
    return id;
  }

  async state(ref: string): Promise<RunnerState | null> {
    const res = await this.call("GET", `/containers/${encodeURIComponent(ref)}/json`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`Docker inspect failed (${res.status}): ${dockerMessage(res.data)}`);
    const s = JSON.parse(res.data.toString("utf8")).State as { Running: boolean; ExitCode: number; OOMKilled?: boolean };
    return { running: s.Running, exitCode: s.Running ? null : s.ExitCode, oomKilled: !!s.OOMKilled };
  }

  async logs(ref: string, since: string | null): Promise<LogLine[]> {
    const q = new URLSearchParams({ stdout: "1", stderr: "1", timestamps: "1" });
    if (since) q.set("since", rfc3339ToDockerSince(since));
    const res = await this.call("GET", `/containers/${encodeURIComponent(ref)}/logs?${q}`);
    if (res.status === 404) return [];
    if (res.status !== 200) throw new Error(`Docker logs failed (${res.status}): ${dockerMessage(res.data)}`);
    const lines = demuxLogs(res.data);
    // `since` has whole-second precision in some engines: drop what we already saw.
    return since ? lines.filter((l) => compareTimestamps(l.ts, since) > 0) : lines;
  }

  async stop(ref: string): Promise<void> {
    const res = await this.call("POST", `/containers/${encodeURIComponent(ref)}/stop?t=10`);
    if (![204, 304, 404].includes(res.status)) throw new Error(`Docker stop failed (${res.status}): ${dockerMessage(res.data)}`);
  }

  async remove(ref: string): Promise<void> {
    const res = await this.call("DELETE", `/containers/${encodeURIComponent(ref)}?force=1`);
    if (![204, 404].includes(res.status)) throw new Error(`Docker remove failed (${res.status}): ${dockerMessage(res.data)}`);
  }
}

function dockerMessage(data: Buffer): string {
  const text = data.toString("utf8");
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Splits Docker's multiplexed log stream (8-byte frame headers: stream type, 3 bytes padding, uint32 length)
 * into lines with their timestamp (requested with timestamps=1).
 */
export function demuxLogs(buf: Buffer): LogLine[] {
  const chunks: { stream: "stdout" | "stderr"; text: string }[] = [];
  let pending: { stream: "stdout" | "stderr"; parts: Buffer[] } | null = null;
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off]!;
    const len = buf.readUInt32BE(off + 4);
    const stream = type === 2 ? "stderr" : "stdout";
    const payload = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
    if (pending && pending.stream !== stream) {
      chunks.push({ stream: pending.stream, text: Buffer.concat(pending.parts).toString("utf8") });
      pending = null;
    }
    pending ??= { stream, parts: [] };
    pending.parts.push(payload);
  }
  if (pending) chunks.push({ stream: pending.stream, text: Buffer.concat(pending.parts).toString("utf8") });

  const lines: LogLine[] = [];
  for (const c of chunks) {
    for (const raw of c.text.split("\n")) {
      if (!raw) continue;
      const sp = raw.indexOf(" ");
      const ts = sp > 0 ? raw.slice(0, sp) : "";
      if (!/^\d{4}-\d\d-\d\dT/.test(ts)) {
        // Continuation of a line longer than one frame: append to the previous line of the same stream.
        const prev = lines.at(-1);
        if (prev && prev.stream === c.stream) prev.text += raw;
        continue;
      }
      lines.push({ ts, stream: c.stream, text: raw.slice(sp + 1) });
    }
  }
  return lines;
}

/** RFC 3339 with nanoseconds → nanoseconds since epoch, for exact ordering. */
export function timestampNanos(ts: string): bigint {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(ts);
  if (!m) return 0n;
  const seconds = BigInt(Math.floor(Date.parse(`${m[1]}${m[3]}`) / 1000));
  const nanos = BigInt((m[2] ?? "").padEnd(9, "0").slice(0, 9));
  return seconds * 1_000_000_000n + nanos;
}

export function compareTimestamps(a: string, b: string): number {
  const d = timestampNanos(a) - timestampNanos(b);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

/** Docker's `since` takes "<seconds>.<nanoseconds>". */
export function rfc3339ToDockerSince(ts: string): string {
  const ns = timestampNanos(ts);
  return `${ns / 1_000_000_000n}.${(ns % 1_000_000_000n).toString().padStart(9, "0")}`;
}
