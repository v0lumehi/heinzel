/**
 * Admin commands, addressed to Heinzel with a "!" prefix, e.g. "@Heinzel !ambient on".
 * Handled without an LLM call so configuration is predictable and free.
 */

export type Command =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "ambient"; enabled: boolean }
  | { kind: "limit"; perDay: number | null }
  | { kind: "instructions-show" }
  | { kind: "instructions-set"; text: string }
  | { kind: "instructions-clear" }
  | { kind: "memories"; query: string }
  | { kind: "deep"; text: string }
  | { kind: "unknown"; raw: string };

/** Removes leading mentions like "@Heinzel" so commands and prompts see only the actual message. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(\s*@[\p{L}\p{N}._-]+[,:]?\s*)+/u, "").trim();
}

/** Message text as the model should see it: no leading mentions, no "!deep" routing prefix. */
export function cleanForPrompt(text: string): string {
  const t = stripLeadingMentions(text);
  return (t.replace(/^!(deep|think)\s+/i, "") || text).trim();
}

export function parseCommand(text: string): Command | null {
  const t = stripLeadingMentions(text);
  if (!t.startsWith("!")) return null;
  const [head = "", ...rest] = t.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (head.toLowerCase()) {
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "ambient": {
      const v = arg.toLowerCase();
      if (["on", "an", "true", "1"].includes(v)) return { kind: "ambient", enabled: true };
      if (["off", "aus", "false", "0"].includes(v)) return { kind: "ambient", enabled: false };
      return { kind: "unknown", raw: t };
    }
    case "limit": {
      if (arg.toLowerCase() === "default") return { kind: "limit", perDay: null };
      const n = Number(arg);
      return Number.isInteger(n) && n >= 0 && n <= 1000 ? { kind: "limit", perDay: n } : { kind: "unknown", raw: t };
    }
    case "instructions":
    case "anweisungen": {
      if (!arg) return { kind: "instructions-show" };
      if (["clear", "reset", "löschen"].includes(arg.toLowerCase())) return { kind: "instructions-clear" };
      return { kind: "instructions-set", text: arg };
    }
    case "memories":
    case "memory":
      return { kind: "memories", query: arg };
    case "deep":
    case "think":
      return arg ? { kind: "deep", text: arg } : { kind: "unknown", raw: t };
    default:
      return { kind: "unknown", raw: t };
  }
}

export function helpText(botName: string): string {
  return [
    `*${botName} commands* (mention me, then the command):`,
    "`!status` – settings and usage for this channel",
    "`!ambient on|off` – let me speak up without being tagged",
    "`!limit <n>|default` – max unprompted posts per day here",
    "`!instructions <text>` – standing instructions for this channel (`!instructions` shows, `!instructions clear` removes)",
    "`!memories [query]` – what I remember about this channel",
    "`!deep <question>` – answer with the stronger model right away",
  ].join("\n");
}
