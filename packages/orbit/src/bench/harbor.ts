// Harbor task format: <task>/{task.toml, instruction.md, environment/, tests/, solution/}.
// Orbit runs the solve phase in the task environment and the verifier in a separate container
// (environment_mode = "separate"), with the declared artifacts copied across. Settings Orbit cannot
// honour mark the task unsupported instead of being ignored, so scores keep the task's conditions.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { runAgentDir } from "../config/paths.ts";
import type { BenchTask, FailureKind, Method, ScoreResult } from "../contracts/index.ts";
import type { AdapterHandlers, RunDescription, ScoreReply } from "./adapter.ts";
import { type ComposePlan, composeFile, parseCompose } from "./compose.ts";

export interface Artifact {
  /** Absolute path in the solve container. */
  source: string;
  /** Absolute path in the verifier container. */
  destination: string;
  /** Harbor's convention directory: always carried across, empty when nothing was written. */
  optional?: boolean;
  /** A compose service other than `main` the file comes from. */
  service?: string;
  exclude?: string[];
}

/** Harbor copies this directory from the solve to the verifier environment without a declaration. */
export const CONVENTION_ARTIFACTS = "/logs/artifacts";

function withConvention(artifacts: Artifact[]): Artifact[] {
  if (artifacts.some((a) => a.source === CONVENTION_ARTIFACTS)) return artifacts;
  const convention = {
    source: CONVENTION_ARTIFACTS,
    destination: CONVENTION_ARTIFACTS,
    optional: true,
  };
  return [...artifacts, convention];
}

/** A prebuilt image, or a Dockerfile built with its directory as context. */
export type HarborImage = { image: string } | { dockerfile: string };

export interface HarborTask {
  id: string;
  dir: string;
  title: string | null;
  supported: boolean;
  reason: string | null;
  artifacts: Artifact[];
  /** Service containers from environment/docker-compose.yaml. */
  compose: ComposePlan | null;
  /** `[[verifier.collect]]`: commands run before artifacts are collected. */
  hooks: { service?: string; command: string; timeoutSec: number }[];
  agentTimeoutSec: number | null;
  agentUser?: string;
  verifierTimeoutSec: number | null;
  env: Resources & {
    network: boolean;
    vars: Record<string, string>;
    image: HarborImage | null;
    workdir: string | null;
  };
  solutionEnv: Record<string, string>;
  verifier: Resources & {
    network: boolean;
    vars: Record<string, string>;
    mode: "separate" | "shared";
    image: HarborImage | null;
    /** The verifier image has /tests itself (tests/Dockerfile or its own image); else tests/ is mounted. */
    bundledTests: boolean;
    workdir: string | null;
  };
  tags: Record<string, string>;
  /** Conditions that differ from Harbor's, allowed by the registration and recorded on trials. */
  deviations: string[];
}

/** Registration options of the built-in harbor adapter (`orbit bench add -c KEY=VALUE`). */
export interface HarborOptions {
  /** `allow`: compose `pid: host` / `cgroup: host` (resource monitors). */
  hostNamespaces?: string;
  /** `public`: run an `allowlist` agent network as public internet (a recorded deviation). */
  allowlistNetwork?: string;
  /** `any`: do not enforce solve/verifier `gpu_types` (a recorded deviation for each phase). */
  gpuTypes?: string;
  /**
   * Deprecated (design §9.10): accepted so older registrations keep working; `category` stays a
   * recorded condition so their jobs remain comparable, but neither changes what Orbit does.
   */
  category?: string;
  profiles?: string;
}

const HARBOR_CONFIG = new Set([
  "hostNamespaces",
  "allowlistNetwork",
  "gpuTypes",
  "category",
  "profiles",
]);

export function harborOptions(config: Record<string, string>): HarborOptions {
  const unknown = Object.keys(config).filter((k) => !HARBOR_CONFIG.has(k));
  if (unknown.length) throw new Error(`unknown harbor config: ${unknown.join(", ")}`);
  if (config.hostNamespaces && config.hostNamespaces !== "allow")
    throw new Error("hostNamespaces must be allow");
  if (config.allowlistNetwork && config.allowlistNetwork !== "public")
    throw new Error("allowlistNetwork must be public");
  if (config.gpuTypes && config.gpuTypes !== "any") throw new Error("gpuTypes must be any");
  return config;
}

interface Resources {
  cpus: number;
  memGB: number;
  gpus: number;
  gpuModels?: string[];
}

/**
 * Embodied First Exam tasks (`[task] name = "embodied-first-exam/…"`): a coding agent solving a
 * robotics task (category agent-workspace). A privileged task hands in a trajectory or program that
 * the verifier replays; a standard or realtime task drives the simulator live and its sidecar grades.
 */
