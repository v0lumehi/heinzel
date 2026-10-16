import type { ChatEvent } from "../core/types.js";
import type { Memory } from "../memory/memory.js";

export type RespondMode = "direct" | "ambient" | "thread" | "followup";

export interface PromptInput {
  botName: string;
  platform: string;
  channelName: string | null;
  isDirect: boolean;
  channelInstructions: string;
  mode: RespondMode;
  /** Why Heinzel is speaking (from triage or follow-up note). */
  reason?: string;
  memories: Memory[];
  now: Date;
}

export function buildSystemPrompt(p: PromptInput): string {
  const where = p.isDirect ? `a direct message on ${p.platform}` : `the ${p.platform} channel ${p.channelName ? `#${p.channelName}` : "(unnamed)"}`;
  const parts: string[] = [
    `You are ${p.botName}, an AI teammate embedded in a team's chat. You are currently in ${where}.`,
    `Current time: ${p.now.toISOString()}.`,
    "",
    "How you work:",
    "- You are one shared teammate for everyone in the channel. Several people may talk to you in the same thread.",
    "- Be concise and concrete. Chat, not essays: short paragraphs, lists only when they help scanning.",
    "- Answer in the language the people in the thread are using.",
    "- Never pretend to be a human or to act on someone's behalf. You act under your own identity.",
    "- If you are unsure or lack access, say so plainly instead of guessing.",
    "- Use `remember` for durable facts the team will want later (decisions, owners, conventions). Use `recall` before saying you do not know something the team may have told you.",
    "- Use `schedule_followup` when someone commits to something or a question is left open and checking back later would help.",
    "- Never reveal or store secrets, tokens or credentials.",
  ];

  if (p.mode === "ambient") {
    parts.push(
      "",
      "Nobody addressed you. You are considering speaking up on your own because:",
      `  ${p.reason ?? "you might be able to help"}`,
      "Only post if it clearly helps: a correction, missing context, an answer to an open question, or a concrete next step.",
      `If on reflection it does not, reply with exactly ${"SILENT"}. Keep unprompted posts to 1–3 sentences.`,
    );
  } else if (p.mode === "followup") {
    parts.push(
      "",
      "You scheduled a follow-up on this thread earlier. Your note to yourself:",
      `  ${p.reason ?? "(no note)"}`,
      "Look at what happened since. If the matter is resolved or a nudge would be noise, reply with exactly SILENT.",
      "Otherwise post one short, friendly check-in and tag the relevant person by name.",
    );
  } else if (p.mode === "thread") {
    parts.push(
      "",
      "You are part of this thread and someone replied without tagging you. Reply only if the message is meant for you",
      "or you can clearly help; otherwise reply with exactly SILENT.",
    );
  }

  if (p.channelInstructions.trim()) {
    parts.push("", "Standing instructions for this channel (from the team):", p.channelInstructions.trim());
  }

  if (p.memories.length) {
    parts.push("", "Relevant team memory (may be outdated; prefer what people say in the thread):");
    for (const m of p.memories) parts.push(`- #${m.id} [${m.scope}] ${m.content}`);
  }

  return parts.join("\n");
}

/**
 * Renders a multi-person conversation as a transcript inside one user message.
 * Mapping each person to the "user" role would lose who said what.
 */
export function renderTranscript(events: ChatEvent[], botName: string, focusMessageId?: string): string {
  const lines = events.map((e) => {
    const who = e.isSelf ? `${botName} (you)` : `${e.userName ?? e.userId}${e.isBot ? " [bot]" : ""}`;
    const marker = e.messageId === focusMessageId ? " ← latest" : "";
    return `[${e.sentAt.toISOString().slice(0, 16).replace("T", " ")}] ${who}: ${e.text}${marker}`;
  });
  return ["Conversation so far:", "", ...lines].join("\n");
}

export function finalInstruction(mode: RespondMode, focus: ChatEvent | null): string {
  if (mode === "direct" && focus) {
    return `Respond to the latest message from ${focus.userName ?? focus.userId}.`;
  }
  if (mode === "thread" && focus) {
    return `Decide whether to respond to the latest message from ${focus.userName ?? focus.userId} (or reply SILENT).`;
  }
  if (mode === "followup") return "Decide whether to post a follow-up now (or reply SILENT).";
  return "Write your contribution now (or reply SILENT).";
}
