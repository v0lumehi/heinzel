import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * MCP servers come from a JSON file in the widely used `mcpServers` format (Claude Desktop, Cursor, VS Code),
 * so configs from server READMEs can be copied over. Secrets stay in .env and are referenced as ${VAR}.
 *
 *   { "mcpServers": {
 *       "search": { "url": "http://mcp-searxng:3000/mcp" },
 *       "gitlab": { "url": "${GITLAB_URL}/api/v4/mcp", "headers": { "Authorization": "Bearer ${GITLAB_MCP_TOKEN}" } }
 *   } }
 */

const common = {
  /** Set to false to keep a server in the file without starting it. */
  enabled: z.boolean().default(true),
  /** Only expose these tools (exact names, `*` as wildcard). Default: all tools the server offers. */
  tools: z.array(z.string().min(1)).optional(),
  /** Hide these tools (exact names, `*` as wildcard). Applied after `tools`. */
  exclude: z.array(z.string().min(1)).default([]),
  /** Per-call timeout. */
  timeoutMs: z.number().int().positive().default(60_000),
};

const stdioServer = z.object({
  ...common,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
}).strict();

const httpServer = z.object({
  ...common,
  /** Streamable HTTP endpoint. */
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
}).strict();

/** Becomes the tool-name prefix (`<server>__<tool>`), so keep it short and simple. */
const SERVER_NAME = /^[a-zA-Z0-9-]{1,20}$/;
/** Prefixes taken by built-in tools (`web__fetch_url`). */
const RESERVED_NAMES = new Set(["web"]);

/** Servers are validated one by one after interpolation, so values like "https://${HOST}/mcp" are checked resolved. */
const fileSchema = z.object({ mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) });

export type StdioServerConfig = z.infer<typeof stdioServer>;
export type HttpServerConfig = z.infer<typeof httpServer>;
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export type McpServers = Record<string, McpServerConfig>;

export function isStdio(c: McpServerConfig): c is StdioServerConfig {
  return "command" in c;
}

/**
 * Replaces ${VAR} with the environment value and ${VAR:-default} with the value or the default.
 * Unset variables without a default are an error, so a missing secret fails loudly at startup.
 */
export function interpolate(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}

function interpolateDeep(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === "string") return interpolate(value, env, missing);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, env, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, env, missing)]));
  }
  return value;
}

/** Parses an MCP config document. Disabled servers are dropped before interpolation, so they need no secrets. */
export function parseMcpConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): McpServers {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid MCP config:\n${issues}`);
  }
  const servers: McpServers = {};
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(parsed.data.mcpServers)) {
    if (!SERVER_NAME.test(name)) {
      errors.push(`  - "${name}": server names may only contain letters, digits and '-' (at most 20 characters)`);
      continue;
    }
    if (RESERVED_NAMES.has(name)) {
      errors.push(`  - "${name}": this name is used by a built-in tool; pick another one`);
      continue;
    }
    if (raw.enabled === false) continue;
    const missing = new Set<string>();
    const resolved = interpolateDeep(raw, env, missing);
    if (missing.size) {
      errors.push(`  - ${name}: environment variable(s) not set: ${[...missing].join(", ")} (set them in .env, or set "enabled": false)`);
      continue;
    }
    const shape = "command" in raw ? stdioServer : "url" in raw ? httpServer : null;
    if (!shape) {
      errors.push(`  - ${name}: needs either "command" (stdio) or "url" (streamable HTTP)`);
      continue;
    }
    const server = shape.safeParse(resolved);
    if (!server.success) {
      errors.push(...server.error.issues.map((i) => `  - ${[name, ...i.path].join(".")}: ${i.message}`));
      continue;
    }
    servers[name] = server.data;
  }
  if (errors.length) throw new Error(`Invalid MCP config:\n${errors.join("\n")}`);
  return servers;
}

export function loadMcpConfig(path: string, env: NodeJS.ProcessEnv = process.env): McpServers {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const hint = (err as NodeJS.ErrnoException).code === "ENOENT" ? ` (create it with: cp mcp.example.json ${path}, or unset MCP_CONFIG)` : "";
    throw new Error(`Cannot read MCP config ${path}: ${err instanceof Error ? err.message : String(err)}${hint}`);
  }
  return parseMcpConfig(raw, env);
}

/** `*` matches any run of characters; everything else is literal. */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

export function toolAllowed(name: string, c: Pick<McpServerConfig, "tools" | "exclude">): boolean {
  if (c.tools && !c.tools.some((p) => matchesPattern(name, p))) return false;
  return !c.exclude.some((p) => matchesPattern(name, p));
}
