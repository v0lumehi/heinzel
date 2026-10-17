import type { ChatEvent } from "../../core/types.js";

/** The subset of a Bot Framework / Teams activity Heinzel cares about. */
export interface TeamsActivityLike {
  type?: string;
  id?: string;
  text?: string;
  timestamp?: Date | string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; role?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; name?: string; conversationType?: string };
  entities?: Array<{ type?: string; mentioned?: { id?: string; name?: string }; text?: string }>;
  channelData?: { channel?: { id?: string; name?: string }; team?: { id?: string; name?: string } };
}

/**
 * Splits a Teams conversation id into the conversation and the thread root.
 * Replies in a channel thread arrive as "19:…@thread.tacv2;messageid=<root id>".
 */
export function splitConversationId(id: string): { conversationId: string; rootId?: string } {
  const m = /^(.*);messageid=(\d+)$/.exec(id);
  return m ? { conversationId: m[1]!, rootId: m[2]! } : { conversationId: id };
}

/** Channel conversations have threads; personal and group chats are flat. */
export function isChannelConversation(conversationId: string, conversationType?: string): boolean {
  if (conversationType) return conversationType === "channel";
  return /@thread\.(tacv2|skype)$/.test(conversationId);
}

/**
 * Converts a Teams message activity into a ChatEvent. Returns null for anything that is not a message.
 * In personal and group chats every message is its own thread root, as Teams has no threads there.
 */
export function teamsToChatEvent(a: TeamsActivityLike, botId: string): ChatEvent | null {
  if (a.type !== "message" || !a.id || !a.conversation?.id || !a.from?.id) return null;
  const { conversationId, rootId } = splitConversationId(a.conversation.id);
  const type = a.conversation.conversationType;
  const isDirect = type === "personal";
  const threadId = isChannelConversation(conversationId, type) ? (rootId ?? a.id) : a.id;
  const isSelf = a.from.id === botId;
  const channelName = isDirect ? undefined : (a.channelData?.channel?.name ?? (a.channelData?.channel ? "General" : a.conversation.name));
  return {
    platform: "teams",
    channelId: conversationId,
    channelName,
    threadId,
    messageId: a.id,
    userId: a.from.id,
    userName: isSelf ? undefined : a.from.name,
    text: teamsToPlainText(a.text ?? ""),
    isBot: isSelf || a.from.role === "bot",
    isSelf,
    mentionsBot: (a.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === botId),
    isDirect,
    sentAt: a.timestamp ? new Date(a.timestamp) : new Date(),
  };
}

/** Turns Teams message text (light HTML with <at> mentions) into readable plain text. */
export function teamsToPlainText(text: string): string {
  let t = text
    .replace(/<at[^>]*>(.*?)<\/at>/gi, (_, name: string) => `@${name.replace(/\s+/g, "")}`)
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href: string, label: string) => (label === href ? href : `${label} (${href})`))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n");
  // Repeat until stable, so nested fragments like "<scr<b>ipt>" leave no tag behind.
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/<[^<>]*>/g, "");
  }
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Converts the light markdown the model writes into the markdown subset Teams renders.
 * Teams shows no headings in bot messages and joins single line breaks, so headings become bold
 * and line breaks outside code blocks become hard breaks.
 */
export function markdownToTeams(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code block
      return part.replace(/^#{1,6}\s+(.+)$/gm, "**$1**").replace(/([^\n])\n(?!\n)/g, "$1  \n");
    })
    .join("");
}
