// Allowlisting forward proxy for coding containers (`node dist/egress/proxy.js`).
// Coding containers sit on an internal network without internet access; this proxy is their only way out and
// lets through only the hosts in EGRESS_ALLOW (LLM gateway, GitLab, maybe a package registry).
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

export interface AllowRule {
  /** Lower-case host; a leading "*." matches any subdomain (not the bare domain). */
  host: string;
  /** null = 80 and 443. */
  port: number | null;
}

/** "api.example.com, *.corp.local, gitlab.local:8443" → rules. */
export function parseAllowList(raw: string): AllowRule[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const m = /^(.*?)(?::(\d+))?$/.exec(entry)!;
      return { host: m[1]!.replace(/^\[|\]$/g, ""), port: m[2] ? Number(m[2]) : null };
    });
}

export function isAllowed(rules: AllowRule[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return rules.some((r) => {
    const hostOk = r.host.startsWith("*.") ? h.endsWith(r.host.slice(1)) : h === r.host;
    const portOk = r.port === null ? port === 80 || port === 443 : port === r.port;
    return hostOk && portOk;
  });
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: m[1]!, port: m[2] ? Number(m[2]) : defaultPort };
}

export function createEgressProxy(rules: AllowRule[], log: (entry: Record<string, unknown>) => void = () => {}): Server {
  const server = createServer((req, res) => {
    req.on("error", () => res.destroy());
    // Plain-HTTP proxying: the request line carries an absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute URL required\n");
      return;
    }
    const port = Number(target.port || 80);
    if (target.protocol !== "http:" || !isAllowed(rules, target.hostname, port)) {
      log({ action: "deny", method: req.method, host: target.hostname, port });
      res.writeHead(403).end(`egress to ${target.hostname}:${port} is not allowed\n`);
      return;
    }
    log({ action: "allow", method: req.method, host: target.hostname, port });
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = httpRequest({ host: target.hostname, port, method: req.method, path: `${target.pathname}${target.search}`, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end("upstream error\n"));
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, socket, head) => {
    // Clients may reset the connection at any time (also right after a 403); never let that crash the proxy.
    socket.on("error", () => socket.destroy());
    const target = splitHostPort(req.url ?? "", 443);
    if (!target || !isAllowed(rules, target.host, target.port)) {
      log({ action: "deny", method: "CONNECT", host: target?.host ?? req.url, port: target?.port });
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\negress not allowed\n");
      return;
    }
    log({ action: "allow", method: "CONNECT", host: target.host, port: target.port });
    const upstream = connect(target.port, target.host.replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", () => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      close();
    });
    socket.on("error", close);
    socket.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rules = parseAllowList(process.env.EGRESS_ALLOW ?? "");
  if (rules.length === 0) {
    console.error("EGRESS_ALLOW is empty: set the hosts coding containers may reach (LLM gateway, GitLab).");
    process.exit(1);
  }
  const port = Number(process.env.EGRESS_PORT ?? 3128);
  createEgressProxy(rules, (e) => console.log(JSON.stringify({ time: new Date().toISOString(), ...e }))).listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "egress proxy listening", port, allow: rules.map((r) => (r.port ? `${r.host}:${r.port}` : r.host)) }));
  });
}
