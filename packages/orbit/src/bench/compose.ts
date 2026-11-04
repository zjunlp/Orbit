// The subset of Docker Compose that Harbor task environments use for service containers next to the
// Agent's (`main`): build/image, command, environment, limits, health checks, dependencies, networks
// and container hardening. Anything else is reported, so the task is listed as unsupported rather
// than run under different conditions.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Healthcheck, NetworkSpec, ServiceSpec, VolumeMount } from "../contracts/index.ts";

export interface ComposeOptions {
  /**
   * Allow `pid: host` / `cgroup: host` (a resource monitor watching sibling containers). It sees
   * every process on the machine, so the benchmark registration must opt in.
   */
  hostNamespaces?: boolean;
}

export interface ComposePlan {
  services: ServiceSpec[];
  networks: NetworkSpec[];
  /** Networks `main` joins. */
  runNetworks: string[];
  /** Services `main` waits for. */
  dependsOn: string[];
  /** `main`'s own environment and working directory from the compose file. */
  env: Record<string, string>;
  workdir: string | null;
  /** Top-level named volumes, created per run. */
  volumes: string[];
  /** Volumes and the PID limit of `main`. */
  mainVolumes: VolumeMount[];
  mainPidsLimit: number | null;
}

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const NAME = /^[a-z0-9]([a-z0-9_-]{0,40}[a-z0-9])?$/;

/** Keys Orbit maps; `expose` and `pull_policy` change nothing for containers on a private network. */
const MAIN_KEYS = new Set([
  "build",
  "image",
  "command",
  "environment",
  "working_dir",
  "depends_on",
  "networks",
  "expose",
  "volumes",
  "pids_limit",
]);
const SERVICE_KEYS = new Set([
  "build",
  "image",
  "command",
  "environment",
  "working_dir",
  "cpus",
  "mem_limit",
  "healthcheck",
  "depends_on",
  "networks",
  "expose",
  "pull_policy",
  "init",
  "read_only",
  "tmpfs",
  "cap_add",
  "cap_drop",
  "security_opt",
  "pids_limit",
  "shm_size",
  "volumes",
  "restart",
  "pid",
  "cgroup",
  "network_mode",
]);

/**
 * Service `volumes`: a top-level named volume, or a host path relative to the compose file (bind).
 * Short (`src:target[:ro]`) and long (`{type, source, target, read_only}`) syntax.
 */
function volumesOf(
  v: unknown,
  named: Set<string>,
  envDir: string,
  problems: string[],
  label: string,
): { volumes: VolumeMount[]; binds: { source: string; target: string; mode: "ro" | "rw" }[] } {
  const volumes: VolumeMount[] = [];
  const binds: { source: string; target: string; mode: "ro" | "rw" }[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    let source: string | undefined;
    let target: string | undefined;
    let ro = false;
    if (typeof raw === "string") {
      const parts = raw.split(":");
      [source, target] = parts;
      const mode = parts[2];
      if (parts.length > 3 || (mode && mode !== "ro" && mode !== "rw")) {
        problems.push(`${label}: volume ${raw} is not supported`);
        continue;
      }
      ro = mode === "ro";
    } else if (isTable(raw)) {
      const extra = Object.keys(raw).filter(
        (k) => !["type", "source", "target", "read_only"].includes(k),
      );
      if (extra.length || (raw.type !== "volume" && raw.type !== "bind")) {
        problems.push(`${label}: volume ${JSON.stringify(raw)} is not supported`);
        continue;
      }
      source = typeof raw.source === "string" ? raw.source : undefined;
      target = typeof raw.target === "string" ? raw.target : undefined;
      ro = raw.read_only === true;
    }
    if (!source || !target?.startsWith("/")) {
      problems.push(
        `${label}: volume ${JSON.stringify(raw)} needs a source and an absolute target`,
      );
      continue;
    }
    const mode = ro ? "ro" : "rw";
    if (named.has(source)) volumes.push({ volume: source, target, mode });
    else if (source.startsWith(".") || source.startsWith("/")) {
      const path = isAbsolute(source) ? source : resolve(envDir, source);
      if (!path.startsWith(`${resolve(envDir)}/`))
        problems.push(`${label}: bind ${source} leaves the task environment directory`);
      else if (!existsSync(path)) problems.push(`${label}: bind source ${source} not found`);
      else binds.push({ source: path, target, mode });
    } else problems.push(`${label}: volume ${source} is not declared at the top level`);
  }
  return { volumes, binds };
}

