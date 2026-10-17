import { describe, expect, it } from "vitest";
import { KubernetesRunner, kubeLabels, parseKubeLogs, type KubeApi } from "../src/coding/kubernetes.js";

/** Records calls and answers from a small in-memory model of jobs, secrets and pods. */
function fakeApi() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const jobs = new Map<string, Record<string, any>>();
  const secrets = new Map<string, Record<string, any>>();
  const pods = new Map<string, Record<string, any>>(); // by job name
  let logs = "";
  const api: KubeApi = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      const send = (status: number, data?: unknown) => ({ status, body: data === undefined ? "" : JSON.stringify(data) });
      const [p, query] = path.split("?");
      let m: RegExpExecArray | null;
      if ((m = /\/jobs\/([^/]+)$/.exec(p!))) {
        const job = jobs.get(m[1]!);
        if (method === "GET") return job ? send(200, job) : send(404, { message: "not found" });
        if (method === "PATCH") return job ? (Object.assign(job.spec, (body as any).spec), send(200, job)) : send(404, {});
        if (method === "DELETE") return jobs.delete(m[1]!) ? send(200, {}) : send(404, {});
      }
      if (/\/jobs$/.test(p!) && method === "POST") {
        const b = body as any;
        if (jobs.has(b.metadata.name)) return send(409, { message: "exists" });
        const job = { ...b, metadata: { ...b.metadata, uid: "uid-1" } };
        jobs.set(b.metadata.name, job);
        return send(201, job);
      }
      if (/\/secrets$/.test(p!) && method === "POST") {
        const b = body as any;
        if (secrets.has(b.metadata.name)) return send(409, {});
        secrets.set(b.metadata.name, b);
        return send(201, b);
      }
      if ((m = /\/secrets\/([^/]+)$/.exec(p!))) {
        const s = secrets.get(m[1]!)!;
        if (method === "PATCH") Object.assign(s.metadata, (body as any).metadata);
        if (method === "PUT") secrets.set(m[1]!, body as any);
        return send(200, s);
      }
      if (/\/pods$/.test(p!)) {
        const job = decodeURIComponent(new URLSearchParams(query).get("labelSelector")!).replace("job-name=", "");
        const pod = pods.get(job);
        return send(200, { items: pod ? [pod] : [] });
      }
      if (/\/log$/.test(p!)) return logs ? { status: 200, body: logs } : { status: 204, body: "" };
      return send(500, { message: `unexpected ${method} ${path}` });
    },
  };
  return { api, calls, jobs, secrets, pods, setLogs: (l: string) => (logs = l) };
}

const spec = {
  name: "heinzel-coding-7",
  image: "ghcr.io/v0lumehi/heinzel-coder:0.1.0",
  env: { HEINZEL_GIT_TOKEN: "glpat-secret", HEINZEL_TASK_B64: "dGFzaw==" },
  labels: { "heinzel.coding.session": "7", "heinzel.coding.repository": "team/api" },
  memoryMb: 4096,
  cpus: 2,
};

