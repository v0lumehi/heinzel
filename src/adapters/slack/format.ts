import type { ChatEvent } from "../../core/types.js";

/** The subset of a Slack message event Heinzel cares about. */
export interface SlackMessageLike {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SlackIdentity {
  botUserId: string;
  botId: string;
}

/** Subtypes that represent a real message someone wrote. Everything else (joins, edits, deletes, ...) is ignored. */
const MESSAGE_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share", "bot_message", "me_message"]);

export function slackTsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}

/**
 * Converts a Slack message (event or history item) into a ChatEvent.
 * `channelId` must be passed for history items, which do not carry it.
 */
export function slackToChatEvent(
  m: SlackMessageLike,
  me: SlackIdentity,
  extra: { channelId?: string; channelName?: string; userName?: string; text?: string } = {},
): ChatEvent | null {
  if (!MESSAGE_SUBTYPES.has(m.subtype)) return null;
  const channelId = m.channel ?? extra.channelId;
  if (!channelId || !m.ts) return null;
  const rawText = m.text ?? "";
  const isSelf = m.user === me.botUserId || (m.bot_id !== undefined && m.bot_id === me.botId);
  const isBot = isSelf || m.bot_id !== undefined || m.subtype === "bot_message";
  const isDirect = m.channel_type === "im" || channelId.startsWith("D");
  return {
    platform: "slack",
    channelId,
    channelName: extra.channelName,
    threadId: m.thread_ts ?? m.ts,
    messageId: m.ts,
    userId: m.user ?? m.bot_id ?? "unknown",
    userName: extra.userName,
    text: extra.text ?? rawText,
    isBot,
    isSelf,
    mentionsBot: rawText.includes(`<@${me.botUserId}>`),
    isDirect,
    sentAt: slackTsToDate(m.ts),
  };
}

/** User ids mentioned as <@U123> or <@U123|name>. */
export function mentionedUserIds(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
}

/** Turns Slack's wire format into readable text: mentions, channels, links, special mentions, entities. */
export function slackToPlainText(text: string, userNames: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${userNames.get(id) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => name ?? "@group")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Converts the light markdown the model writes into Slack mrkdwn.
 * Code spans and blocks are left untouched.
 */
export function markdownToMrkdwn(md: string, resolveMention?: (name: string) => string | undefined): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      const converted = part
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
        .replace(/^(\s*)[-*]\s+/gm, "$1• ");
      if (!resolveMention) return converted;
      // "@Anna" → "<@U123>" so the person actually gets notified. Unknown names stay as written.
      return converted.replace(/(^|[\s(])@([\p{L}\p{N}._-]+)/gu, (m, pre: string, raw: string) => {
        const name = raw.replace(/[._-]+$/, ""); // "@Anna." at the end of a sentence
        const id = resolveMention(name);
        return id ? `${pre}<@${id}>${raw.slice(name.length)}` : m;
      });
    })
    .join("");
}
