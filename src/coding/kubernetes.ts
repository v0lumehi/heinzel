import { readFileSync } from "node:fs";
import { Agent, request, type Dispatcher } from "undici";
import { compareTimestamps } from "./docker.js";
import type { CodingRunner, LogLine, RunnerState, RunSpec } from "./runner.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Minimal Kubernetes REST client: in-cluster service account, JSON in and out. */
export interface KubeApi {
  call(method: Dispatcher.HttpMethod, path: string, body?: unknown, contentType?: string): Promise<{ status: number; body: string }>;
}

export function inClusterApi(): KubeApi {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("CODING_RUNNER=kubernetes needs to run inside a Kubernetes pod (KUBERNETES_SERVICE_HOST is not set)");
  const dispatcher = new Agent({ connect: { ca: readFileSync(`${SA_DIR}/ca.crt`) } });
  const origin = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    async call(method, path, body, contentType = "application/json") {
      // Projected tokens rotate, so read it for every call.
      const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
      const res = await request(`${origin}${path}`, {
        method,
        dispatcher,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.statusCode, body: await res.body.text() };
    },
  };
}

export interface KubernetesRunnerOptions {
  namespace: string;
  /** e.g. gvisor or kata, for stronger isolation than plain containers. */
  runtimeClassName?: string;
  /** Hard limit for the Job; the coordinator stops sessions at CODING_TIMEOUT_MIN before that. */
  activeDeadlineSeconds: number;
  api?: KubeApi;
}

/** Waiting reasons that will not resolve on their own. */
const STUCK = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError", "RunContainerError"]);

/**
 * Runs each coding session as a Kubernetes Job with one pod. Secrets (git token, LLM key) go into a Secret owned by the Job,
 * so deleting the Job removes them too. Network isolation is a NetworkPolicy in the coding namespace (see the Helm chart).
 */
export class KubernetesRunner implements CodingRunner {
  private readonly api: KubeApi;
  private readonly ns: string;

  constructor(private readonly opts: KubernetesRunnerOptions) {
    this.api = opts.api ?? inClusterApi();
    this.ns = encodeURIComponent(opts.namespace);
  }

  private async json<T>(method: Dispatcher.HttpMethod, path: string, body?: unknown, ok: number[] = [200, 201], contentType?: string): Promise<{ status: number; data: T | null }> {
    const res = await this.api.call(method, path, body, contentType);
    if (!ok.includes(res.status)) throw new Error(`Kubernetes ${method} ${path.split("?")[0]} failed (${res.status}): ${kubeMessage(res.body)}`);
    return { status: res.status, data: res.body ? (JSON.parse(res.body) as T) : null };
  }

  /** Registries cannot be checked from here; a missing image shows up as a failed session (ErrImagePull). */
  async checkImage(): Promise<void> {}