describe("KubernetesRunner", () => {
  it("creates a hardened Job whose Secret holds the env and is owned by the Job; start is idempotent", async () => {
    const k = fakeApi();
    const runner = new KubernetesRunner({ namespace: "coding", runtimeClassName: "gvisor", activeDeadlineSeconds: 3300, api: k.api });
    expect(await runner.start(spec)).toBe("heinzel-coding-7");

    const job = k.jobs.get("heinzel-coding-7")!;
    const pod = job.spec.template.spec;
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 3300 });
    expect(pod).toMatchObject({ restartPolicy: "Never", automountServiceAccountToken: false, runtimeClassName: "gvisor" });
    expect(pod.containers[0]).toMatchObject({
      image: spec.image,
      envFrom: [{ secretRef: { name: "heinzel-coding-7-env" } }],
      resources: { limits: { cpu: "2", memory: "4096Mi" } },
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
    });
    expect(JSON.stringify(job)).not.toContain("glpat-secret");
    expect(job.spec.template.metadata.labels).toMatchObject({ "heinzel.coding": "true", "heinzel.dev/coding.session": "7", "heinzel.dev/coding.repository": "team_api" });

    const secret = k.secrets.get("heinzel-coding-7-env")!;
    expect(secret.stringData.HEINZEL_GIT_TOKEN).toBe("glpat-secret");
    expect(secret.metadata.ownerReferences).toEqual([{ apiVersion: "batch/v1", kind: "Job", name: "heinzel-coding-7", uid: "uid-1", blockOwnerDeletion: false }]);

    const before = k.calls.length;
    await runner.start(spec);
    expect(k.calls.length).toBe(before + 1); // only the GET
  });

  it("maps pod states: pending, running, done, out of memory, image pull errors, stopped", async () => {
    const k = fakeApi();
    const runner = new KubernetesRunner({ namespace: "coding", activeDeadlineSeconds: 3300, api: k.api });
    expect(await runner.state("heinzel-coding-7")).toBeNull();
    await runner.start(spec);
    expect(await runner.state("heinzel-coding-7")).toEqual({ running: true, exitCode: null, oomKilled: false });

    const pod = (state: object) => k.pods.set("heinzel-coding-7", { metadata: { name: "p1" }, status: { containerStatuses: [{ state }] } });
    pod({ running: {} });
    expect((await runner.state("heinzel-coding-7"))?.running).toBe(true);
    pod({ terminated: { exitCode: 0, reason: "Completed" } });
    expect(await runner.state("heinzel-coding-7")).toEqual({ running: false, exitCode: 0, oomKilled: false });
    pod({ terminated: { exitCode: 137, reason: "OOMKilled" } });
    expect((await runner.state("heinzel-coding-7"))?.oomKilled).toBe(true);
    pod({ waiting: { reason: "ImagePullBackOff", message: "pull access denied" } });
    expect((await runner.state("heinzel-coding-7"))?.error).toMatch(/ImagePullBackOff: pull access denied/);

    pod({ running: {} });
    await runner.stop("heinzel-coding-7");
    expect(k.jobs.get("heinzel-coding-7")!.spec.suspend).toBe(true);
    k.pods.delete("heinzel-coding-7");
    expect(await runner.state("heinzel-coding-7")).toEqual({ running: false, exitCode: null, oomKilled: false });

    await runner.remove("heinzel-coding-7");
    expect(k.calls.at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("propagationPolicy=Background") });
    expect(await runner.state("heinzel-coding-7")).toBeNull();
  });

  it("reads logs after the cursor with nanosecond precision", async () => {
    const k = fakeApi();
    const runner = new KubernetesRunner({ namespace: "coding", activeDeadlineSeconds: 60, api: k.api });
    expect(await runner.logs("heinzel-coding-7", null)).toEqual([]);
    k.pods.set("heinzel-coding-7", { metadata: { name: "p1" }, status: {} });
    expect(await runner.logs("heinzel-coding-7", null)).toEqual([]); // 204 while the container starts
    k.setLogs("2026-10-17T10:00:00.100000000Z [heinzel-coder] cloning\n2026-10-17T10:00:00.200000000Z {\"type\":\"step\"}\n");
    expect((await runner.logs("heinzel-coding-7", null)).map((l) => l.text)).toEqual(["[heinzel-coder] cloning", '{"type":"step"}']);
    expect((await runner.logs("heinzel-coding-7", "2026-10-17T10:00:00.100000000Z")).map((l) => l.text)).toEqual(['{"type":"step"}']);
    expect(k.calls.at(-1)!.path).toContain("sinceTime=2026-10-17T10%3A00%3A00Z");
  });
});

describe("kubernetes helpers", () => {
  it("parses timestamped log lines and makes valid labels", () => {
    expect(parseKubeLogs("2026-10-17T10:00:00Z hello\nnoise\n")).toEqual([{ ts: "2026-10-17T10:00:00Z", stream: "stdout", text: "hello" }]);
    expect(kubeLabels({ "heinzel.coding.repository": "group/sub group/very-long-name-".repeat(5) })["heinzel.dev/coding.repository"]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,61}[A-Za-z0-9]$/);
  });
});
