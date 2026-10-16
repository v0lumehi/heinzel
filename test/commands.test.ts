import { describe, expect, it } from "vitest";
import { parseCommand, stripLeadingMentions } from "../src/core/commands.js";

describe("commands", () => {
  it("strips leading mentions", () => {
    expect(stripLeadingMentions("@Heinzel, @Anna: what's up")).toBe("what's up");
    expect(stripLeadingMentions("hey @Heinzel")).toBe("hey @Heinzel");
  });

  it("parses admin commands", () => {
    expect(parseCommand("@Heinzel !ambient on")).toEqual({ kind: "ambient", enabled: true });
    expect(parseCommand("@Heinzel !ambient aus")).toEqual({ kind: "ambient", enabled: false });
    expect(parseCommand("!limit 3")).toEqual({ kind: "limit", perDay: 3 });
    expect(parseCommand("!limit default")).toEqual({ kind: "limit", perDay: null });
    expect(parseCommand("!instructions Antworte immer auf Deutsch.")).toEqual({ kind: "instructions-set", text: "Antworte immer auf Deutsch." });
    expect(parseCommand("!instructions clear")).toEqual({ kind: "instructions-clear" });
    expect(parseCommand("!memories deploy")).toEqual({ kind: "memories", query: "deploy" });
    expect(parseCommand("!status")).toEqual({ kind: "status" });
    expect(parseCommand("!ambient maybe")?.kind).toBe("unknown");
  });

  it("treats normal messages as non-commands", () => {
    expect(parseCommand("@Heinzel how do I deploy?")).toBeNull();
    expect(parseCommand("@Heinzel this is great!")).toBeNull();
  });
});
