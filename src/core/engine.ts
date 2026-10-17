import type { Logger } from "pino";
import type { Config } from "../config.js";
import { buildSystemPrompt, finalInstruction, renderTranscript, type RespondMode } from "../agent/prompt.js";
import { isSilent, runAgent } from "../agent/runner.js";
import { defaultTools, escalateTool, followupDedupeKey, memoryScopes, type AgentTool, type ToolContext } from "../agent/tools.js";
import { CodingCoordinator } from "../coding/coordinator.js";
import type { CodingRunner } from "../coding/runner.js";
import { createCodingTool } from "../coding/tool.js";
import type { LlmClient } from "../llm/client.js";
import type { Memory, MemoryStore } from "../memory/memory.js";
import type { JobHandlers } from "../queue/worker.js";
import type { JobPayloads, JobQueue } from "../queue/queue.js";
import { checkSpeakBudget, preFilter, triageMessage } from "../triage/triage.js";
import type { CodingStore } from "../store/coding.js";
import type { BotPostKind, ChannelSettings, Store, StoredEvent } from "../store/store.js";
import { cleanForPrompt, helpText, parseCommand, type Command } from "./commands.js";
import { parseChannelKey, type ChatAdapter, type ChatEvent, type Platform } from "./types.js";

export interface EngineDeps {
  config: Config;
  store: Store;
  memory: MemoryStore;
  queue: JobQueue;
  llm: LlmClient;
  adapters: Map<Platform, ChatAdapter>;
  log: Logger;
  tools?: AgentTool[];
  /** Coding sessions; used when CODING_ENABLED=true. */
  coding?: { runner: CodingRunner; sessions: CodingStore };
  now?: () => Date;
}

/**
 * The platform-neutral brain. Adapters hand it events; it decides what to do and does the work in background jobs.
 *
 *   incoming message ──► addressed? ──yes──► command? ──► answer directly
 *                           │                  └─no──► job "respond"
 *                           └─no──► ambient on / in my thread? ──► pre-filter ──► job "triage"
 *   triage ──► ignore | remember | follow_up (job later) | reply (job "respond", ambient)
 */