export function embodiedTags(id: string, task: Table, meta: Table): Record<string, string> {
  if (!str(task.name)?.startsWith("embodied-first-exam/")) return {};
  const mode = /-(privileged|standard-realtime|realtime|standard)$/.exec(id)?.[1] ?? "standard";
  // roboEngineer seals a numeric controller even in standard mode (its hidden dynamics are the task).
  const program = mode === "privileged" || id.startsWith("roboengineer-");
  const out: Record<string, string> = {
    domain: "embodied",
    mode: mode === "standard-realtime" ? "realtime" : mode,
    profile: program ? "embodied-program" : "embodied-live",
  };
  for (const k of ["protocol", "oracle", "simulator", "task_type"] as const) {
    const v = str(meta[k]);
    if (v) out[k === "task_type" ? "deliverable" : k] = v;
  }
  return out;
}

/** GPU models any of which Harbor may provision for the specified environment. */
function gpuTypes(v: unknown, problems: string[], label = "[environment]"): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() && x.length <= 40)) {
    problems.push(`${label} gpu_types must be a list of GPU model names`);
    return [];
  }
  return [...new Set(v.map((x) => (x as string).trim()))].slice(0, 16);
}

type Table = Record<string, unknown>;
const table = (v: unknown): Table => (v && typeof v === "object" ? (v as Table) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A whole-value `${VAR:-default}` / `${VAR-default}` template; Orbit uses the default. */
const DEFAULTED = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}$/;

function vars(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(table(v))) {
    const m = DEFAULTED.exec(String(x));
    out[k] = m ? (m[1] as string) : String(x);
  }
  return out;
}

function resources(t: Table, fallback?: Resources): Resources {
  return {
    cpus: num(t.cpus) ?? fallback?.cpus ?? 2,
    memGB: (num(t.memory_mb) ?? (fallback ? fallback.memGB * 1024 : 4096)) / 1024,
    gpus: num(t.gpus) ?? fallback?.gpus ?? 0,
  };
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `artifacts` entries: strings, or `{source, destination?, exclude?, service?}` tables. */
export function parseArtifacts(v: unknown): { artifacts: Artifact[]; skipped: string[] } {
  const artifacts: Artifact[] = [];
  const skipped: string[] = [];
  for (const a of Array.isArray(v) ? v : []) {
    if (typeof a === "string") {
      artifacts.push({ source: trimSlash(a), destination: trimSlash(a) });
      continue;
    }
    const t = table(a);
    const source = str(t.source);
    if (!source) continue;
    const exclude = Array.isArray(t.exclude) ? t.exclude : [];
    const service = str(t.service);
    // `exclude = ["*"]` placeholders carry nothing.
    if (exclude.includes("*")) {
      skipped.push(source);
      continue;
    }
    const dest = str(t.destination);
    artifacts.push({
      source: trimSlash(source),
      destination: trimSlash(dest?.startsWith("/") ? dest : source),
      ...(service && service !== "main" ? { service } : {}),
      ...(exclude.length
        ? { exclude: exclude.filter((x): x is string => typeof x === "string") }
        : {}),
    });
  }
  return { artifacts, skipped };
}

const hasCompose = (d: string) =>
  existsSync(join(d, "docker-compose.yaml")) || existsSync(join(d, "docker-compose.yml"));
const nonEmpty = (v: unknown) =>
  v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";

/**
 * Harbor's verifier mode: explicit `environment_mode`, else `separate` when `[verifier.environment]`
 * is given, else `shared`.
 */
export function verifierMode(verifier: Table): string {
  return str(verifier.environment_mode) ?? ("environment" in verifier ? "separate" : "shared");
}

/**
 * Harbor's network policy for a phase: the phase's own `network_mode`, else its environment's
 * (`allow_internet = false` is the deprecated spelling of `no-network`), defaulting to public.
 */
function networkMode(
  phase: Table,
  env: Table,
  problems: string[],
  label: string,
  opts: HarborOptions = {},
  deviations: string[] = [],
): boolean {
  const legacy = env.allow_internet === false ? "no-network" : "public";
  const mode = str(phase.network_mode) ?? str(env.network_mode) ?? legacy;
  if (mode === "public") return true;
  if (mode === "no-network") return false;
  if (mode === "allowlist" && opts.allowlistNetwork === "public") {
    deviations.push(`${label} network: allowlist run as public internet (no egress filter)`);
    return true;
  }
  problems.push(
    `${label}-phase network_mode "${mode}" is not supported${mode === "allowlist" ? " (register with -c allowlistNetwork=public to run it as public, recorded as a deviation)" : ""}`,
  );
  return true;
}

/** `[[verifier.collect]]` entries as run hooks (in `main` or a compose service). */
function collectHooks(v: unknown, compose: ComposePlan | null, problems: string[]) {
  const out: HarborTask["hooks"] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const t = table(raw);
    const command = str(t.command);
    const service = str(t.service) ?? "main";
    if (!command) {
      problems.push("[[verifier.collect]] without a command");
      continue;
    }
    if (nonEmpty(t.user)) problems.push("[[verifier.collect]] user is not supported");
    if (service !== "main" && !compose?.services.some((x) => x.name === service))
      problems.push(`[[verifier.collect]] names unknown service ${service}`);
    out.push({
      ...(service !== "main" ? { service } : {}),
      command,
      timeoutSec: num(t.timeout_sec) ?? 60,
    });
  }
  return out;
}

