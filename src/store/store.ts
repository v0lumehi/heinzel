import type { Db } from "../db/pool.js";
import { channelKey, type ChatEvent, type Platform } from "../core/types.js";

export interface ChannelSettings {
  channelKey: string;
  platform: Platform;
  externalId: string;
  name: string | null;
  ambientEnabled: boolean;
  instructions: string;
  dailyUnsolicitedLimit: number | null;
}

export interface StoredEvent extends ChatEvent {
  id: number;
  channelKey: string;
}

export type BotPostKind = "reply" | "ambient" | "followup";

/** A channel with activity figures, for the admin UI. */
export interface ChannelOverview extends ChannelSettings {
  unsolicitedLast24h: number;
  callsLast7d: number;
  tokensLast7d: number;
  lastActivity: Date | null;
}

export interface AuditEntry {
  id: number;
  actor: string;
  actorName: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface UsageRow {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/** Thin data-access layer. All SQL outside migrations and the queue lives here or in memory/. */
export class Store {
  constructor(private readonly db: Db) {}

  // ---------- channels ----------

  async ensureChannel(platform: Platform, externalId: string, name: string | undefined, ambientDefault: boolean): Promise<ChannelSettings> {
    const key = channelKey(platform, externalId);
    const { rows } = await this.db.query(
      `INSERT INTO channels (channel_key, platform, external_id, name, ambient_enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_key) DO UPDATE SET name = COALESCE(EXCLUDED.name, channels.name)
       RETURNING *`,
      [key, platform, externalId, name ?? null, ambientDefault],
    );
    return toChannel(rows[0]);
  }

  async getChannel(key: string): Promise<ChannelSettings | null> {
    const { rows } = await this.db.query(`SELECT * FROM channels WHERE channel_key = $1`, [key]);
    return rows[0] ? toChannel(rows[0]) : null;
  }

  async updateChannel(
    key: string,
    patch: Partial<Pick<ChannelSettings, "ambientEnabled" | "instructions" | "dailyUnsolicitedLimit">>,
  ): Promise<ChannelSettings> {
    const { rows } = await this.db.query(
      `UPDATE channels SET
         ambient_enabled = COALESCE($2, ambient_enabled),
         instructions = COALESCE($3, instructions),
         daily_unsolicited_limit = CASE WHEN $4::boolean THEN $5 ELSE daily_unsolicited_limit END,
         updated_at = now()
       WHERE channel_key = $1 RETURNING *`,
      [
        key,
        patch.ambientEnabled ?? null,
        patch.instructions ?? null,
        patch.dailyUnsolicitedLimit !== undefined,
        patch.dailyUnsolicitedLimit ?? null,
      ],
    );
    if (!rows[0]) throw new Error(`Unknown channel ${key}`);
    return toChannel(rows[0]);
  }

  /** All channels with activity figures, most recently active first. */
  async listChannels(): Promise<ChannelOverview[]> {
    const { rows } = await this.db.query(
      `SELECT c.*,
         (SELECT count(*) FROM bot_posts b WHERE b.channel_key = c.channel_key AND b.kind IN ('ambient', 'followup')
            AND b.created_at > now() - interval '24 hours') AS unsolicited,
         u.calls, u.tokens,
         (SELECT max(sent_at) FROM events e WHERE e.channel_key = c.channel_key) AS last_activity
       FROM channels c
       LEFT JOIN LATERAL (SELECT count(*) AS calls, COALESCE(sum(prompt_tokens + completion_tokens), 0) AS tokens FROM llm_usage l
                          WHERE l.channel_key = c.channel_key AND l.created_at > now() - interval '7 days') u ON true
       ORDER BY last_activity DESC NULLS LAST, c.channel_key`,
    );
    return rows.map((r) => ({
      ...toChannel(r),
      unsolicitedLast24h: Number(r.unsolicited),
      callsLast7d: Number(r.calls),
      tokensLast7d: Number(r.tokens),
      lastActivity: r.last_activity,
    }));
  }

  // ---------- events ----------

  /** Stores an event. Returns null if it was already stored (platforms redeliver events). */
  async insertEvent(e: ChatEvent): Promise<StoredEvent | null> {
    const key = channelKey(e.platform, e.channelId);
    const { rows } = await this.db.query(
      `INSERT INTO events (platform, channel_key, thread_ref, message_ref, user_ref, user_name, text,
                           is_bot, is_self, mentions_bot, is_direct, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (platform, channel_key, message_ref) DO NOTHING
       RETURNING id`,
      [e.platform, key, e.threadId, e.messageId, e.userId, e.userName ?? null, e.text,
        e.isBot, e.isSelf, e.mentionsBot, e.isDirect, e.sentAt],
    );
    const row = rows[0];
    return row ? { ...e, id: Number(row.id), channelKey: key } : null;
  }

  async getEvent(id: number): Promise<StoredEvent | null> {
    const { rows } = await this.db.query(`SELECT * FROM events WHERE id = $1`, [id]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /** Thread history from our own store, oldest first. Used when the platform API is unavailable or as a fallback. */
  async threadEvents(key: string, threadRef: string, limit: number): Promise<StoredEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM (SELECT * FROM events WHERE channel_key = $1 AND thread_ref = $2
                      ORDER BY sent_at DESC LIMIT $3) t ORDER BY sent_at ASC`,
      [key, threadRef, limit],
    );
    return rows.map(toEvent);
  }

  /** Most recent events of a channel before the given event (exclusive), oldest first. */
  async recentChannelEvents(key: string, beforeEventId: number, limit: number): Promise<StoredEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM (SELECT * FROM events WHERE channel_key = $1 AND id < $2
                      ORDER BY sent_at DESC, id DESC LIMIT $3) t ORDER BY sent_at ASC, id ASC`,
      [key, beforeEventId, limit],
    );
    return rows.map(toEvent);
  }

  async lastEventInThread(key: string, threadRef: string): Promise<StoredEvent | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM events WHERE channel_key = $1 AND thread_ref = $2 ORDER BY sent_at DESC, id DESC LIMIT 1`,
      [key, threadRef],
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  // ---------- bot posts (budgets & cooldowns) ----------

  async recordBotPost(key: string, threadRef: string, messageRef: string, kind: BotPostKind): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_posts (channel_key, thread_ref, message_ref, kind) VALUES ($1,$2,$3,$4)`,
      [key, threadRef, messageRef, kind],
    );
  }

