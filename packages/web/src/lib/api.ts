// Typed fetch helpers for the daemon API. Types come from the shared contracts (type-only import,
// so zod is not bundled); the daemon validates, the Web trusts its own daemon.
import type {
  AgentCatalog,
  AgentList,
  Artifacts,
  AuthProfile,
  AuthTestResult,
  BenchCatalog,
  BenchCompare,
  BenchCompatibility,
  BenchConsolidateInput,
  BenchConsolidateResult,
  BenchJob,
  BenchJobDetail,
  BenchJobList,
  BenchJobSpecInput,
  BenchLabels,
  Benchmark,
  BenchReport,
  BenchRescoreInput,
  BenchRescoreResult,
  BenchTaskList,
  CalibrationRequestInput,
  DoctorReport,
  FolderMoveResult,
  FolderStat,
  Ledger,
  LogChunk,
  MethodList,
  Metrics,
  NotifyTarget,
  Run,
  RunCursor,
  RunDeletion,
  RunEvent,
  RunList,
  RunSessions,
} from "@zjunlp/orbit/contracts";

export type {
  AgentCatalog,
  AgentCatalogEntry,
  Artifacts,
  AuthProfile,
  BenchCatalog,
  BenchCompare,
  BenchCompatibility,
  BenchJob,
  BenchJobDetail,
  BenchJobList,
  BenchJobSpecInput,
  Benchmark,
  BenchTask,
  BenchTaskList,
  CalibrationCheck,
  CalibrationReport,
  CapabilityState,
  CatalogEntry,
  CatalogMethod,
  CodeSnapshot,
  CompatibilityCell,
  FolderStat,
  Gpu,
  GpuProcess,
  Lease,
  Ledger,
  LogChunk,
  Method,
  MethodLine,
  MethodList,
  MethodRevisionEntry,
  MethodSummary,
  Metrics,
  NodeResources,
  NodeStatus,
  NotifyTarget,
  Outcome,
  Review,
  ReviewFile,
  ReviewItem,
  Run,
  RunEvent,
  RunSessions,
  RunState,
  Scoring,
  SessionMessage,
  SessionTranscript,
  Trial,
} from "@zjunlp/orbit/contracts";

