import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export type LlmMessage = ChatCompletionMessageParam;
export type LlmTool = ChatCompletionTool;

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object. Honoured according to LLM_STRUCTURED_OUTPUT. */
  json?: { name: string; schema: Record<string, unknown> };
  /** Attribution for cost tracking in the gateway (channel, purpose, trace). */
  meta?: { channelKey?: string | null; purpose: string; traceId?: string };
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string | null;
}

/** Everything above this interface is gateway-agnostic. Tests use a fake implementation. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface OpenAiCompatibleOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  metadataStyle: "requesty" | "none";
  structuredOutput: "none" | "json_object" | "json_schema";
}

/** Works with any OpenAI-compatible chat completions endpoint: Requesty, LiteLLM, vLLM, Azure OpenAI, ... */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };

    if (req.json && this.opts.structuredOutput === "json_object") {
      params.response_format = { type: "json_object" };
    } else if (req.json && this.opts.structuredOutput === "json_schema") {
      params.response_format = {
        type: "json_schema",
        json_schema: { name: req.json.name, schema: req.json.schema, strict: true },
      };
    }

    if (req.meta && this.opts.metadataStyle === "requesty") {
      // https://docs.requesty.ai/features/request-metadata
      params.requesty = {
        tags: ["heinzel", req.meta.purpose],
        ...(req.meta.traceId ? { trace_id: req.meta.traceId } : {}),
        extra: { app: "heinzel", purpose: req.meta.purpose, channel: req.meta.channelKey ?? "none" },
      };
    }

    const res = await this.client.chat.completions.create(params);
    const choice = res.choices[0];
    const toolCalls: LlmToolCall[] = [];
    for (const tc of choice?.message.tool_calls ?? []) {
      if (tc.type === "function") toolCalls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
    return {
      content: choice?.message.content ?? null,
      toolCalls,
      usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
      finishReason: choice?.finish_reason ?? null,
    };
  }
}

/**
 * Extracts the first JSON object from model output. Tolerates code fences and prose around it,
 * which many models add even when told not to.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in model output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("Unterminated JSON object in model output");
}
