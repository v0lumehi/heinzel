import type { Db } from "../db/pool.js";

export type CodingStatus =
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "no_changes"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "expired";

export const ACTIVE_STATUSES: CodingStatus[] = ["queued", "running", "cancelling"];
export const FINAL_STATUSES: CodingStatus[] = ["succeeded", "no_changes", "failed", "cancelled", "timed_out", "expired"];

/** Live progress, accumulated from the agent's event stream. */
export interface CodingProgress {
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Most recent activities, newest last (e.g. "edit src/a.ts", "$ pnpm test"). */
  recent?: string[];
  /** Latest text the agent wrote (its final summary once it is done). */
  lastText?: string;
  lastError?: string;
}

/** What the coding container reports when it is done. */
export interface CodingResult {
  status: "pushed" | "no_changes" | "failed";
  branch?: string;
  commits?: number;
  diffstat?: string;
  mergeRequestUrl?: string | null;
  agentExitCode?: number;
  error?: string;
}

export interface CodingSession {
  id: number;
  channelKey: string;
  threadRef: string;
  requestedBy: string;
  requestedByName: string | null;
  backend: string;
  repository: string;
  baseBranch: string | null;
  branch: string;
  title: string;
  task: string;
  context: string;
  status: CodingStatus;
  runnerRef: string | null;
  statusMessageRef: string | null;
  logCursor: string | null;
  progress: CodingProgress;
  result: CodingResult | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export class CodingStore {
  constructor(private readonly db: Db) {}

  async create(s: Pick<CodingSession, "channelKey" | "threadRef" | "requestedBy" | "requestedByName" | "repository" | "baseBranch" | "title" | "task" | "context">): Promise<CodingSession> {
    // The branch name needs the id, so insert and set it in one statement.
    const { rows } = await this.db.query(
      `WITH next AS (SELECT nextval(pg_get_serial_sequence('coding_sessions', 'id')) AS id)
       INSERT INTO coding_sessions (id, channel_key, thread_ref, requested_by, requested_by_name, repository, base_branch, branch, title, task, context)
       SELECT next.id, $1, $2, $3, $4, $5, $6, 'heinzel/' || next.id || '-' || $7, $8, $9, $10 FROM next
       RETURNING *`,
      [s.channelKey, s.threadRef, s.requestedBy, s.requestedByName, s.repository, s.baseBranch, branchSlug(s.title), s.title, s.task, s.context],
    );
    return toSession(rows[0]);
  }

  async get(id: number): Promise<CodingSession | null> {
    const { rows } = await this.db.query(`SELECT * FROM coding_sessions WHERE id = $1`, [id]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  /** Most recent sessions of a thread, newest first. */
  async inThread(channelKey: string, threadRef: string): Promise<CodingSession[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM coding_sessions WHERE channel_key = $1 AND thread_ref = $2 ORDER BY id DESC LIMIT 20`,
      [channelKey, threadRef],
    );
    return rows.map(toSession);
  }

  async recentInChannel(channelKey: string, limit = 10): Promise<CodingSession[]> {
    const { rows } = await this.db.query(`SELECT * FROM coding_sessions WHERE channel_key = $1 ORDER BY id DESC LIMIT $2`, [channelKey, limit]);
    return rows.map(toSession);
  }

  async active(): Promise<CodingSession[]> {
    const { rows } = await this.db.query(`SELECT * FROM coding_sessions WHERE status = ANY($1) ORDER BY id`, [ACTIVE_STATUSES]);
    return rows.map(toSession);
  }

  /** Sessions that currently hold a container. */
  async countRunning(): Promise<number> {
    const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM coding_sessions WHERE status IN ('running', 'cancelling')`);
    return rows[0].n;
  }

  /**
   * Moves a session from one of `from` to `to`, optionally setting more fields. Returns the updated session,
   * or null if it was not in an expected state (another worker got there first), which makes transitions idempotent.
   */
  async transition(
    id: number,
    from: CodingStatus[],
    to: CodingStatus,
    patch: Partial<Pick<CodingSession, "runnerRef" | "statusMessageRef" | "result" | "error">> = {},
  ): Promise<CodingSession | null> {
    const { rows } = await this.db.query(
      `UPDATE coding_sessions SET
         status = $3,
         runner_ref = COALESCE($4, runner_ref),
         status_message_ref = COALESCE($5, status_message_ref),
         result = COALESCE($6, result),
         error = COALESCE($7, error),
         started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
         finished_at = CASE WHEN $3 = ANY($8) THEN now() ELSE finished_at END
       WHERE id = $1 AND status = ANY($2)
       RETURNING *`,
      [id, from, to, patch.runnerRef ?? null, patch.statusMessageRef ?? null, patch.result ? JSON.stringify(patch.result) : null, patch.error ?? null, FINAL_STATUSES],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async saveProgress(id: number, progress: CodingProgress, logCursor: string | null): Promise<void> {
    await this.db.query(`UPDATE coding_sessions SET progress = $2, log_cursor = COALESCE($3, log_cursor) WHERE id = $1`, [id, JSON.stringify(progress), logCursor]);
  }

  async setStatusMessage(id: number, ref: string): Promise<void> {
    await this.db.query(`UPDATE coding_sessions SET status_message_ref = $2 WHERE id = $1`, [id, ref]);
  }

  /** Sessions nobody confirmed in time. */
  async expireUnconfirmed(olderThanMinutes: number): Promise<number> {
    const res = await this.db.query(
      `UPDATE coding_sessions SET status = 'expired', finished_at = now()
       WHERE status = 'awaiting_confirmation' AND created_at < now() - make_interval(mins => $1)`,
      [olderThanMinutes],
    );
    return res.rowCount ?? 0;
  }
}

/** "Fix login redirect!" → "fix-login-redirect" (ASCII, max 40 chars). */
export function branchSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

function toSession(r: any): CodingSession {
  return {
    id: Number(r.id),
    channelKey: r.channel_key,
    threadRef: r.thread_ref,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    backend: r.backend,
    repository: r.repository,
    baseBranch: r.base_branch,
    branch: r.branch,
    title: r.title,
    task: r.task,
    context: r.context,
    status: r.status,
    runnerRef: r.runner_ref,
    statusMessageRef: r.status_message_ref,
    logCursor: r.log_cursor,
    progress: r.progress ?? {},
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