export const API = "/api/v1";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Set when any request returns 401; the shell then shows the login hint. */
export const authState = { unauthorized: false, listeners: new Set<() => void>() };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    authState.unauthorized = true;
    for (const l of authState.listeners) l();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(res.status, body?.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => req<{ ok: boolean }>("/health"),
  runs: (limit = 1000) => api.runsPage(limit).then((r) => r.runs),
  runsPage: (limit = 1000, before?: RunCursor) =>
    req<RunList>(`/runs?limit=${limit}${before ? `&before=${enc(JSON.stringify(before))}` : ""}`),
  allRuns: async (): Promise<Run[]> => {
    const runs: Run[] = [];
    let before: RunCursor | undefined;
    do {
      const page = await api.runsPage(1000, before);
      runs.push(...page.runs);
      before = page.next ?? undefined;
    } while (before);
    return runs;
  },
  run: (id: string) => req<Run>(`/runs/${enc(id)}`),
  resume: (id: string) =>
    req<Run>(`/runs/${enc(id)}/resume`, { method: "POST", body: JSON.stringify({}) }),
  cancel: (id: string) => req<Run>(`/runs/${enc(id)}/cancel`, { method: "POST" }),
  deleteRuns: (ids: string[]) =>
    req<RunDeletion>("/runs/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  note: (id: string, note: string) =>
    req<Run>(`/runs/${enc(id)}/note`, { method: "PUT", body: JSON.stringify({ note }) }),
  events: (id: string) =>
    req<{ events: RunEvent[] }>(`/runs/${enc(id)}/events`).then((r) => r.events),
  logs: (id: string, offset: number, limit = 1024 * 1024) =>
    req<LogChunk>(`/runs/${enc(id)}/logs?offset=${offset}&limit=${limit}`),
  metrics: (id: string) => req<Metrics>(`/runs/${enc(id)}/metrics`),
  artifacts: (id: string) => req<Artifacts>(`/runs/${enc(id)}/artifacts`),
  diff: (id: string) => req<{ patch: string; truncated: boolean }>(`/runs/${enc(id)}/diff`),
  session: (id: string) => req<RunSessions>(`/runs/${enc(id)}/session`),
  ledger: () => req<Ledger>("/ledger"),
  doctor: () => req<DoctorReport>("/doctor"),
  authProfiles: () => req<{ profiles: AuthProfile[] }>("/auth").then((r) => r.profiles),
  agents: () => req<AgentList>("/agents").then((r) => r.agents),
  authRemove: (name: string) => req<{ ok: boolean }>(`/auth/${enc(name)}`, { method: "DELETE" }),
  authTest: (name: string) =>
    req<AuthTestResult>(`/auth/${enc(name)}/test`, { method: "POST", body: "{}" }),
  notifyTargets: () => req<{ targets: NotifyTarget[] }>("/notify").then((r) => r.targets),
  notifyRemove: (name: string) =>
    req<{ ok: boolean }>(`/notify/${enc(name)}`, { method: "DELETE" }),
  notifyTest: (name: string) =>
    req<{ ok: boolean }>(`/notify/${enc(name)}/test`, { method: "POST" }),
  benchmarks: () => req<{ benchmarks: Benchmark[] }>("/benchmarks").then((r) => r.benchmarks),
  benchInfo: (name: string) => req<BenchTaskList>(`/benchmarks/${enc(name)}/tasks`),
  benchTasks: (name: string) => api.benchInfo(name).then((r) => r.tasks),
  benchSubmit: (spec: BenchJobSpecInput, folder = "") =>
    req<BenchJob>(`/bench/jobs${folder ? `?folder=${enc(folder)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(spec),
    }),
  benchJobs: () => req<BenchJobList>("/bench/jobs").then((r) => r.jobs),
  agentCatalog: () => req<AgentCatalog>("/agents/catalog"),
  benchCompatibility: () => req<BenchCompatibility>("/bench/compatibility"),
  methods: (metric?: string) =>
    req<MethodList>(`/methods${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`).then(
      (r) => r.methods,
    ),
  benchLabel: (name: string, labels: BenchLabels) =>
    req<Benchmark>(`/benchmarks/${enc(name)}/labels`, {
      method: "PATCH",
      body: JSON.stringify(labels),
    }),
  benchCatalog: (refresh: string[] = []) =>
    req<BenchCatalog>(
      `/bench/catalog${refresh.length ? `?refresh=${refresh.map(enc).join(",")}` : ""}`,
    ),
  benchCalibrate: (body: CalibrationRequestInput) =>
    req<BenchJob>("/bench/calibrations", { method: "POST", body: JSON.stringify(body) }),
  benchJob: (id: string) => req<BenchJobDetail>(`/bench/jobs/${enc(id)}`),
  benchReports: (id: string) =>
    req<{ reports: BenchReport[] }>(`/bench/jobs/${enc(id)}/reports`).then((r) => r.reports),
  benchCancel: (id: string) => req<BenchJob>(`/bench/jobs/${enc(id)}/cancel`, { method: "POST" }),
  /** Pass the preview digest as `expect` when applying. */
  benchConsolidate: (id: string, body: BenchConsolidateInput) =>
    req<BenchConsolidateResult>(`/bench/jobs/${enc(id)}/consolidate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  benchRescore: (id: string, body: BenchRescoreInput = {}) =>
    req<BenchRescoreResult>(`/bench/jobs/${enc(id)}/rescore`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  benchDeleteJob: (id: string) => req<RunDeletion>(`/bench/jobs/${enc(id)}`, { method: "DELETE" }),
  benchCompare: (ids: string[]) =>
    req<BenchCompare>(`/bench/compare?jobs=${ids.map(enc).join(",")}`),
  folders: () => req<{ folders: FolderStat[] }>("/folders").then((r) => r.folders),
  move: (ids: string[], folder: string) =>
    req<FolderMoveResult>("/folders/move", {
      method: "POST",
      body: JSON.stringify({ ids, folder }),
    }),
};

export const fileUrl = (id: string, path: string, download = false) =>
  `${API}/runs/${enc(id)}/files/${path.split("/").map(enc).join("/")}${download ? "?download=1" : ""}`;
export const logUrl = (id: string, download = false) =>
  `${API}/runs/${enc(id)}/log.txt${download ? "?download=1" : ""}`;