function workdir(env: Table, problems: string[]): string | null {
  const w = str(env.workdir);
  if (w && !w.startsWith("/")) problems.push(`workdir "${w}" is not an absolute path`);
  return w?.startsWith("/") ? w : null;
}

/** Settings Orbit does not implement; running without them would change the task's conditions. */
function unsupportedSettings(toml: Table): string[] {
  const environment = table(toml.environment);
  const agent = table(toml.agent);
  const verifier = table(toml.verifier);
  const verifierEnv = table(verifier.environment);
  const out: string[] = [];
  const check = (cond: boolean, what: string) => cond && out.push(`${what} is not supported`);
  for (const [label, env] of [
    ["[environment]", environment],
    ["[verifier.environment]", verifierEnv],
  ] as const) {
    check((str(env.os) ?? "linux").toLowerCase() !== "linux", `${label} os "${str(env.os)}"`);
    for (const k of ["tpu", "mcp_servers", "skills_dir", "healthcheck"])
      check(nonEmpty(env[k]), `${label} ${k}`);
  }
  check(
    nonEmpty(agent.user) &&
      (typeof agent.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(agent.user)),
    "[agent] user (expected an existing image account name)",
  );
  check(nonEmpty(verifier.user), "[verifier] user");
  check(nonEmpty(toml.steps), "[[steps]] (multi-step tasks)");
  const tables: [string, unknown][] = [
    ["[environment.env]", environment.env],
    ["[verifier.env]", verifier.env],
    ["[verifier.environment.env]", verifierEnv.env],
    ["[solution.env]", table(toml.solution).env],
  ];
  for (const [label, v] of tables)
    check(
      Object.values(table(v)).some((x) => String(x).includes("${") && !DEFAULTED.test(String(x))),
      `${label} \${VAR} template without a default`,
    );
  return out;
}

/** The solve image: `docker_image` (Harbor prefers it), else environment/Dockerfile. */
function solveImage(dir: string, environment: Table, problems: string[]): HarborImage | null {
  const envDir = join(dir, "environment");
  const image = str(environment.docker_image);
  const dockerfile = join(envDir, "Dockerfile");
  if (image) {
    // Harbor uploads the environment directory into prebuilt images that have no build spec.
    const files = existsSync(envDir) ? readdirSync(envDir) : [];
    if (!existsSync(dockerfile) && !hasCompose(envDir) && files.length > 0)
      problems.push("docker_image with environment files but no Dockerfile is not supported");
    return { image };
  }
  if (existsSync(dockerfile)) return { dockerfile };
  problems.push("environment/Dockerfile missing");
  return null;
}

/**
 * The separate verifier image, in Harbor's order: `[verifier.environment] docker_image`,
 * tests/Dockerfile (both own /tests), tests/docker-compose.yaml, then a fresh copy of the task
 * environment with tests/ mounted at /tests.
 */
function verifierImage(
  dir: string,
  verifierEnv: Table,
  solve: HarborImage | null,
  problems: string[],
): { image: HarborImage | null; bundledTests: boolean } {
  const tests = join(dir, "tests");
  const image = str(verifierEnv.docker_image);
  if (image) return { image: { image }, bundledTests: true };
  if (existsSync(join(tests, "Dockerfile")))
    return { image: { dockerfile: join(tests, "Dockerfile") }, bundledTests: true };
  if (hasCompose(tests)) {
    problems.push("docker-compose verifier environments are not supported");
    return { image: null, bundledTests: true };
  }
  if (!existsSync(join(tests, "test.sh"))) problems.push("tests/test.sh missing");
  return { image: solve, bundledTests: false };
}

/** Tables whose `${VAR:-default}` values take their default (Orbit does not pass its environment). */
function defaultedTemplates(toml: Table): string[] {
  const environment = table(toml.environment);
  const verifier = table(toml.verifier);
  const out: string[] = [];
  for (const [label, v] of [
    ["[environment.env]", environment.env],
    ["[verifier.env]", verifier.env],
    ["[verifier.environment.env]", table(verifier.environment).env],
    ["[solution.env]", table(toml.solution).env],
  ] as const)
    for (const [k, x] of Object.entries(table(v)))
      if (DEFAULTED.test(String(x)))
        out.push(`${label} ${k} uses its template default (Harbor reads the host environment)`);
  return out;
}