export function composeFile(envDir: string): string | null {
  for (const f of ["docker-compose.yaml", "docker-compose.yml"])
    if (existsSync(join(envDir, f))) return join(envDir, f);
  return null;
}

/**
 * `${VAR}`, `${VAR:-default}`, `${VAR-default}` and `$$` as Compose interpolates them; unknown
 * variables without a default are reported (Compose would use an empty string).
 */
export function interpolate(text: string, vars: Record<string, string>, problems: string[]) {
  return text.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, braced?: string, op?: string, def?: string, bare?: string) => {
      if (m === "$$") return "$";
      const name = (braced ?? bare) as string;
      const v = vars[name];
      if (op === ":-" && !v) return def ?? "";
      if (op === "-" && v === undefined) return def ?? "";
      if (v === undefined) {
        problems.push(`compose variable \${${name}} is not set`);
        return "";
      }
      return v;
    },
  );
}

const deepInterpolate = (v: unknown, vars: Record<string, string>, problems: string[]): unknown => {
  if (typeof v === "string") return interpolate(v, vars, problems);
  if (Array.isArray(v)) return v.map((x) => deepInterpolate(x, vars, problems));
  if (isTable(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, deepInterpolate(x, vars, problems)]),
    );
  return v;
};

/** Compose durations: `1m30s`, `5s`, `500ms`, or a number of seconds. */
export function durationSec(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v.trim()) return null;
  let total = 0;
  let rest = v.trim();
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6, ns: 1e-9 };
  while (rest) {
    const m = /^(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * (unit[m[2] as string] as number);
    rest = rest.slice(m[0].length);
  }
  return total;
}

/** Compose byte sizes (`12g`, `4096m`, `4096M`, `512mb`, bytes) in GB. */
export function sizeGB(v: unknown): number | null {
  if (typeof v === "number") return v / 1024 ** 3;
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(v.trim());
  if (!m) return null;
  const pow = { "": 0, k: 1, m: 2, g: 3, t: 4 }[(m[2] as string).toLowerCase()] as number;
  return (Number(m[1]) * 1024 ** pow) / 1024 ** 3;
}

function envOf(v: unknown, problems: string[], label: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = String(x);
      const i = s.indexOf("=");
      if (i < 0) problems.push(`${label}: environment entry ${s} without a value`);
      else out[s.slice(0, i)] = s.slice(i + 1);
    }
  } else if (isTable(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (x === null) problems.push(`${label}: environment ${k} without a value`);
      else out[k] = String(x);
    }
  }
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];

/** Compose `command`: a list, or a string split on whitespace when it has no quotes. */
function command(v: unknown, problems: string[], label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  const s = String(v);
  if (/["'\\]/.test(s)) {
    problems.push(`${label}: quoted string commands are not supported (use a list)`);
    return undefined;
  }
  return s.split(/\s+/).filter(Boolean);
}

function healthcheck(v: unknown, problems: string[], label: string): Healthcheck | undefined {
  if (!isTable(v) || v.disable === true) return undefined;
  const test = v.test;
  let cmd: string[] | null = null;
  if (typeof test === "string") cmd = ["/bin/sh", "-c", test];
  else if (Array.isArray(test) && test[0] === "CMD") cmd = test.slice(1).map(String);
  else if (Array.isArray(test) && test[0] === "CMD-SHELL")
    cmd = ["/bin/sh", "-c", String(test[1] ?? "")];
  else if (Array.isArray(test) && test[0] === "NONE") return undefined;
  if (!cmd?.length) {
    problems.push(`${label}: healthcheck test is not supported`);
    return undefined;
  }
  return {
    command: cmd,
    intervalSec: durationSec(v.interval) ?? 30,
    timeoutSec: durationSec(v.timeout) ?? 30,
    startPeriodSec: durationSec(v.start_period) ?? 0,
    retries: typeof v.retries === "number" ? v.retries : 3,
  };
}

/** `depends_on` names; only the started and healthy conditions are supported. */
function dependsOn(v: unknown, problems: string[], label: string): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (!isTable(v)) return [];
  for (const [k, c] of Object.entries(v)) {
    const cond = isTable(c) ? (c.condition ?? "service_started") : "service_started";
    if (cond !== "service_started" && cond !== "service_healthy")
      problems.push(`${label}: depends_on ${k} condition ${String(cond)} is not supported`);
  }
  return Object.keys(v);
}

