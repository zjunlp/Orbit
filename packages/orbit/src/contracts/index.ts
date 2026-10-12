import { z } from "zod";

export { autoRunName, runDisplayName } from "./naming.ts";

export const API_PREFIX = "/api/v1";

/** A process holding GPU memory; null fields could not be read (shown as unknown). */
export const GpuProcess = z.object({
  pid: z.number().int(),
  memMiB: z.number(),
  user: z.string().nullable(),
  /** Process name and its script or module, without arguments (they may hold secrets). */
  command: z.string().nullable(),
  startedAt: z.string().nullable(),
  /** Docker container name when the process runs in one. */
  container: z.string().nullable(),
  /** The Orbit run of that container. */
  runId: z.string().nullable(),
});
export type GpuProcess = z.infer<typeof GpuProcess>;

export const Gpu = z.object({
  index: z.number().int(),
  uuid: z.string(),
  name: z.string(),
  memTotalMiB: z.number(),
  memUsedMiB: z.number(),
  utilPct: z.number().nullable(),
  /** Memory used on the GPU by any process; the allocator treats leased GPUs separately. */
  externalMemMiB: z.number(),
  available: z.boolean(),
  /** Compute processes on this GPU, largest first (empty when the driver does not list them). */
  processes: z.array(GpuProcess).default([]),
});
export type Gpu = z.infer<typeof Gpu>;

export const NodeResources = z.object({
  node: z.string(),
  probedAt: z.string(),
  gpus: z.array(Gpu),
  gpuError: z.string().nullable(),
  cpu: z.object({
    count: z.number().int(),
    load1: z.number(),
    /** CPUs in use by all processes (Orbit's and others'), measured from /proc/stat and smoothed. */
    busy: z.number(),
  }),
  memory: z.object({
    totalGB: z.number(),
    availableGB: z.number(),
  }),
  disk: z.object({
    path: z.string(),
    totalGB: z.number(),
    freeGB: z.number(),
  }),
});
export type NodeResources = z.infer<typeof NodeResources>;

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  /** Works, but worth changing (e.g. data on the system disk). */
  warn: z.boolean().default(false),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  ok: z.boolean(),
  checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
});
export type Health = z.infer<typeof Health>;

export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

// ---- R1: runs, leases, records ----

export const ResourceRequest = z.object({
  gpus: z.number().int().min(0).default(0),
  /** Minimum total memory per GPU. */
  gpuMemGB: z.number().positive().optional(),
  /** Pin specific GPUs by UUID or index. */
  gpuIds: z.array(z.string()).optional(),
  cpus: z.number().positive().default(4),
  memGB: z.number().positive().default(16),
  /** Pin the run to this node; default: any node that can run it. */
  node: z.string().optional(),
});
export type ResourceRequest = z.infer<typeof ResourceRequest>;

const hasDotDot = (p: string) => p.split("/").includes("..");
/** Container paths Orbit mounts itself: the run directory, and the code at /workspace. */
const RESERVED_TARGET = /^\/(orbit)?(\/|$)/;
const WORKSPACE_TARGET = /^\/workspace(\/|$)/;

/** A bind mount: a host path (`source`, this node only) or a named dataset (any node that has it). */
export const Mount = z
  .object({
    source: z.string().optional(),
    dataset: z.string().optional(),
    target: z.string(),
    mode: z.enum(["ro", "rw"]).default("ro"),
  })
  .refine((m) => Boolean(m.source) !== Boolean(m.dataset), {
    message: "a mount needs exactly one of source or dataset",
  });
export type Mount = z.infer<typeof Mount>;

export const AgentRef = z.object({
  harness: z.enum(["claude-code", "codex", "other"]),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
});
export type AgentRef = z.infer<typeof AgentRef>;

// ---- R2: auth profiles and notifications ----

export const Harness = z.enum(["codex", "claude-code"]);
export type Harness = z.infer<typeof Harness>;
export const AuthKind = z.enum(["login", "api-key", "relay"]);
export type AuthKind = z.infer<typeof AuthKind>;
export const ProfileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, '.', '_' or '-'");

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid environment variable name");