export function parseHarborTask(dir: string, id: string, opts: HarborOptions = {}): HarborTask {
  const toml = table(parseToml(readFileSync(join(dir, "task.toml"), "utf8")));
  const task = table(toml.task);
  const meta = table(toml.metadata);
  const environment = table(toml.environment);
  const agent = table(toml.agent);
  const verifier = table(toml.verifier);
  const ownVerifierEnv = "environment" in verifier;
  // A separate verifier without its own environment runs in a fresh copy of the task environment.
  const verifierEnv = ownVerifierEnv ? table(verifier.environment) : environment;
  const envRes = resources(environment);
  const problems: string[] = [];
  const deviations = defaultedTemplates(toml);
  const image = solveImage(dir, environment, problems);
  if (!existsSync(join(dir, "instruction.md"))) problems.push("instruction.md missing");
  const envDir = join(dir, "environment");
  const composePath = composeFile(envDir);
  const memMb = num(environment.memory_mb);
  const compose = composePath
    ? parseCompose(
        composePath,
        envDir,
        image && "dockerfile" in image ? image.dockerfile : null,
        image && "image" in image ? image.image : null,
        {
          ...vars(environment.env),
          CONTEXT_DIR: envDir,
          ...(num(environment.cpus) !== null ? { CPUS: String(environment.cpus) } : {}),
          ...(memMb !== null ? { MEMORY: `${memMb}M` } : {}),
          ...(image && "image" in image ? { PREBUILT_IMAGE_NAME: image.image } : {}),
        },
        problems,
        { hostNamespaces: opts.hostNamespaces === "allow" },
      )
    : null;
  if (compose?.services.some((x) => x.hostPid || x.hostCgroup))
    deviations.push(
      "a compose service shares the host PID/cgroup namespace (registration allows it)",
    );
  const artifacts = withConvention(parseArtifacts(toml.artifacts).artifacts);
  for (const a of artifacts)
    if (a.service && !compose?.services.some((x) => x.name === a.service))
      problems.push(`artifact ${a.source} names unknown service ${a.service}`);
  const hooks = collectHooks(verifier.collect, compose, problems);
  const mode = verifierMode(verifier);
  let verify: ReturnType<typeof verifierImage> = { image: null, bundledTests: true };
  if (mode === "separate") {
    verify = verifierImage(dir, table(verifier.environment), image, problems);
    if (compose && !verify.bundledTests)
      problems.push("a separate verifier copying a docker-compose environment is not supported");
  } else if (mode === "shared") {
    // Harbor uploads tests/ into the Agent's container once it is done and runs test.sh there.
    if (!existsSync(join(dir, "tests", "test.sh"))) problems.push("tests/test.sh missing");
  } else problems.push(`verifier environment_mode "${mode}" is not supported`);
  problems.push(...unsupportedSettings(toml));
  const envNetwork = networkMode(agent, environment, problems, "agent", opts, deviations);
  const verifierNetwork = networkMode(
    verifier,
    verifierEnv,
    problems,
    "verifier",
    opts,
    deviations,
  );
  if (compose?.mainGpus) envRes.gpus = Math.max(envRes.gpus, compose.mainGpus);
  else if (envRes.gpus > 0 && compose?.sharedGpuOwner && compose.sharedGpuOwner !== "main")
    // Compose would put main and the sharing services on the same cards; Orbit cannot express that.
    problems.push("[environment] gpus with a compose GPU service is not supported");
  const gpuModels = gpuTypes(environment.gpu_types, problems);
  if (gpuModels.length) {
    // gpu_types restricts every card the task gets: main's and each GPU role's.
    const holders = [
      ...(envRes.gpus > 0 ? ["main"] : []),
      ...(compose?.services.filter((x) => x.role && (x.gpus ?? 0) > 0).map((x) => x.role) ?? []),
    ];
    if (!holders.length) problems.push("[environment] gpu_types without a GPU reservation");
    else if (opts.gpuTypes === "any")
      deviations.push(
        `gpu_types ${gpuModels.join(" / ")} not enforced (registration allows any GPU)`,
      );
    else {
      if (holders.includes("main")) envRes.gpuModels = gpuModels;
      for (const svc of compose?.services ?? [])
        if (svc.role && (svc.gpus ?? 0) > 0) svc.gpuModels = gpuModels;
    }
  }
  const verifyRes = resources(verifierEnv, envRes);
  const verifierModels = gpuTypes(verifierEnv.gpu_types, problems, "[verifier.environment]");
  if (verifierModels.length && mode === "separate") {
    if (!verifyRes.gpus)
      problems.push("[verifier.environment] gpu_types without a GPU reservation");
    else if (opts.gpuTypes === "any")
      deviations.push(
        `verifier gpu_types ${verifierModels.join(" / ")} not enforced (registration allows any GPU)`,
      );
    else verifyRes.gpuModels = verifierModels;
  } else if (verifierModels.length && ownVerifierEnv)
    problems.push("[verifier.environment] gpu_types requires a separate verifier");
  const tags: Record<string, string> = {};
  for (const k of ["domain", "field", "subfield"]) {
    const v = str(meta[k]);
    if (v) tags[k] = v;
  }
  Object.assign(tags, embodiedTags(id, task, meta));
  if (typeof meta.oracle_reward_threshold === "number" && meta.oracle_reward_threshold < 1)
    tags.oracle = "partial";
  return {
    id,
    dir,
    title: str(task.description) ?? str(task.name),
    supported: problems.length === 0,
    reason: problems.length ? [...new Set(problems)].join("; ") : null,
    artifacts,
    compose,
    hooks,
    agentTimeoutSec: num(agent.timeout_sec),
    ...(str(agent.user) ? { agentUser: str(agent.user) as string } : {}),
    verifierTimeoutSec: num(verifier.timeout_sec),
    env: {
      ...envRes,
      network: envNetwork,
      vars: vars(environment.env),
      image,
      workdir: workdir(environment, problems),
    },
    solutionEnv: vars(table(toml.solution).env),
    verifier: {
      ...verifyRes,
      network: verifierNetwork,
      vars: { ...vars(verifierEnv.env), ...vars(verifier.env) },
      mode: mode === "shared" ? "shared" : "separate",
      image: verify.image,
      bundledTests: verify.bundledTests,
      workdir: workdir(verifierEnv, problems),
    },
    tags: deviations.length ? { ...tags, deviations: deviations.join("; ") } : tags,
    deviations,
  };
}

