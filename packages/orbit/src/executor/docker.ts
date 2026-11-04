import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  type Dirent,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { exec } from "../lib/exec.ts";
import type { Redactor } from "../lib/redact.ts";

export const LABEL_RUN = "orbit.run";
export const LABEL_HOME = "orbit.home";
/** Containers started by a process run (through the docker shim). */
export const LABEL_PARENT = "orbit.parent";

/** How GPUs are passed to containers: CDI devices (preferred) or the legacy `--gpus` flag. */
export type GpuMode = "cdi" | "gpus";

const CDI_DIRS = ["/etc/cdi", "/var/run/cdi"];

/** Use CDI when an NVIDIA CDI spec is installed; `--gpus` is broken on some Docker versions. */
export function detectGpuMode(dirs = CDI_DIRS): GpuMode {
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(ya?ml|json)$/.test(n)) continue;
      try {
        if (readFileSync(join(d, n), "utf8").includes("nvidia.com/gpu")) return "cdi";
      } catch {}
    }
  }
  return "gpus";
}

export interface ContainerSpec {
  name: string;
  image: string;
  /** Empty keeps the image's command. */
  command: string[];
  /** Replaces the image's ENTRYPOINT. */
  entrypoint?: string;
  labels: Record<string, string>;
  gpuIds: string[];
  gpuMode: GpuMode;
  /** Concrete device nodes assigned to this container by its role lease. */
  devices?: string[];
  /** Null: no limit (service containers without one). */
  cpus: number | null;
  memGB: number | null;
  mounts: { source: string; target: string; mode: "ro" | "rw" }[];
  env: Record<string, string>;
  /** Null keeps the image's WORKDIR. */
  workdir: string | null;
  network: "bridge" | "host" | "none";
  /** `uid:gid`, or null for the image default user. */
  user: string | null;
  /** Private `KEY=VALUE` file for secret variables, so they never appear in argv. */
  envFile?: string;
  /** Per-run networks with this container's aliases; replaces `network`. */
  networks?: { name: string; aliases: string[] }[];
  /** Default true for runs; services follow their own setting. */
  init?: boolean;
  /** A /dev/shm sized from the memory limit (runs); else Docker's default. */
  shm?: boolean;
  /** An explicit /dev/shm size. */
  shmGB?: number;
  healthcheck?: {
    command: string[];
    intervalSec: number;
    timeoutSec: number;
    startPeriodSec: number;
    retries: number;
  };
  readOnly?: boolean;
  tmpfs?: string[];
  capAdd?: string[];
  capDrop?: string[];
  securityOpt?: string[];
  pidsLimit?: number;
  /** Named volumes (already created) mounted into the container. */
  volumes?: { name: string; target: string; mode: "ro" | "rw" }[];
  /** Docker restart policy, e.g. `on-failure:6`. */
  restart?: string;
  /** Share the host's PID / cgroup namespace. */
  hostPid?: boolean;
  hostCgroup?: boolean;
}

export interface ContainerStatus {
  id: string;
  running: boolean;
  exitCode: number;
  oomKilled: boolean;
  /** `starting`, `healthy` or `unhealthy`; null without a health check. */
  health: string | null;
  gpuIds: string[];
  /** Host pid of the container's init process (0 when stopped). */
  pid: number;
}

