import type { Db } from "../db/pool.js";

/** Job kinds and their payloads. Extend here when adding a new kind of background work. */
export interface JobPayloads {
  /** Heinzel was addressed (or triage decided to speak): produce a reply in the thread. */
  respond: { eventId: number; mode: "direct" | "ambient" | "thread"; reason?: string; tier?: "default" | "heavy" };
  /** A message Heinzel was not addressed in: decide whether to ignore, remember, speak or follow up. */
  triage: { eventId: number; botInThread: boolean };
  /** Check back on a thread that may have gone quiet. */
  followup: { channelKey: string; threadRef: string; note: string; scheduledAfterEventId: number };
}

export type JobKind = keyof JobPayloads;

export interface Job<K extends JobKind = JobKind> {
  id: number;
  kind: K;
  payload: JobPayloads[K];
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  /** At most one queued/running job per key; a duplicate enqueue is silently dropped. */
  dedupeKey?: string;
  maxAttempts?: number;
}

const NOTIFY_CHANNEL = "heinzel_jobs";

export class JobQueue {
  constructor(private readonly db: Db) {}

  /** Returns the job id, or null if a job with the same dedupe key is already pending. */
  async enqueue<K extends JobKind>(kind: K, payload: JobPayloads[K], opts: EnqueueOptions = {}): Promise<number | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, run_at, dedupe_key, max_attempts)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [kind, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 3],
    );
    const row = rows[0];
    if (!row) return null;
    await this.db.query(`SELECT pg_notify($1, '')`, [NOTIFY_CHANNEL]);
    return Number(row.id);
  }

  /** Claims the next due job, or null if none is ready. */
  async claim(): Promise<Job | null> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
    );
    const r = rows[0];
    if (!r) return null;
    return { id: Number(r.id), kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts };
  }

  async complete(id: number): Promise<void> {
    await this.db.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL WHERE id = $1`, [id]);
  }

  /** Retries with exponential backoff until max_attempts, then marks the job failed. */
  async fail(job: Job, error: unknown): Promise<"retry" | "failed"> {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    if (job.attempts < job.maxAttempts) {
      const delaySec = Math.min(300, 5 * 2 ** (job.attempts - 1));
      await this.db.query(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = $2,
                run_at = now() + make_interval(secs => $3) WHERE id = $1`,
        [job.id, message.slice(0, 4000), delaySec],
      );
      return "retry";
    }
    await this.db.query(
      `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = $2, finished_at = now() WHERE id = $1`,
      [job.id, message.slice(0, 4000)],
    );
    return "failed";
  }

  /** Re-queues jobs whose worker died mid-run. */
  async recoverStale(olderThanMinutes = 10): Promise<number> {
    const res = await this.db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL
       WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
      [olderThanMinutes],
    );
    return res.rowCount ?? 0;
  }

  /** Cancels pending jobs with the given dedupe key (e.g. a follow-up made obsolete by new activity). */
  async cancelByDedupeKey(dedupeKey: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE jobs SET status = 'done', finished_at = now(), last_error = 'cancelled'
       WHERE dedupe_key = $1 AND status = 'queued'`,
      [dedupeKey],
    );
    return res.rowCount ?? 0;
  }

  /** Subscribes to enqueue notifications so workers wake immediately instead of waiting for the next poll. */
  async listen(onNotify: () => void): Promise<() => Promise<void>> {
    const client = await this.db.connect();
    client.on("notification", onNotify);
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    return async () => {
      client.off("notification", onNotify);
      await client.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => {});
      client.release();
    };
  }
}