const taskBase = (root: string) => (existsSync(join(root, "tasks")) ? join(root, "tasks") : root);

function harborTaskDirs(base: string): string[] {
  const dirs: string[] = [];
  const walk = (d: string, depth: number) => {
    if (existsSync(join(d, "task.toml"))) {
      dirs.push(d);
      return;
    }
    if (depth === 0) return;
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      if (statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p, depth - 1);
    }
  };
  walk(base, 4);
  return dirs;
}

/** Task directories (containing task.toml) under `root/tasks` or `root`; ids are directory names. */
export function findHarborTasks(root: string, opts: HarborOptions = {}): HarborTask[] {
  const base = taskBase(root);
  const dirs = harborTaskDirs(base);
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(basename(d), (counts.get(basename(d)) ?? 0) + 1);
  return dirs.map((d) => {
    const id = (counts.get(basename(d)) ?? 0) > 1 ? relative(base, d) : basename(d);
    let task: HarborTask;
    try {
      task = parseHarborTask(d, id, opts);
    } catch (e) {
      task = brokenTask(d, id, `task.toml: ${(e as Error).message}`);
    }
    // Hubs group tasks in suite directories (tasks/<suite>/<task>); coverage reports by suite.
    const parts = relative(base, d).split(sep);
    if (parts.length > 1 && !task.tags.suite) task.tags.suite = parts[0] as string;
    return task;
  });
}

function brokenTask(dir: string, id: string, reason: string): HarborTask {
  const r = { cpus: 1, memGB: 1, gpus: 0, network: false, vars: {}, image: null, workdir: null };
  return {
    id,
    dir,
    title: null,
    supported: false,
    reason,
    artifacts: [],
    compose: null,
    hooks: [],
    agentTimeoutSec: null,
    verifierTimeoutSec: null,
    env: r,
    solutionEnv: {},
    verifier: { ...r, mode: "separate", bundledTests: true },
    tags: {},
    deviations: [],
  };
}

export const toBenchTask = (t: HarborTask): BenchTask => ({
  id: t.id,
  title: t.title,
  supported: t.supported,
  reason: t.reason,
  tags: t.tags,
});

/**
 * The verifier command. The chmod is best effort: an image that runs as a non-root USER cannot change
 * the mode of the mounted /tests, so the tests are staged executable on the host instead (and the
 * script keeps its own shebang).
 */
const VERIFY_COMMAND =
  "mkdir -p /logs/verifier /logs/agent && chmod +x /tests/test.sh 2>/dev/null; (/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1";

function imageFields(img: HarborImage | null): { image: string } | { dockerfile: string } {
  if (!img) throw new Error("task has no environment image");
  return img;
}

