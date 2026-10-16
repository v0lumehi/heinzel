import type { Logger } from "pino";
import type { LlmClient, LlmMessage, LlmRequest } from "../llm/client.js";
import { ESCALATE_TOOL, toLlmTools, type AgentTool, type ToolContext } from "./tools.js";

export interface AgentRunInput {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  toolContext: ToolContext;
  maxSteps: number;
  meta: NonNullable<LlmRequest["meta"]>;
  onUsage?: (u: { model: string; promptTokens: number; completionTokens: number }) => Promise<void>;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  toolCalls: { name: string; ok: boolean }[];
  /** Set when the model called the escalate tool; the caller should re-run the task on the heavy model. */
  escalation?: { reason: string };
}

/** Marker the model returns when it decides not to post anything. */
export const SILENT = "SILENT";

export function isSilent(text: string): boolean {
  const t = text.trim().replace(/^[*_`"']+|[*_`"'.!]+$/g, "");
  return t === "" || t.toUpperCase() === SILENT;
}

/** Classic tool loop: call the model, run requested tools, feed results back, until it answers in text. */
export async function runAgent(llm: LlmClient, input: AgentRunInput, log: Logger): Promise<AgentRunResult> {
  const messages: LlmMessage[] = [{ role: "system", content: input.system }, ...input.messages];
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const llmTools = toLlmTools(input.tools);
  const calls: AgentRunResult["toolCalls"] = [];

  for (let step = 1; step <= input.maxSteps; step++) {
    const lastStep = step === input.maxSteps;
    const res = await llm.complete({
      model: input.model,
      messages: lastStep
        ? [...messages, { role: "user", content: "Tool budget exhausted. Give your final answer now, without calling tools." }]
        : messages,
      tools: lastStep ? undefined : llmTools,
      meta: input.meta,
    });
    await input.onUsage?.({ model: input.model, ...res.usage });

    if (res.toolCalls.length === 0 || lastStep) {
      return { text: (res.content ?? "").trim(), steps: step, toolCalls: calls };
    }

    const esc = res.toolCalls.find((tc) => tc.name === ESCALATE_TOOL && byName.has(ESCALATE_TOOL));
    if (esc) {
      let reason = "needs deeper reasoning";
      try {
        const parsed = JSON.parse(esc.arguments || "{}") as { reason?: unknown };
        if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim().slice(0, 500);
      } catch {
        // keep default reason
      }
      calls.push({ name: ESCALATE_TOOL, ok: true });
      return { text: "", steps: step, toolCalls: calls, escalation: { reason } };
    }

    messages.push({
      role: "assistant",
      content: res.content ?? null,
      tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })),
    });

    for (const tc of res.toolCalls) {
      const tool = byName.get(tc.name);
      let output: string;
      let ok = false;
      if (!tool) {
        output = `Unknown tool "${tc.name}".`;
      } else {
        try {
          const parsed = tool.args.safeParse(tc.arguments ? JSON.parse(tc.arguments) : {});
          if (!parsed.success) {
            output = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          } else {
            output = await tool.run(parsed.data, input.toolContext);
            ok = true;
          }
        } catch (err) {
          log.warn({ err, tool: tc.name }, "tool failed");
          output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      calls.push({ name: tc.name, ok });
      messages.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
  }
  // Unreachable: the last step always returns.
  return { text: "", steps: input.maxSteps, toolCalls: calls };
}
