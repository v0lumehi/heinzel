import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/llm/client.js";
import { toOrTsQuery } from "../src/memory/memory.js";
import { checkSpeakBudget, parseTriageDecision, preFilter } from "../src/triage/triage.js";
import { msg } from "./helpers.js";

describe("extractJsonObject", () => {
  it("handles fences, prose and nested braces", () => {
    expect(extractJsonObject('Sure:\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: "}" } });
    expect(extractJsonObject('I think {"x": 1} is right')).toEqual({ x: 1 });
    expect(() => extractJsonObject("no json")).toThrow();
  });
});

describe("parseTriageDecision", () => {
  it("normalizes strict-schema placeholders", () => {
    const d = parseTriageDecision('{"action":"reply","confidence":0.9,"reason":"open question","memory":"","follow_up_hours":0}');
    expect(d).toEqual({ action: "reply", confidence: 0.9, reason: "open question" });
  });
  it("rejects invalid actions", () => {
    expect(() => parseTriageDecision('{"action":"shout","confidence":1,"reason":""}')).toThrow();
  });
});

describe("preFilter", () => {
  it("skips chatter, bots and emoji-only messages", () => {
    expect(preFilter(msg({ text: "ok" }))).toBe("skip");
    expect(preFilter(msg({ text: ":tada: :tada: :rocket:" }))).toBe("skip");
    expect(preFilter(msg({ text: "🎉🎉🎉🎉🎉🎉🎉🎉" }))).toBe("skip");
    expect(preFilter(msg({ isBot: true }))).toBe("skip");
    expect(preFilter(msg({ text: "Who owns the billing service?" }))).toBe("triage");
  });
});

describe("checkSpeakBudget", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("enforces daily limit and thread cooldown", () => {
    expect(checkSpeakBudget({ unsolicitedLast24h: 0, dailyLimit: 5, lastUnsolicitedInThread: null, threadCooldownMin: 30, now })).toEqual({ allowed: true });
    expect(checkSpeakBudget({ unsolicitedLast24h: 5, dailyLimit: 5, lastUnsolicitedInThread: null, threadCooldownMin: 30, now }).allowed).toBe(false);
    expect(checkSpeakBudget({ unsolicitedLast24h: 0, dailyLimit: 0, lastUnsolicitedInThread: null, threadCooldownMin: 30, now }).allowed).toBe(false);
    const recent = new Date(now.getTime() - 10 * 60_000);
    expect(checkSpeakBudget({ unsolicitedLast24h: 1, dailyLimit: 5, lastUnsolicitedInThread: recent, threadCooldownMin: 30, now }).allowed).toBe(false);
    const old = new Date(now.getTime() - 60 * 60_000);
    expect(checkSpeakBudget({ unsolicitedLast24h: 1, dailyLimit: 5, lastUnsolicitedInThread: old, threadCooldownMin: 30, now }).allowed).toBe(true);
  });
});

describe("toOrTsQuery", () => {
  it("builds a safe OR query", () => {
    expect(toOrTsQuery("Deploy: prod & staging's (eu)!")).toBe("deploy | prod | staging | eu");
    expect(toOrTsQuery("!! ?")).toBe("");
  });
});
