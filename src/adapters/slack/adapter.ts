import bolt from "@slack/bolt";
import type { Logger } from "pino";
import type { ChatAdapter, ChatEvent, EventHandler, OutboundMessage, SentMessage } from "../../core/types.js";
import {
  markdownToMrkdwn,
  mentionedUserIds,
  slackToChatEvent,
  slackToPlainText,
  type SlackIdentity,
  type SlackMessageLike,
} from "./format.js";

const { App, LogLevel } = bolt;
type BoltApp = InstanceType<typeof App>;

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  /** How Heinzel's own mention is rendered in text ("@Heinzel"), independent of the Slack display name. */
  botName: string;
  log: Logger;
}

/** Slack via Socket Mode: no public URL needed, works from a laptop. */
export class SlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  private readonly app: BoltApp;
  private me: SlackIdentity | null = null;
  private readonly userNames = new Map<string, string>();
  private readonly channelNames = new Map<string, string | undefined>();

  constructor(private readonly opts: SlackAdapterOptions) {
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async start(onEvent: EventHandler): Promise<void> {
    const auth = await this.app.client.auth.test();
    if (!auth.user_id || !auth.bot_id) throw new Error("Slack auth.test did not return a bot identity. Is SLACK_BOT_TOKEN a bot token (xoxb-)?");
    this.me = { botUserId: auth.user_id, botId: auth.bot_id };
    this.userNames.set(auth.user_id, this.opts.botName.replace(/\s+/g, ""));
    this.opts.log.info({ team: auth.team, bot: auth.user }, "slack: authenticated");

    const handle = async (raw: SlackMessageLike): Promise<void> => {
      const ev = await this.toEvent(raw);
      if (ev) await onEvent(ev);
    };
    this.app.event("message", async ({ event }) => handle(event as SlackMessageLike));
    // Mentions in channels Heinzel is not a member of arrive only as app_mention; duplicates are dropped downstream.
    this.app.event("app_mention", async ({ event }) => handle({ ...(event as SlackMessageLike), type: "message" }));
    this.app.error(async (err) => {
      this.opts.log.error({ err }, "slack: unhandled error");
    });

    await this.app.start();
    this.opts.log.info("slack: connected via socket mode");
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async send(m: OutboundMessage): Promise<SentMessage> {
    const res = await this.app.client.chat.postMessage({
      channel: m.channelId,
      text: markdownToMrkdwn(m.text),
      ...(m.threadId ? { thread_ts: m.threadId } : {}),
      unfurl_links: false,
    });
    if (!res.ts) throw new Error(`Slack chat.postMessage returned no ts: ${res.error ?? "unknown error"}`);
    return { messageId: res.ts, threadId: m.threadId ?? res.ts };
  }

  async fetchThread(channelId: string, threadId: string, limit: number): Promise<ChatEvent[]> {
    const res = await this.app.client.conversations.replies({ channel: channelId, ts: threadId, limit: Math.min(limit, 200) });
    const msgs = (res.messages ?? []) as SlackMessageLike[];
    // replies returns the root first, then the oldest replies; keep the root plus the most recent replies.
    const trimmed = msgs.length > limit ? [msgs[0]!, ...msgs.slice(msgs.length - (limit - 1))] : msgs;
    return this.toEvents(trimmed, channelId);
  }

  async fetchRecent(channelId: string, limit: number): Promise<ChatEvent[]> {
    const res = await this.app.client.conversations.history({ channel: channelId, limit: Math.min(limit, 200) });
    const msgs = ((res.messages ?? []) as SlackMessageLike[]).slice().reverse(); // API returns newest first
    return this.toEvents(msgs, channelId);
  }

  async acknowledge(channelId: string, messageId: string): Promise<void> {
    await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name: "eyes" });
  }

  // ------------------------------------------------------------------ internals

  private async toEvents(msgs: SlackMessageLike[], channelId: string): Promise<ChatEvent[]> {
    const out: ChatEvent[] = [];
    for (const m of msgs) {
      const ev = await this.toEvent({ ...m, channel: channelId });
      if (ev) out.push(ev);
    }
    return out;
  }

  private async toEvent(m: SlackMessageLike): Promise<ChatEvent | null> {
    if (!this.me) return null;
    const base = slackToChatEvent(m, this.me);
    if (!base) return null;
    const ids = mentionedUserIds(m.text ?? "");
    await Promise.all([...ids, base.userId].map((id) => this.userName(id)));
    return {
      ...base,
      userName: base.isSelf ? undefined : this.userNames.get(base.userId),
      channelName: base.isDirect ? undefined : await this.channelName(base.channelId),
      text: slackToPlainText(m.text ?? "", this.userNames),
    };
  }

  private async userName(id: string): Promise<void> {
    if (this.userNames.has(id) || !/^[UW]/.test(id)) return;
    try {
      const res = await this.app.client.users.info({ user: id });
      const p = res.user?.profile;
      this.userNames.set(id, p?.display_name || p?.real_name || res.user?.name || id);
    } catch {
      this.userNames.set(id, id);
    }
  }

  private async channelName(id: string): Promise<string | undefined> {
    if (this.channelNames.has(id)) return this.channelNames.get(id);
    try {
      const res = await this.app.client.conversations.info({ channel: id });
      this.channelNames.set(id, res.channel?.name);
    } catch {
      this.channelNames.set(id, undefined);
    }
    return this.channelNames.get(id);
  }
}
