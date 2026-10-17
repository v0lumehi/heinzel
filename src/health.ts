import http from "node:http";
import type { Db } from "./db/pool.js";

/**
 * Liveness and readiness for orchestrators (Kubernetes probes, Docker healthchecks, load balancers).
 *   GET /healthz – the process is up (no dependencies checked, so a slow database never restarts it)
 *   GET /readyz  – started, not shutting down, and the database answers
 */
export class HealthServer {
  private readonly server: http.Server;
  private ready = false;

  constructor(private readonly db: Db) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  /** Called once everything is connected; and with false at the start of a shutdown, so traffic drains. */
  setReady(ready: boolean): void {
    this.ready = ready;
  }

  async listen(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    await closed;
  }

  get address(): number | null {
    const a = this.server.address();
    return a && typeof a === "object" ? a.port : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { status: "method not allowed" });
    if (req.url === "/healthz") return send(200, { status: "ok" });
    if (req.url === "/readyz") {
      if (!this.ready) return send(503, { status: "not ready" });
      try {
        await withTimeout(this.db.query("SELECT 1"), 2000);
        return send(200, { status: "ready" });
      } catch {
        return send(503, { status: "database unavailable" });
      }
    }
    send(404, { status: "not found" });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref())]);
}
