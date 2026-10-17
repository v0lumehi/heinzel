import type { Db } from "../db/pool.js";

export type MemoryScope = "channel" | "org" | "user";

export interface Memory {
  id: number;
  scope: MemoryScope;
  scopeKey: string;
  content: string;
  createdBy: string;
  createdAt: Date;
}

export interface MemoryQuery {
  /** Scopes to search in, e.g. this channel + org + the asking user. */
  scopes: { scope: MemoryScope; scopeKey: string }[];
  /** Free text; empty returns the most recent memories. */
  text?: string;
  limit?: number;
}

export const ORG_SCOPE_KEY = "*";

/**
 * Team memory backed by Postgres full-text search.
 * Deliberately simple for the MVP; pgvector embeddings can be added behind the same interface.
 */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  async add(m: { scope: MemoryScope; scopeKey: string; content: string; createdBy: string; sourceEvent?: number | null }): Promise<Memory> {
    const content = m.content.trim().slice(0, 2000);
    if (!content) throw new Error("Memory content must not be empty");
    // Skip exact duplicates within the same scope.
    const existing = await this.db.query(
      `SELECT * FROM memories WHERE scope = $1 AND scope_key = $2 AND lower(content) = lower($3) LIMIT 1`,
      [m.scope, m.scopeKey, content],
    );
    if (existing.rows[0]) return toMemory(existing.rows[0]);
    const { rows } = await this.db.query(
      `INSERT INTO memories (scope, scope_key, content, created_by, source_event) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [m.scope, m.scopeKey, content, m.createdBy, m.sourceEvent ?? null],
    );
    return toMemory(rows[0]);
  }

  async search(q: MemoryQuery): Promise<Memory[]> {
    if (q.scopes.length === 0) return [];
    const limit = q.limit ?? 10;
    const params: unknown[] = [];
    const scopeSql = q.scopes
      .map((s) => {
        params.push(s.scope, s.scopeKey);
        return `(scope = $${params.length - 1} AND scope_key = $${params.length})`;
      })
      .join(" OR ");
    const text = (q.text ?? "").trim();
    if (!text) {
      params.push(limit);
      const { rows } = await this.db.query(
        `SELECT * FROM memories WHERE ${scopeSql} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toMemory);
    }
    // OR-match the words so partial overlap still recalls; rank by relevance, then recency.
    const tsQuery = toOrTsQuery(text);
    if (!tsQuery) return this.search({ ...q, text: "" });
    params.push(tsQuery);
    const tsIdx = params.length;
    params.push(limit);
    const { rows } = await this.db.query(
      `SELECT *, ts_rank(tsv, to_tsquery('simple', $${tsIdx})) AS rank FROM memories
       WHERE (${scopeSql}) AND tsv @@ to_tsquery('simple', $${tsIdx})
       ORDER BY rank DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toMemory);
  }

  /** Admin listing across all scopes, optionally filtered; newest first. Channel memories carry the channel name. */
  async list(q: { id?: number; scope?: MemoryScope; scopeKey?: string; text?: string; limit?: number } = {}): Promise<(Memory & { channelName: string | null })[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.id !== undefined) where.push(`m.id = $${params.push(q.id)}`);
    if (q.scope) where.push(`m.scope = $${params.push(q.scope)}`);
    if (q.scopeKey) where.push(`m.scope_key = $${params.push(q.scopeKey)}`);
    const text = (q.text ?? "").trim();
    if (text) where.push(`m.content ILIKE $${params.push(`%${text.replace(/[\\%_]/g, "\\$&")}%`)}`);
    const { rows } = await this.db.query(
      `SELECT m.*, c.name AS channel_name FROM memories m
       LEFT JOIN channels c ON m.scope = 'channel' AND c.channel_key = m.scope_key
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.push(q.limit ?? 200)}`,
      params,
    );
    return rows.map((r) => ({ ...toMemory(r), channelName: r.channel_name }));
  }

  /** Deletes a memory regardless of scope (admin). */
  async remove(id: number): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM memories WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async forget(id: number, scopes: { scope: MemoryScope; scopeKey: string }[]): Promise<boolean> {
    // Only allow deleting memories visible in the caller's scopes.
    const visible = await this.search({ scopes, limit: 10_000 });
    if (!visible.some((m) => m.id === id)) return false;
    const res = await this.db.query(`DELETE FROM memories WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

/**
 * Turns free text into an OR tsquery ("a | b | c") using only characters that are safe in to_tsquery.
 * Returns "" when no usable word remains.
 */
export function toOrTsQuery(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 30).join(" | ");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toMemory(r: any): Memory {
  return {
    id: Number(r.id),
    scope: r.scope,
    scopeKey: r.scope_key,
    content: r.content,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}