export class Engine {
  private readonly tools: AgentTool[];
  /** MCP servers behind the external tools, for the system prompt. */
  private readonly toolSources: string[];
  private readonly now: () => Date;
  readonly coding: CodingCoordinator | null = null;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? (() => new Date());
    const tools = [...(d.tools ?? defaultTools)];
    if (d.config.CODING_ENABLED && d.coding) {
      this.coding = new CodingCoordinator({
        config: d.config,
        sessions: d.coding.sessions,
        store: d.store,
        runner: d.coding.runner,
        queue: d.queue,
        log: d.log.child({ component: "coding" }),
        now: this.now,
        chat: {
          post: async (key, threadRef, text) => (await this.postToThread(key, threadRef, text)).messageId,
          update: async (key, messageId, text) => {
            const { platform, channelId } = parseChannelKey(key);
            await this.adapter(platform).update?.(channelId, messageId, text);
          },
        },
      });
      tools.push(createCodingTool(this.coding) as AgentTool);
    }
    this.tools = tools;
    this.toolSources = [...new Set(this.tools.map((t) => t.source).filter((s): s is string => !!s))];
  }

  // ---------------------------------------------------------------- ingest

  async handleIncoming(e: ChatEvent): Promise<void> {
    const { store, queue, config, log } = this.d;
    const channel = await store.ensureChannel(e.platform, e.channelId, e.channelName, config.AMBIENT_DEFAULT);
    const stored = await store.insertEvent(e);
    if (!stored) return; // duplicate delivery
    if (e.isSelf) return;

    const elog = log.child({ channel: channel.channelKey, event: stored.id });

    if (e.mentionsBot || e.isDirect) {
      if (e.isBot) return; // never let bots command us (avoids bot loops)
      const cmd = parseCommand(e.text);
      if (cmd) {
        await this.runCommand(cmd, stored, channel);
        return;
      }
      await this.adapter(e.platform).acknowledge?.(e.channelId, e.messageId).catch(() => {});
      await queue.enqueue("respond", { eventId: stored.id, mode: "direct" });
      elog.debug("queued respond");
      return;
    }

    if (e.isBot) return;
    const inThread = e.threadId !== e.messageId;
    const botInThread = inThread && (await store.botParticipatedInThread(channel.channelKey, e.threadId));
    if (!channel.ambientEnabled && !botInThread) return;
    if (preFilter(e) === "skip") return;
    await queue.enqueue("triage", { eventId: stored.id, botInThread });
    elog.debug({ botInThread }, "queued triage");
  }

  // ---------------------------------------------------------------- jobs

  handlers(): JobHandlers {
    return {
      respond: (p) => this.respond(p),
      triage: (p) => this.triage(p),
      followup: (p) => this.followup(p),
      coding_start: async (p) => this.coding?.start(p.sessionId),
      coding_watch: async (p) => this.coding?.watch(p.sessionId),
    };
  }

  private async respond(p: JobPayloads["respond"]): Promise<void> {
    const { store } = this.d;
    const ev = await store.getEvent(p.eventId);
    if (!ev) return;
    const channel = await store.getChannel(ev.channelKey);
    if (!channel) return;

    if (p.mode === "ambient") {
      const budget = await this.speakBudget(channel, ev.threadId);
      if (!budget.allowed) {
        this.d.log.info({ channel: channel.channelKey, why: budget.why }, "ambient reply suppressed by budget");
        return;
      }
    }

    const context = await this.conversationContext(ev);
    const text = await this.think({
      channel,
      mode: p.mode,
      reason: p.reason,
      transcript: context,
      focus: ev,
      toolContext: this.toolContext(ev.channelKey, ev.threadId, `${ev.platform}:${ev.userId}`, ev.id),
      traceId: `event-${ev.id}`,
      tier: p.tier ?? "default",
    });

    if (isSilent(text)) {
      if (p.mode === "direct") {
        await this.post(channel, ev, "I don't have anything useful to add here.", "reply");
      }
      return;
    }
    await this.post(channel, ev, text, p.mode === "ambient" ? "ambient" : "reply");
  }

  private async triage(p: JobPayloads["triage"]): Promise<void> {
    const { store, config, llm, memory, queue, log } = this.d;
    const ev = await store.getEvent(p.eventId);
    if (!ev) return;
    const channel = await store.getChannel(ev.channelKey);
    if (!channel || (!channel.ambientEnabled && !p.botInThread)) return;

    // If something newer already happened in the thread, this message is stale; the newer one gets its own triage.
    const latest = await store.lastEventInThread(ev.channelKey, ev.threadId);
    if (latest && latest.id !== ev.id && latest.sentAt.getTime() - ev.sentAt.getTime() > 10 * 60_000) return;

    const inThread = ev.threadId !== ev.messageId;
    const context = inThread
      ? (await store.threadEvents(ev.channelKey, ev.threadId, 12)).filter((x) => x.id !== ev.id)
      : await store.recentChannelEvents(ev.channelKey, ev.id, 8);

    const decision = await triageMessage(
      llm,
      config.LLM_MODEL_TRIAGE,
      {
        botName: config.BOT_NAME,
        channelName: channel.name,
        channelInstructions: channel.instructions,
        botInThread: p.botInThread,
        context,
        message: ev,
      },
      { channelKey: ev.channelKey, purpose: "triage", traceId: `event-${ev.id}` },
      (u) => this.recordUsage(ev.channelKey, "triage", config.LLM_MODEL_TRIAGE, u, `event-${ev.id}`),
    );
    const dlog = log.child({ channel: ev.channelKey, event: ev.id });
    dlog.info(
      { action: decision.action, confidence: decision.confidence, complexity: decision.complexity, reason: decision.reason },
      "triage decision",
    );

    switch (decision.action) {
      case "ignore":
        return;
      case "remember":
        if (decision.memory && decision.confidence >= 0.6) {
          await memory.add({ scope: "channel", scopeKey: ev.channelKey, content: decision.memory, createdBy: "triage", sourceEvent: ev.id });
        }
        return;
      case "follow_up": {
        if (decision.confidence < config.AMBIENT_MIN_CONFIDENCE) return;
        const hours = decision.follow_up_hours ?? 24;
        await queue.enqueue(
          "followup",
          { channelKey: ev.channelKey, threadRef: ev.threadId, note: decision.reason || "check whether this was resolved", scheduledAfterEventId: ev.id },
          { runAt: new Date(this.now().getTime() + hours * 3_600_000), dedupeKey: followupDedupeKey(ev.channelKey, ev.threadId) },
        );
        return;
      }
      case "reply": {
        if (decision.confidence < config.AMBIENT_MIN_CONFIDENCE) return;
        if (!p.botInThread) {
          const budget = await this.speakBudget(channel, ev.threadId);
          if (!budget.allowed) {
            dlog.info({ why: budget.why }, "ambient reply suppressed by budget");
            return;
          }
        }
        await queue.enqueue("respond", {
          eventId: ev.id,
          mode: p.botInThread ? "thread" : "ambient",
          reason: decision.reason,
          tier: decision.complexity === "complex" ? "heavy" : "default",
        });
        return;
      }
    }
  }

  private async followup(p: JobPayloads["followup"]): Promise<void> {
    const { store } = this.d;
    const channel = await store.getChannel(p.channelKey);
    if (!channel) return;
    const budget = await this.speakBudget(channel, p.threadRef);
    if (!budget.allowed) {
      this.d.log.info({ channel: p.channelKey, why: budget.why }, "follow-up suppressed by budget");
      return;
    }
    const anchor = await store.getEvent(p.scheduledAfterEventId);
    const last = await store.lastEventInThread(p.channelKey, p.threadRef);
    const focus = last ?? anchor;
    if (!focus) return;

    const context = await this.conversationContext(focus);
    const text = await this.think({
      channel,
      mode: "followup",
      reason: p.note,
      transcript: context,
      focus: null,
      toolContext: this.toolContext(p.channelKey, p.threadRef, null, focus.id),
      traceId: `followup-${p.channelKey}-${p.threadRef}`,
    });
    if (isSilent(text)) return;
    await this.post(channel, focus, text, "followup");
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(cmd: Command, ev: StoredEvent, channel: ChannelSettings): Promise<void> {
    const { store, memory, config } = this.d;
    let reply: string;
    switch (cmd.kind) {
      case "deep":
        await this.adapter(ev.platform).acknowledge?.(ev.channelId, ev.messageId).catch(() => {});
        await this.d.queue.enqueue("respond", { eventId: ev.id, mode: "direct", tier: "heavy", reason: "the person explicitly asked for the stronger model" });
        return;
      case "help":
        reply = helpText(config.BOT_NAME);
        break;
      case "status": {
        const usage = await store.usageLast24h(channel.channelKey);
        const posted = await store.unsolicitedPostsLast24h(channel.channelKey);
        const limit = channel.dailyUnsolicitedLimit ?? config.AMBIENT_DAILY_LIMIT;
        reply = [
          `**Status for ${channel.name ? `#${channel.name}` : channel.channelKey}**`,
          `Ambient mode: ${channel.ambientEnabled ? "on" : "off"}`,
          `Unprompted posts (24h): ${posted}/${limit}`,
          `LLM calls (24h): ${usage.calls} · tokens in/out: ${usage.promptTokens}/${usage.completionTokens}`,
          config.LLM_MODEL_HEAVY
            ? `Heavy model runs (24h): ${await store.heavyRunsLast24h(channel.channelKey)}/${config.HEAVY_DAILY_LIMIT}`
            : "Heavy model: not configured",
          `Instructions: ${channel.instructions ? "set (`!instructions` to show)" : "none"}`,
          `External tools: ${this.toolSources.length ? this.toolSources.join(", ") : "none"}`,
        ].join("\n");
        break;
      }
      case "ambient":
        await store.updateChannel(channel.channelKey, { ambientEnabled: cmd.enabled });
        reply = cmd.enabled
          ? "Ambient mode is **on**. I'll follow this channel and speak up when I can clearly help."
          : "Ambient mode is **off**. I'll only respond when tagged (and in threads I'm part of).";
        break;
      case "limit":
        await store.updateChannel(channel.channelKey, { dailyUnsolicitedLimit: cmd.perDay });
        reply = cmd.perDay === null
          ? `Daily limit reset to the default (${config.AMBIENT_DAILY_LIMIT}).`
          : `Daily limit for unprompted posts set to ${cmd.perDay}.`;
        break;
      case "instructions-show":
        reply = channel.instructions ? `**Instructions for this channel:**\n${channel.instructions}` : "No instructions set. Use `!instructions <text>`.";
        break;
      case "instructions-set":
        await store.updateChannel(channel.channelKey, { instructions: cmd.text.slice(0, 4000) });
        reply = "Got it, I'll follow these instructions in this channel.";
        break;
      case "instructions-clear":
        await store.updateChannel(channel.channelKey, { instructions: "" });
        reply = "Instructions cleared.";
        break;
      case "memories": {
        const found = await memory.search({
          scopes: memoryScopes({ channelKey: channel.channelKey, userKey: `${ev.platform}:${ev.userId}` }),
          text: cmd.query,
          limit: 15,
        });
        reply = found.length ? found.map((m) => `#${m.id} [${m.scope}] ${m.content}`).join("\n") : "I don't remember anything matching that here.";
        break;
      }
      case "go":
      case "stop":
      case "coding": {
        if (!this.coding) {
          reply = "Coding sessions are not enabled here (CODING_ENABLED).";
          break;
        }
        const userKey = `${ev.platform}:${ev.userId}`;
        if (cmd.kind === "go") reply = await this.coding.confirm(channel.channelKey, ev.threadId, userKey, cmd.id);
        else if (cmd.kind === "stop") reply = await this.coding.cancel(channel.channelKey, ev.threadId, cmd.id);
        else reply = await this.coding.list(channel.channelKey);
        break;
      }
      case "unknown":
        reply = `I don't know that command.\n${helpText(config.BOT_NAME)}`;
        break;
    }
    await this.post(channel, ev, reply, "reply");
  }

  // ---------------------------------------------------------------- helpers

  private adapter(platform: Platform): ChatAdapter {
    const a = this.d.adapters.get(platform);
    if (!a) throw new Error(`No adapter for platform ${platform}`);
    return a;
  }

  private toolContext(channelKeyValue: string, threadRef: string, userKey: string | null, eventId: number): ToolContext {
    return { channelKey: channelKeyValue, threadRef, userKey, eventId, memory: this.d.memory, queue: this.d.queue };
  }

  private async speakBudget(channel: ChannelSettings, threadRef: string) {
    const { store, config } = this.d;
    return checkSpeakBudget({
      unsolicitedLast24h: await store.unsolicitedPostsLast24h(channel.channelKey),
      dailyLimit: channel.dailyUnsolicitedLimit ?? config.AMBIENT_DAILY_LIMIT,
      lastUnsolicitedInThread: await store.lastUnsolicitedPostInThread(channel.channelKey, threadRef),
      threadCooldownMin: config.AMBIENT_THREAD_COOLDOWN_MIN,
      now: this.now(),
    });
  }

  /** Thread (or recent channel / DM history for top-level messages), from the platform if it can, else from our store. */
  private async conversationContext(ev: StoredEvent): Promise<ChatEvent[]> {
    const { config, store, log } = this.d;
    const limit = config.CONTEXT_MESSAGES;
    const inThread = ev.threadId !== ev.messageId;
    const adapter = this.adapter(ev.platform);
    let events: ChatEvent[] | undefined;
    try {
      events = inThread ? await adapter.fetchThread?.(ev.channelId, ev.threadId, limit) : await adapter.fetchRecent?.(ev.channelId, Math.min(limit, 15));
    } catch (err) {
      log.warn({ err, channel: ev.channelKey }, "fetching context from platform failed; using stored history");
    }
    events ??= inThread ? await store.threadEvents(ev.channelKey, ev.threadId, limit) : await store.recentChannelEvents(ev.channelKey, ev.id + 1, 15);
    if (!events.some((x) => x.messageId === ev.messageId)) events.push(ev);
    return events;
  }

  private async think(a: {
    channel: ChannelSettings;
    mode: RespondMode;
    reason?: string;
    transcript: ChatEvent[];
    focus: ChatEvent | null;
    toolContext: ToolContext;
    traceId: string;
    tier?: "default" | "heavy";
  }): Promise<string> {
    const { config, memory, log } = this.d;
    const query = [a.focus?.text ?? "", a.reason ?? ""].join(" ");
    const recalled = await memory.search({ scopes: memoryScopes(a.toolContext), text: query, limit: 8 });
    const recent = await memory.search({ scopes: memoryScopes(a.toolContext), limit: 5 });
    const memories = dedupeMemories([...recalled, ...recent]);
    const transcript = a.transcript.map((e) => ({ ...e, text: e.isSelf ? e.text : cleanForPrompt(e.text) }));
    const user = `${renderTranscript(transcript, config.BOT_NAME, a.focus?.messageId)}\n\n${finalInstruction(a.mode, a.focus)}`;
    const heavyAllowed = await this.heavyAllowed(a.channel.channelKey);
    const rlog = log.child({ channel: a.channel.channelKey, trace: a.traceId });

    // Tools with side effects that need a person's explicit request are not offered when Heinzel speaks on its own.
    const tools = a.mode === "direct" ? this.tools : this.tools.filter((t) => !t.directOnly);
    const run = async (heavy: { reason: string } | null): Promise<{ text: string; escalation?: { reason: string } }> => {
      const canEscalate = !heavy && heavyAllowed;
      const system = buildSystemPrompt({
        botName: config.BOT_NAME,
        platform: a.channel.platform,
        channelName: a.channel.name,
        isDirect: a.focus?.isDirect ?? false,
        channelInstructions: a.channel.instructions,
        mode: a.mode,
        reason: a.reason,
        memories,
        now: this.now(),
        canEscalate,
        heavy: heavy ?? undefined,
        externalTools: this.toolSources,
        coding: tools.some((t) => t.name === "start_coding_task"),
      });
      const model = heavy ? config.LLM_MODEL_HEAVY! : config.LLM_MODEL_AGENT;
      const purpose = heavy ? "agent_heavy" : "agent";
      const traceId = heavy ? `${a.traceId}-heavy` : a.traceId;
      const result = await runAgent(
        this.d.llm,
        {
          model,
          system,
          messages: [{ role: "user", content: user }],
          tools: canEscalate ? [...tools, escalateTool as AgentTool] : tools,
          toolContext: a.toolContext,
          maxSteps: heavy ? config.AGENT_MAX_STEPS_HEAVY : config.AGENT_MAX_STEPS,
          meta: { channelKey: a.channel.channelKey, purpose, traceId },
          onUsage: (u) => this.recordUsage(a.channel.channelKey, purpose, u.model, u, traceId),
        },
        rlog,
      );
      rlog.debug({ model, steps: result.steps, tools: result.toolCalls, escalated: !!result.escalation }, "agent run finished");
      return result;
    };

    if (a.tier === "heavy" && heavyAllowed) {
      return (await run({ reason: a.reason ?? "routed to the stronger model" })).text;
    }
    if (a.tier === "heavy") rlog.info("heavy model requested but not configured or over budget; using default model");

    const first = await run(null);
    if (!first.escalation) return first.text;
    rlog.info({ reason: first.escalation.reason }, "escalating to heavy model");
    return (await run(first.escalation)).text;
  }

  /** Heavy model configured and the channel is within its daily heavy-run budget. */
  private async heavyAllowed(key: string): Promise<boolean> {
    const { config, store } = this.d;
    if (!config.LLM_MODEL_HEAVY || config.HEAVY_DAILY_LIMIT <= 0) return false;
    return (await store.heavyRunsLast24h(key)) < config.HEAVY_DAILY_LIMIT;
  }

  /** Sends a reply to an event (top-level in DMs unless the person is in a thread) and records it. */
  private async post(channel: ChannelSettings, replyTo: ChatEvent, text: string, kind: BotPostKind): Promise<void> {
    const threadId = replyTo.isDirect && replyTo.threadId === replyTo.messageId ? undefined : replyTo.threadId;
    await this.deliver(channel.channelKey, threadId, text, kind, replyTo.isDirect);
  }

  /** Posts into a thread, e.g. coding session updates. */
  private async postToThread(key: string, threadRef: string, text: string): Promise<{ messageId: string }> {
    return this.deliver(key, threadRef, text, "reply", false);
  }

  /** Sends a message and records it. Failures after sending are logged, never rethrown, so a job retry can't double-post. */
  private async deliver(key: string, threadId: string | undefined, text: string, kind: BotPostKind, isDirect: boolean): Promise<{ messageId: string }> {
    const { platform, channelId } = parseChannelKey(key);
    const adapter = this.adapter(platform);
    const sent = await adapter.send({ channelId, threadId, text });
    try {
      await this.d.store.recordBotPost(key, sent.threadId, sent.messageId, kind);
      await this.d.store.insertEvent({
        platform,
        channelId,
        threadId: sent.threadId,
        messageId: sent.messageId,
        userId: "self",
        userName: this.d.config.BOT_NAME,
        text,
        isBot: true,
        isSelf: true,
        mentionsBot: false,
        isDirect,
        sentAt: this.now(),
      });
    } catch (err) {
      this.d.log.error({ err, channel: key }, "failed to record bot post");
    }
    return { messageId: sent.messageId };
  }

  private async recordUsage(
    key: string,
    purpose: string,
    model: string,
    u: { promptTokens: number; completionTokens: number },
    traceId?: string,
  ): Promise<void> {
    await this.d.store
      .recordUsage({ channelKey: key, purpose, model, promptTokens: u.promptTokens, completionTokens: u.completionTokens, traceId })
      .catch((err) => this.d.log.warn({ err }, "failed to record usage"));
  }
}

function dedupeMemories(ms: Memory[]): Memory[] {
  const seen = new Set<number>();
  return ms.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

