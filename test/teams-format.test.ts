import { describe, expect, it } from "vitest";
import { isChannelConversation, markdownToTeams, splitConversationId, teamsToChatEvent, teamsToPlainText } from "../src/adapters/teams/format.js";

const BOT = "28:bot-app-id";
const channel = "19:abc@thread.tacv2";

describe("teamsToChatEvent", () => {
  it("normalizes a channel thread reply with a mention", () => {
    const ev = teamsToChatEvent(
      {
        type: "message",
        id: "1700000000200",
        text: "<at>Heinzel</at> can you look?",
        timestamp: "2023-11-14T22:13:20.000Z",
        from: { id: "29:anna", name: "Anna Muster" },
        recipient: { id: BOT, name: "Heinzel" },
        conversation: { id: `${channel};messageid=1700000000100`, conversationType: "channel" },
        entities: [{ type: "mention", mentioned: { id: BOT, name: "Heinzel" }, text: "<at>Heinzel</at>" }],
        channelData: { channel: { id: channel, name: "deploys" }, team: { id: "19:team@thread.tacv2" } },
      },
      BOT,
    );
    expect(ev).toMatchObject({
      platform: "teams",
      channelId: channel,
      channelName: "deploys",
      threadId: "1700000000100",
      messageId: "1700000000200",
      userId: "29:anna",
      userName: "Anna Muster",
      text: "@Heinzel can you look?",
      mentionsBot: true,
      isDirect: false,
      isBot: false,
      isSelf: false,
    });
    expect(ev?.sentAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("treats a new channel post as its own thread root and names the General channel", () => {
    const ev = teamsToChatEvent(
      { type: "message", id: "5", text: "hi", from: { id: "29:a" }, conversation: { id: channel, conversationType: "channel" }, channelData: { channel: { id: channel } } },
      BOT,
    );
    expect(ev).toMatchObject({ threadId: "5", messageId: "5", channelName: "General", mentionsBot: false });
  });

  it("keeps personal and group chats flat", () => {
    const dm = teamsToChatEvent({ type: "message", id: "7", text: "x", from: { id: "29:a" }, conversation: { id: "a:dm", conversationType: "personal" } }, BOT);
    expect(dm).toMatchObject({ isDirect: true, threadId: "7", channelName: undefined });
    const group = teamsToChatEvent(
      { type: "message", id: "8", text: "x", from: { id: "29:a" }, conversation: { id: "19:g@thread.v2", conversationType: "groupChat", name: "Release crew" } },
      BOT,
    );
    expect(group).toMatchObject({ isDirect: false, threadId: "8", channelName: "Release crew" });
  });

  it("detects other bots and ignores non-message activities", () => {
    const bot = teamsToChatEvent({ type: "message", id: "9", text: "x", from: { id: "28:other", role: "bot" }, conversation: { id: channel } }, BOT);
    expect(bot).toMatchObject({ isBot: true, isSelf: false });
    expect(teamsToChatEvent({ type: "conversationUpdate", id: "1", from: { id: "29:a" }, conversation: { id: channel } }, BOT)).toBeNull();
  });
});

describe("conversation ids", () => {
  it("splits the thread root off a channel conversation id", () => {
    expect(splitConversationId(`${channel};messageid=123`)).toEqual({ conversationId: channel, rootId: "123" });
    expect(splitConversationId("a:dm")).toEqual({ conversationId: "a:dm" });
  });

  it("tells channels from chats by type, else by id", () => {
    expect(isChannelConversation("anything", "channel")).toBe(true);
    expect(isChannelConversation(channel, "personal")).toBe(false);
    expect(isChannelConversation(channel)).toBe(true);
    expect(isChannelConversation("19:g@thread.v2")).toBe(false);
  });
});

describe("teamsToPlainText", () => {
  it("renders mentions, links, line breaks and entities", () => {
    const out = teamsToPlainText('<p><at>Anna Muster</at> see <a href="https://x.dev">docs</a> &amp; <a href="https://y.dev">https://y.dev</a></p><p>a &lt; b&nbsp;c</p>');
    expect(out).toBe("@AnnaMuster see docs (https://x.dev) & https://y.dev\na < b c");
  });
});

describe("markdownToTeams", () => {
  it("turns headings bold and keeps line breaks, but leaves code blocks alone", () => {
    expect(markdownToTeams("# Title\nline one\n- item\n\nnext\n```\na\nb\n```")).toBe("**Title**  \nline one  \n- item\n\nnext  \n```\na\nb\n```");
  });
});