/** Build the `docker run` argument list. Pure, for testing. */
export function runArgs(s: ContainerSpec): string[] {
  const args = ["run", "-d", ...(s.init === false ? [] : ["--init"]), "--name", s.name];
  for (const [k, v] of Object.entries(s.labels)) args.push("--label", `${k}=${v}`);
  if (s.gpuIds.length > 0 && s.gpuMode === "cdi") {
    for (const id of s.gpuIds) args.push("--device", `nvidia.com/gpu=${id}`);
  } else if (s.gpuIds.length > 0) {
    args.push("--gpus", `"device=${s.gpuIds.join(",")}"`);
  } else {
    // Hosts whose default runtime is nvidia would otherwise expose every GPU to CUDA images.
    args.push("-e", "NVIDIA_VISIBLE_DEVICES=void");
  }
  for (const device of s.devices ?? []) args.push("--device", device);
  if (s.cpus !== null) args.push("--cpus", String(s.cpus));
  if (s.memGB !== null) {
    args.push("--memory", `${Math.ceil(s.memGB * 1024)}m`);
    if (s.shm !== false)
      args.push("--shm-size", `${Math.max(1, Math.min(16, Math.floor(s.memGB / 2)))}g`);
  }
  for (const m of s.mounts) {
    args.push(
      "--mount",
      [
        "type=bind",
        csvField(`source=${m.source}`),
        csvField(`target=${m.target}`),
        ...(m.mode === "ro" ? ["readonly"] : []),
      ].join(","),
    );
  }
  for (const v of s.volumes ?? [])
    args.push(
      "--mount",
      [
        "type=volume",
        csvField(`source=${v.name}`),
        csvField(`target=${v.target}`),
        ...(v.mode === "ro" ? ["readonly"] : []),
      ].join(","),
    );
  for (const [k, v] of Object.entries(s.env)) args.push("-e", `${k}=${v}`);
  if (s.envFile) args.push("--env-file", s.envFile);
  if (s.shmGB) args.push("--shm-size", `${Math.ceil(s.shmGB * 1024)}m`);
  if (s.networks)
    for (const n of s.networks)
      args.push("--network", [`name=${n.name}`, ...n.aliases.map((a) => `alias=${a}`)].join(","));
  else if (s.network !== "bridge") args.push("--network", s.network);
  const h = s.healthcheck;
  if (h)
    args.push(
      "--health-cmd",
      shellJoin(h.command),
      "--health-interval",
      `${h.intervalSec}s`,
      "--health-timeout",
      `${h.timeoutSec}s`,
      "--health-start-period",
      `${h.startPeriodSec}s`,
      "--health-retries",
      String(h.retries),
    );
  if (s.readOnly) args.push("--read-only");
  for (const t of s.tmpfs ?? []) args.push("--tmpfs", t);
  for (const c of s.capAdd ?? []) args.push("--cap-add", c);
  for (const c of s.capDrop ?? []) args.push("--cap-drop", c);
  for (const o of s.securityOpt ?? []) args.push("--security-opt", o);
  if (s.pidsLimit) args.push("--pids-limit", String(s.pidsLimit));
  if (s.restart && s.restart !== "no") args.push("--restart", s.restart);
  if (s.hostPid) args.push("--pid", "host");
  if (s.hostCgroup) args.push("--cgroupns", "host");
  if (s.user) args.push("--user", s.user);
  if (s.workdir) args.push("-w", s.workdir);
  if (s.entrypoint) args.push("--entrypoint", s.entrypoint);
  args.push(s.image, ...s.command);
  return args;
}

/** POSIX shell words for `--health-cmd`, which Docker runs with `/bin/sh -c`. */
export const shellJoin = (argv: string[]) =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

/** `--mount` is parsed as CSV: quote a field holding a comma or a quote. */
const csvField = (f: string) => (/[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);

const deadlines = new AsyncLocalStorage<number>();
export function withDeadline<T>(deadline: number, action: () => Promise<T>): Promise<T> {
  return deadlines.run(deadline, action);
}

async function docker(args: string[], timeoutMs = 60_000) {
  const deadline = deadlines.getStore();
  if (deadline !== undefined) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("phase deadline exceeded");
    timeoutMs = Math.max(1, Math.min(timeoutMs || Infinity, left));
  }
  return exec("docker", args, { timeoutMs });
}

/**
 * Image tag for a Dockerfile build: the hash covers the Dockerfile and the build context's file list
 * (path, size, mtime), so changed context files rebuild the image.
 */
export function dockerfileTag(dockerfile: string, context: string, project: string): string {
  const h = createHash("sha256").update(readFileSync(dockerfile));
  for (const line of contextListing(context)) h.update(`${line}\n`);
  const hash = h.digest("hex").slice(0, 12);
  const name =
    project
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "") || "project";
  return `orbit-local/${name}:${hash}`;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

