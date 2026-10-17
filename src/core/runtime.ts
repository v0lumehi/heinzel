import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { RUNTIME_SETTINGS, isRuntimeKey, lockedSettings, parseSetting, type Config, type RuntimeKey } from "../config.js";
import type { SecretBox } from "../crypto.js";
import type { Db } from "../db/pool.js";
import { SERVER_NAME, parseMcpConfig, type McpServers } from "../mcp/config.js";
import { McpHub, type McpServerReport } from "../mcp/hub.js";
import { SettingsStore, type StoredMcpServer } from "../store/settings.js";
import type { Store } from "../store/store.js";

export type SettingSource = "admin" | "deployment" | "default";

export interface SettingView {
  key: RuntimeKey;
  kind: "text" | "number" | "boolean";
  group: string;
  label: string;
  help: string;
  /** Effective value as text (secrets are never runtime settings). */
  value: string;
  source: SettingSource;
  locked: boolean;
  /** What the deployment (environment or default) says, shown when the admin UI overrides it. */
  deploymentValue: string;
  updatedBy: string | null;
}

export interface McpServerInput {
  name: string;
  url: string;
  /** Header name → value. An empty value keeps the stored one (values are never sent back to the UI). */
  headers: Record<string, string>;
  tools: string[] | null;
  exclude: string[];
  enabled: boolean;
  timeoutMs: number;
}

export interface McpServerView {
  name: string;
  source: "deployment" | "admin";
  url: string | null;
  headerNames: string[];
  tools: string[] | null;
  exclude: string[];
  enabled: boolean;
  timeoutMs: number;
  updatedBy: string | null;
  status: McpServerReport | null;
}

export class SettingsError extends Error {}

/**
 * Runtime configuration: settings and MCP servers changed in the admin UI, applied without a restart.
 *
 * Precedence per setting: locked (LOCKED_SETTINGS) → value from the deployment; else admin UI value → deployment value → default.
 * MCP servers from mcp.json (deployment) always win over servers with the same name from the UI.
 * The shared Config object is updated in place, so every module sees new values on its next read.
 * All replicas reload on a Postgres notification, and every 30 seconds as a fallback.
 */