  async botParticipatedInThread(key: string, threadRef: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM bot_posts WHERE channel_key = $1 AND thread_ref = $2 LIMIT 1`,
      [key, threadRef],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Unsolicited posts (ambient + follow-ups) in the channel during the last 24 hours. */
  async unsolicitedPostsLast24h(key: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bot_posts
       WHERE channel_key = $1 AND kind IN ('ambient', 'followup') AND created_at > now() - interval '24 hours'`,
      [key],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async lastUnsolicitedPostInThread(key: string, threadRef: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ created_at: Date }>(
      `SELECT created_at FROM bot_posts WHERE channel_key = $1 AND thread_ref = $2 AND kind IN ('ambient', 'followup')
       ORDER BY created_at DESC LIMIT 1`,
      [key, threadRef],
    );
    return rows[0]?.created_at ?? null;
  }

  // ---------- housekeeping ----------

  /**
   * Deletes message copies older than `eventRetentionDays` (0 = keep) and finished jobs older than 7 days.
   * Returns the number of deleted rows per table.
   */
  async pruneOldData(eventRetentionDays: number): Promise<{ events: number; jobs: number }> {
    let events = 0;
    if (eventRetentionDays > 0) {
      const res = await this.db.query(`DELETE FROM events WHERE sent_at < now() - make_interval(days => $1)`, [eventRetentionDays]);
      events = res.rowCount ?? 0;
    }
    const jobs = await this.db.query(
      `DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - interval '7 days'`,
    );
    return { events, jobs: jobs.rowCount ?? 0 };
  }

  // ---------- audit ----------

