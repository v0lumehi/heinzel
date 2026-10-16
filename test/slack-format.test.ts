import { describe, expect, it } from "vitest";
import { markdownToMrkdwn, mentionedUserIds, slackToChatEvent, slackToPlainText } from "../src/adapters/slack/format.js";

const me = { botUserId: "UBOT", botId: "BBOT" };

describe("slackToChatEvent", () => {
  it("normalizes a top-level channel message", () => {
    const ev = slackToChatEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi <@UBOT>", ts: "1700000000.000100" }, me);
    expect(ev).toMatchObject({ platform: "slack", channelId: "C1", threadId: "1700000000.000100", messageId: "1700000000.000100", userId: "U1", mentionsBot: true, isDirect: false, isBot: false, isSelf: false });
    expect(ev?.sentAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("uses thread_ts as thread id for replies", () => {
    const ev = slackToChatEvent({ channel: "C1", user: "U1", text: "x", ts: "2.0", thread_ts: "1.0" }, me);
    expect(ev?.threadId).toBe("1.0");
    expect(ev?.messageId).toBe("2.0");
  });

  it("detects DMs, own messages and other bots", () => {
    expect(slackToChatEvent({ channel: "D1", channel_type: "im", user: "U1", text: "x", ts: "1" }, me)?.isDirect).toBe(true);
    const self = slackToChatEvent({ channel: "C1", user: "UBOT", bot_id: "BBOT", text: "x", ts: "1" }, me);
    expect(self).toMatchObject({ isSelf: true, isBot: true });
    const other = slackToChatEvent({ channel: "C1", subtype: "bot_message", bot_id: "BX", text: "x", ts: "1" }, me);
    expect(other).toMatchObject({ isSelf: false, isBot: true, userId: "BX" });
  });

  it("ignores edits, deletes and joins", () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
      expect(slackToChatEvent({ channel: "C1", subtype, ts: "1" }, me)).toBeNull();
    }
  });
});

describe("slackToPlainText", () => {
  it("renders mentions, channels, links and entities", () => {
    const names = new Map([["U1", "Anna"]]);
    const out = slackToPlainText("<@U1> see <#C9|deploys> and <https://x.dev|docs> &amp; <https://y.dev> <!here> a &lt; b", names);
    expect(out).toBe("@Anna see #deploys and docs (https://x.dev) & https://y.dev @here a < b");
    expect(mentionedUserIds("<@U1> <@W2|bob> <@U1>")).toEqual(["U1", "W2"]);
  });
});

describe("markdownToMrkdwn", () => {
  it("converts bold, links, headings and bullets but leaves code alone", () => {
    const out = markdownToMrkdwn("# Title\n**bold** and [docs](https://x.dev)\n- item\n`**not bold**`\n```\n<raw>\n```");
    expect(out).toBe("*Title*\n*bold* and <https://x.dev|docs>\n• item\n`**not bold**`\n```\n<raw>\n```");
  });

  it("turns known @names into real mentions outside code", () => {
    const ids: Record<string, string> = { anna: "U1" };
    const out = markdownToMrkdwn("@Anna did it land? (cc @bob) `@Anna` mail@anna.dev thanks @Anna.", (n) => ids[n.toLowerCase()]);
    expect(out).toBe("<@U1> did it land? (cc @bob) `@Anna` mail@anna.dev thanks <@U1>.");
  });

  it("escapes control characters outside code", () => {
    expect(markdownToMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});
