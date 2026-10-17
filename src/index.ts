import { readFileSync } from "node:fs";
import pino from "pino";
import { OidcLogin } from "./admin/auth.js";
import { buildAdminServer } from "./admin/server.js";
import { defaultTools, type AgentTool } from "./agent/tools.js";
import { createWebFetchTool } from "./agent/webfetch.js";
import { DockerRunner } from "./coding/docker.js";
import { KubernetesRunner } from "./coding/kubernetes.js";
import type { CodingRunner } from "./coding/runner.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { SlackAdapter } from "./adapters/slack/adapter.js";
import { TeamsAdapter } from "./adapters/teams/adapter.js";
import { Engine } from "./core/engine.js";
import type { ChatAdapter, Platform } from "./core/types.js";
import { migrate } from "./db/migrate.js";
import { HealthServer } from "./health.js";
import { createPool } from "./db/pool.js";
import { OpenAiCompatibleClient } from "./llm/client.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpHub } from "./mcp/hub.js";
import { MemoryStore } from "./memory/memory.js";
import { RuntimeConfig } from "./core/runtime.js";
import { SecretBox } from "./crypto.js";
import { SettingsStore } from "./store/settings.js";
import { JobQueue } from "./queue/queue.js";
import { Worker } from "./queue/worker.js";
import { AdminSessionStore } from "./store/admin.js";
import { CodingStore } from "./store/coding.js";
import { Store } from "./store/store.js";

loadDotEnv();
const config = loadConfig();
const mcpServers = config.MCP_CONFIG ? loadMcpConfig(config.MCP_CONFIG) : {};
const log = pino({
  level: config.LOG_LEVEL,
  ...(process.stdout.isTTY ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } } : {}),
});

const db = createPool(config.DATABASE_URL);
await migrate(db, (m) => log.info(m));

// Up early so liveness probes pass while connecting; ready only once everything runs.
const health = new HealthServer(db);
if (config.HEALTH_PORT) await health.listen(config.HEALTH_PORT, config.HEALTH_HOST);

const store = new Store(db);
const memory = new MemoryStore(db);
const queue = new JobQueue(db);
const llm = new OpenAiCompatibleClient({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  timeoutMs: config.LLM_TIMEOUT_MS,
  metadataStyle: config.LLM_METADATA_STYLE,
  structuredOutput: config.LLM_STRUCTURED_OUTPUT,
});

const adapters = new Map<Platform, ChatAdapter>();
if (config.SLACK_BOT_TOKEN && config.SLACK_APP_TOKEN) {
  adapters.set(
    "slack",
    new SlackAdapter({ botToken: config.SLACK_BOT_TOKEN, appToken: config.SLACK_APP_TOKEN, botName: config.BOT_NAME, log: log.child({ adapter: "slack" }) }),
  );
}
if (config.TEAMS_APP_ID || config.TEAMS_PLAYGROUND) {
  adapters.set(
    "teams",
    new TeamsAdapter({
      appId: config.TEAMS_APP_ID,
      appPassword: config.TEAMS_APP_PASSWORD,
      tenantId: config.TEAMS_TENANT_ID,
      port: config.TEAMS_PORT,
      playground: config.TEAMS_PLAYGROUND,
      serviceUrl: config.TEAMS_SERVICE_URL,
      log: log.child({ adapter: "teams" }),
    }),
  );
}
if (adapters.size === 0) {
  log.fatal("No chat platform configured. Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN, or TEAMS_APP_ID (see README).");
  process.exit(1);
}

const mcp = new McpHub({ log: log.child({ component: "mcp" }), maxResultChars: config.TOOL_RESULT_MAX_CHARS });
// Applies settings and MCP servers from the admin UI on top of the environment, and connects the MCP servers.
const runtime = new RuntimeConfig({
  config,
  env: process.env,
  db,
  settings: new SettingsStore(db),
  store,
  mcp,
  fileServers: mcpServers,
  secrets: config.SECRETS_KEY ? new SecretBox(config.SECRETS_KEY) : null,
  log: log.child({ component: "settings" }),
});
await runtime.start();