export class RuntimeConfig {
  private readonly base: Config;
  private readonly fromEnv: Set<string>;
  private overrides = new Map<string, { value: string; updatedBy: string }>();
  private mcpHash = "";
  private timer: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly d: {
      config: Config;
      env: NodeJS.ProcessEnv;
      db: Db;
      settings: SettingsStore;
      store: Store;
      mcp: McpHub;
      /** Servers from mcp.json. */
      fileServers: McpServers;
      secrets: SecretBox | null;
      log: Logger;
      /** For tests: MCP hub used by testMcpServer. */
      testHub?: () => McpHub;
    },
  ) {
    this.base = { ...d.config };
    this.fromEnv = new Set(RUNTIME_SETTINGS.map((s) => s.key).filter((k) => d.env[k] !== undefined && d.env[k] !== ""));
  }

  /** Loads everything once (connecting MCP servers) and starts following changes. */
  async start(): Promise<void> {
    await this.reload();
    const client = await this.d.db.connect();
    const onNotify = (msg: { channel: string }) => {
      if (msg.channel === SettingsStore.CHANNEL) void this.reload().catch((err) => this.d.log.warn({ err }, "settings reload failed"));
    };
    client.on("notification", onNotify);
    await client.query(`LISTEN ${SettingsStore.CHANNEL}`);
    this.unlisten = async () => {
      client.off("notification", onNotify);
      await client.query(`UNLISTEN ${SettingsStore.CHANNEL}`).catch(() => {});
      client.release();
    };
    this.timer = setInterval(() => void this.reload().catch((err) => this.d.log.warn({ err }, "settings reload failed")), 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unlisten?.();
  }

  async reload(): Promise<void> {
    await this.reloadSettings();
    await this.reloadMcp();
  }

  // ------------------------------------------------------------------ settings

  private async reloadSettings(): Promise<void> {
    const rows = await this.d.settings.all();
    this.overrides = new Map(rows.filter((r) => isRuntimeKey(r.key)).map((r) => [r.key, { value: r.value, updatedBy: r.updatedBy }]));
    const locked = this.locked();
    const next: Partial<Record<RuntimeKey, unknown>> = {};
    for (const { key } of RUNTIME_SETTINGS) {
      const o = this.overrides.get(key);
      let value: unknown = this.base[key];
      if (o && !locked(key)) {
        const parsed = parseSetting(key, o.value);
        if (parsed.ok) value = parsed.value;
        else this.d.log.warn({ key, error: parsed.error }, "ignoring invalid stored setting");
      }
      next[key] = value;
    }
    Object.assign(this.d.config, next);
  }

  private locked(): (key: string) => boolean {
    const l = lockedSettings(this.base);
    return (key) => l.has("*") || l.has(key);
  }

  settings(): SettingView[] {
    const locked = this.locked();
    return RUNTIME_SETTINGS.map((s) => {
      const o = this.overrides.get(s.key);
      const isLocked = locked(s.key);
      const active = o && !isLocked && parseSetting(s.key, o.value).ok;
      return {
        ...s,
        value: text(this.d.config[s.key]),
        source: active ? "admin" : this.fromEnv.has(s.key) ? "deployment" : "default",
        locked: isLocked,
        deploymentValue: text(this.base[s.key]),
        updatedBy: active ? o.updatedBy : null,
      } satisfies SettingView;
    });
  }

  /** Sets a value (as text, like the environment variable) or, with null, returns to the deployment value. */
  async updateSetting(key: string, raw: string | null, actor: { actor: string; actorName: string | null }): Promise<void> {
    if (!isRuntimeKey(key)) throw new SettingsError(`${key} cannot be changed at runtime`);
    if (this.locked()(key)) throw new SettingsError(`${key} is locked by the deployment (LOCKED_SETTINGS)`);
    if (raw !== null) {
      const parsed = parseSetting(key, raw.trim());
      if (!parsed.ok) throw new SettingsError(`${key}: ${parsed.error}`);
    }
    const before = text(this.d.config[key]);
    await this.d.settings.set(key, raw === null ? null : raw.trim(), actor.actor);
    await this.reloadSettings();
    await this.d.store.recordAudit({ ...actor, action: "setting.update", target: `setting:${key}`, details: { key, from: before, to: text(this.d.config[key]), reset: raw === null } });
  }

  // ------------------------------------------------------------------ MCP servers

  private async reloadMcp(): Promise<void> {
    const servers = await this.mcpConfig();
    const hash = createHash("sha256").update(JSON.stringify(servers)).digest("hex");
    if (hash === this.mcpHash) return;
    const first = this.mcpHash === "";
    this.mcpHash = hash;
    if (first) await this.d.mcp.start(servers);
    else {
      this.d.log.info({ servers: Object.keys(servers) }, "MCP servers changed; reconnecting");
      await this.d.mcp.restart(servers);
    }
  }

  /** File servers plus valid admin servers (file wins on name clashes). */
  private async mcpConfig(): Promise<McpServers> {
    const fromDb: McpServers = {};
    for (const s of await this.d.settings.mcpServers()) {
      if (!s.enabled || Object.hasOwn(this.d.fileServers, s.name)) continue;
      try {
        Object.assign(fromDb, parseMcpConfig({ mcpServers: { [s.name]: this.toRaw(s) } }, this.d.env));
      } catch (err) {
        this.d.log.warn({ mcp: s.name, err: err instanceof Error ? err.message : String(err) }, "skipping MCP server from the admin UI");
      }
    }
    return { ...fromDb, ...this.d.fileServers };
  }

  private toRaw(s: Pick<StoredMcpServer, "url" | "headersEnc" | "tools" | "exclude" | "timeoutMs">): Record<string, unknown> {
    const headers = s.headersEnc ? (JSON.parse(this.box().open(s.headersEnc)) as Record<string, string>) : {};
    return { url: s.url, headers, ...(s.tools ? { tools: s.tools } : {}), exclude: s.exclude, timeoutMs: s.timeoutMs };
  }

  private box(): SecretBox {
    if (!this.d.secrets) throw new SettingsError("SECRETS_KEY is not set, so secrets cannot be stored or read (see docs/ADMIN.md)");
    return this.d.secrets;
  }

  async mcpServers(): Promise<McpServerView[]> {
    const reports = new Map(this.d.mcp.report.map((r) => [r.server, r]));
    const file: McpServerView[] = Object.entries(this.d.fileServers).map(([name, c]) => ({
      name,
      source: "deployment",
      url: "url" in c ? c.url : null,
      headerNames: "headers" in c ? Object.keys(c.headers) : [],
      tools: c.tools ?? null,
      exclude: c.exclude,
      enabled: true,
      timeoutMs: c.timeoutMs,
      updatedBy: null,
      status: reports.get(name) ?? null,
    }));
    const db: McpServerView[] = (await this.d.settings.mcpServers())
      .filter((s) => !Object.hasOwn(this.d.fileServers, s.name))
      .map((s) => ({
        name: s.name,
        source: "admin",
        url: s.url,
        headerNames: s.headerNames,
        tools: s.tools,
        exclude: s.exclude,
        enabled: s.enabled,
        timeoutMs: s.timeoutMs,
        updatedBy: s.updatedBy,
        status: reports.get(s.name) ?? null,
      }));
    return [...file, ...db].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Validates input and merges headers with the stored ones (empty value = keep). Returns what would be stored. */
  private async prepare(input: McpServerInput): Promise<{ raw: Record<string, unknown>; headers: Record<string, string>; existing: StoredMcpServer | undefined }> {
    if (!SERVER_NAME.test(input.name)) throw new SettingsError(`"${input.name}": server names may only contain letters, digits and '-' (at most 20 characters)`);
    if (Object.hasOwn(this.d.fileServers, input.name)) throw new SettingsError(`"${input.name}" is defined in the deployment (mcp.json) and cannot be changed here`);
    const existing = (await this.d.settings.mcpServers()).find((s) => s.name === input.name);
    const stored = existing?.headersEnc ? (JSON.parse(this.box().open(existing.headersEnc)) as Record<string, string>) : {};
    // No prototype: header names come from the admin UI.
    const headers = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(input.headers)) {
      const name = k.trim();
      if (!name) continue;
      if (!HEADER_NAME.test(name)) throw new SettingsError(`"${name}" is not a valid header name`);
      const value = v === "" ? (Object.hasOwn(stored, name) ? stored[name] : undefined) : v;
      if (value === undefined) throw new SettingsError(`Header ${name} needs a value`);
      headers[name] = value;
    }
    const raw = { url: input.url, headers: { ...headers }, ...(input.tools ? { tools: input.tools } : {}), exclude: input.exclude, timeoutMs: input.timeoutMs };
    try {
      parseMcpConfig({ mcpServers: Object.fromEntries([[input.name, raw]]) }, this.d.env);
    } catch (err) {
      throw new SettingsError(err instanceof Error ? err.message.replace(/^Invalid MCP config:\n\s*-\s*/, "") : String(err));
    }
    return { raw, headers, existing };
  }

  async saveMcpServer(input: McpServerInput, actor: { actor: string; actorName: string | null }): Promise<void> {
    const { headers, existing } = await this.prepare(input);
    const headerNames = Object.keys(headers);
    await this.d.settings.upsertMcpServer({
      name: input.name,
      url: input.url,
      headersEnc: headerNames.length ? this.box().seal(JSON.stringify(headers)) : null,
      headerNames,
      tools: input.tools,
      exclude: input.exclude,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      updatedBy: actor.actor,
    });
    await this.d.store.recordAudit({
      ...actor,
      action: existing ? "mcp.update" : "mcp.create",
      target: `mcp:${input.name}`,
      // Header values are secrets and never go into the audit log.
      details: { url: input.url, headers: headerNames, tools: input.tools, exclude: input.exclude, enabled: input.enabled },
    });
    await this.reloadMcp();
  }

  async deleteMcpServer(name: string, actor: { actor: string; actorName: string | null }): Promise<boolean> {
    if (Object.hasOwn(this.d.fileServers, name)) throw new SettingsError(`"${name}" is defined in the deployment (mcp.json) and cannot be deleted here`);
    const deleted = await this.d.settings.deleteMcpServer(name);
    if (deleted) {
      await this.d.store.recordAudit({ ...actor, action: "mcp.delete", target: `mcp:${name}` });
      await this.reloadMcp();
    }
    return deleted;
  }

  /** Connects once with the given settings and lists the tools, without saving anything. */
  async testMcpServer(input: McpServerInput): Promise<McpServerReport> {
    const { raw } = await this.prepare(input);
    const servers = parseMcpConfig({ mcpServers: Object.fromEntries([[input.name, { ...raw, enabled: true }]]) }, this.d.env);
    const hub = this.d.testHub?.() ?? new McpHub({ log: this.d.log, maxResultChars: this.d.config.TOOL_RESULT_MAX_CHARS });
    try {
      await hub.start(servers);
      return hub.report[0] ?? { server: input.name, tools: [], error: "no result" };
    } finally {
      await hub.stop();
    }
  }
}

/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

function text(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