/** Public view of a credential profile for an Agent CLI inside containers. Never contains the secret. */
export const AuthProfile = z.object({
  name: ProfileName,
  harness: Harness,
  kind: AuthKind,
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  /** Extra non-secret variables for the container (proxy, model aliases). */
  env: z.record(EnvName, z.string()).default({}),
  /** Runs using this profile share the host network (e.g. a proxy on 127.0.0.1). */
  hostNetwork: z.boolean().default(false),
  /** Masked hint of the stored secret, e.g. `sk-…a1b2`. */
  secretHint: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AuthProfile = z.infer<typeof AuthProfile>;

/**
 * Create or replace a profile. `secret` is the API key / token; for codex `login` it is the content
 * of a Codex `auth.json`.
 */
export const AuthProfileInput = AuthProfile.pick({
  name: true,
  harness: true,
  kind: true,
  baseUrl: true,
  model: true,
  env: true,
  hostNetwork: true,
})
  .extend({ secret: z.string().min(1) })
  .refine((p) => p.kind !== "relay" || Boolean(p.baseUrl), {
    message: "relay profiles need baseUrl",
  });
export type AuthProfileInput = z.input<typeof AuthProfileInput>;

export const AuthTestResult = z.object({
  ok: z.boolean(),
  runId: z.string(),
  detail: z.string(),
});
export type AuthTestResult = z.infer<typeof AuthTestResult>;

export const NotifyEvent = z.enum(["succeeded", "failed", "group"]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;
const NotifyOn = z.array(NotifyEvent).min(1).default(["succeeded", "failed", "group"]);
export const WebhookKind = z.enum(["feishu", "dingtalk", "wecom", "slack", "webhook"]);
export const FEISHU_APP = "feishu-app";
export const WebhookTargetInput = z.object({
  name: ProfileName,
  kind: WebhookKind,
  url: z.string().url(),
  on: NotifyOn,
});
/**
 * A Feishu self-built app: the daemon holds an outbound long connection to Feishu, answers
 * read-only commands from paired users and sends them cards.
 */
export const FeishuAppTargetInput = z.object({
  name: ProfileName,
  kind: z.literal(FEISHU_APP),
  appId: z.string().regex(/^cli_[0-9a-fA-F]{16}$/, "appId looks like cli_ and 16 hex digits"),
  appSecret: z.string().min(1),
  /** open_id of paired users (`orbit notify pair`); kept when the target is replaced. */
  users: z.array(z.string().min(1)).optional(),
  on: NotifyOn,
});
export const NotifyTargetInput = z.discriminatedUnion("kind", [
  WebhookTargetInput,
  FeishuAppTargetInput,
]);
export type NotifyTargetInput = z.input<typeof NotifyTargetInput>;
/** Public view: webhook URLs usually embed a token, so only their origin is shown. */
export const NotifyTarget = z.object({
  name: ProfileName,
  kind: z.union([WebhookKind, z.literal(FEISHU_APP)]),
  on: z.array(NotifyEvent),
  /** Webhook URL origin, or the app id of a Feishu app. */
  urlHint: z.string(),
  /** Feishu app: paired users and the state of its long connection. */
  users: z.number().int().optional(),
  connection: z.enum(["connecting", "connected", "failed", "stopped"]).optional(),
});
export type NotifyTarget = z.infer<typeof NotifyTarget>;
export const NotifyPairInput = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * A folder for organizing runs and bench jobs: `/`-separated names (letters, digits, `_ . -`), e.g.
 * `rcb/noskills`; `""` is no folder. Logical only: run directories never move.
 */
export const Folder = z
  .string()
  .max(200)
  .refine(
    (f) =>
      f === "" ||
      f.split("/").every((p) => /^[\p{L}\p{N}_.-]+$/u.test(p) && p !== "." && p !== ".."),
    "folder must be names of letters, digits, _ . - separated by /, e.g. rcb/noskills",
  );
export type Folder = z.infer<typeof Folder>;

/** Whether `f` is `folder` or inside it (`""` contains everything). */
export const inFolder = (f: string, folder: string) =>
  folder === "" || f === folder || f.startsWith(`${folder}/`);

/** A service or network name: a DNS label, also the host name other containers reach it by. */
const ServiceName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/, "names must be lowercase DNS labels");

/** Container health check, as in Docker's HEALTHCHECK (`CMD` form). */
export const Healthcheck = z.object({
  command: z.array(z.string()).min(1),
  intervalSec: z.number().positive().default(30),
  timeoutSec: z.number().positive().default(30),
  startPeriodSec: z.number().min(0).default(0),
  retries: z.number().int().min(1).default(3),
});
export type Healthcheck = z.infer<typeof Healthcheck>;

/**
 * A service container next to the run's own (e.g. a simulator the Agent queries over HTTP). It runs
 * for the whole run on the run's networks, reachable by its name; it holds no GPUs.
 */
export const ServiceSpec = z
  .object({
    name: ServiceName,
    image: z.string().optional(),
    /** Absolute Dockerfile path; built with `context` (default: its directory). */
    dockerfile: z.string().optional(),
    context: z.string().optional(),
    /** Default: the image's command. */
    command: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).default({}),
    workdir: z.string().optional(),
    /** Limits; a service without one is unlimited but leased as 1 CPU / 1 GB. */
    cpus: z.number().positive().optional(),
    memGB: z.number().positive().optional(),
    healthcheck: Healthcheck.optional(),
    /** Services that must be healthy (with a health check) or running (without) first. */
    dependsOn: z.array(ServiceName).default([]),
    networks: z.array(ServiceName).default(["default"]),
    init: z.boolean().default(false),
    readOnly: z.boolean().default(false),
    /** Size of /dev/shm in GB (Docker's default otherwise). */
    shmGB: z.number().positive().optional(),
    tmpfs: z.array(z.string()).default([]),
    capAdd: z.array(z.string()).default([]),
    capDrop: z.array(z.string()).default([]),
    securityOpt: z.array(z.string()).default([]),
    pidsLimit: z.number().int().positive().optional(),
    /** Absolute paths copied to `output/services/<name>/<path>` once the run has stopped. */
    collect: z.array(z.string()).default([]),
  })
  .refine((s) => Boolean(s.image) !== Boolean(s.dockerfile), {
    message: "a service needs exactly one of image or dockerfile",
  })
  .refine((s) => s.collect.every((p) => p.startsWith("/") && !hasDotDot(p)), {
    message: "service collect paths must be absolute container paths without `..`",
  });
export type ServiceSpec = z.infer<typeof ServiceSpec>;

export const Hook = z.object({
  /** Default: the run's own container. */
  service: ServiceName.optional(),
  command: z.string().min(1),
  timeoutSec: z.number().positive().default(60),
});
export type Hook = z.infer<typeof Hook>;

/** A per-run network; `internal` ones have no route out. `default` exists unless declared. */
export const NetworkSpec = z.object({ name: ServiceName, internal: z.boolean().default(false) });
export type NetworkSpec = z.infer<typeof NetworkSpec>;

/**
 * A second command in the same container once `command` has exited (or was stopped at its
 * timeout), with the state it left: e.g. a verifier that checks files and processes in place.
 */
export const AfterPhase = z
  .object({
    command: z.array(z.string()).min(1),
    timeoutMin: z.number().positive(),
    env: z.record(z.string(), z.string()).default({}),
    /** Daemon variables for this phase only (e.g. grader keys); set by Orbit for bench runs. */
    passEnv: z.array(EnvName).default([]),
    /** Host paths copied to absolute container paths just before the phase. */
    copy: z.array(z.object({ source: z.string(), target: z.string() })).default([]),
    /** Network during the phase; default: unchanged. */
    network: z.boolean().optional(),
    /** Absolute paths copied to `output/after/<path>` once the phase has ended. */
    collect: z.array(z.string()).default([]),
  })
  .refine(
    (a) =>
      [...a.collect, ...a.copy.map((c) => c.target)].every(
        (p) => p.startsWith("/") && !hasDotDot(p),
      ) && a.copy.every((c) => c.source.startsWith("/")),
    { message: "after-phase paths must be absolute, without `..`" },
  );
export type AfterPhase = z.infer<typeof AfterPhase>;

/** How a run's after phase went (`skipped`: the run was cancelled or its container died first). */
export const AfterStatus = z.object({
  state: z.enum(["running", "succeeded", "failed", "timeout", "skipped", "error"]),
  exitCode: z.number().int().nullable(),
  reason: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type AfterStatus = z.infer<typeof AfterStatus>;

/** Lease for a service: its limits, or 1 CPU / 1 GB when it has none. */
export const serviceLease = (s: Pick<ServiceSpec, "cpus" | "memGB">) => ({
  cpus: s.cpus ?? 1,
  memGB: s.memGB ?? 1,
});

export const RunSpec = z
  .object({
    name: z.string().max(200).optional(),
    group: z.string().max(200).optional(),
    /** Absolute path of a git repository to snapshot into /workspace. */
    project: z.string().optional(),
    image: z.string().optional(),
    /** Dockerfile path; relative paths resolve against `project`. Build context is its directory. */
    dockerfile: z.string().optional(),
    command: z.array(z.string()).min(1),
    resources: ResourceRequest.prefault({}),
    mounts: z.array(Mount).default([]),
    env: z.record(z.string(), z.string()).default({}),
    network: z.boolean().default(true),
    /** Share the host network namespace (ignored when `network` is false). */
    hostNetwork: z.boolean().default(false),
    /** Auth profile: installs the matching Agent CLI and its credentials in the container. */
    auth: ProfileName.optional(),
    snapshot: z.boolean().default(true),
    /** Run as root instead of the host user (files in outputs are then root-owned). */
    root: z.boolean().default(false),
    timeoutMin: z.number().positive().optional(),
    tags: z.record(z.string(), z.string()).default({}),
    /** Values that define this run within its group (e.g. sweep params); used by compare views. */
    params: z.record(z.string(), z.string()).default({}),
    parentId: z.string().optional(),
    agent: AgentRef.optional(),
    /**
     * `docker` runs `command` in one container; `process` runs it on the host (a native benchmark
     * runner) with a private HOME, the leased GPUs in CUDA_VISIBLE_DEVICES and a `docker` shim that
     * labels, cleans up and injects auth into the containers it starts.
     */
    backend: z.enum(["docker", "process"]).default("docker"),
    /** Working directory of a process run (default: the code snapshot, else the project, else the run directory). */
    cwd: z.string().optional(),
    /** Container working directory: an absolute path, or `image` for the image's WORKDIR. */
    workdir: z.string().optional(),
    /** Higher runs are scheduled first; equal priorities keep submission order. */
    priority: z.number().int().default(0),
    /** Absolute container paths copied to `output/collected/<path>` after exit, before removal. */
    collect: z.array(z.string()).default([]),
    /**
     * Variables copied from the daemon environment at launch (never stored). Values of names that
     * look secret (KEY, TOKEN, SECRET, PASSWORD) are redacted from logs.
     */
    passEnv: z.array(EnvName).default([]),
    /** Method bundle directory copied into the Agent home (AGENTS.md / CLAUDE.md, skills). */
    agentBundle: z.string().optional(),
    /** Service containers started (healthy) before the run's container and removed with it. */
    services: z.array(ServiceSpec).default([]),
    /**
     * Networks of a run with services. `default` (added when missing) is internal when `network` is
     * false; the run's container joins `runNetworks` as `main`.
     */
    networks: z.array(NetworkSpec).default([]),
    runNetworks: z.array(ServiceName).default(["default"]),
    /** Services the run's container waits for (healthy, or running without a health check). */
    dependsOn: z.array(ServiceName).default([]),
    /** A phase run in the same container after `command` (docker runs). */
    after: AfterPhase.optional(),
    /** Absolute directories created in the container before `command` (e.g. Harbor's /logs/*). */
    mkdirs: z.array(z.string()).default([]),
    /**
     * Shell commands run once `command` has exited, in the run's container (kept for them) or in a
     * service, before anything is collected (e.g. Harbor's `[[verifier.collect]]` snapshots).
     */
    hooks: z.array(Hook).default([]),
  })
  .refine(
    (s) =>
      s.backend === "process"
        ? !s.image && !s.dockerfile
        : Boolean(s.image) !== Boolean(s.dockerfile),
    { message: "exactly one of image or dockerfile is required (none for process runs)" },
  )
  .refine((s) => !s.workdir || s.workdir === "image" || s.workdir.startsWith("/"), {
    message: "workdir must be an absolute path or `image`",
  })
  .refine((s) => s.collect.every((p) => p.startsWith("/") && !hasDotDot(p)), {
    message: "collect paths must be absolute container paths without `..`",
  })
  .refine((s) => s.mkdirs.every((p) => p.startsWith("/") && !hasDotDot(p)), {
    message: "mkdirs must be absolute container paths without `..`",
  })
  .refine(
    (s) => {
      const targets = s.mounts.map((m) => m.target.replace(/\/+$/, "") || "/");
      return (
        targets.every(
          (t) =>
            t.startsWith("/") &&
            !hasDotDot(t) &&
            !RESERVED_TARGET.test(t) &&
            // /workspace is taken only when the run has code (a project) there.
            !(s.project && WORKSPACE_TARGET.test(t)),
        ) && new Set(targets).size === targets.length
      );
    },
    {
      message:
        "mount targets must be distinct absolute paths without `..`, outside /orbit (and /workspace with a project)",
    },
  )
  .superRefine((s, ctx) => {
    const problem = servicesProblem(s);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
    if ((s.after || s.hooks.length) && s.backend !== "docker")
      ctx.addIssue({ code: "custom", message: "after phases and hooks need the docker backend" });
    for (const h of s.hooks)
      if (h.service && !s.services.some((x) => x.name === h.service))
        ctx.addIssue({ code: "custom", message: `hook for unknown service ${h.service}` });
  });
export type RunSpec = z.infer<typeof RunSpec>;
export type RunSpecInput = z.input<typeof RunSpec>;

/** Why a run's services, networks and dependencies do not fit together, or null. */
function servicesProblem(s: {
  services: ServiceSpec[];
  networks: NetworkSpec[];
  runNetworks: string[];
  dependsOn: string[];
  backend: string;
  hostNetwork: boolean;
}): string | null {
  if (s.services.length === 0) {
    const plain =
      s.networks.length === 0 &&
      s.dependsOn.length === 0 &&
      s.runNetworks.length === 1 &&
      s.runNetworks[0] === "default";
    return plain ? null : "networks and dependsOn need services";
  }
  if (s.backend !== "docker") return "services need the docker backend";
  if (s.hostNetwork) return "services do not work with host networking";
  const names = s.services.map((x) => x.name);
  if (names.includes("main")) return "service name `main` is the run's own container";
  if (new Set(names).size !== names.length) return "service names must be distinct";
  const nets = new Set(["default", ...s.networks.map((n) => n.name)]);
  for (const n of [...s.runNetworks, ...s.services.flatMap((x) => x.networks)])
    if (!nets.has(n)) return `unknown network ${n}`;
  for (const d of [...s.dependsOn, ...s.services.flatMap((x) => x.dependsOn)])
    if (!names.includes(d)) return `unknown service ${d} in dependsOn`;
  return serviceOrder(s.services) ? null : "service dependencies form a cycle";
}

/** Services in start order (dependencies first), or null when they form a cycle. */
export function serviceOrder<T extends { name: string; dependsOn: string[] }>(
  services: T[],
): T[] | null {
  const out: T[] = [];
  const done = new Set<string>();
  let left = [...services];
  while (left.length) {
    const ready = left.filter((x) => x.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return null;
    for (const x of ready) done.add(x.name);
    out.push(...ready);
    left = left.filter((x) => !done.has(x.name));
  }
  return out;
}

/** What a run leases: its own resources plus its services' (GPUs stay with the run's container). */
export function leaseRequest(s: Pick<RunSpec, "resources" | "services">): ResourceRequest {
  const extra = s.services.map(serviceLease);
  return {
    ...s.resources,
    cpus: s.resources.cpus + extra.reduce((a, x) => a + x.cpus, 0),
    memGB: s.resources.memGB + extra.reduce((a, x) => a + x.memGB, 0),
  };
}

export const RunState = z.enum([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
export type RunState = z.infer<typeof RunState>;
export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled", "lost"];
export const isTerminal = (s: RunState) => TERMINAL_STATES.includes(s);

export const CodeSnapshot = z.object({
  repo: z.string(),
  /** Project path relative to the repo root; the container starts in /workspace/<subdir>. */
  subdir: z.string(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  /** Files changed relative to HEAD (tracked modifications + untracked). */
  changedFiles: z.array(z.string()),
  fileCount: z.number().int(),
  bytes: z.number().int(),
});
export type CodeSnapshot = z.infer<typeof CodeSnapshot>;

export const Lease = z.object({
  id: z.string(),
  runId: z.string(),
  node: z.string(),
  gpuIds: z.array(z.string()),
  cpus: z.number(),
  memGB: z.number(),
  state: z.enum(["active", "released"]),
  createdAt: z.string(),
  releasedAt: z.string().nullable(),
});
export type Lease = z.infer<typeof Lease>;

/** Measured resource use of a run, sampled while it runs (null before the first sample). */
export const RunUsage = z.object({
  samples: z.number().int(),
  /** Peak memory: container cgroup peak; process runs: RSS of the group plus child containers. */
  peakMemGB: z.number(),
  peakCpus: z.number(),
  meanCpus: z.number(),
  /** Peak GPU memory summed over the leased GPUs (null without GPUs or nvidia-smi). */
  peakGpuMemGB: z.number().nullable(),
  /** Processes the kernel killed for memory inside the run (the run may have continued). */
  oomKills: z.number().int().default(0),
  /** The run itself ended because it ran out of memory. */
  oomKilled: z.boolean().default(false),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: z.string(),
  spec: RunSpec,
  state: RunState,
  /** Why the run is queued or how it ended, in one line. */
  reason: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  node: z.string(),
  /** Image name or tag the run used (`spec.image`, or the tag built from its Dockerfile). */
  image: z.string().nullable(),
  /** Content id (`sha256:…`) of that image when the run started, for reproducing it. */
  imageId: z.string().nullable().default(null),
  containerId: z.string().nullable(),
  lease: Lease.nullable(),
  code: CodeSnapshot.nullable(),
  /** Process runs: host pid and its start time (clock ticks) to tell it from a reused pid. */
  proc: z.object({ pid: z.number().int(), start: z.string() }).nullable().default(null),
  cleanup: z.enum(["pending", "done", "failed"]),
  /** True on the primary for a run placed on another node: this record mirrors that node's run. */
  remote: z.boolean().default(false),
  /** On a worker: the primary node that submitted the run. */
  origin: z.string().nullable().default(null),
  note: z.string(),
  /** Folder for organizing (movable; a bench run follows its job). */
  folder: Folder.default(""),
  usage: RunUsage.nullable().default(null),
  /** The run's service containers; `failure` says how one broke while the run was going. */
  services: z
    .array(
      z.object({
        name: z.string(),
        containerId: z.string().nullable(),
        failure: z.string().nullable(),
      }),
    )
    .default([]),
  /** The after phase (`spec.after`), once it was reached. */
  after: AfterStatus.nullable().default(null),
  /** Size of the run directory on disk, measured once the run is cleaned up. */
  sizeBytes: z.number().nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const RunEvent = z.object({
  seq: z.number().int(),
  runId: z.string(),
  at: z.string(),
  kind: z.string(),
  message: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const RunList = z.object({ runs: z.array(Run) });

/** One folder in use: what is directly in it (the Web sums subfolders). */
export const FolderStat = z.object({
  path: z.string(),
  runs: z.number().int(),
  jobs: z.number().int(),
  /** Runs queued, starting or running. */
  active: z.number().int(),
  /** Measured run directories; runs not measured yet count as 0. */
  sizeBytes: z.number(),
  updatedAt: z.string(),
});
export type FolderStat = z.infer<typeof FolderStat>;
export const FolderList = z.object({ folders: z.array(FolderStat) });
export type FolderList = z.infer<typeof FolderList>;

/** Move runs and bench jobs (with their runs), given by id, into `folder` (`""` takes them out). */
export const FolderMove = z.object({ folder: Folder, ids: z.array(z.string()).min(1) });
export type FolderMoveInput = z.input<typeof FolderMove>;
export const FolderMoveResult = z.object({ runs: z.array(z.string()), jobs: z.array(z.string()) });
export type FolderMoveResult = z.infer<typeof FolderMoveResult>;

/** Copy a folder's runs (with their files) and jobs into a new directory. */
export const FolderExport = z.object({
  folder: Folder,
  dest: z.string().refine((p) => p.startsWith("/"), "dest must be an absolute path"),
});
export const FolderExportResult = z.object({
  dest: z.string(),
  runs: z.number().int(),
  jobs: z.number().int(),
  bytes: z.number(),
  /** Runs left out (outputs on another node) and files that could not be copied. */
  skipped: z.array(z.string()),
});
export type FolderExportResult = z.infer<typeof FolderExportResult>;
/** Result of deleting runs (or a bench job's runs). */
export const RunDeletion = z.object({
  deleted: z.array(z.string()),
  /** Run directories that could not be removed completely (e.g. root-owned files). */
  leftovers: z.array(z.string()),
});
export type RunDeletion = z.infer<typeof RunDeletion>;
export const RunEvents = z.object({ events: z.array(RunEvent) });

/** A chunk of the combined stdout/stderr log. Offsets are byte offsets in the log file. */
export const LogChunk = z.object({
  offset: z.number().int(),
  next: z.number().int(),
  size: z.number().int(),
  text: z.string(),
  /** True when the run is terminal and `next` reached the end of the log. */
  eof: z.boolean(),
});
export type LogChunk = z.infer<typeof LogChunk>;

export const MetricSeries = z.object({
  key: z.string(),
  /** [step, value] pairs; step falls back to the line number when missing. */
  points: z.array(z.tuple([z.number(), z.number()])),
});
export const Metrics = z.object({
  series: z.array(MetricSeries),
  /** Last value of every numeric key, for tables. */
  summary: z.record(z.string(), z.number()),
  invalidLines: z.number().int(),
});
export type Metrics = z.infer<typeof Metrics>;

export const Artifact = z.object({ path: z.string(), bytes: z.number().int(), mtime: z.string() });
export const Artifacts = z.object({ files: z.array(Artifact), truncated: z.boolean() });
export type Artifacts = z.infer<typeof Artifacts>;

export const CodeDiff = z.object({ patch: z.string(), truncated: z.boolean() });

export const SessionMessage = z.object({
  at: z.string().nullable(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  kind: z.enum(["text", "thinking", "tool_call", "tool_result"]),
  /** Tool name for tool_call/tool_result. */
  name: z.string().optional(),
  text: z.string(),
  truncated: z.boolean().optional(),
});
export type SessionMessage = z.infer<typeof SessionMessage>;
export const SessionTranscript = z.object({
  harness: z.string(),
  sessionId: z.string(),
  file: z.string().nullable(),
  messages: z.array(SessionMessage),
});
export type SessionTranscript = z.infer<typeof SessionTranscript>;
/**
 * The sessions of a run: `submitter` is the host Agent session that submitted it (`spec.agent`),
 * `agent` the session of an Agent that ran inside it (kept in the run directory).
 */
export const RunSessions = z.object({
  submitter: SessionTranscript.nullable(),
  /** Why the submitter's transcript is missing although the run is linked to one. */
  submitterError: z.string().nullable(),
  agent: SessionTranscript.nullable(),
});
export type RunSessions = z.infer<typeof RunSessions>;

// ---- R4: multi-node ----

/** A named dataset or weights directory: the name is shared, the path is local to each node. */
export const DatasetInput = z.object({
  name: ProfileName,
  path: z.string().refine((p) => p.startsWith("/"), "path must be absolute"),
});
export type DatasetInput = z.input<typeof DatasetInput>;
export const Dataset = DatasetInput.extend({ createdAt: z.string() });
export type Dataset = z.infer<typeof Dataset>;
export const DatasetList = z.object({ datasets: z.array(Dataset) });

/** What placement needs to know about an auth profile on a node (never the secret). */
export const NodeProfile = z.object({
  name: z.string(),
  harness: Harness,
  /** The harness CLI is installed on that node. */
  cli: z.boolean(),
});
export type NodeProfile = z.infer<typeof NodeProfile>;

export const CLUSTER_PREFIX = "/cluster/v1";
/** Bumped when the node-to-node protocol changes incompatibly. */
export const CLUSTER_PROTOCOL = 1;

/** A worker's answer to the primary's heartbeat. */
export const NodeInfo = z.object({
  name: z.string(),
  version: z.string(),
  protocol: z.number().int(),
  resources: NodeResources,
  leases: z.array(Lease),
  queued: z.number().int(),
  datasets: z.array(z.string()),
  profiles: z.array(NodeProfile),
});
export type NodeInfo = z.infer<typeof NodeInfo>;

/** A worker node as the primary sees it. */
export const NodeStatus = z.object({
  name: z.string(),
  url: z.string(),
  online: z.boolean(),
  lastSeen: z.string().nullable(),
  error: z.string().nullable(),
  info: NodeInfo.nullable(),
});
export type NodeStatus = z.infer<typeof NodeStatus>;
export const NodeList = z.object({ nodes: z.array(NodeStatus) });

export const NodeAddInput = z.object({
  url: z.string().url(),
  token: z.string().min(16),
});
export type NodeAddInput = z.infer<typeof NodeAddInput>;

/** This node's cluster listener (what other nodes connect to). */
export const ExposeStatus = z.object({
  node: z.string(),
  /** `host:port` the listener is configured for, or null when not exposed. */
  listen: z.string().nullable(),
  listening: z.boolean(),
  error: z.string().nullable(),
});
export type ExposeStatus = z.infer<typeof ExposeStatus>;

/** Primary -> worker: run `spec` under the same id. Code arrives as content-addressed bundles. */
export const RemoteSubmit = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/),
  origin: z.string(),
  spec: RunSpec,
  code: CodeSnapshot.nullable(),
  /** Bundle hash of the code snapshot (mounted at /workspace). */
  workspace: z.string().nullable(),
  /** Dockerfile inside a bundle; its directory is the build context. */
  dockerfile: z.object({ bundle: z.string(), path: z.string() }).nullable(),
  /** Bundle hash of the method bundle. */
  agentBundle: z.string().nullable(),
});
export type RemoteSubmit = z.infer<typeof RemoteSubmit>;

export const Ledger = z.object({
  resources: NodeResources,
  leases: z.array(Lease),
  queued: z.array(z.object({ runId: z.string(), reason: z.string().nullable() })),
  /** Registered worker nodes with their resources and leases (empty on a single node). */
  nodes: z.array(NodeStatus).default([]),
});
export type Ledger = z.infer<typeof Ledger>;

// ---- R3: benchmarks ----

/** Adapters shipped with Orbit (`orbit __adapter <name>`). */
export const BUILTIN_ADAPTERS = ["harbor", "asi"] as const;

/** A registered benchmark checkout. */
export const BenchmarkInput = z.object({
  name: ProfileName,
  /**
   * A built-in adapter (`harbor`: task.toml task directories; `asi`: ASI-Bench with its native
   * runner) or the absolute path of an executable speaking the adapter protocol (design §7).
   */
  adapter: z
    .string()
    .refine(
      (a) => (BUILTIN_ADAPTERS as readonly string[]).includes(a) || a.startsWith("/"),
      `adapter must be ${BUILTIN_ADAPTERS.join(" or ")}, or the absolute path of an executable`,
    ),
  /** Absolute path of the benchmark checkout (the adapter's working directory). */
  path: z.string().refine((p) => p.startsWith("/"), "path must be absolute"),
  /** Adapter settings, e.g. asi `python` and `instances`. Non-secret. */
  config: z.record(z.string(), z.string()).default({}),
  /** Extra non-secret variables for every run of this benchmark. */
  env: z.record(EnvName, z.string()).default({}),
  /** Variables copied from the daemon environment into verify runs (judge API keys); never stored. */
  passEnv: z.array(EnvName).default([]),
  /** Absolute path of a resources file (`BenchResources`) overriding the solve resources per task. */
  resources: z
    .string()
    .refine((p) => p.startsWith("/"), "resources must be an absolute path")
    .optional(),
});
export type BenchmarkInput = z.input<typeof BenchmarkInput>;
export const Benchmark = BenchmarkInput.extend({ createdAt: z.string(), updatedAt: z.string() });
export type Benchmark = z.infer<typeof Benchmark>;

export const BenchTask = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** Unsupported tasks are listed but never run (e.g. docker-compose environments). */
  supported: z.boolean(),
  reason: z.string().nullable(),
  tags: z.record(z.string(), z.string()).default({}),
});
export type BenchTask = z.infer<typeof BenchTask>;

/**
 * A metric an adapter declares (`tasks` reply) and reports per trial (`score` reply `metrics`).
 * Valid trials average per task, then over tasks (see `contracts/metrics.ts`). `score`, the score
 * as a percent of its maximum, always exists; declaring it changes only how it is labelled.
 */
export const MetricSpec = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "metric names are camelCase or snake_case identifiers"),
  label: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  unit: z.string().max(8).optional(),
  range: z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => hi > lo, "range must be [low, high]")
    .optional(),
  higherIsBetter: z.boolean().default(true),
  primary: z.boolean().default(false),
  reference: z.number().optional(),
});
export type MetricSpec = z.infer<typeof MetricSpec>;
export type MetricSpecInput = z.input<typeof MetricSpec>;

const MetricSpecs = z
  .array(MetricSpec)
  .max(20)
  .refine((ms) => new Set(ms.map((m) => m.name)).size === ms.length, "metric names must be unique")
  .refine((ms) => ms.filter((m) => m.primary).length <= 1, "at most one primary metric");

/** Per-trial metric values; non-finite values are dropped. */
const MetricValues = z
  .record(z.string(), z.number().nullable())
  .transform((r) =>
    Object.fromEntries(
      Object.entries(r).filter((e): e is [string, number] => Number.isFinite(e[1])),
    ),
  );

/**
 * An AgentProfile: harness (with the host CLI version recorded per run) + model + auth + method
 * bundle. `oracle` runs the reference solution and `empty` submits nothing; both check an adapter.
 */
export const Method = z
  .object({
    name: ProfileName,
    agent: z.enum(["codex", "claude-code", "oracle", "empty"]),
    auth: ProfileName.optional(),
    model: z.string().optional(),
    /** Reasoning effort, e.g. `high`. */
    effort: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "effort must be a plain word, e.g. high")
      .optional(),
    /** Method bundle directory (AGENTS.md / CLAUDE.md, skills) copied into the Agent home. */
    bundle: z.string().optional(),
  })
  .refine((m) => m.agent === "oracle" || m.agent === "empty" || Boolean(m.auth), {
    message: "agent methods need an auth profile",
  });
export type Method = z.infer<typeof Method>;

export const BenchJobSpec = z.object({
  name: z.string().max(200).optional(),
  benchmark: ProfileName,
  /** Task ids; default: every supported task. */
  tasks: z.array(z.string()).default([]),
  methods: z.array(Method).min(1),
  /** Repetitions per task × method. */
  seeds: z.number().int().min(1).max(100).default(1),
  /** Adapter options, e.g. asi `promptLevel` (default b1). */
  options: z.record(z.string(), z.string()).default({}),
  /** Override the per-task solve timeout. */
  timeoutMin: z.number().positive().optional(),
});
export type BenchJobSpec = z.infer<typeof BenchJobSpec>;
export type BenchJobSpecInput = z.input<typeof BenchJobSpec>;

export const Evaluation = z.enum(["valid", "invalid", "unknown"]);
export type Evaluation = z.infer<typeof Evaluation>;

/**
 * Kinds of review content the Web UI renders, each with its own built-in style. The set is closed:
 * an adapter picks a kind, it never sends markup or styles. Unknown kinds are kept and shown with
 * their `fallback` kind, else by file extension, else as text.
 */
export const REVIEW_KINDS = ["markdown", "image", "text", "json", "table"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
const LIMIT_TEXT = 20_000;
const clipText = (max: number) =>
  z.string().transform((s) => (s.length > max ? `${s.slice(0, max)}…` : s));

/** A file of the solve or verify run to show on the trial page. */
export const ReviewFile = z.looseObject({
  label: clipText(60),
  phase: z.enum(["solve", "verify"]),
  /** Relative to the run's output directory, without `..`. */
  path: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").includes(".."),
      "path must stay in the output",
    ),
  /** One of REVIEW_KINDS, or a newer kind an older Orbit does not know (then `fallback` is used). */
  kind: z.string().max(40).optional(),
  fallback: z.enum(REVIEW_KINDS).optional(),
});
export type ReviewFile = z.infer<typeof ReviewFile>;

/** One graded criterion. */
export const ReviewItem = z.looseObject({
  criterion: clipText(4000),
  score: z.number().nullable().optional(),
  maxScore: z.number().optional(),
  weight: z.number().optional(),
  /** Free label, e.g. `text` / `image` / `test`. */
  type: clipText(40).optional(),
  reasoning: clipText(LIMIT_TEXT).optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/**
 * What the trial page shows besides the score: files to render, graded items, and short key/value
 * details. Fields Orbit does not know are kept and listed under Details.
 */
export const Review = z.looseObject({
  files: z.array(ReviewFile).max(20).default([]),
  items: z.array(ReviewItem).max(500).default([]),
  /** Short facts shown as a key/value table (scorer model, attempts, ...). */
  details: z
    .record(z.string().max(80), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .refine((d) => Object.keys(d).length <= 50, "at most 50 details")
    .default({}),
});
export type Review = z.infer<typeof Review>;

/** Execution, evaluation and cleanup are separate: only `valid` scores enter means. */
export const Outcome = z.object({
  /** How the solve run ended (RunState, or `skipped`). */
  execution: z.string(),
  evaluation: Evaluation,
  score: z.number().nullable(),
  maxScore: z.number(),
  issues: z.array(z.string()),
  cleanup: z.enum(["pending", "done", "failed"]),
  /** What the adapter asked the trial page to show (null for older trials and adapters). */
  review: Review.nullable().default(null),
  /** Adapter metrics of the trial (besides `score`); kept also when the score is not trusted. */
  metrics: z.record(z.string(), z.number()).optional(),
});
export type Outcome = z.infer<typeof Outcome>;

/** A scoring of a trial that a rescore replaced: its verify run and outcome. */
export const Scoring = z.object({
  verifyRunId: z.string().nullable(),
  outcome: Outcome,
  endedAt: z.string().nullable(),
});
export type Scoring = z.infer<typeof Scoring>;

export const TrialState = z.enum(["pending", "solving", "verifying", "done"]);
export const Trial = z.object({
  id: z.string(),
  jobId: z.string(),
  task: z.string(),
  method: z.string(),
  seed: z.number().int(),
  state: TrialState,
  solveRunId: z.string().nullable(),
  verifyRunId: z.string().nullable(),
  /** Notes gathered before the outcome (e.g. artifacts the solve run did not produce). */
  issues: z.array(z.string()).default([]),
  outcome: Outcome.nullable(),
  /**
   * Earlier scorings, oldest first. A rescore moves the current verify run and outcome here and
   * verifies the same solve run again; `verifyRunId` / `outcome` are always the latest.
   */
  history: z.array(Scoring).default([]),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Trial = z.infer<typeof Trial>;

/** Every run a trial has had: its solve run, its verify run and earlier verify runs. */
export function trialRunIds(t: Trial): string[] {
  return [t.solveRunId, t.verifyRunId, ...t.history.map((h) => h.verifyRunId)].filter(
    (r): r is string => Boolean(r),
  );
}

/** Merge completed retries or append new tasks, preserving their evaluation validity. */
export const BenchConsolidate = z.strictObject({
  /** Import previously absent tasks, including invalid outcomes and their artifacts. */
  appendTasks: z.boolean().default(false),
  /** Allow proxy/host-network aliases of the same checkout and credential. */
  allowTransportDifferences: z.boolean().default(false),
  sources: z.array(z.string().min(1)).default([]),
  pruneInvalid: z.boolean().default(false),
  dryRun: z.boolean().default(true),
});
export type BenchConsolidateInput = z.input<typeof BenchConsolidate>;
export const BenchConsolidateResult = z.object({
  dryRun: z.boolean(),
  adopted: z.array(
    z.object({
      task: z.string(),
      sourceJob: z.string(),
      sourceTrial: z.string(),
      trial: z.string(),
    }),
  ),
  removedJobs: z.array(z.string()),
  removedRuns: z.array(z.string()),
  leftovers: z.array(z.string()),
});
export type BenchConsolidateResult = z.infer<typeof BenchConsolidateResult>;

/** Which finished trials of a job to score again (all of them when nothing is given). */
export const BenchRescore = z.object({
  tasks: z.array(z.string()).default([]),
  methods: z.array(z.string()).default([]),
  trials: z.array(z.string()).default([]),
});
export type BenchRescoreInput = z.input<typeof BenchRescore>;
export const BenchRescoreResult = z.object({
  /** Trials now being verified again. */
  trials: z.array(z.string()),
  /** Matching trials left as they are, with why. */
  skipped: z.array(z.object({ trial: z.string(), reason: z.string() })),
});
export type BenchRescoreResult = z.infer<typeof BenchRescoreResult>;

/** Solve resources of one task; `evidence` / `confidence` / `note` are for people and ignored. */
export const TaskResources = z.strictObject({
  cpus: z.number().positive().optional(),
  memGB: z.number().positive().optional(),
  gpus: z.number().int().min(0).optional(),
  gpuMemGB: z.number().positive().optional(),
  timeoutMin: z.number().positive().optional(),
  evidence: z.string().optional(),
  confidence: z.string().optional(),
  note: z.string().optional(),
});
export type TaskResources = z.infer<typeof TaskResources>;

/**
 * A benchmark's resources file: `default` and per-task entries override what the adapter asks for
 * the solve run (a task entry over `default` over the adapter; `orbit bench run --timeout` wins).
 */
export const BenchResources = z.strictObject({
  version: z.literal(1),
  note: z.string().optional(),
  default: TaskResources.default({}),
  tasks: z.record(z.string(), TaskResources).default({}),
});
export type BenchResources = z.infer<typeof BenchResources>;

/** Resolved overrides for one task (the fields Orbit applies). */
export const ResourceOverride = TaskResources.pick({
  cpus: true,
  memGB: true,
  gpus: true,
  gpuMemGB: true,
  timeoutMin: true,
});
export type ResourceOverride = z.infer<typeof ResourceOverride>;

export const BenchJob = z.object({
  id: z.string(),
  spec: BenchJobSpec,
  /** Per-task overrides read from the benchmark's resources file at submit (null without one). */
  resources: z.record(z.string(), ResourceOverride).nullable().default(null),
  /** Folder for organizing; the job's runs follow it. */
  folder: Folder.default(""),
  /** Metrics declared by the adapter at submit, `score` first (only `score` for older jobs). */
  metrics: z.array(MetricSpec).default([]),
  /** The benchmark checkout at submit (null outside git, or for older jobs). */
  source: z
    .object({ commit: z.string(), describe: z.string().nullable(), dirty: z.boolean() })
    .nullable()
    .default(null),
  state: z.enum(["running", "done", "cancelled"]),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type BenchJob = z.infer<typeof BenchJob>;

/** A metric over tasks (see `contracts/metrics.ts`): SE clustered by task, 95% CI. */
export const MetricStat = z.object({
  mean: z.number(),
  se: z.number().nullable(),
  ci: z.tuple([z.number(), z.number()]).nullable(),
  tasks: z.number().int(),
  trials: z.number().int(),
});
export type MetricStat = z.infer<typeof MetricStat>;

export const MethodSummary = z.object({
  method: z.string(),
  trials: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  unknown: z.number().int(),
  pending: z.number().int(),
  /** Per metric name: mean over tasks of the per-task mean of valid trials; null without any. */
  metrics: z.record(z.string(), MetricStat.nullable()),
});
export type MethodSummary = z.infer<typeof MethodSummary>;

export const BenchJobDetail = z.object({
  job: BenchJob,
  trials: z.array(Trial),
  summary: z.array(MethodSummary),
});
export type BenchJobDetail = z.infer<typeof BenchJobDetail>;

export const BenchJobList = z.object({
  jobs: z.array(BenchJob.extend({ summary: z.array(MethodSummary) })),
});
export type BenchJobList = z.infer<typeof BenchJobList>;

export const BenchmarkList = z.object({ benchmarks: z.array(Benchmark) });
export const BenchTaskList = z.object({ tasks: z.array(BenchTask) });

/** Methods from several jobs side by side; columns are `<job>/<method>`. */
export const BenchCompare = z.object({
  columns: z.array(z.object({ key: z.string(), jobId: z.string(), method: z.string() })),
  /** Metrics every compared job has (always `score`); the first job's primary one if shared. */
  metrics: z.array(MetricSpec),
  rows: z.array(
    z.object({
      task: z.string(),
      /** Evaluation counts per column: `valid/total` (empty when the column has no such trial). */
      counts: z.record(z.string(), z.string()),
      /** Per metric, per column: mean over the task's valid trials; null when none has a value. */
      values: z.record(z.string(), z.record(z.string(), z.number().nullable())),
    }),
  ),
  /**
   * Per metric: tasks with a value in every column (`paired`), and per column the mean over all its
   * tasks, over the paired tasks, and the paired difference to the first column.
   */
  stats: z.record(
    z.string(),
    z.object({
      pairedTasks: z.number().int(),
      columns: z.record(
        z.string(),
        z.object({
          all: MetricStat.nullable(),
          paired: MetricStat.nullable(),
          diff: MetricStat.nullable(),
        }),
      ),
    }),
  ),
});
export type BenchCompare = z.infer<typeof BenchCompare>;

// ---- Bench adapter protocol (design §7) ----

export const ADAPTER_PROTOCOL = 1;
export const AdapterOp = z.enum(["tasks", "solve", "verify", "score"]);
export type AdapterOp = z.infer<typeof AdapterOp>;

/** RunSpec fields Orbit sets itself; an adapter's run spec may not contain them. */
export const ORBIT_OWNED_SPEC_FIELDS = [
  "name",
  "group",
  "params",
  "project",
  "snapshot",
  "auth",
  "agentBundle",
  "agent",
  "parentId",
  "priority",
  "passEnv",
] as const;

/**
 * A run as an adapter describes it: RunSpec fields (validated as a RunSpec once Orbit has added its
 * own) with either `command`, or `agentTask` for Agent methods, which Orbit turns into the method's
 * Agent CLI command with its auth and bundle.
 */
export const AdapterRunSpec = z
  .looseObject({
    command: z.array(z.string()).min(1).optional(),
    agentTask: z.object({ instruction: z.string().min(1) }).optional(),
  })
  .refine((s) => !ORBIT_OWNED_SPEC_FIELDS.some((k) => k in s), {
    message: `adapter run specs may not set ${ORBIT_OWNED_SPEC_FIELDS.join(", ")}`,
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.agentTask), {
    message: "an adapter run spec needs exactly one of command or agentTask",
  });
export type AdapterRunSpec = z.infer<typeof AdapterRunSpec>;

export const AdapterRunRef = z.object({
  run: Run,
  /** Host path of the run's output directory (`$ORBIT_OUTPUT`). */
  output: z.string(),
});
export type AdapterRunRef = z.infer<typeof AdapterRunRef>;

/** Request on the adapter's stdin; `trial` from `solve` on, `solve` from `verify`, `verify` for `score`. */
export const AdapterRequest = z.object({
  protocol: z.literal(ADAPTER_PROTOCOL),
  op: AdapterOp,
  benchmark: z.object({
    name: z.string(),
    path: z.string(),
    config: z.record(z.string(), z.string()),
  }),
  trial: z
    .object({
      id: z.string(),
      task: z.string(),
      method: Method,
      seed: z.number().int(),
      /** Job options (`orbit bench run -o key=value`). */
      options: z.record(z.string(), z.string()),
      timeoutMin: z.number().positive().optional(),
      /** Private per-trial host directory for files mounted into the runs; removed with the trial. */
      staging: z.string(),
      /** The method's auth profile uses the host network (for runners that start containers). */
      hostNetwork: z.boolean(),
    })
    .optional(),
  solve: AdapterRunRef.optional(),
  verify: AdapterRunRef.optional(),
});
export type AdapterRequest = z.infer<typeof AdapterRequest>;

export const AdapterTasksResponse = z.object({
  tasks: z.array(BenchTask),
  metrics: MetricSpecs.default([]),
});
export type AdapterTasksResponse = z.infer<typeof AdapterTasksResponse>;
export const AdapterSpecResponse = z.object({
  spec: AdapterRunSpec,
  /** Recorded on the trial (e.g. artifacts the solve run did not produce). */
  issues: z.array(z.string()).default([]),
});
export type AdapterSpecResponse = z.input<typeof AdapterSpecResponse>;

/** `score`: `invalid` when the verifier could not produce a trustworthy score. */
export const ScoreResult = z.object({
  score: z.number().nullable(),
  maxScore: z.number().positive().default(1),
  invalid: z.boolean().default(false),
  issues: z.array(z.string()).default([]),
  review: Review.optional(),
  /** Values of declared metrics (other than `score`); undeclared names are kept but not shown. */
  metrics: MetricValues.optional(),
});
export type ScoreResult = z.infer<typeof ScoreResult>;

/** Measured solve use per task over one or more jobs, with a suggested resources entry. */
export const BenchUsageRow = z.object({
  task: z.string(),
  /** Solve runs with usage samples. */
  runs: z.number().int(),
  requested: ResourceOverride,
  peakMemGB: z.number().nullable(),
  peakGpuMemGB: z.number().nullable(),
  peakCpus: z.number().nullable(),
  meanCpus: z.number().nullable(),
  /** Longest solve run, in minutes. */
  maxMinutes: z.number().nullable(),
  /** Runs that ended out of memory / had processes killed for memory / timed out. */
  oomKilled: z.number().int(),
  oomKills: z.number().int(),
  timeouts: z.number().int(),
  /** Fields worth changing (empty when the request fits), and why. */
  suggest: ResourceOverride,
  notes: z.array(z.string()),
});
export type BenchUsageRow = z.infer<typeof BenchUsageRow>;
export const BenchUsage = z.object({ jobs: z.array(z.string()), rows: z.array(BenchUsageRow) });
export type BenchUsage = z.infer<typeof BenchUsage>;
