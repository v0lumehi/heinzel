import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isSilent, runAgent } from "../src/agent/runner.js";
import type { AgentTool, ToolContext } from "../src/agent/tools.js";
import { FakeLlm, reply, silentLog } from "./helpers.js";

const ctx = {} as ToolContext;
const echo: AgentTool<{ text: string }> = {
  name: "echo",
  description: "echo",
  args: z.object({ text: z.string() }),
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: async (a) => `echo:${a.text}`,
};

function base(llm: FakeLlm, maxSteps = 5) {
  return runAgent(llm, { model: "m", system: "sys", messages: [{ role: "user", content: "hi" }], tools: [echo as AgentTool], toolContext: ctx, maxSteps, meta: { purpose: "agent" } }, silentLog);
}

describe("runAgent", () => {
  it("runs tools and feeds results back", async () => {
    const llm = new FakeLlm((_req, n) => (n === 1 ? reply("", [{ id: "t1", name: "echo", arguments: '{"text":"x"}' }]) : reply("done")));
    const res = await base(llm);
    expect(res).toMatchObject({ text: "done", steps: 2, toolCalls: [{ name: "echo", ok: true }] });
    const second = llm.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "t1", content: "echo:x" });
  });

  it("reports invalid arguments and unknown tools to the model instead of throwing", async () => {
    const llm = new FakeLlm((_req, n) =>
      n === 1 ? reply("", [{ id: "a", name: "echo", arguments: "{}" }, { id: "b", name: "nope", arguments: "{}" }]) : reply("ok"));
    const res = await base(llm);
    expect(res.toolCalls).toEqual([{ name: "echo", ok: false }, { name: "nope", ok: false }]);
    const msgs = llm.requests[1]!.messages;
    expect(String((msgs.at(-2) as { content: string }).content)).toMatch(/Invalid arguments/);
    expect(String((msgs.at(-1) as { content: string }).content)).toMatch(/Unknown tool/);
  });

  it("forces a final answer without tools on the last step", async () => {
    const llm = new FakeLlm(() => reply("still working", [{ id: "x", name: "echo", arguments: '{"text":"y"}' }]));
    const res = await base(llm, 3);
    expect(res.steps).toBe(3);
    expect(llm.requests[2]!.tools).toBeUndefined();
    expect(res.text).toBe("still working");
  });

  it("recognizes SILENT variants", () => {
    for (const t of ["SILENT", " silent ", "**SILENT**", "SILENT.", ""]) expect(isSilent(t)).toBe(true);
    expect(isSilent("Silent night is a song")).toBe(false);
  });
});