const networkList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : isTable(v) ? Object.keys(v) : ["default"];

/**
 * Translate `environment/docker-compose.yaml` into Orbit services. `vars` are what Harbor
 * interpolates with (CONTEXT_DIR, CPUS, MEMORY and the task environment's variables).
 */
export function parseCompose(
  file: string,
  envDir: string,
  mainDockerfile: string | null,
  mainImage: string | null,
  vars: Record<string, string>,
  problems: string[],
  options: ComposeOptions = {},
): ComposePlan {
  const plan: ComposePlan = {
    services: [],
    networks: [],
    runNetworks: ["default"],
    dependsOn: [],
    env: {},
    workdir: null,
    volumes: [],
    mainVolumes: [],
    mainPidsLimit: null,
  };
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`docker-compose.yaml: ${(e as Error).message.split("\n")[0]}`);
    return plan;
  }
  const top = deepInterpolate(isTable(doc) ? doc : {}, vars, problems) as Table;
  for (const k of Object.keys(top))
    if (!["services", "networks", "volumes", "name", "version"].includes(k) && !k.startsWith("x-"))
      problems.push(`compose top-level ${k} is not supported`);
  const nets = isTable(top.networks) ? top.networks : {};
  for (const [name, cfg] of Object.entries(nets)) {
    const c = isTable(cfg) ? cfg : {};
    for (const k of Object.keys(c))
      if (k !== "internal") problems.push(`compose network ${name}: ${k} is not supported`);
    if (!NAME.test(name)) problems.push(`compose network name ${name} is not supported`);
    plan.networks.push({ name, internal: c.internal === true });
  }
  const vols = isTable(top.volumes) ? top.volumes : {};
  for (const [name, cfg] of Object.entries(vols)) {
    // Only plain per-project volumes: external, driver or named-elsewhere ones are shared state.
    if (isTable(cfg) && Object.keys(cfg).length)
      problems.push(`compose volume ${name}: ${Object.keys(cfg).join(", ")} is not supported`);
    if (!NAME.test(name)) problems.push(`compose volume name ${name} is not supported`);
    plan.volumes.push(name);
  }
  const named = new Set(plan.volumes);
  const services = isTable(top.services) ? top.services : {};
  for (const [name, raw] of Object.entries(services)) {
    const s = isTable(raw) ? raw : {};
    const label = `compose service ${name}`;
    if (name === "main") {
      for (const k of Object.keys(s))
        if (!MAIN_KEYS.has(k)) problems.push(`${label}: ${k} is not supported`);
      if (s.build !== undefined) {
        const b = buildOf(s.build, envDir);
        if (!mainDockerfile || b.dockerfile !== resolve(mainDockerfile))
          problems.push(`${label}: a build other than environment/Dockerfile is not supported`);
      }
      // Harbor tasks repeat their prebuilt [environment] docker_image here.
      if (s.image !== undefined && s.image !== mainImage)
        problems.push(`${label}: an image other than [environment] docker_image is not supported`);
      plan.env = envOf(s.environment, problems, label);
      plan.workdir = typeof s.working_dir === "string" ? s.working_dir : null;
      plan.dependsOn = dependsOn(s.depends_on, problems, label);
      plan.runNetworks = networkList(s.networks);
      const mv = volumesOf(s.volumes, named, envDir, problems, label);
      plan.mainVolumes = mv.volumes;
      if (mv.binds.length) problems.push(`${label}: bind mounts are not supported`);
      if (typeof s.pids_limit === "number") plan.mainPidsLimit = s.pids_limit;
      continue;
    }
    for (const k of Object.keys(s))
      if (!SERVICE_KEYS.has(k)) problems.push(`${label}: ${k} is not supported`);
    if (!NAME.test(name)) {
      problems.push(`${label}: the name is not a lowercase DNS label`);
      continue;
    }
    const svc: ServiceSpec = {
      name,
      env: envOf(s.environment, problems, label),
      dependsOn: dependsOn(s.depends_on, problems, label),
      networks: networkList(s.networks),
      init: s.init === true,
      readOnly: s.read_only === true,
      tmpfs: strings(s.tmpfs),
      capAdd: strings(s.cap_add),
      capDrop: strings(s.cap_drop),
      securityOpt: strings(s.security_opt),
      collect: [],
      ...volumesOf(s.volumes, named, envDir, problems, label),
      hostPid: false,
      hostCgroup: false,
      noNetwork: false,
    };
    if (s.restart !== undefined) {
      const r = String(s.restart);
      if (/^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(r)) svc.restart = r;
      else problems.push(`${label}: restart ${r} is not supported`);
    }
    for (const [key, field] of [
      ["pid", "hostPid"],
      ["cgroup", "hostCgroup"],
    ] as const) {
      if (s[key] === undefined) continue;
      if (s[key] !== "host") problems.push(`${label}: ${key} ${String(s[key])} is not supported`);
      else if (!options.hostNamespaces)
        problems.push(
          `${label}: ${key}: host needs the registration option -c hostNamespaces=allow (it sees every process on this machine)`,
        );
      else svc[field] = true;
    }
    if (s.network_mode !== undefined) {
      if (s.network_mode !== "none")
        problems.push(`${label}: network_mode ${String(s.network_mode)} is not supported`);
      else if (s.networks !== undefined)
        problems.push(`${label}: network_mode none with networks is not supported`);
      else {
        svc.noNetwork = true;
        svc.networks = [];
      }
    }
    if (s.build !== undefined) {
      const b = buildOf(s.build, envDir);
      if (!existsSync(b.dockerfile)) problems.push(`${label}: ${b.dockerfile} not found`);
      svc.dockerfile = b.dockerfile;
      svc.context = b.context;
    } else if (typeof s.image === "string") svc.image = s.image;
    else problems.push(`${label}: needs build or image`);
    const cmd = command(s.command, problems, label);
    if (cmd) svc.command = cmd;
    if (typeof s.working_dir === "string") svc.workdir = s.working_dir;
    const cpus = typeof s.cpus === "string" ? Number(s.cpus) : s.cpus;
    if (typeof cpus === "number" && Number.isFinite(cpus) && cpus > 0) svc.cpus = cpus;
    else if (s.cpus !== undefined)
      problems.push(`${label}: cpus ${String(s.cpus)} is not a number`);
    if (s.mem_limit !== undefined) {
      const gb = sizeGB(s.mem_limit);
      if (gb) svc.memGB = gb;
      else problems.push(`${label}: mem_limit ${String(s.mem_limit)} is not a size`);
    }
    const h = healthcheck(s.healthcheck, problems, label);
    if (h) svc.healthcheck = h;
    if (typeof s.pids_limit === "number") svc.pidsLimit = s.pids_limit;
    if (s.shm_size !== undefined) {
      const gb = sizeGB(s.shm_size);
      if (gb) svc.shmGB = gb;
      else problems.push(`${label}: shm_size ${String(s.shm_size)} is not a size`);
    }
    plan.services.push(svc);
  }
  // Compose refuses to wait for the health of a service without a health check.
  for (const [name, raw] of Object.entries(services)) {
    const d = isTable(raw) ? raw.depends_on : undefined;
    if (!isTable(d)) continue;
    for (const [dep, c] of Object.entries(d))
      if (
        isTable(c) &&
        c.condition === "service_healthy" &&
        !plan.services.find((x) => x.name === dep)?.healthcheck
      )
        problems.push(
          `compose service ${name}: depends on ${dep} being healthy, but it has no healthcheck`,
        );
  }
  return plan;
}

/** Compose `build`: a context path, or `{context, dockerfile}`; relative to the compose file. */
function buildOf(v: unknown, envDir: string): { context: string; dockerfile: string } {
  const b = isTable(v) ? v : { context: v };
  const ctx = typeof b.context === "string" ? b.context : ".";
  const context = isAbsolute(ctx) ? ctx : resolve(envDir, ctx);
  const df = typeof b.dockerfile === "string" ? b.dockerfile : "Dockerfile";
  return { context, dockerfile: isAbsolute(df) ? df : resolve(context, df) };
}