  async recordAudit(a: { actor: string; actorName?: string | null; action: string; target?: string | null; details?: Record<string, unknown> }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (actor, actor_name, action, target, details) VALUES ($1, $2, $3, $4, $5)`,
      [a.actor, a.actorName ?? null, a.action, a.target ?? null, JSON.stringify(a.details ?? {})],
    );
  }

  /** Newest first, optionally for one target (e.g. a channel key). */
  async listAudit(q: { target?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM audit_log WHERE ($1::text IS NULL OR target = $1) ORDER BY created_at DESC, id DESC LIMIT $2`,
      [q.target ?? null, q.limit ?? 200],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      actor: r.actor,
      actorName: r.actor_name,
      action: r.action,
      target: r.target,
      details: r.details,
      createdAt: r.created_at,
    }));
  }

  // ---------- usage ----------

  async recordUsage(u: {
    channelKey: string | null;
    purpose: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    traceId?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO llm_usage (channel_key, purpose, model, prompt_tokens, completion_tokens, trace_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [u.channelKey, u.purpose, u.model, u.promptTokens, u.completionTokens, u.traceId ?? null],
    );
  }

  /** Number of distinct heavy-model agent runs in the channel during the last 24 hours. */
  async heavyRunsLast24h(key: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(DISTINCT COALESCE(trace_id, id::text)) AS n FROM llm_usage
       WHERE channel_key = $1 AND purpose = 'agent_heavy' AND created_at > now() - interval '24 hours'`,
      [key],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** LLM usage of the last `days` days per day, model and purpose, newest day first. */
  async usageByDay(days: number): Promise<(UsageRow & { day: string; model: string; purpose: string })[]> {
    const { rows } = await this.db.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, model, purpose,
              count(*) AS calls, sum(prompt_tokens) AS p, sum(completion_tokens) AS c
       FROM llm_usage WHERE created_at > now() - make_interval(days => $1)
       GROUP BY 1, 2, 3 ORDER BY 1 DESC, 4 DESC`,
      [days],
    );
    return rows.map((r) => ({ day: r.day, model: r.model, purpose: r.purpose, ...toUsage(r) }));
  }

  /** LLM usage of the last `days` days per channel, biggest first. Calls without a channel have key null. */
  async usageByChannel(days: number): Promise<(UsageRow & { channelKey: string | null; name: string | null })[]> {
    const { rows } = await this.db.query(
      `SELECT l.channel_key, c.name, count(*) AS calls, sum(l.prompt_tokens) AS p, sum(l.completion_tokens) AS c
       FROM llm_usage l LEFT JOIN channels c ON c.channel_key = l.channel_key
       WHERE l.created_at > now() - make_interval(days => $1)
       GROUP BY 1, 2 ORDER BY sum(l.prompt_tokens + l.completion_tokens) DESC`,
      [days],
    );
    return rows.map((r) => ({ channelKey: r.channel_key, name: r.name, ...toUsage(r) }));
  }

  async usageLast24h(key: string): Promise<{ calls: number; promptTokens: number; completionTokens: number }> {
    const { rows } = await this.db.query(
      `SELECT count(*) AS calls, COALESCE(sum(prompt_tokens),0) AS p, COALESCE(sum(completion_tokens),0) AS c
       FROM llm_usage WHERE channel_key = $1 AND created_at > now() - interval '24 hours'`,
      [key],
    );
    const r = rows[0];
    return { calls: Number(r.calls), promptTokens: Number(r.p), completionTokens: Number(r.c) };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toChannel(r: any): ChannelSettings {
  return {
    channelKey: r.channel_key,
    platform: r.platform,
    externalId: r.external_id,
    name: r.name,
    ambientEnabled: r.ambient_enabled,
    instructions: r.instructions,
    dailyUnsolicitedLimit: r.daily_unsolicited_limit,
  };
}

function toUsage(r: any): UsageRow {
  return { calls: Number(r.calls), promptTokens: Number(r.p ?? 0), completionTokens: Number(r.c ?? 0) };
}

function toEvent(r: any): StoredEvent {
  return {
    id: Number(r.id),
    channelKey: r.channel_key,
    platform: r.platform,
    channelId: r.channel_key.slice(r.channel_key.indexOf(":") + 1),
    threadId: r.thread_ref,
    messageId: r.message_ref,
    userId: r.user_ref,
    userName: r.user_name ?? undefined,
    text: r.text,
    isBot: r.is_bot,
    isSelf: r.is_self,
    mentionsBot: r.mentions_bot,
    isDirect: r.is_direct,
    sentAt: r.sent_at,
  };
}
