import pino from "pino";
import { loadConfig, type Config } from "../src/config.js";
import type { ChatAdapter, ChatEvent, EventHandler, OutboundMessage, SentMessage } from "../src/core/types.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/client.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const silentLog = pino({ level: "silent" });

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? "postgres://unused",
    LLM_API_KEY: "test",
    LLM_MODEL_AGENT: "agent-model",
    LLM_MODEL_TRIAGE: "triage-model",
    ...overrides,
  });
}

/** Fresh schema for each test file. */
export async function freshDb(): Promise<Db> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL not set");
  const db = createPool(TEST_DATABASE_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}

export function reply(content: string, toolCalls: LlmResponse["toolCalls"] = []): LlmResponse {
  return { content, toolCalls, usage: { promptTokens: 10, completionTokens: 5 }, finishReason: toolCalls.length ? "tool_calls" : "stop" };
}

/** LLM fake: a function decides each response from the request, and every request is recorded. */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(public respond: (req: LlmRequest, n: number) => LlmResponse) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return this.respond(req, this.requests.length);
  }
  byModel(model: string): LlmRequest[] {
    return this.requests.filter((r) => r.model === model);
  }
}

export class FakeAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  readonly sent: (OutboundMessage & SentMessage)[] = [];
  readonly acks: string[] = [];
  history: ChatEvent[] = [];
  private seq = 1000;

  async start(_onEvent: EventHandler): Promise<void> {}
  async stop(): Promise<void> {}
  async send(m: OutboundMessage): Promise<SentMessage> {
    const messageId = `bot-${this.seq++}`;
    const threadId = m.threadId ?? messageId;
    this.sent.push({ ...m, messageId, threadId });
    return { messageId, threadId };
  }
  async fetchThread(channelId: string, threadId: string): Promise<ChatEvent[]> {
    return this.history.filter((e) => e.channelId === channelId && e.threadId === threadId);
  }
  async fetchRecent(channelId: string): Promise<ChatEvent[]> {
    return this.history.filter((e) => e.channelId === channelId && e.threadId === e.messageId);
  }
  async acknowledge(_c: string, messageId: string): Promise<void> {
    this.acks.push(messageId);
  }
}

let msgSeq = 1;
export function msg(over: Partial<ChatEvent> = {}): ChatEvent {
  const id = over.messageId ?? `m${msgSeq++}`;
  return {
    platform: "slack",
    channelId: "C1",
    channelName: "general",
    threadId: id,
    messageId: id,
    userId: "U1",
    userName: "Anna",
    text: "Hello there, does anyone know how deployments work?",
    isBot: false,
    isSelf: false,
    mentionsBot: false,
    isDirect: false,
    sentAt: new Date(),
    ...over,
  };
}
