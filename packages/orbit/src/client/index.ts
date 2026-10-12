import { z } from "zod";
import { type DaemonInfo, readDaemonInfo } from "../config/daemon-info.ts";
import type { OrbitPaths } from "../config/paths.ts";
import {
  API_PREFIX,
  Artifacts,
  AuthProfile,
  type AuthProfileInput,
  AuthTestResult,
  BenchCompare,
  type BenchConsolidateInput,
  BenchConsolidateResult,
  BenchJob,
  BenchJobDetail,
  BenchJobList,
  type BenchJobSpecInput,
  Benchmark,
  type BenchmarkInput,
  BenchmarkList,
  type BenchRescoreInput,
  BenchRescoreResult,
  BenchTaskList,
  BenchUsage,
  CodeDiff,
  Dataset,
  type DatasetInput,
  DatasetList,
  DoctorReport,
  ExposeStatus,
  FolderExportResult,
  FolderList,
  FolderMoveResult,
  Health,
  Ledger,
  LogChunk,
  Metrics,
  NodeList,
  NodeResources,
  NodeStatus,
  NotifyTarget,
  type NotifyTargetInput,
  Run,
  RunDeletion,
  RunEvents,
  RunList,
  RunSessions,
  type RunSpecInput,
  type RunState,
} from "../contracts/index.ts";

