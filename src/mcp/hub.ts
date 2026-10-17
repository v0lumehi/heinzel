import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentTool } from "../agent/tools.js";
import { isStdio, toolAllowed, type McpServerConfig, type McpServers } from "./config.js";

const CLIENT_INFO = { name: "heinzel", version: "0.1.0" };
const CONNECT_TIMEOUT_MS = 60_000; // first `npx -y …` run downloads the package
const MAX_DESCRIPTION_CHARS = 1_000;

/** Separator between server and tool name in the name the model sees, e.g. `gitlab__get_issue`. */
export const MCP_NAME_SEPARATOR = "__";

export type TransportFactory = (name: string, config: McpServerConfig, log: Logger) => Transport;

export interface McpHubOptions {
  log: Logger;
  /** Tool results longer than this are cut, so one big API response cannot flood the context. */
  maxResultChars: number;
  /** Overridable for tests (in-memory transports). */
  transportFactory?: TransportFactory;
}

/** What `start` found per server, for `pnpm mcp` and diagnostics. */
export interface McpServerReport {
  server: string;
  tools: { name: string; exposedAs: string | null }[];
  error?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** OpenAI-style function names: [a-zA-Z0-9_-], at most 64 characters. */
export function exposedToolName(server: string, tool: string): string {
  return `${server}${MCP_NAME_SEPARATOR}${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

type ContentBlock = { type: string; text?: string; resource?: { uri?: string; text?: string } };

/** Flattens an MCP tool result into text for the model. */
export function formatToolResult(result: Record<string, unknown>, maxChars: number): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
    else if (block.type === "resource_link" || block.type === "resource") parts.push(`[resource ${block.resource?.uri ?? ""}]`.trim());
    else parts.push(`[${block.type} content omitted]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  if (parts.length === 0 && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult)); // pre-2024-11 servers
  let text = parts.join("\n\n").trim() || "(empty result)";
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters]`;
  return result.isError === true ? `Tool error: ${text}` : text;
}

/** The model needs an object schema; `$schema` trips up some providers. */
function toolParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _, ...rest } = inputSchema;
  return { type: "object", properties: {}, ...rest };
}

function defaultTransport(name: string, config: McpServerConfig, log: Logger): Transport {
  if (isStdio(config)) {
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: "pipe" });
    // Server logs would otherwise interleave with ours on stderr.
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) log.debug({ mcp: name }, line.trim());
    });
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** One configured server. Reconnects lazily when the connection dropped (e.g. a stdio server crashed). */
class McpConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly factory: TransportFactory,
    private readonly log: Logger,
  ) {}

  async get(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = this.factory(this.name, this.config, this.log);
    client.onclose = () => {
      if (this.client === client) {
        this.client = null;
        this.log.warn({ mcp: this.name }, "MCP server connection closed; will reconnect on next use");
      }
    };
    client.onerror = (err) => this.log.debug({ mcp: this.name, err }, "MCP transport error");
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to MCP server "${this.name}"`);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    this.client = client;
    return client;
  }

  async listTools(): Promise<McpTool[]> {
    const client = await this.get();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.config.timeoutMs });
      tools.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = await this.get();
    return (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.config.timeoutMs })) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => {});
  }
}

/**
 * Connects to the configured MCP servers and exposes their tools as agent tools.
 * A server that fails to start is logged and skipped; Heinzel keeps running without it.
 */
export class McpHub {
  private readonly connections: McpConnection[] = [];
  private exposed: AgentTool[] = [];
  private reports: McpServerReport[] = [];
  private readonly factory: TransportFactory;

  constructor(private readonly opts: McpHubOptions) {
    this.factory = opts.transportFactory ?? defaultTransport;
  }

  get tools(): AgentTool[] {
    return this.exposed;
  }

  get report(): McpServerReport[] {
    return this.reports;
  }

  /** Names of servers whose tools are available. */
  get servers(): string[] {
    return [...new Set(this.exposed.map((t) => t.source).filter((s): s is string => !!s))];
  }

  async start(servers: McpServers): Promise<void> {
    const results = await Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        const conn = new McpConnection(name, config, this.factory, this.opts.log);
        try {
          const all = await conn.listTools();
          const tools = all.filter((t) => toolAllowed(t.name, config)).map((t) => this.wrap(conn, t));
          const exposed = new Set(tools.map((t) => t.name));
          this.reports.push({
            server: name,
            tools: all.map((t) => {
              const as = exposedToolName(name, t.name);
              return { name: t.name, exposedAs: exposed.has(as) ? as : null };
            }),
          });
          this.opts.log.info({ mcp: name, tools: tools.length, hidden: all.length - tools.length }, "MCP server connected");
          if (tools.length === 0) this.opts.log.warn({ mcp: name }, "MCP server exposes no tools (check `tools` / `exclude`)");
          this.connections.push(conn);
          return tools;
        } catch (err) {
          this.reports.push({ server: name, tools: [], error: err instanceof Error ? err.message : String(err) });
          this.opts.log.error({ mcp: name, err }, "MCP server unavailable; continuing without it");
          await conn.close();
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    this.exposed = results.flat().filter((t) => {
      if (seen.has(t.name)) {
        this.opts.log.warn({ tool: t.name }, "duplicate MCP tool name after sanitizing; keeping the first");
        return false;
      }
      seen.add(t.name);
      return true;
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.close()));
  }

  private wrap(conn: McpConnection, tool: McpTool): AgentTool {
    const description = (tool.description ?? "").trim() || `${tool.name} (from ${conn.name})`;
    return {
      name: exposedToolName(conn.name, tool.name),
      description: `[${conn.name}] ${description}`.slice(0, MAX_DESCRIPTION_CHARS),
      source: conn.name,
      // The server validates arguments against its own schema; we only require an object.
      args: z.record(z.string(), z.unknown()),
      parameters: toolParameters(tool.inputSchema),
      run: async (args) => formatToolResult(await conn.call(tool.name, args as Record<string, unknown>), this.opts.maxResultChars),
    };
  }
}
