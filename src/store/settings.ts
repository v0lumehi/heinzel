import type { Db } from "../db/pool.js";

export interface StoredMcpServer {
  name: string;
  url: string;
  headersEnc: string | null;
  headerNames: string[];
  tools: string[] | null;
  exclude: string[];
  enabled: boolean;
  timeoutMs: number;
  updatedBy: string;
  updatedAt: Date;
}

/** Runtime settings and admin-managed MCP servers. Changes are announced on the `heinzel_settings` channel. */
export class SettingsStore {
  static readonly CHANNEL = "heinzel_settings";

  constructor(private readonly db: Db) {}

  async all(): Promise<{ key: string; value: string; updatedBy: string; updatedAt: Date }[]> {
    const { rows } = await this.db.query(`SELECT * FROM settings ORDER BY key`);
    return rows.map((r) => ({ key: r.key, value: r.value, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  /** Sets a value, or removes the override with null. */
  async set(key: string, value: string | null, updatedBy: string): Promise<void> {
    if (value === null) await this.db.query(`DELETE FROM settings WHERE key = $1`, [key]);
    else {
      await this.db.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, value, updatedBy],
      );
    }
    await this.notify("settings");
  }

  async mcpServers(): Promise<StoredMcpServer[]> {
    const { rows } = await this.db.query(`SELECT * FROM mcp_servers ORDER BY name`);
    return rows.map((r) => ({
      name: r.name,
      url: r.url,
      headersEnc: r.headers_enc,
      headerNames: r.header_names,
      tools: r.tools,
      exclude: r.exclude,
      enabled: r.enabled,
      timeoutMs: r.timeout_ms,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }));
  }

  async upsertMcpServer(s: Omit<StoredMcpServer, "updatedAt">): Promise<void> {
    await this.db.query(
      `INSERT INTO mcp_servers (name, url, headers_enc, header_names, tools, exclude, enabled, timeout_ms, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name) DO UPDATE SET url = EXCLUDED.url, headers_enc = EXCLUDED.headers_enc, header_names = EXCLUDED.header_names,
         tools = EXCLUDED.tools, exclude = EXCLUDED.exclude, enabled = EXCLUDED.enabled, timeout_ms = EXCLUDED.timeout_ms,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [s.name, s.url, s.headersEnc, s.headerNames, s.tools === null ? null : JSON.stringify(s.tools), JSON.stringify(s.exclude), s.enabled, s.timeoutMs, s.updatedBy],
    );
    await this.notify("mcp");
  }

  async deleteMcpServer(name: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM mcp_servers WHERE name = $1`, [name]);
    await this.notify("mcp");
    return (res.rowCount ?? 0) > 0;
  }

  private async notify(what: "settings" | "mcp"): Promise<void> {
    await this.db.query(`SELECT pg_notify($1, $2)`, [SettingsStore.CHANNEL, what]);
  }
}