  async start(spec: RunSpec): Promise<string> {
    const jobs = `/apis/batch/v1/namespaces/${this.ns}/jobs`;
    const secrets = `/api/v1/namespaces/${this.ns}/secrets`;
    // Idempotent by name: a retried start job finds what it already created.
    const existing = await this.json<KubeJob>("GET", `${jobs}/${spec.name}`, undefined, [200, 404]);
    if (existing.status === 200) return spec.name;

    const labels = { "app.kubernetes.io/name": "heinzel-coder", "app.kubernetes.io/managed-by": "heinzel", ...kubeLabels(spec.labels) };
    const secretName = `${spec.name}-env`;
    const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: secretName, labels }, type: "Opaque", stringData: spec.env };
    const created = await this.json("POST", secrets, secret, [201, 409]);
    if (created.status === 409) await this.json("PUT", `${secrets}/${secretName}`, secret);

    const job = await this.json<KubeJob>("POST", jobs, this.jobManifest(spec, labels, secretName), [201, 409]);
    const uid = job.data?.metadata?.uid ?? (await this.json<KubeJob>("GET", `${jobs}/${spec.name}`)).data?.metadata?.uid;
    // The Secret goes away with the Job.
    await this.json(
      "PATCH",
      `${secrets}/${secretName}`,
      { metadata: { ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: spec.name, uid, blockOwnerDeletion: false }] } },
      [200],
      "application/merge-patch+json",
    );
    return spec.name;
  }

  jobManifest(spec: RunSpec, labels: Record<string, string>, secretName: string): Record<string, unknown> {
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: spec.name, labels },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: this.opts.activeDeadlineSeconds,
        // Safety net if Heinzel never cleans up; normally the Job is deleted when the session ends.
        ttlSecondsAfterFinished: 86_400,
        template: {
          metadata: { labels: { ...labels, "heinzel.coding": "true" } },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            ...(this.opts.runtimeClassName ? { runtimeClassName: this.opts.runtimeClassName } : {}),
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "coder",
                image: spec.image,
                envFrom: [{ secretRef: { name: secretName } }],
                // Modest requests so a session schedules on busy nodes; the limits are what CODING_CPUS / CODING_MEMORY_MB allow.
                resources: {
                  requests: { cpu: String(Math.min(spec.cpus, 0.5)), memory: `${Math.min(spec.memoryMb, 1024)}Mi` },
                  limits: { cpu: String(spec.cpus), memory: `${spec.memoryMb}Mi` },
                },
                securityContext: {
                  // Root only to clone and push; the agent itself runs as an unprivileged user (coder/entrypoint.mjs).
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"] },
                },
              },
            ],
          },
        },
      },
    };
  }

  async state(ref: string): Promise<RunnerState | null> {
    const job = await this.json<KubeJob>("GET", `/apis/batch/v1/namespaces/${this.ns}/jobs/${encodeURIComponent(ref)}`, undefined, [200, 404]);
    if (job.status === 404 || !job.data) return null;
    const pod = await this.pod(ref);
    const cs = pod?.status?.containerStatuses?.[0];
    if (cs?.state?.terminated) {
      return { running: false, exitCode: cs.state.terminated.exitCode ?? null, oomKilled: cs.state.terminated.reason === "OOMKilled" };
    }
    const waiting = cs?.state?.waiting;
    if (waiting?.reason && STUCK.has(waiting.reason)) {
      return { running: false, exitCode: null, oomKilled: false, error: `the coding container could not start (${waiting.reason}: ${waiting.message ?? "no details"})` };
    }
    const conditions = job.data.status?.conditions ?? [];
    const failed = conditions.find((c) => (c.type === "Failed" || c.type === "Suspended") && c.status === "True");
    if (failed && !cs?.state?.running) {
      return { running: false, exitCode: null, oomKilled: false, error: failed.type === "Suspended" ? undefined : `the job failed (${failed.reason ?? "unknown"})` };
    }
    if (job.data.spec?.suspend && !pod) return { running: false, exitCode: null, oomKilled: false };
    // Pending (scheduling, pulling) counts as running.
    return { running: true, exitCode: null, oomKilled: false };
  }

  async logs(ref: string, since: string | null): Promise<LogLine[]> {
    const pod = await this.pod(ref);
    if (!pod?.metadata?.name) return [];
    const q = new URLSearchParams({ timestamps: "true" });
    if (since) q.set("sinceTime", since.replace(/\.\d+/, "")); // seconds precision; exact filtering below
    const res = await this.api.call("GET", `/api/v1/namespaces/${this.ns}/pods/${encodeURIComponent(pod.metadata.name)}/log?${q}`);
    if (res.status === 204 || res.status === 400 || res.status === 404) return []; // no output yet, container not started yet, or gone
    if (res.status !== 200) throw new Error(`Kubernetes logs failed (${res.status}): ${kubeMessage(res.body)}`);
    const lines = parseKubeLogs(res.body);
    return since ? lines.filter((l) => compareTimestamps(l.ts, since) > 0) : lines;
  }

  /** Suspending the Job makes Kubernetes terminate its pod (SIGTERM, then SIGKILL after the grace period). */
  async stop(ref: string): Promise<void> {
    await this.json(
      "PATCH",
      `/apis/batch/v1/namespaces/${this.ns}/jobs/${encodeURIComponent(ref)}`,
      { spec: { suspend: true } },
      [200, 404],
      "application/merge-patch+json",
    );
  }

  async remove(ref: string): Promise<void> {
    await this.json("DELETE", `/apis/batch/v1/namespaces/${this.ns}/jobs/${encodeURIComponent(ref)}?propagationPolicy=Background`, undefined, [200, 202, 404]);
  }

  private async pod(job: string): Promise<KubePod | null> {
    const { data } = await this.json<{ items: KubePod[] }>("GET", `/api/v1/namespaces/${this.ns}/pods?labelSelector=${encodeURIComponent(`job-name=${job}`)}`);
    const items = data?.items ?? [];
    return items.sort((a, b) => (b.metadata?.creationTimestamp ?? "").localeCompare(a.metadata?.creationTimestamp ?? ""))[0] ?? null;
  }
}

interface KubeJob {
  metadata?: { uid?: string };
  spec?: { suspend?: boolean };
  status?: { conditions?: { type: string; status: string; reason?: string }[] };
}

interface KubePod {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: {
    containerStatuses?: {
      state?: {
        running?: object;
        waiting?: { reason?: string; message?: string };
        terminated?: { exitCode?: number; reason?: string };
      };
    }[];
  };
}

/** Kubernetes merges stdout and stderr; the log parser treats non-JSON lines like stderr anyway. */
export function parseKubeLogs(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const sp = raw.indexOf(" ");
    const ts = sp > 0 ? raw.slice(0, sp) : "";
    if (!/^\d{4}-\d\d-\d\dT/.test(ts)) continue;
    lines.push({ ts, stream: "stdout", text: raw.slice(sp + 1) });
  }
  return lines;
}

/** Label values: at most 63 characters of [A-Za-z0-9._-], starting and ending alphanumeric. Keys get a domain prefix. */
export function kubeLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([k, v]) => [
      k.replace(/^heinzel\./, "heinzel.dev/").replace(/[^A-Za-z0-9._/-]/g, "-"),
      v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""),
    ]),
  );
}

function kubeMessage(body: string): string {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