/** Solve run: the Agent (or the oracle solution) in the task environment, as the image's user. */
export function harborSolveSpec(
  t: HarborTask,
  method: Method,
  staging: string,
  timeoutMin?: number,
): RunDescription {
  if (method.agent === "external")
    throw new Error("Harbor does not support external methods; use a compatible adapter");
  const mounts: RunDescription["mounts"] = [];
  // Harbor layers the task's variables over those of the compose file's `main`.
  const base = { ...t.compose?.env, ...t.env.vars };
  const env = method.agent === "oracle" ? { ...base, ...t.solutionEnv } : base;
  const c = t.compose;
  const run = {
    ...imageFields(t.env.image),
    resources: {
      gpus: t.env.gpus,
      cpus: t.env.cpus,
      memGB: t.env.memGB,
      ...(t.env.gpuModels?.length ? { gpuModels: t.env.gpuModels } : {}),
      ...(c?.mainGpuMemGB ? { gpuMemGB: c.mainGpuMemGB } : {}),
    },
    ...(c?.mainShmGB ? { shmGB: c.mainShmGB } : {}),
    mounts,
    env,
    network: t.env.network,
    root: true,
    ...(t.agentUser ? { commandUser: t.agentUser } : {}),
    workdir: t.env.workdir ?? c?.workdir ?? "image",
    timeoutMin: timeoutMin ?? (t.agentTimeoutSec ? t.agentTimeoutSec / 60 : undefined),
    collect: t.artifacts.filter((a) => !a.service).map((a) => a.source),
    // Harbor mounts these into the Agent's environment; tasks may expect them to exist.
    mkdirs: ["/logs/agent", "/logs/verifier", "/logs/artifacts"],
    ...(t.hooks.length ? { hooks: t.hooks } : {}),
    ...(c?.services.length
      ? {
          services: c.services.map((s) => ({
            ...s,
            collect: t.artifacts.filter((a) => a.service === s.name).map((a) => a.source),
          })),
          networks: c.networks,
          runNetworks: c.runNetworks,
          dependsOn: c.dependsOn,
          volumes: c.volumes,
          volumeMounts: c.mainVolumes,
          ...(c.mainPidsLimit ? { pidsLimit: c.mainPidsLimit } : {}),
        }
      : {}),
  };
  if (t.verifier.mode === "shared") {
    const tests = join(staging, "tests");
    mkdirSync(staging, { recursive: true });
    cpSync(join(t.dir, "tests"), tests, { recursive: true });
    // A bind mount keeps this mode; the verifier may run as an image USER that cannot chmod it.
    if (existsSync(join(tests, "test.sh"))) chmodSync(join(tests, "test.sh"), 0o755);
    Object.assign(run, {
      after: {
        // Harbor's verifier command: executable test.sh, output kept with the reward.
        command: ["sh", "-c", VERIFY_COMMAND],
        timeoutMin: t.verifierTimeoutSec ? t.verifierTimeoutSec / 60 : 10,
        env: t.verifier.vars,
        copy: [{ source: tests, target: "/tests" }],
        network: t.verifier.network,
        collect: ["/logs/verifier"],
      },
    });
  }
  if (method.agent === "oracle") {
    const sol = join(staging, "solution");
    mkdirSync(staging, { recursive: true });
    cpSync(join(t.dir, "solution"), sol, { recursive: true });
    mounts.push({ source: sol, target: "/solution", mode: "rw" });
    return { ...run, command: ["bash", "/solution/solve.sh"] };
  }
  if (method.agent === "empty") return { ...run, command: ["true"] };
  return {
    ...run,
    agentTask: { instruction: readFileSync(join(t.dir, "instruction.md"), "utf8") },
  };
}

/**
 * Verify run: the verifier image with the collected artifacts copied in (and tests/ at /tests unless
 * the image has its own); `/logs/verifier` (reward) is collected back. Missing artifacts are left
 * out, so the tests see what the Agent actually produced.
 */
export function harborVerifySpec(
  t: HarborTask,
  solveOutput: string,
  staging: string,
): { spec: RunDescription; missing: string[] } {
  const mounts: RunDescription["mounts"] = [];
  const missing: string[] = [];
  for (const a of t.artifacts) {
    const src = a.service
      ? join(solveOutput, "services", a.service, a.source)
      : join(solveOutput, "collected", a.source);
    const copy = join(staging, "artifacts", a.source);
    if (!existsSync(src)) {
      if (!a.optional) {
        missing.push(a.source);
        continue;
      }
      mkdirSync(copy, { recursive: true });
    } else {
      mkdirSync(dirname(copy), { recursive: true });
      if (a.exclude?.length && lstatSync(src).isDirectory()) {
        // Harbor transfers exclusions through tar; filesystem globs differ for ./paths and *.
        const temporary = mkdtempSync(join(staging, "artifact-filter-"));
        try {
          const archive = join(temporary, "artifact.tar");
          execFileSync("tar", [
            "-cf",
            archive,
            ...a.exclude.map((p) => `--exclude=${p}`),
            "-C",
            src,
            ".",
          ]);
          mkdirSync(copy, { recursive: true });
          execFileSync("tar", ["-xf", archive, "--no-same-owner", "-C", copy]);
        } finally {
          rmSync(temporary, { recursive: true, force: true });
        }
      } else cpSync(src, copy, { recursive: true });
    }
    mounts.push({ source: copy, target: a.destination, mode: "rw" });
  }
  if (!t.verifier.bundledTests) {
    const tests = join(staging, "tests");
    cpSync(join(t.dir, "tests"), tests, { recursive: true });
    mounts.push({ source: tests, target: "/tests", mode: "rw" });
  }
  return {
    spec: {
      ...imageFields(t.verifier.image),
      command: ["sh", "-c", VERIFY_COMMAND],
      resources: {
        gpus: t.verifier.gpus,
        cpus: t.verifier.cpus,
        memGB: t.verifier.memGB,
        ...(t.verifier.gpuModels?.length ? { gpuModels: t.verifier.gpuModels } : {}),
      },
      mounts,
      env: t.verifier.vars,
      network: t.verifier.network,
      root: true,
      workdir: t.verifier.workdir ?? "image",
      timeoutMin: t.verifierTimeoutSec ? t.verifierTimeoutSec / 60 : 10,
      collect: ["/logs/verifier"],
    },
    missing,
  };
}

