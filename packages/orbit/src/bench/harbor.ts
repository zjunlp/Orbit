// Harbor task format: <task>/{task.toml, instruction.md, environment/, tests/, solution/}.
// Orbit runs the solve phase in the task environment and the verifier in a separate container
// (environment_mode = "separate"), with the declared artifacts copied across. Settings Orbit cannot
// honour mark the task unsupported instead of being ignored, so scores keep the task's conditions.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { BenchTask, Method } from "../contracts/index.ts";
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
}

interface Resources {
  cpus: number;
  memGB: number;
  gpus: number;
}

type Table = Record<string, unknown>;
const table = (v: unknown): Table => (v && typeof v === "object" ? (v as Table) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function vars(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(table(v))) out[k] = String(x);
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
function networkMode(phase: Table, env: Table, problems: string[], label: string): boolean {
  const legacy = env.allow_internet === false ? "no-network" : "public";
  const mode = str(phase.network_mode) ?? str(env.network_mode) ?? legacy;
  if (mode === "public") return true;
  if (mode === "no-network") return false;
  problems.push(`${label}-phase network_mode "${mode}" is not supported`);
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
    for (const k of ["gpu_types", "tpu", "mcp_servers", "skills_dir", "healthcheck"])
      check(nonEmpty(env[k]), `${label} ${k}`);
  }
  check(nonEmpty(agent.user), "[agent] user");
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
      Object.values(table(v)).some((x) => String(x).includes("${")),
      `${label} \${VAR} template`,
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

export function parseHarborTask(dir: string, id: string): HarborTask {
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
      )
    : null;
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
  const envNetwork = networkMode(agent, environment, problems, "agent");
  const verifierNetwork = networkMode(verifier, verifierEnv, problems, "verifier");
  const tags: Record<string, string> = {};
  for (const k of ["domain", "field", "subfield"]) {
    const v = str(meta[k]);
    if (v) tags[k] = v;
  }
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
      ...resources(verifierEnv, envRes),
      network: verifierNetwork,
      vars: { ...vars(verifierEnv.env), ...vars(verifier.env) },
      mode: mode === "shared" ? "shared" : "separate",
      image: verify.image,
      bundledTests: verify.bundledTests,
      workdir: workdir(verifierEnv, problems),
    },
    tags,
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
export function findHarborTasks(root: string): HarborTask[] {
  const base = taskBase(root);
  const dirs = harborTaskDirs(base);
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(basename(d), (counts.get(basename(d)) ?? 0) + 1);
  return dirs.map((d) => {
    const id = (counts.get(basename(d)) ?? 0) > 1 ? relative(base, d) : basename(d);
    try {
      return parseHarborTask(d, id);
    } catch (e) {
      return brokenTask(d, id, `task.toml: ${(e as Error).message}`);
    }
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
  };
}

export const toBenchTask = (t: HarborTask): BenchTask => ({
  id: t.id,
  title: t.title,
  supported: t.supported,
  reason: t.reason,
  tags: t.tags,
});

const VERIFY_COMMAND =
  "mkdir -p /logs/verifier /logs/agent && chmod +x /tests/test.sh && (/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1";

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
    resources: { gpus: t.env.gpus, cpus: t.env.cpus, memGB: t.env.memGB },
    mounts,
    env,
    network: t.env.network,
    root: true,
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
        }
      : {}),
  };
  if (t.verifier.mode === "shared") {
    const tests = join(staging, "tests");
    mkdirSync(staging, { recursive: true });
    cpSync(join(t.dir, "tests"), tests, { recursive: true });
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
      cpSync(src, copy, { recursive: true });
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
      resources: { gpus: t.verifier.gpus, cpus: t.verifier.cpus, memGB: t.verifier.memGB },
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
export function harborReward(verifierDir: string): ScoreReply {
  const json = join(verifierDir, "reward.json");
  const txt = join(verifierDir, "reward.txt");
  const bad = (issue: string): ScoreReply => ({
    score: null,
    maxScore: 1,
    issues: [issue],
    invalid: true,
  });
  if (existsSync(json)) {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(json, "utf8"));
    } catch {
      return bad("reward.json is not valid JSON");
    }
    const t = table(v);
    const keys = Object.keys(t);
    const pick = "reward" in t ? t.reward : keys.length === 1 ? t[keys[0] as string] : undefined;
    const n = num(pick);
    if (n === null)
      return bad(`reward.json has no single numeric reward (keys: ${keys.join(", ")})`);
    return { score: n, maxScore: 1, issues: [], invalid: false };
  }
  if (existsSync(txt)) {
    const raw = readFileSync(txt, "utf8").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n))
      return bad(`reward.txt is not a number: ${raw.slice(0, 40)}`);
    return { score: n, maxScore: 1, issues: [], invalid: false };
  }
  return bad("verifier wrote no reward");
}

function harborTask(root: string, id: string): HarborTask {
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
    t = parseHarborTask(dir, id);
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
  tasks: (req) => findHarborTasks(req.benchmark.path).map(toBenchTask),
  solve: ({ benchmark, trial }) => ({
    spec: harborSolveSpec(
      harborTask(benchmark.path, trial.task),
      trial.method,
      trial.staging,
      trial.timeoutMin,
    ),
  }),
  verify: ({ benchmark, trial, solve }) => {
    const t = harborTask(benchmark.path, trial.task);
    const { spec, missing } = harborVerifySpec(t, solve.output, trial.staging);
    return { spec, issues: missing.map((m) => `artifact not produced: ${m}`) };
  },
  score: ({ verify }) => {
    // Shared mode: the solve run's after phase collected /logs/verifier into output/after/.
    const sub = verify.run.spec.after ? "after" : "collected";
    const r = harborReward(join(verify.output, sub, "logs", "verifier"));
    return {
      ...r,
      ...(r.score === null ? {} : { metrics: { resolved: r.score >= 1 ? 100 : 0 } }),
      review: harborReview(verify.output, sub),
    };
  },
};