const Ok = z.object({ ok: z.boolean() });

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class OrbitClient {
  readonly info: DaemonInfo;

  constructor(info: DaemonInfo) {
    this.info = info;
  }

  private async call<T extends z.ZodType>(
    schema: T,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<z.infer<T>> {
    const res = await fetch(`${this.info.url}${API_PREFIX}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.info.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
    return schema.parse(body);
  }

  health = () => this.call(Health, "/health");
  resources = () => this.call(NodeResources, "/resources");
  doctor = () => this.call(DoctorReport, "/doctor");
  ledger = () => this.call(Ledger, "/ledger");

  submit = (spec: RunSpecInput, folder?: string) =>
    this.call(Run, `/runs${folderQuery(folder)}`, {
      method: "POST",
      body: spec,
      timeoutMs: 600_000,
    });
  /** Pre-flight checks of a run without submitting it. */
  check = (spec: RunSpecInput) =>
    this.call(DoctorReport, "/runs/check", { method: "POST", body: spec, timeoutMs: 120_000 });
  list = (q: { states?: RunState[]; group?: string; folder?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.states?.length) p.set("state", q.states.join(","));
    if (q.group) p.set("group", q.group);
    if (q.folder) p.set("folder", q.folder);
    if (q.limit) p.set("limit", String(q.limit));
    return this.call(RunList, `/runs?${p}`).then((r) => r.runs);
  };
  get = (id: string) => this.call(Run, `/runs/${enc(id)}`);
  cancel = (id: string) => this.call(Run, `/runs/${enc(id)}/cancel`, { method: "POST" });
  note = (id: string, note: string) =>
    this.call(Run, `/runs/${enc(id)}/note`, { method: "PUT", body: { note } });
  wait = (id: string, timeoutSec = 60) =>
    this.call(Run, `/runs/${enc(id)}/wait?timeout=${timeoutSec}`, {
      timeoutMs: (timeoutSec + 30) * 1000,
    });
  events = (id: string, after = 0) =>
    this.call(RunEvents, `/runs/${enc(id)}/events?after=${after}`).then((r) => r.events);
  logs = (id: string, offset: number, limit = 256 * 1024) =>
    this.call(LogChunk, `/runs/${enc(id)}/logs?offset=${offset}&limit=${limit}`);
  metrics = (id: string) => this.call(Metrics, `/runs/${enc(id)}/metrics`);
  artifacts = (id: string) => this.call(Artifacts, `/runs/${enc(id)}/artifacts`);
  diff = (id: string) => this.call(CodeDiff, `/runs/${enc(id)}/diff`);
  deleteRuns = (ids: string[]) =>
    this.call(RunDeletion, "/runs/delete", { method: "POST", body: { ids }, timeoutMs: 600_000 });
  session = (id: string) => this.call(RunSessions, `/runs/${enc(id)}/session`);

  authList = () =>
    this.call(z.object({ profiles: z.array(AuthProfile) }), "/auth").then((r) => r.profiles);
  authPut = (p: AuthProfileInput) => this.call(AuthProfile, "/auth", { method: "POST", body: p });
  authRemove = (name: string) => this.call(Ok, `/auth/${enc(name)}`, { method: "DELETE" });
  authTest = (name: string, image?: string) =>
    this.call(AuthTestResult, `/auth/${enc(name)}/test`, {
      method: "POST",
      body: { image },
      timeoutMs: 15 * 60_000,
    });

  notifyList = () =>
    this.call(z.object({ targets: z.array(NotifyTarget) }), "/notify").then((r) => r.targets);
  notifyPut = (t: NotifyTargetInput) =>
    this.call(NotifyTarget, "/notify", { method: "POST", body: t });
  notifyRemove = (name: string) => this.call(Ok, `/notify/${enc(name)}`, { method: "DELETE" });
  notifyTest = (name: string) => this.call(Ok, `/notify/${enc(name)}/test`, { method: "POST" });
  notifyReconnect = (name: string) =>
    this.call(Ok, `/notify/${enc(name)}/reconnect`, { method: "POST" });
  notifyPair = (name: string, code: string) =>
    this.call(Ok, `/notify/${enc(name)}/pair`, { method: "POST", body: { code } });

  nodes = () => this.call(NodeList, "/cluster/nodes").then((r) => r.nodes);
  nodeAdd = (url: string, token: string) =>
    this.call(NodeStatus, "/cluster/nodes", { method: "POST", body: { url, token } });
  nodeRemove = (name: string) => this.call(Ok, `/cluster/nodes/${enc(name)}`, { method: "DELETE" });
  exposeStatus = () => this.call(ExposeStatus, "/cluster/expose");
  expose = (listen: string | null) =>
    this.call(ExposeStatus, "/cluster/expose", { method: "POST", body: { listen } });
  clusterToken = (rotate = false) =>
    this.call(
      z.object({ token: z.string() }),
      rotate ? "/cluster/token/rotate" : "/cluster/token",
      rotate ? { method: "POST" } : {},
    ).then((r) => r.token);

  datasets = () => this.call(DatasetList, "/datasets").then((r) => r.datasets);
  datasetPut = (d: DatasetInput) => this.call(Dataset, "/datasets", { method: "POST", body: d });
  datasetRemove = (name: string) => this.call(Ok, `/datasets/${enc(name)}`, { method: "DELETE" });

  benchmarks = () => this.call(BenchmarkList, "/benchmarks").then((r) => r.benchmarks);
  benchmarkPut = (b: BenchmarkInput) =>
    // Registration lists the tasks through the adapter (up to its 120 s limit).
    this.call(Benchmark, "/benchmarks", { method: "POST", body: b, timeoutMs: 180_000 });
  benchmarkRemove = (name: string) =>
    this.call(Ok, `/benchmarks/${enc(name)}`, { method: "DELETE" });
  benchTasks = (name: string) =>
    this.call(BenchTaskList, `/benchmarks/${enc(name)}/tasks`, { timeoutMs: 180_000 }).then(
      (r) => r.tasks,
    );
  benchSubmit = (spec: BenchJobSpecInput, folder?: string) =>
    this.call(BenchJob, `/bench/jobs${folderQuery(folder)}`, {
      method: "POST",
      body: spec,
      timeoutMs: 600_000,
    });
  /** Preview/apply retries or new tasks; transport equivalence is explicitly opt-in. */
  benchConsolidate = (id: string, body: BenchConsolidateInput) =>
    this.call(BenchConsolidateResult, `/bench/jobs/${enc(id)}/consolidate`, {
      method: "POST",
      body,
      timeoutMs: 600_000,
    });
  benchRescore = (id: string, body: BenchRescoreInput) =>
    this.call(BenchRescoreResult, `/bench/jobs/${enc(id)}/rescore`, { method: "POST", body });
  benchUsage = (ids: string[]) =>
    this.call(BenchUsage, `/bench/usage?jobs=${ids.map(enc).join(",")}`);
  benchDeleteJob = (id: string) =>
    this.call(RunDeletion, `/bench/jobs/${enc(id)}`, { method: "DELETE", timeoutMs: 600_000 });
  benchJobs = (limit = 200) =>
    this.call(BenchJobList, `/bench/jobs?limit=${limit}`).then((r) => r.jobs);
  benchJob = (id: string) => this.call(BenchJobDetail, `/bench/jobs/${enc(id)}`);
  benchCancel = (id: string) =>
    this.call(BenchJob, `/bench/jobs/${enc(id)}/cancel`, { method: "POST" });
  benchCompare = (ids: string[]) =>
    this.call(BenchCompare, `/bench/compare?jobs=${ids.map(enc).join(",")}`);

  folders = () => this.call(FolderList, "/folders").then((r) => r.folders);
  move = (ids: string[], folder: string) =>
    this.call(FolderMoveResult, "/folders/move", { method: "POST", body: { ids, folder } });
  exportFolder = (folder: string, dest: string) =>
    this.call(FolderExportResult, "/folders/export", {
      method: "POST",
      body: { folder, dest },
      timeoutMs: 3_600_000,
    });
}

const enc = encodeURIComponent;
const folderQuery = (f?: string) => (f ? `?folder=${enc(f)}` : "");

/** Return a client for a live daemon, or null when none is reachable. */
export async function tryConnect(paths: OrbitPaths): Promise<OrbitClient | null> {
  const info = readDaemonInfo(paths);
  if (!info) return null;
  const client = new OrbitClient(info);
  try {
    await client.health();
    return client;
  } catch {
    return null;
  }
}