/** Reward from `reward.json` (the `reward` key, or its only key) or `reward.txt` (one number). */
/**
 * Messages upstream verifiers print when their own infrastructure failed, before writing a reward of
 * 0 anyway (design: integration-categories §3 ③). A 0 that comes with one is not the method's result.
 */
const UPSTREAM_FAULTS: { pattern: RegExp; failure: FailureKind; issue: string }[] = [
  // Harbor's TextArena adapter (tests/test.sh): the game server was unreachable or gave no reward.
  {
    // A game without a final result is not this fault: a method that never finished the game is a
    // legitimate 0 (the server answers 425 "game not finished yet"; the verifier writes 0 too).
    pattern: /✗ (Could not reach game server|Game server returned (?!425\b)\d+)/,
    failure: "infra",
    issue: "the game server did not report a result (the verifier wrote 0)",
  },
];

/** A grader script that crashed (not an assertion) before the wrapper wrote 0. */
const CRASH =
  /Traceback \(most recent call last\):[\s\S]*?\n(?!AssertionError)(\w+(?:Error|Exception)): ?(.{0,160})/;

/** The verifier log's last 64 KiB (the run wrote it; read as data only). */
function verifierLog(verifierDir: string): string {
  const file = join(verifierDir, "test-stdout.txt");
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return "";
    const text = readFileSync(file, "utf8");
    return text.slice(-65_536);
  } catch {
    return "";
  }
}

/** The reward with upstream faults that a 0 may hide made visible (invalid, or an issue). */
export function harborReward(verifierDir: string): ScoreReply {
  const r = rawHarborReward(verifierDir);
  if (r.invalid || r.score !== 0) return r;
  const log = verifierLog(verifierDir);
  for (const f of UPSTREAM_FAULTS)
    if (f.pattern.test(log))
      return { score: null, maxScore: 1, invalid: true, failure: f.failure, issues: [f.issue] };
  const crash = CRASH.exec(log);
  if (crash)
    return {
      ...r,
      issues: [
        ...(r.issues ?? []),
        `the verifier raised ${crash[1]} (${crash[2]?.trim()}) and scored 0: check whether the solution or the grader failed`,
      ],
    };
  return r;
}

function rawHarborReward(verifierDir: string): ScoreReply {
  const json = join(verifierDir, "reward.json");
  const txt = join(verifierDir, "reward.txt");
  const bad = (issue: string, failure: FailureKind = "scorer_error"): ScoreReply => ({
    score: null,
    maxScore: 1,
    issues: [issue],
    invalid: true,
    failure,
  });
  const fromTxt = (): ScoreReply | null => {
    if (!existsSync(txt)) return null;
    const raw = readFileSync(txt, "utf8").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n))
      return bad(`reward.txt is not a number: ${raw.slice(0, 40)}`);
    return { score: n, maxScore: 1, issues: [], invalid: false };
  };
  if (existsSync(json)) {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(json, "utf8"));
    } catch {
      return bad("reward.json is not valid JSON");
    }
    const t = table(v);
    const keys = Object.keys(t);
    // Benchmarks that report failures of their own infrastructure or grader beside the reward
    // (Embodied First Exam: `infra_error`, `grader_error`): no trustworthy score, not a zero.
    if ((num(t.infra_error) ?? 0) > 0)
      return bad("the benchmark reported an infrastructure error", "infra");
    if ((num(t.grader_error) ?? 0) > 0) return bad("the benchmark reported a grader error");
    const pick = "reward" in t ? t.reward : keys.length === 1 ? t[keys[0] as string] : undefined;
    const n = num(pick);
    if (n !== null) return { score: n, maxScore: 1, issues: [], invalid: false };
    // Several named values and no `reward`: Harbor keeps them all; reward.txt names the reward.
    const txtReward = fromTxt();
    if (txtReward) return txtReward;
    return bad(`reward.json has no single numeric reward (keys: ${keys.join(", ")})`);
  }
  return fromTxt() ?? bad("verifier wrote no reward");
}

