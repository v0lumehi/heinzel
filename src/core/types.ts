/**
 * Platform-neutral types. Everything below the adapters only ever sees these.
 * Adding a platform = implementing ChatAdapter; nothing else should need to change.
 */

export type Platform = "slack" | "teams";

/** A message as seen by Heinzel, normalized across chat platforms. */
export interface ChatEvent {
  platform: Platform;
  /** Platform channel / conversation id. */
  channelId: string;
  channelName?: string;
  /** Root message id of the thread. For a top-level message this equals messageId. */
  threadId: string;
  messageId: string;
  userId: string;
  userName?: string;
  text: string;
  /** Posted by any bot or integration. */
  isBot: boolean;
  /** Posted by Heinzel itself. */
  isSelf: boolean;
  /** Heinzel was @-mentioned (or addressed by name in a DM). */
  mentionsBot: boolean;
  /** 1:1 conversation with Heinzel. */
  isDirect: boolean;
  sentAt: Date;
}

export interface OutboundMessage {
  channelId: string;
  /** Reply inside this thread. Omit to post top-level. */
  threadId?: string;
  /** Plain text with light markdown (**bold**, `code`, lists, links). Adapters translate to native format. */
  text: string;
}

export interface SentMessage {
  messageId: string;
  threadId: string;
}

export type EventHandler = (event: ChatEvent) => Promise<void>;

export interface ChatAdapter {
  readonly platform: Platform;
  /** Connects to the platform and starts delivering events. Resolves once connected. */
  start(onEvent: EventHandler): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SentMessage>;
  /** Messages of a thread, oldest first, including the root. Optional: without it the engine uses its stored copy. */
  fetchThread?(channelId: string, threadId: string, limit: number): Promise<ChatEvent[]>;
  /** Most recent top-level messages of a channel, oldest first. Optional like fetchThread. */
  fetchRecent?(channelId: string, limit: number): Promise<ChatEvent[]>;
  /** Optional lightweight acknowledgement (e.g. 👀 reaction) while working. */
  acknowledge?(channelId: string, messageId: string): Promise<void>;
  /** Optional: replace the text of a message Heinzel sent (live status updates). */
  update?(channelId: string, messageId: string, text: string): Promise<void>;
}

export function channelKey(platform: Platform, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function parseChannelKey(key: string): { platform: Platform; channelId: string } {
  const idx = key.indexOf(":");
  const platform = key.slice(0, idx);
  if (platform !== "slack" && platform !== "teams") throw new Error(`Unknown platform in channel key: ${key}`);
  return { platform, channelId: key.slice(idx + 1) };
}
