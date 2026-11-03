import { posix } from "node:path";
import { z } from "zod";
import { EnvName, ProfileName } from "./common.ts";
import { Folder } from "./folders.ts";
import { Lease, ResourceRequest } from "./resources.ts";

const hasDotDot = (p: string) => p.split("/").includes("..");
const ContainerPath = z
  .string()
  .refine(
    (p) => p.startsWith("/") && !hasDotDot(p),
    "container paths must be absolute without `..`",
  )
  .transform((p) => posix.normalize(p).replace(/\/+$/, "") || "/");
/** Container paths Orbit mounts itself: the run directory, and the code at /workspace. */
const RESERVED_TARGET = /^\/(orbit)?(\/|$)/;
const WORKSPACE_TARGET = /^\/workspace(\/|$)/;

/** A bind mount: a host path (`source`, this node only) or a named dataset (any node that has it). */
export const Mount = z
  .object({
    source: z.string().optional(),
    dataset: z.string().optional(),
    target: ContainerPath,
    mode: z.enum(["ro", "rw"]).default("ro"),
  })
  .refine((m) => Boolean(m.source) !== Boolean(m.dataset), {
    message: "a mount needs exactly one of source or dataset",
  });
export type Mount = z.infer<typeof Mount>;

export const AgentRef = z.object({
  /** An Agent name (`contracts/agent.ts`), or `other` for an unrecognized submitter. */
  harness: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
});
export type AgentRef = z.infer<typeof AgentRef>;

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
    collect: z.array(ContainerPath).default([]),
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
    collect: z.array(ContainerPath).default([]),
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

export const CheckpointPolicy = z.object({
  /** Maximum saved writable layer plus checkpoint files, excluding shared base layers. */
  maxSizeGB: z.number().positive().max(100).default(4),
});
export type CheckpointPolicy = z.infer<typeof CheckpointPolicy>;

export const RunResume = z.object({
  /** Override the Agent resume command, e.g. to inspect the restored environment without an API. */
  command: z.array(z.string()).min(1).optional(),
});
export type RunResumeInput = z.input<typeof RunResume>;

export const RunCheckpoint = z.object({
  state: z.enum(["ready", "failed"]),
  imageId: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  /** Command execution only; snapshot and artifact collection time is excluded. */
  executionMin: z.number().nonnegative().optional(),
  session: z.object({ harness: z.string(), sessionId: z.string() }).nullable(),
  createdAt: z.string(),
  reason: z.string().nullable(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpoint>;

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
    /** Save local filesystem and native session state before failure cleanup. */
    checkpoint: CheckpointPolicy.optional(),
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
    collect: z.array(ContainerPath).default([]),
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
      const targets = s.mounts.map((m) => m.target);
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
    if (
      s.checkpoint &&
      (s.backend !== "docker" ||
        s.services.length ||
        s.mounts.some((m) => m.mode === "rw") ||
        (s.project && !s.snapshot))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "checkpoints require local Docker runs without services, external writable mounts or a live project mount",
      });
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
  /** Gitlinks and nested repositories whose contents were excluded from the snapshot. */
  skippedSubmodules: z.array(z.string()).default([]),
  fileCount: z.number().int(),
  bytes: z.number().int(),
});
export type CodeSnapshot = z.infer<typeof CodeSnapshot>;

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
  checkpoint: RunCheckpoint.nullable().default(null),
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

export const RunCursor = z.object({ createdAt: z.string().min(1), id: z.string().min(1) });
export type RunCursor = z.infer<typeof RunCursor>;
export const RunList = z.object({ runs: z.array(Run), next: RunCursor.nullable().default(null) });
export type RunList = z.infer<typeof RunList>;

/** Result of deleting runs (or a bench job's runs). */
export const RunDeletion = z.object({
  deleted: z.array(z.string()),
  /** Run directories that could not be removed completely (e.g. root-owned files). */
  leftovers: z.array(z.string()),
});
export type RunDeletion = z.infer<typeof RunDeletion>;
