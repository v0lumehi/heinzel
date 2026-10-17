/** Starts and observes coding containers: Docker (docker.ts) or Kubernetes Jobs (kubernetes.ts). */
export interface CodingRunner {
  /** Throws with an actionable message if the image is missing. */
  checkImage(image: string): Promise<void>;
  /** Creates and starts the container; idempotent by `spec.name`. Returns the runner's reference (container id). */
  start(spec: RunSpec): Promise<string>;
  /** null = the container is gone. */
  state(ref: string): Promise<RunnerState | null>;
  /** Log lines after `since` (an RFC 3339 timestamp from a previous line), oldest first. */
  logs(ref: string, since: string | null): Promise<LogLine[]>;
  stop(ref: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

export interface RunSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  network?: string;
  memoryMb: number;
  cpus: number;
}

export interface RunnerState {
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  /** Why it never ran (e.g. the image could not be pulled), if known. */
  error?: string;
}

export interface LogLine {
  ts: string;
  stream: "stdout" | "stderr";
  text: string;
}
