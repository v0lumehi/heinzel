import { z } from "zod";

/**
 * All runtime configuration comes from environment variables.
 * See .env.example for documentation of every value.
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** Optional string: unset and "" both mean "not configured". */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // --- LLM gateway (any OpenAI-compatible endpoint; Requesty EU by default) ---
  LLM_BASE_URL: z.string().url().default("https://router.eu.requesty.ai/v1"),
  LLM_API_KEY: z.string().min(1),
  /** Model for real work (answers, tool use). Use the gateway's model id. */
  LLM_MODEL_AGENT: z.string().min(1),
  /** Small, cheap model for ambient triage ("should I speak?"). */
  LLM_MODEL_TRIAGE: z.string().min(1),
  /**
   * Optional strong model for hard tasks. When set, the agent model can hand a task over via the `escalate` tool,
   * triage can route complex questions to it, and people can force it with "!deep <question>".
   */
  LLM_MODEL_HEAVY: optionalString,
  /** Max heavy-model runs per channel per day. */
  HEAVY_DAILY_LIMIT: z.coerce.number().int().min(0).default(20),
  /** Tool-call rounds for heavy runs, which tend to be longer. */
  AGENT_MAX_STEPS_HEAVY: z.coerce.number().int().min(1).max(100).default(16),
  /** "requesty" attaches channel/trace metadata in Requesty's format; "none" sends plain OpenAI requests. */
  LLM_METADATA_STYLE: z.enum(["requesty", "none"]).default("requesty"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /**
   * How triage asks for JSON. "none" (default) relies on the prompt + lenient parsing and works with every model;
   * "json_object" / "json_schema" use the OpenAI response_format when your model/gateway supports it.
   */
  LLM_STRUCTURED_OUTPUT: z.enum(["none", "json_object", "json_schema"]).default("none"),

  // --- Slack (enabled when both tokens are set) ---
  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,

  // --- Microsoft Teams (enabled when TEAMS_APP_ID is set, or TEAMS_PLAYGROUND=true) ---
  /** Azure Bot registration: Microsoft App ID, client secret and the tenant the app is registered in. */
  TEAMS_APP_ID: optionalString,
  TEAMS_APP_PASSWORD: optionalString,
  TEAMS_TENANT_ID: optionalString,
  /** Port of the messaging endpoint (`/api/messages`). Teams needs it reachable over public HTTPS (reverse proxy or dev tunnel). */
  TEAMS_PORT: z.coerce.number().int().min(1).max(65535).default(3978),
  /** Local testing with the Microsoft 365 Agents Playground: no credentials, unauthenticated requests, localhost only. */
  TEAMS_PLAYGROUND: bool.default(false),
  /** Bot Connector URL for proactive posts to conversations not seen since the start. Default: https://smba.trafficmanager.net/teams */
  TEAMS_SERVICE_URL: optionalString,

  // --- External tools ---
  /** Path to a JSON file with MCP servers (`mcpServers` format, see mcp.example.json). Unset = no MCP tools. */
  MCP_CONFIG: optionalString,
  /** Built-in `web__fetch_url` tool: read public web pages (private network addresses are always refused). */
  WEB_FETCH: bool.default(true),
  /** Tool results (MCP, web pages) longer than this are cut before they reach the model. */
  TOOL_RESULT_MAX_CHARS: z.coerce.number().int().min(1_000).max(200_000).default(16_000),

  // --- Coding sessions (see docs/CODING.md) ---
  /** Let people hand coding tasks to a coding agent (OpenCode) that runs in an isolated container and opens a draft MR. */
  CODING_ENABLED: bool.default(false),
  /** Base URL of the git host, e.g. https://gitlab.example.com (also used for the GitLab MCP server). */
  GITLAB_URL: optionalString,
  /** Token the coding container clones and pushes with (GitLab project/group access token, role Developer, scope write_repository). */
  CODING_GIT_TOKEN: optionalString,
  /** Basic-auth user that goes with the token: "oauth2" for GitLab tokens. */
  CODING_GIT_USERNAME: z.string().default("oauth2"),
  CODING_GIT_AUTHOR_EMAIL: z.string().default("heinzel@localhost"),
  /** Comma-separated repository patterns sessions may target, e.g. "team/*,tools/heinzel". */
  CODING_REPOSITORIES: z.string().default("*"),
  CODING_IMAGE: z.string().default("heinzel-coder:latest"),
  /** Docker network for coding containers (the internal network behind the egress proxy). */
  CODING_DOCKER_NETWORK: optionalString,
  /** Proxy the coding containers must use, e.g. http://egress-proxy:3128. */
  CODING_PROXY_URL: optionalString,
  /** Hosts the coding containers reach without the proxy (e.g. an internal GitLab on the same network). */
  CODING_NO_PROXY: optionalString,
  /** Model for the coding agent. Default: LLM_MODEL_HEAVY, else LLM_MODEL_AGENT. */
  CODING_MODEL: optionalString,
  /** LLM endpoint for the coding agent. Default: LLM_BASE_URL / LLM_API_KEY. */
  CODING_LLM_BASE_URL: optionalString,
  CODING_LLM_API_KEY: optionalString,
  CODING_TIMEOUT_MIN: z.coerce.number().int().min(5).max(480).default(45),
  /** Coding containers running at the same time (across all channels). */
  CODING_MAX_RUNNING: z.coerce.number().int().min(1).max(50).default(2),
  CODING_MEMORY_MB: z.coerce.number().int().min(512).default(4096),
  CODING_CPUS: z.coerce.number().min(0.5).max(64).default(2),

  // --- Admin UI (see docs/ADMIN.md; enabled when ADMIN_OIDC_ISSUER is set or ADMIN_DEV_LOGIN=true) ---
  ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  /** Interface to listen on. 127.0.0.1 keeps it local; use 0.0.0.0 in a container behind a reverse proxy. */
  ADMIN_HOST: z.string().default("127.0.0.1"),
  /** Public base URL of the admin UI, used for the OIDC redirect (https in production). */
  ADMIN_PUBLIC_URL: z.string().url().default("http://localhost:3080"),
  /** OpenID Connect provider, e.g. https://login.microsoftonline.com/<tenant id>/v2.0 for Entra ID. */
  ADMIN_OIDC_ISSUER: optionalString,
  ADMIN_OIDC_CLIENT_ID: optionalString,
  ADMIN_OIDC_CLIENT_SECRET: optionalString,
  /** ID token claim that carries roles or groups, and the values that map to admin / viewer (comma-separated). */
  ADMIN_ROLE_CLAIM: z.string().default("roles"),
  ADMIN_ADMIN_ROLES: z.string().default("Heinzel.Admin"),
  ADMIN_VIEWER_ROLES: z.string().default("Heinzel.Viewer"),
  /** Local development only: a sign-in button without identity provider. Requires ADMIN_HOST to be a loopback address. */
  ADMIN_DEV_LOGIN: bool.default(false),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),

  // --- Behaviour ---
  BOT_NAME: z.string().default("Heinzel"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Whether ambient (proactive) mode is on for channels Heinzel joins. Per-channel override via chat command. */
  AMBIENT_DEFAULT: bool.default(false),
  /** Max unsolicited (ambient + follow-up) posts per channel per day. */
  AMBIENT_DAILY_LIMIT: z.coerce.number().int().min(0).default(5),
  /** Minimum minutes between unsolicited posts in the same thread. */
  AMBIENT_THREAD_COOLDOWN_MIN: z.coerce.number().int().min(0).default(30),
  /** Triage must be at least this confident before Heinzel speaks unprompted. */
  AMBIENT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  /** How many prior messages of a thread/channel go into the agent's context. */
  CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(200).default(30),
  /**
   * Days to keep stored message copies (events). 0 = keep forever (default until a retention policy is decided).
   * Memories survive; they just lose the link to their source message.
   */
  EVENTS_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  /** Hard cap on tool-call rounds per agent run. */
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(8),
});

