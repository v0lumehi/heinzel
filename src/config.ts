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

  // --- Microsoft Teams (phase 3; not implemented yet) ---
  TEAMS_APP_ID: optionalString,
  TEAMS_APP_PASSWORD: optionalString,
  TEAMS_TENANT_ID: optionalString,

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
  /** Hard cap on tool-call rounds per agent run. */
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(8),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
