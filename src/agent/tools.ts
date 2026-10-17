import { z } from "zod";
import type { LlmTool } from "../llm/client.js";
import { ORG_SCOPE_KEY, type MemoryScope, type MemoryStore } from "../memory/memory.js";
import type { JobQueue } from "../queue/queue.js";

/** What a tool may know about the conversation it runs in. */
export interface ToolContext {
  channelKey: string;
  threadRef: string;
  /** '<platform>:<user id>' of the person Heinzel is responding to, if any. */
  userKey: string | null;
  eventId: number;
  memory: MemoryStore;
  queue: JobQueue;
}

export interface AgentTool<A = unknown> {
  name: string;
  description: string;
  args: z.ZodType<A>;
  /** JSON Schema shown to the model. Kept explicit so it is readable and portable across providers. */
  parameters: Record<string, unknown>;
  /** Name of the MCP server this tool comes from; unset for built-in tools. */
  source?: string;
  /** Only offered when a person addressed Heinzel directly (never in ambient, thread-triage or follow-up runs). */
  directOnly?: boolean;
  run(args: A, ctx: ToolContext): Promise<string>;
}

export function toLlmTools(tools: AgentTool[]): LlmTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function memoryScopes(ctx: Pick<ToolContext, "channelKey" | "userKey">): { scope: MemoryScope; scopeKey: string }[] {
  const scopes: { scope: MemoryScope; scopeKey: string }[] = [
    { scope: "channel", scopeKey: ctx.channelKey },
    { scope: "org", scopeKey: ORG_SCOPE_KEY },
  ];
  if (ctx.userKey) scopes.push({ scope: "user", scopeKey: ctx.userKey });
  return scopes;
}

function scopeKeyFor(scope: MemoryScope, ctx: ToolContext): string | null {
  if (scope === "channel") return ctx.channelKey;
  if (scope === "org") return ORG_SCOPE_KEY;
  return ctx.userKey;
}

const rememberTool: AgentTool<{ content: string; scope: MemoryScope }> = {
  name: "remember",
  description:
    "Store a durable fact for later: decisions, owners, conventions, recurring problems and their fixes, preferences the team stated. " +
    "Write one self-contained sentence. Do not store secrets, credentials, personal data beyond names and roles, or chit-chat.",
  args: z.object({ content: z.string().min(3).max(2000), scope: z.enum(["channel", "org", "user"]).default("channel") }),
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact, as one self-contained sentence." },
      scope: {
        type: "string",
        enum: ["channel", "org", "user"],
        description: "channel = relevant to this channel (default); org = true company-wide; user = about the person you are talking to.",
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const key = scopeKeyFor(args.scope, ctx);
    if (!key) return "Cannot store a user memory here: no user in context.";
    const m = await ctx.memory.add({ scope: args.scope, scopeKey: key, content: args.content, createdBy: "agent", sourceEvent: ctx.eventId });
    return `Stored memory #${m.id} (${m.scope}).`;
  },
};

const recallTool: AgentTool<{ query: string }> = {
  name: "recall",
  description: "Search team memory (this channel, company-wide, and the current person) for facts relevant to a query.",
  args: z.object({ query: z.string().max(500) }),
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords to search for. Empty returns the most recent memories." } },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const found = await ctx.memory.search({ scopes: memoryScopes(ctx), text: args.query, limit: 10 });
    if (found.length === 0) return "No matching memories.";
    return found.map((m) => `#${m.id} [${m.scope}, ${m.createdAt.toISOString().slice(0, 10)}] ${m.content}`).join("\n");
  },
};

const forgetTool: AgentTool<{ id: number }> = {
  name: "forget",
  description: "Delete a memory by id when someone says it is wrong or outdated, or asks you to forget it.",
  args: z.object({ id: z.number().int().positive() }),
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "Memory id as shown by recall (#123 → 123)." } },
    required: ["id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const ok = await ctx.memory.forget(args.id, memoryScopes(ctx));
    return ok ? `Deleted memory #${args.id}.` : `Memory #${args.id} not found in this context.`;
  },
};

const followupTool: AgentTool<{ hours: number; note: string }> = {
  name: "schedule_followup",
  description:
    "Check back on this thread later, e.g. when someone promised to do something or a question is waiting for an answer. " +
    "If the thread gets new messages in the meantime, you will still be woken and can decide that nothing is needed.",
  args: z.object({ hours: z.number().min(0.25).max(24 * 14), note: z.string().min(3).max(500) }),
  parameters: {
    type: "object",
    properties: {
      hours: { type: "number", description: "When to check back, in hours (0.25 – 336)." },
      note: { type: "string", description: "What to check, for your future self." },
    },
    required: ["hours", "note"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const runAt = new Date(Date.now() + args.hours * 3_600_000);
    const id = await ctx.queue.enqueue(
      "followup",
      { channelKey: ctx.channelKey, threadRef: ctx.threadRef, note: args.note, scheduledAfterEventId: ctx.eventId },
      { runAt, dedupeKey: followupDedupeKey(ctx.channelKey, ctx.threadRef) },
    );
    return id === null
      ? "A follow-up for this thread is already scheduled."
      : `Follow-up scheduled for ${runAt.toISOString()}.`;
  },
};

/** Name of the control tool that hands the task to the heavy model. Handled by the runner, not executed. */
export const ESCALATE_TOOL = "escalate";

export const escalateTool: AgentTool<{ reason: string }> = {
  name: ESCALATE_TOOL,
  description:
    "Hand this task to a stronger model when it needs deep reasoning: multi-step analysis or planning, non-trivial code, " +
    "long documents, careful trade-offs, or when you tried and are not confident. Call it early, before writing an answer. " +
    "Do not call it for simple questions, lookups or chit-chat.",
  args: z.object({ reason: z.string().min(3).max(500) }),
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Why this needs the stronger model, in one sentence." } },
    required: ["reason"],
    additionalProperties: false,
  },
  async run() {
    return "Escalation is handled by the runtime.";
  },
};

export function followupDedupeKey(channelKey: string, threadRef: string): string {
  return `followup:${channelKey}:${threadRef}`;
}

export const defaultTools: AgentTool[] = [rememberTool, recallTool, forgetTool, followupTool] as AgentTool[];