function contextListing(root: string, limit = 50_000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      try {
        const st = statSync(p);
        out.push(`${relative(root, p)} ${st.size} ${Math.floor(st.mtimeMs)}`);
      } catch {}
    }
  };
  walk(root);
  return out;
}

export async function imageExists(image: string): Promise<boolean> {
  return (await imageId(image)) !== null;
}

/** Content id (`sha256:…`) of a local image, or null when it is not present. */
export async function imageId(image: string): Promise<string | null> {
  const r = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** The image's configured `PATH`, or null when it sets none. */
export async function imagePath(image: string): Promise<string | null> {
  const r = await docker(["image", "inspect", "--format", "{{json .Config.Env}}", image]);
  if (r.code !== 0) return null;
  const env = (JSON.parse(r.stdout || "null") as string[] | null) ?? [];
  return env.find((e) => e.startsWith("PATH="))?.slice(5) ?? null;
}

/** Image-declared volumes are excluded from `docker commit` unless replaced by our bind mounts. */
export async function imageVolumes(image: string): Promise<string[]> {
  const r = await docker(["image", "inspect", "--format", "{{json .Config.Volumes}}", image]);
  if (r.code !== 0) throw new Error("cannot inspect image volumes for checkpoint support");
  return Object.keys((JSON.parse(r.stdout) as Record<string, unknown> | null) ?? {});
}

/** `docker run --env-file` content. Values cannot span lines in that format. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new Error(`environment value of ${k} must be a single line`);
      return `${k}=${v}\n`;
    })
    .join("");
}

/** `docker build`, streaming output to `logFile`. Resolves with the exit code. */
export function buildImage(
  dockerfile: string,
  context: string,
  tag: string,
  logFile: string,
  opts: { hostNetwork?: boolean } = {},
) {
  const net = opts.hostNetwork ? ["--network", "host"] : [];
  return spawnToLog(["build", ...net, "-f", dockerfile, "-t", tag, context], logFile);
}

/** `docker pull`, streaming progress to `logFile`. Resolves with the exit code. */
export function pullImage(image: string, logFile: string): Promise<number> {
  return spawnToLog(["pull", image], logFile);
}

function spawnToLog(args: string[], logFile: string): Promise<number> {
  const fd = openSync(logFile, "a");
  return new Promise<number>((resolve) => {
    try {
      const p = spawn("docker", args, { stdio: ["ignore", fd, fd] });
      p.on("error", () => resolve(127));
      p.on("close", (code) => resolve(code ?? 1));
    } finally {
      closeSync(fd);
    }
  });
}

export async function startContainer(spec: ContainerSpec): Promise<string> {
  const r = await docker(runArgs(spec), 300_000);
  if (r.code !== 0) {
    const line = r.stderr.split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
    throw new Error(`docker run failed: ${line.replace(/^docker: /, "").trim()}`);
  }
  return r.stdout.trim();
}

/** The container's status, null when it does not exist; throws when docker itself fails. */
export async function inspectContainer(idOrName: string): Promise<ContainerStatus | null> {
  const r = await docker(["inspect", "--type", "container", idOrName]);
  if (r.code !== 0) {
    if (/no such (object|container)/i.test(r.stderr)) return null;
    throw new Error(`docker inspect failed: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  }
  const [c] = JSON.parse(r.stdout) as {
    Id: string;
    State: {
      Running: boolean;
      ExitCode: number;
      OOMKilled: boolean;
      Pid: number;
      Health?: { Status: string } | null;
    };
    HostConfig: { DeviceRequests: { DeviceIDs: string[] | null }[] | null };
  }[];
  if (!c) return null;
  return {
    id: c.Id,
    running: c.State.Running,
    exitCode: c.State.ExitCode,
    oomKilled: c.State.OOMKilled,
    health: c.State.Health?.Status ?? null,
    pid: c.State.Pid ?? 0,
    // CDI ids look like `nvidia.com/gpu=<UUID>`; `--gpus` ids are bare UUIDs.
    gpuIds: (c.HostConfig.DeviceRequests ?? [])
      .flatMap((d) => d.DeviceIDs ?? [])
      .map((id) => id.replace(/^nvidia\.com\/gpu=/, "")),
  };
}

/** Resolves with the container exit code once it stops (or -1 if docker wait fails). */
export async function waitContainer(id: string): Promise<number> {
  const r = await exec("docker", ["wait", id], { timeoutMs: 0 });
  const code = Number.parseInt(r.stdout.trim(), 10);
  return r.code === 0 && Number.isFinite(code) ? code : -1;
}

export interface LogFollower {
  proc: ChildProcess;
  /** Resolves once the logs reached EOF and are written. */
  done: Promise<void>;
}

/**
 * Append container logs (stdout + stderr) to `logFile` from the beginning, until EOF. With a
 * redactor, known secrets are replaced before anything is written (one filter per stream, so a
 * secret split across chunks of one stream is still caught when the other interleaves).
 */
export function followLogs(id: string, logFile: string, redactor?: Redactor): LogFollower {
  if (!redactor || redactor.empty) {
    const fd = openSync(logFile, "a");
    try {
      const proc = spawn("docker", ["logs", "-f", id], { stdio: ["ignore", fd, fd] });
      return { proc, done: new Promise((r) => proc.once("close", () => r())) };
    } finally {
      closeSync(fd);
    }
  }
  const proc = spawn("docker", ["logs", "-f", id], { stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(logFile, { flags: "a" });
  const filters = [proc.stdout, proc.stderr].map((src) => {
    const f = redactor.stream();
    src?.pipe(f);
    f.on("data", (chunk) => out.write(chunk));
    return new Promise<void>((r) => f.once("end", () => r()));
  });
  const done = Promise.all(filters).then(() => new Promise<void>((r) => out.end(() => r())));
  return { proc, done };
}

export async function stopContainer(id: string, graceSec = 10): Promise<void> {
  await docker(["stop", "-t", String(graceSec), id], (graceSec + 30) * 1000);
}

/** Remove the container; resolves true when it is gone. */
export async function removeContainer(id: string): Promise<boolean> {
  const r = await docker(["rm", "-f", id]);
  if (r.code === 0) return true;
  return (await inspectContainer(id).catch(() => undefined)) === null;
}

/** Writable layer size; shared image layers and mounts are excluded. */
export async function writableSize(id: string): Promise<number> {
  const r = await docker(["container", "inspect", "--size", "--format", "{{.SizeRw}}", id]);
  const size = Number(r.stdout.trim());
  if (r.code !== 0 || !r.stdout.trim() || !Number.isSafeInteger(size) || size < 0)
    throw new Error("cannot measure container writable layer");
  return size;
}

/** A local checkpoint layer. Credentials in the original container environment are cleared. */
export async function commitCheckpoint(
  id: string,
  tag: string,
  clearEnv: string[],
  labels: Record<string, string>,
): Promise<string> {
  const changes = [
    ...clearEnv.map((key) => `ENV ${key}=`),
    ...Object.entries(labels).map(([key, value]) => `LABEL ${key}=${value}`),
  ];
  const r = await docker(["commit", ...changes.flatMap((c) => ["--change", c]), id, tag], 600_000);
  const image = r.stdout.trim();
  if (r.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("cannot commit container checkpoint");
  return image;
}

export async function removeCheckpoint(tag: string): Promise<boolean> {
  const r = await docker(["image", "rm", tag], 120_000);
  return r.code === 0 || /no such image/i.test(r.stderr);
}

/** Copy `src` out of a container to `dest` on the host; returns an error line or null. */
export async function copyFromContainer(
  id: string,
  src: string,
  dest: string,
): Promise<string | null> {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await docker(["cp", `${id}:${src}`, dest], 600_000);
  return r.code === 0 ? null : (r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
}

/**
 * Start `argv` in a running container, detached (`docker exec -d`), so it survives a daemon
 * restart; it reports through files it writes itself.
 */
export async function execDetached(
  id: string,
  argv: string[],
  env: Record<string, string>,
  envFile?: string,
): Promise<string | null> {
  const args = ["exec", "-d"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  if (envFile) args.push("--env-file", envFile);
  const r = await docker([...args, id, ...argv]);
  return r.code === 0 ? null : (r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
}

/** Run `argv` in a running container and wait; returns the exit code (-1 if docker failed). */
export async function execWait(id: string, argv: string[], timeoutMs = 60_000): Promise<number> {
  const r = await docker(["exec", id, ...argv], timeoutMs);
  return r.code;
}

/** Read a small command status from a running container. */
export async function execRead(id: string, argv: string[], timeoutMs = 10_000) {
  return docker(["exec", id, ...argv], timeoutMs);
}

/** Copy a host file or directory's contents to `dest` in a container; returns an error line or null. */
export async function copyToContainer(
  id: string,
  src: string,
  dest: string,
): Promise<string | null> {
  const dir = statSync(src, { throwIfNoEntry: false })?.isDirectory();
  // A directory's contents go into dest (created if missing), not into dest/<name>.
  if (dir && (await execWait(id, ["mkdir", "-p", dest])) !== 0) return `cannot create ${dest}`;
  const r = await docker(["cp", dir ? `${src}/.` : src, `${id}:${dest}`], 600_000);
  return r.code === 0 ? null : (r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
}

/** Names of the networks a container is attached to. */
export async function containerNetworks(id: string): Promise<string[] | null> {
  const r = await docker([
    "inspect",
    "--type",
    "container",
    "--format",
    "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
    id,
  ]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter(Boolean);
}

export async function connectNetwork(network: string, id: string): Promise<boolean> {
  return (await docker(["network", "connect", network, id])).code === 0;
}

export async function disconnectNetwork(network: string, id: string): Promise<boolean> {
  return (await docker(["network", "disconnect", network, id])).code === 0;
}

/** Create a per-run network; returns an error line or null. */
export async function createNetwork(
  name: string,
  internal: boolean,
  labels: Record<string, string>,
): Promise<string | null> {
  const args = ["network", "create", ...(internal ? ["--internal"] : [])];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  const r = await docker([...args, name]);
  return r.code === 0 ? null : (r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
}

/** Names of networks with this label, or null when docker fails. */
export async function networksWithLabel(label: string, value: string): Promise<string[] | null> {
  const r = await docker([
    "network",
    "ls",
    "--filter",
    `label=${label}=${value}`,
    "--format",
    "{{.Name}}",
  ]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter(Boolean);
}

/** Remove a network; resolves true when it is gone. */
export async function removeNetwork(name: string): Promise<boolean> {
  const r = await docker(["network", "rm", name]);
  if (r.code === 0) return true;
  return /not found|no such network/i.test(r.stderr);
}

/** Create a labelled named volume; returns an error line or null. */
export async function createVolume(
  name: string,
  labels: Record<string, string>,
): Promise<string | null> {
  const args = ["volume", "create"];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  const r = await docker([...args, name]);
  return r.code === 0 ? null : (r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
}

/** Names of volumes with this label, or null when docker fails. */
export async function volumesWithLabel(label: string, value: string): Promise<string[] | null> {
  const r = await docker(["volume", "ls", "-q", "--filter", `label=${label}=${value}`]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter(Boolean);
}

/** Remove a volume; resolves true when it is gone. */
export async function removeVolume(name: string): Promise<boolean> {
  const r = await docker(["volume", "rm", name]);
  if (r.code === 0) return true;
  return /no such volume|not found/i.test(r.stderr);
}

/** Ids of containers (running or not) with this label. */
export async function containersWithLabel(label: string, value: string): Promise<string[] | null> {
  const r = await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}=${value}`]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter(Boolean);
}

/**
 * Empty a directory with files a container created as root, from a throwaway container of `image`
 * (no network). The directory itself is left for the caller.
 */
export async function emptyDirAsRoot(dir: string, image: string): Promise<boolean> {
  const r = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "-v",
      `${dir}:/x`,
      "--entrypoint",
      "find",
      image,
      "/x",
      "-mindepth",
      "1",
      "-delete",
    ],
    { timeoutMs: 120_000 },
  );
  return r.code === 0;
}
