import http from "node:http";
import { App, ExpressAdapter, type AppOptions, type IPlugin } from "@microsoft/teams.apps";
import type { Logger } from "pino";
import type { ChatAdapter, EventHandler, OutboundMessage, SentMessage } from "../../core/types.js";
import { isChannelConversation, markdownToTeams, teamsToChatEvent, type TeamsActivityLike } from "./format.js";

type SdkLogger = NonNullable<AppOptions<IPlugin>["logger"]>;

export interface TeamsAdapterOptions {
  /** Azure Bot registration. Unset only together with `playground`. */
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  port: number;
  /**
   * Local testing with the Microsoft 365 Agents Playground: incoming requests are not authenticated,
   * so the endpoint only listens on localhost.
   */
  playground: boolean;
  /** Bot Connector URL for proactive posts to conversations not seen since the start. Default: the SDK's global endpoint. */
  serviceUrl?: string;
  log: Logger;
}

/**
 * Microsoft Teams via the Teams SDK: Teams posts activities to our HTTP endpoint (`/api/messages`),
 * we answer through the Bot Connector REST API.
 *
 * No fetchThread/fetchRecent yet: reading history needs Microsoft Graph, so the engine uses its stored copy.
 */
export class TeamsAdapter implements ChatAdapter {
  readonly platform = "teams" as const;
  private readonly server = http.createServer();
  private readonly app: App;
  /** Learned from incoming activities; the service URL can differ per region and tenant. */
  private readonly serviceUrls = new Map<string, string>();
  private readonly conversationTypes = new Map<string, string>();

  constructor(private readonly opts: TeamsAdapterOptions) {
    this.app = new App({
      clientId: opts.appId,
      clientSecret: opts.appPassword,
      tenantId: opts.tenantId,
      serviceUrl: opts.serviceUrl,
      dangerouslyAllowUnauthenticatedRequests: opts.playground,
      httpServerAdapter: new ExpressAdapter(this.server, { logger: sdkLogger(opts.log) }),
      logger: sdkLogger(opts.log),
    });
  }

  async start(onEvent: EventHandler): Promise<void> {
    this.app.on("message", async ({ activity }) => {
      const a = activity as TeamsActivityLike;
      const botId = a.recipient?.id;
      if (!botId) return;
      const ev = teamsToChatEvent(a, botId);
      if (!ev) return;
      if (a.serviceUrl) this.serviceUrls.set(ev.channelId, a.serviceUrl.replace(/\/+$/, ""));
      if (a.conversation?.conversationType) this.conversationTypes.set(ev.channelId, a.conversation.conversationType);
      await onEvent(ev);
    });
    await this.app.initialize();

    const host = this.opts.playground ? "127.0.0.1" : undefined;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    if (this.opts.playground) {
      this.opts.log.warn({ port: this.opts.port }, "teams: playground mode, accepting unauthenticated requests on localhost only");
    } else {
      this.opts.log.info({ port: this.opts.port }, "teams: listening for activities on /api/messages");
    }
  }

  async stop(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections(); // keep-alive connections from the Bot Connector would hold close() open
    await closed;
  }

  async send(m: OutboundMessage): Promise<SentMessage> {
    const threaded = !!m.threadId && isChannelConversation(m.channelId, this.conversationTypes.get(m.channelId));
    const target = threaded ? `${m.channelId};messageid=${m.threadId}` : m.channelId;
    const res = await this.api(m.channelId).conversations.createActivity(target, { type: "message", text: markdownToTeams(m.text), textFormat: "markdown" });
    if (!res.id) throw new Error("Teams createActivity returned no activity id");
    return { messageId: res.id, threadId: threaded ? m.threadId! : res.id };
  }

  async update(channelId: string, messageId: string, text: string): Promise<void> {
    await this.api(channelId).conversations.updateActivity(channelId, messageId, { type: "message", text: markdownToTeams(text), textFormat: "markdown" });
  }

  async acknowledge(channelId: string, messageId: string): Promise<void> {
    await this.api(channelId).conversations.addReaction(channelId, messageId, "1f440_eyes");
  }

  private api(channelId: string) {
    const serviceUrl = this.serviceUrls.get(channelId);
    return serviceUrl ? this.app.api.clone({ serviceUrl }) : this.app.api;
  }
}

/** Routes the SDK's console-style logging into pino. Its info output is chatty, so it goes to debug. */
function sdkLogger(log: Logger): SdkLogger {
  const emit = (l: Logger, level: "error" | "warn" | "debug" | "trace") => (...msg: unknown[]) => {
    const [first, ...rest] = msg;
    const err = rest.find((x) => x instanceof Error);
    l[level](err ? { err } : rest.length ? { detail: rest } : {}, typeof first === "string" ? first : String(first));
  };
  const wrap = (l: Logger): SdkLogger => ({
    error: emit(l, "error"),
    warn: emit(l, "warn"),
    info: emit(l, "debug"),
    debug: emit(l, "trace"),
    trace: emit(l, "trace"),
    log: (level, ...msg) => emit(l, level === "error" || level === "warn" ? level : "trace")(...msg),
    child: (name) => wrap(l.child({ sdk: name })),
  });
  return wrap(log);
}