export type Config = z.infer<typeof schema>;

/**
 * Loads `.env` from the working directory into process.env, if the file exists.
 * Variables already set in the environment win (Docker, CI, shell exports).
 */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema
    .superRefine((c, ctx) => {
      if (c.TEAMS_APP_ID) {
        for (const key of ["TEAMS_APP_PASSWORD", "TEAMS_TENANT_ID"] as const) {
          if (!c[key]) ctx.addIssue({ code: "custom", path: [key], message: "required when TEAMS_APP_ID is set" });
        }
      }
      if (c.ADMIN_OIDC_ISSUER) {
        for (const key of ["ADMIN_OIDC_CLIENT_ID", "ADMIN_OIDC_CLIENT_SECRET"] as const) {
          if (!c[key]) ctx.addIssue({ code: "custom", path: [key], message: "required when ADMIN_OIDC_ISSUER is set" });
        }
      }
      if (c.ADMIN_DEV_LOGIN && !["127.0.0.1", "::1", "localhost"].includes(c.ADMIN_HOST)) {
        ctx.addIssue({ code: "custom", path: ["ADMIN_DEV_LOGIN"], message: "only allowed when ADMIN_HOST is a loopback address" });
      }
      if (!c.CODING_ENABLED) return;
      for (const key of ["GITLAB_URL", "CODING_GIT_TOKEN"] as const) {
        if (!c[key]) ctx.addIssue({ code: "custom", path: [key], message: "required when CODING_ENABLED=true" });
      }
    })
    .safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