function harborTask(root: string, id: string, opts: HarborOptions = {}): HarborTask {
  const base = taskBase(root);
  let dir: string | undefined;
  if (existsSync(join(base, "task.toml"))) {
    if (id === basename(base)) dir = base;
  } else if (
    id === basename(id) &&
    !id.startsWith(".") &&
    existsSync(join(base, id, "task.toml"))
  ) {
    dir = join(base, id);
  } else {
    // Nested tasks use a short basename when unique, a relative path when names collide.
    const matches = harborTaskDirs(base).filter((d) => basename(d) === basename(id));
    dir = matches.find((d) => (matches.length > 1 ? relative(base, d) : basename(d)) === id);
  }
  if (!dir) throw new Error(`task not found: ${id}`);
  let t: HarborTask;
  try {
    t = parseHarborTask(dir, id, opts);
  } catch (e) {
    t = brokenTask(dir, id, `task.toml: ${(e as Error).message}`);
  }
  if (!t.supported) throw new Error(`task ${id} is not supported: ${t.reason}`);
  return t;
}

const REVIEW_SKIP = /^reward\.(json|txt)$/;

/** Verifier outputs worth reading on the trial page (test output, logs), smallest first. */
export function harborReview(verifyOutput: string, sub = "collected"): ScoreReply["review"] {
  const dir = join(verifyOutput, sub, "logs", "verifier");
  const files: NonNullable<ScoreReply["review"]>["files"] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names.sort()) {
    const st = statSync(join(dir, n), { throwIfNoEntry: false });
    if (!st?.isFile() || REVIEW_SKIP.test(n)) continue;
    files.push({ label: n, phase: "verify", path: relative(verifyOutput, join(dir, n)) });
    if (files.length >= 8) break;
  }
  for (const n of ["reward.json", "reward.txt"])
    if (existsSync(join(dir, n)))
      files.push({ label: "Reward", phase: "verify", path: relative(verifyOutput, join(dir, n)) });
  return { files, items: [], details: {} };
}

/**
 * Terminal-Bench style: the headline is the resolution rate (reward 1, every test passing); the mean
 * reward also credits partial rewards of tasks that give them.
 */
const HARBOR_METRICS: AdapterHandlers["metrics"] = [
  {
    name: "resolved",
    label: "Resolved",
    description: "trials with the full reward (1)",
    unit: "%",
    range: [0, 100],
    primary: true,
  },
  { name: "score", label: "Reward", description: "mean reward, in percent of 1" },
];

export const harborAdapter: AdapterHandlers = {
  metrics: HARBOR_METRICS,
  tasks: (req) =>
    findHarborTasks(req.benchmark.path, harborOptions(req.benchmark.config)).map(toBenchTask),
  info: (req, tasks) => {
    const opts = harborOptions(req.benchmark.config);
    const embodied = tasks.some((t) => t.tags.domain === "embodied");
    return {
      capabilities: {
        ...(embodied
          ? {
              identity: { id: "embodied-first-exam", name: "Embodied First Exam" },
              taxonomy: { domains: ["robotics"] },
            }
          : {}),
        methods: ["oracle", "empty", "cli"],
        conditions: {
          Format: "Harbor task directories; each task's own environment and verifier",
          ...(opts.category ? { Category: `${opts.category} (declared at registration)` } : {}),
        },
        scoreKind: "scalar",
        rescore: "evidence",
        // Every Harbor task ships solution/solve.sh; tasks tagged with a partial oracle are skipped.
        calibration: { oracle: "max" },
      },
    };
  },
  solve: ({ benchmark, trial }) => {
    const t = harborTask(benchmark.path, trial.task, harborOptions(benchmark.config));
    return {
      spec: harborSolveSpec(t, trial.method, trial.staging, trial.timeoutMin),
      issues: t.deviations.map((d) => `deviation: ${d}`),
    };
  },
  verify: ({ benchmark, trial, solve }) => {
    const t = harborTask(benchmark.path, trial.task, harborOptions(benchmark.config));
    const { spec, missing } = harborVerifySpec(t, solve.output, trial.staging);
    return { spec, issues: missing.map((m) => `artifact not produced: ${m}`) };
  },
  score: async ({ trial, solve, verify }) => {
    // Shared mode: the solve run's after phase collected /logs/verifier into output/after/.
    const sub = verify.run.spec.after ? "after" : "collected";
    const r = harborReward(join(verify.output, sub, "logs", "verifier"));
    const reply: ScoreResult = {
      ...r,
      maxScore: r.maxScore ?? 1,
      invalid: r.invalid ?? false,
      issues: r.issues ?? [],
      ...(r.score === null ? {} : { metrics: { resolved: r.score >= 1 ? 100 : 0 } }),
      review: harborReview(verify.output, sub),
    };
    // EFE MetaWorld+ tasks keep a simulator journal; index it with the Agent session for review.
    // Loaded on demand so other adapter calls stay light.
    if (trial.task.startsWith("metaworldplus-")) {
      const { loadRunAgentTranscript } = await import("../sessions/index.ts");
      const { addEfeTrajectory } = await import("./trajectory-artifacts.ts");
      const transcript = await loadRunAgentTranscript(runAgentDir(solve.output)).catch(() => null);
      await addEfeTrajectory(
        solve.output,
        solve.run,
        reply,
        transcript?.messages ?? [],
        trial.task,
      );
    }
    return reply;
  },
};
