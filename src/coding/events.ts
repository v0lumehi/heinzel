import type { CodingProgress, CodingResult } from "../store/coding.js";

/** Marker line the coding container prints last (see coder/entrypoint.sh). */
export const RESULT_MARKER = "HEINZEL_RESULT ";
const MAX_RECENT = 6;

export interface ParsedLogs {
  progress: CodingProgress;
  result: CodingResult | null;
  /** Token usage per agent step, for cost tracking. */
  usage: { inputTokens: number; outputTokens: number }[];
  /** Plain stderr lines (setup output, errors), last few. */
  stderrTail: string[];
}

interface OpenCodeEvent {
  type?: string;
  part?: {
    type?: string;
    tool?: string;
    text?: string;
    state?: { status?: string; title?: string; input?: Record<string, unknown>; error?: string };
    tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  };
  error?: { name?: string; data?: { message?: string }; message?: string };
}

/** One readable line per tool call, e.g. "edit src/app.ts" or "$ pnpm test". */
export function describeTool(tool: string, state: NonNullable<NonNullable<OpenCodeEvent["part"]>["state"]>): string {
  const input = state.input ?? {};
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const path = (p: string) => p.replace(/^\/workspace\//, "");
  let line: string;
  switch (tool) {
    case "shell":
      line = `$ ${short(str("command").split("\n")[0] ?? "")}`;
      break;
    case "edit":
    case "write":
    case "read":
      line = `${tool} ${path(str("path")) || state.title || ""}`;
      break;
    case "grep":
    case "glob":
      line = `${tool} ${short(str("pattern"), 60)}`;
      break;
    default:
      line = `${tool}${state.title ? ` ${short(state.title, 60)}` : ""}`;
  }
  return state.status === "error" ? `${line} (failed)` : line;
}

/** Folds new OpenCode 2 events (`run --format json`) into the progress so far. Unknown lines are ignored. */
export function parseLogs(lines: { stream: string; text: string }[], previous: CodingProgress): ParsedLogs {
  const progress: CodingProgress = { ...previous, recent: [...(previous.recent ?? [])] };
  const usage: ParsedLogs["usage"] = [];
  const stderrTail: string[] = [];
  let result: CodingResult | null = null;

  for (const { stream, text } of lines) {
    if (text.startsWith(RESULT_MARKER)) {
      try {
        result = JSON.parse(text.slice(RESULT_MARKER.length)) as CodingResult;
      } catch {
        result = { status: "failed", error: "unreadable result from coding container" };
      }
      continue;
    }
    if (stream === "stderr" || !text.startsWith("{")) {
      stderrTail.push(text);
      continue;
    }
    let ev: OpenCodeEvent;
    try {
      ev = JSON.parse(text) as OpenCodeEvent;
    } catch {
      stderrTail.push(text);
      continue;
    }
    if (ev.type === "tool_use" && ev.part?.tool && ev.part.state) {
      progress.recent!.push(describeTool(ev.part.tool, ev.part.state));
    } else if (ev.type === "text" && ev.part?.text?.trim()) {
      progress.lastText = ev.part.text.trim();
    } else if (ev.type === "step_finish") {
      progress.steps = (progress.steps ?? 0) + 1;
      const t = ev.part?.tokens;
      if (t) {
        const input = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        const output = t.output ?? 0;
        progress.inputTokens = (progress.inputTokens ?? 0) + input;
        progress.outputTokens = (progress.outputTokens ?? 0) + output;
        usage.push({ inputTokens: input, outputTokens: output });
      }
    } else if (ev.type === "error") {
      progress.lastError = ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? "agent error";
    }
  }
  progress.recent = progress.recent!.slice(-MAX_RECENT);
  return { progress, result, usage, stderrTail: stderrTail.slice(-20) };
}
