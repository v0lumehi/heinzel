import pino from "pino";
import { loadConfig } from "./config.js";
import { SlackAdapter } from "./adapters/slack/adapter.js";
import { Engine } from "./core/engine.js";
import type { ChatAdapter, Platform } from "./core/types.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { OpenAiCompatibleClient } from "./llm/client.js";
import { MemoryStore } from "./memory/memory.js";
import { JobQueue } from "./queue/queue.js";
import { Worker } from "./queue/worker.js";
import { Store } from "./store/store.js";

const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  ...(process.stdout.isTTY ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } } : {}),
});

const db = createPool(config.DATABASE_URL);
await migrate(db, (m) => log.info(m));

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
if (config.TEAMS_APP_ID) {
  log.warn("TEAMS_* is set, but the Microsoft Teams adapter is not implemented yet (see docs/ROADMAP.md)");
}
if (adapters.size === 0) {
  log.fatal("No chat platform configured. Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN (see README).");
  process.exit(1);
}

const engine = new Engine({ config, store, memory, queue, llm, adapters, log: log.child({ component: "engine" }) });
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
    await db.end();
    process.exit(1);
  }
}
log.info({ platforms: [...adapters.keys()], agentModel: config.LLM_MODEL_AGENT, triageModel: config.LLM_MODEL_TRIAGE }, `${config.BOT_NAME} is running`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  for (const a of adapters.values()) await a.stop().catch((err) => log.warn({ err }, "adapter stop failed"));
  await worker.stop();
  await db.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
