import { z } from "zod";
import type { ChatEvent } from "../core/types.js";
import { extractJsonObject, type LlmClient, type LlmRequest } from "../llm/client.js";
import { renderTranscript } from "../agent/prompt.js";

/**
 * Ambient triage, stage 1: cheap and fast. Decides what (if anything) to do with a message nobody addressed
 * Heinzel in. Stage 2 (the real agent run) only happens when this says "reply".
 */

export const triageDecisionSchema = z.object({
  action: z.enum(["ignore", "remember", "reply", "follow_up"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).default(""),
  memory: z.string().max(1000).optional(),
  follow_up_hours: z.number().min(0.25).max(336).optional(),
  /** Only meaningful for "reply": "complex" routes the answer to the heavy model when one is configured. */
  complexity: z.enum(["simple", "complex"]).default("simple"),
});
export type TriageDecision = z.infer<typeof triageDecisionSchema>;

export const IGNORE: TriageDecision = { action: "ignore", confidence: 1, reason: "pre-filter", complexity: "simple" };

const triageJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ignore", "remember", "reply", "follow_up"] },
    confidence: { type: "number" },
    reason: { type: "string" },
    memory: { type: "string" },
    follow_up_hours: { type: "number" },
    complexity: { type: "string", enum: ["simple", "complex"] },
  },
  required: ["action", "confidence", "reason", "memory", "follow_up_hours", "complexity"],
  additionalProperties: false,
};

/** Rule-based pre-filter: messages that never warrant an LLM call. */
export function preFilter(e: ChatEvent): "skip" | "triage" {
  if (e.isSelf || e.isBot) return "skip";
  const text = e.text.trim();
  if (text.length < 8) return "skip"; // "ok", "thx", "+1", single emoji
  const withoutEmoji = text.replace(/:[a-z0-9_+-]+:/gi, "").replace(/\p{Extended_Pictographic}/gu, "").trim();
  if (withoutEmoji.length < 4) return "skip";
  return "triage";
}

export interface TriageInput {
  botName: string;
  channelName: string | null;
  channelInstructions: string;
  botInThread: boolean;
  context: ChatEvent[];
  message: ChatEvent;
}

export function buildTriagePrompt(t: TriageInput): { system: string; user: string } {
  const system = [
    `You are the triage step of ${t.botName}, an AI teammate that silently follows a team chat channel` +
      (t.channelName ? ` (#${t.channelName})` : "") + ".",
    "For the latest message, decide the single best action:",
    '- "ignore": nothing to do. This is the right answer for the vast majority of messages.',
    '- "remember": the message contains a durable fact worth storing (a decision, an owner, a convention, a fix). Put it in "memory" as one self-contained sentence.',
    `- "reply": ${t.botName} should speak up now because it can clearly help: an unanswered question it can answer, a factual error worth correcting, missing context, or a concrete next step.`,
    '- "follow_up": someone committed to something or a question is open; checking back later would help. Set "follow_up_hours".',
    "",
    "Be conservative. Unprompted messages from a bot are annoying when they are not clearly useful.",
    "Never reply to social chatter, jokes, thanks, or messages clearly directed at a specific human.",
    t.botInThread ? `${t.botName} already took part in this thread, so a direct follow-up question to it is likely meant for it.` : "",
    t.channelInstructions.trim() ? `\nStanding instructions for this channel:\n${t.channelInstructions.trim()}` : "",
    "",
    'For "reply", set "complexity" to "complex" if a good answer needs deep reasoning (multi-step analysis, non-trivial code, careful trade-offs), otherwise "simple".',
    "",
    'Answer with one JSON object only: {"action": ..., "confidence": 0..1, "reason": "...", "memory": "...", "follow_up_hours": number, "complexity": "simple"|"complex"}.',
    'Use "" for memory and 0 for follow_up_hours when they do not apply.',
  ]
    .filter((l) => l !== "")
    .join("\n");

  const user = `${renderTranscript([...t.context, t.message], t.botName, t.message.messageId)}\n\nDecide for the message marked "← latest".`;
  return { system, user };
}

export function parseTriageDecision(raw: string): TriageDecision {
  const obj = extractJsonObject(raw) as Record<string, unknown>;
  // Normalize "not applicable" placeholders from strict-schema models.
  if (obj.memory === "") delete obj.memory;
  if (obj.follow_up_hours === 0) delete obj.follow_up_hours;
  return triageDecisionSchema.parse(obj);
}

export async function triageMessage(
  llm: LlmClient,
  model: string,
  input: TriageInput,
  meta: NonNullable<LlmRequest["meta"]>,
  onUsage?: (u: { promptTokens: number; completionTokens: number }) => Promise<void>,
): Promise<TriageDecision> {
  const { system, user } = buildTriagePrompt(input);
  const res = await llm.complete({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    maxTokens: 300,
    json: { name: "triage_decision", schema: triageJsonSchema },
    meta,
  });
  await onUsage?.(res.usage);
  try {
    return parseTriageDecision(res.content ?? "");
  } catch {
    // Unparseable output is treated as "do nothing" rather than retried: triage must never cause noise.
    return { action: "ignore", confidence: 0, reason: "unparseable triage output", complexity: "simple" };
  }
}

// ---------- guardrails ----------

export interface SpeakBudget {
  unsolicitedLast24h: number;
  dailyLimit: number;
  lastUnsolicitedInThread: Date | null;
  threadCooldownMin: number;
  now: Date;
}

/** Hard limits on unprompted posts, applied before any expensive agent run. */
export function checkSpeakBudget(b: SpeakBudget): { allowed: true } | { allowed: false; why: string } {
  if (b.dailyLimit <= 0) return { allowed: false, why: "unsolicited posts disabled for this channel" };
  if (b.unsolicitedLast24h >= b.dailyLimit) return { allowed: false, why: `daily limit of ${b.dailyLimit} reached` };
  if (b.lastUnsolicitedInThread) {
    const minutes = (b.now.getTime() - b.lastUnsolicitedInThread.getTime()) / 60_000;
    if (minutes < b.threadCooldownMin) return { allowed: false, why: `thread cooldown (${Math.round(minutes)}/${b.threadCooldownMin} min)` };
  }
  return { allowed: true };
}
