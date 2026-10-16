import type { Logger } from "pino";
import type { Job, JobKind, JobPayloads, JobQueue } from "./queue.js";

export type JobHandlers = { [K in JobKind]: (payload: JobPayloads[K], job: Job<K>) => Promise<void> };

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs?: number;
}

/** Runs `concurrency` loops that claim and execute jobs until stopped. */
export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];
  private wake: (() => void)[] = [];
  private unlisten: (() => Promise<void>) | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly log: Logger,
    private readonly opts: WorkerOptions,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.unlisten = await this.queue.listen(() => this.wakeAll());
    const recovered = await this.queue.recoverStale();
    if (recovered) this.log.warn({ recovered }, "re-queued stale jobs");
    this.staleTimer = setInterval(() => void this.queue.recoverStale().catch(() => {}), 60_000);
    for (let i = 0; i < this.opts.concurrency; i++) this.loops.push(this.loop(i));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.wakeAll();
    await Promise.all(this.loops);
    await this.unlisten?.();
  }

  private wakeAll(): void {
    const w = this.wake;
    this.wake = [];
    w.forEach((fn) => fn());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const fn = (): void => done();
      function done(): void {
        clearTimeout(t);
        resolve();
      }
      this.wake.push(fn);
    });
  }

  private async loop(n: number): Promise<void> {
    const poll = this.opts.pollIntervalMs ?? 2000;
    while (this.running) {
      let job: Job | null = null;
      try {
        job = await this.queue.claim();
      } catch (err) {
        this.log.error({ err, loop: n }, "failed to claim job");
        await this.sleep(poll);
        continue;
      }
      if (!job) {
        await this.sleep(poll);
        continue;
      }
      const log = this.log.child({ jobId: job.id, kind: job.kind, attempt: job.attempts });
      const started = Date.now();
      try {
        const handler = this.handlers[job.kind] as (p: unknown, j: Job) => Promise<void>;
        await handler(job.payload, job);
        await this.queue.complete(job.id);
        log.debug({ ms: Date.now() - started }, "job done");
      } catch (err) {
        const outcome = await this.queue.fail(job, err).catch(() => "failed" as const);
        log.error({ err, outcome }, "job failed");
      }
    }
  }
}