const webFetch = createWebFetchTool({ maxChars: config.TOOL_RESULT_MAX_CHARS }) as AgentTool;
const tools = (): AgentTool[] => [...defaultTools, ...(config.WEB_FETCH ? [webFetch] : []), ...mcp.tools];
let coding: { runner: CodingRunner; sessions: CodingStore } | undefined;
if (config.CODING_ENABLED) {
  const runner =
    config.CODING_RUNNER === "kubernetes"
      ? new KubernetesRunner({
          namespace: config.CODING_K8S_NAMESPACE ?? currentNamespace(),
          runtimeClassName: config.CODING_K8S_RUNTIME_CLASS,
          activeDeadlineSeconds: (config.CODING_TIMEOUT_MIN + 10) * 60,
        })
      : new DockerRunner();
  coding = { runner, sessions: new CodingStore(db) };
  // A missing image is not fatal: Heinzel keeps working, sessions fail with a clear message.
  await coding.runner.checkImage(config.CODING_IMAGE).catch((err) => log.error({ err: err.message }, "coding sessions will fail until this is fixed"));
}

const engine = new Engine({ config, store, memory, queue, llm, adapters, tools, coding, log: log.child({ component: "engine" }) });
const worker = new Worker(queue, engine.handlers(), log.child({ component: "worker" }), { concurrency: config.WORKER_CONCURRENCY });
await worker.start();

for (const adapter of adapters.values()) {
  try {
    await adapter.start(async (event) => {
      try {
        await engine.handleIncoming(event);
      } catch (err) {
        log.error({ err, platform: event.platform, channel: event.channelId }, "failed to handle incoming event");
      }
    });
  } catch (err) {
    log.fatal({ err, platform: adapter.platform }, "could not connect to chat platform (check tokens and network)");
    await worker.stop();
    await mcp.stop();
    await db.end();
    process.exit(1);
  }
}
let admin: Awaited<ReturnType<typeof buildAdminServer>> | undefined;
if (config.ADMIN_OIDC_ISSUER || config.ADMIN_DEV_LOGIN) {
  try {
    const oidc = config.ADMIN_OIDC_ISSUER
      ? await OidcLogin.discover({
          issuer: config.ADMIN_OIDC_ISSUER,
          clientId: config.ADMIN_OIDC_CLIENT_ID!,
          clientSecret: config.ADMIN_OIDC_CLIENT_SECRET!,
          redirectUri: new URL("/auth/callback", config.ADMIN_PUBLIC_URL).href,
        })
      : undefined;
    admin = await buildAdminServer({
      config,
      store,
      memory,
      sessions: new AdminSessionStore(db),
      coding: coding?.sessions,
      tools: () => ({ builtin: tools().filter((t) => !t.source).map((t) => t.name), servers: mcp.report }),
      oidc,
      runtime,
      log: log.child({ component: "admin" }),
    });
    await admin.listen({ port: config.ADMIN_PORT, host: config.ADMIN_HOST });
    log.info({ url: config.ADMIN_PUBLIC_URL, sso: !!oidc, devLogin: config.ADMIN_DEV_LOGIN }, "admin UI is running");
  } catch (err) {
    // Heinzel keeps working in chat without its admin UI.
    log.error({ err }, "admin UI could not start");
  }
}

health.setReady(true);
log.info({ platforms: [...adapters.keys()], mcpServers: mcp.servers, coding: !!engine.coding, agentModel: config.LLM_MODEL_AGENT, triageModel: config.LLM_MODEL_TRIAGE }, `${config.BOT_NAME} is running`);

async function housekeeping(): Promise<void> {
  try {
    const pruned = await store.pruneOldData(config.EVENTS_RETENTION_DAYS);
    if (pruned.events || pruned.jobs) log.info(pruned, "pruned old data");
  } catch (err) {
    log.warn({ err }, "housekeeping failed");
  }
}
await housekeeping();
setInterval(() => void housekeeping(), 6 * 3_600_000).unref();

if (engine.coding) {
  const maintainCoding = () => engine.coding!.maintain().catch((err) => log.warn({ err }, "coding maintenance failed"));
  await maintainCoding();
  setInterval(() => void maintainCoding(), 5 * 60_000).unref();
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  health.setReady(false);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  for (const a of adapters.values()) await a.stop().catch((err) => log.warn({ err }, "adapter stop failed"));
  await admin?.close().catch((err) => log.warn({ err }, "admin UI stop failed"));
  await worker.stop();
  await runtime.stop().catch(() => {});
  await mcp.stop();
  await health.close().catch(() => {});
  await db.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/** Namespace of this pod, for coding Jobs when CODING_K8S_NAMESPACE is not set. */
function currentNamespace(): string {
  try {
    return readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
  } catch {
    return "default";
  }
}
