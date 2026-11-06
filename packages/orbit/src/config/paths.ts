import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DoctorCheck } from "../contracts/index.ts";

export const DEFAULT_PORT = 7717;

export interface OrbitPaths {
  /** Small state: database, profiles, daemon endpoint, config (`ORBIT_HOME`, default `~/.orbit`). */
  home: string;
  /**
   * Large data: run directories, bench staging and code bundles (`ORBIT_DATA`, else `dataDir` in
   * `<home>/config.json`, else `home`). Put it on a large disk.
   */
  data: string;
  /** Where `data` came from. */
  dataSource: "env" | "config" | "default";
  /** `<home>/config.json`: `{ dataDir? }`. */
  config: string;
  /** This node's name in a cluster (`ORBIT_NODE`, default: the hostname). */
  node: string;
  /** GPUs this daemon manages, by index or UUID (`ORBIT_GPUS`, comma-separated); null means all. */
  gpus: string[] | null;
  /** Daemon port on 127.0.0.1 (`ORBIT_PORT`, default 7717). */
  port: number;
  /** True when `ORBIT_PORT` chose the port: then a busy port is an error instead of a fallback. */
  portSet: boolean;
  /** JSON `{ url, token, pid }` written by the running daemon (0600). */
  daemonFile: string;
  daemonLog: string;
  db: string;
  /** Auth profiles with their secrets (0600, daemon-owned). */
  auth: string;
  /** Notification targets (0600). */
  notify: string;
  /** User Agent definitions (agents.json, 0600); built-ins live in the package. */
  agents: string;
  /** Short-lived private files such as `docker run --env-file` inputs (0700). */
  tmp: string;
  /** Registered benchmarks (benchmarks.json). */
  benchmarks: string;
  /** Per-trial staging copies mounted into bench runs: `bench/<job>/<trial>` (0700). */
  bench: string;
  /** Named datasets / weights: name -> path on this node (datasets.json). */
  datasets: string;
  /** Worker nodes registered on this (primary) node, with their tokens (0600). */
  nodes: string;
  /** This node's cluster listener: address and token (0600). */
  cluster: string;
  /** Content-addressed code bundles received from a primary: `cache/bundles/<sha256>`. */
  bundles: string;
  /** Per-run directories: `runs/<id>/{workspace,orbit/output,orbit/metrics.jsonl,log.txt,code.diff}`. */
  runs: string;
}

export interface OrbitConfig {
  /** Absolute path of the data directory. */
  dataDir?: string;
}

export function readConfig(file: string): OrbitConfig {
  if (!existsSync(file)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const dataDir = (v as OrbitConfig | null)?.dataDir;
  if (dataDir !== undefined && (typeof dataDir !== "string" || !isAbsolute(dataDir)))
    throw new Error(`${file}: dataDir must be an absolute path`);
  return dataDir ? { dataDir } : {};
}

export function writeConfig(file: string, c: OrbitConfig): void {
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

export function orbitPaths(env: NodeJS.ProcessEnv = process.env): OrbitPaths {
  const home = env.ORBIT_HOME || join(homedir(), ".orbit");
  const config = join(home, "config.json");
  if (env.ORBIT_DATA && !isAbsolute(env.ORBIT_DATA))
    throw new Error("ORBIT_DATA must be an absolute path");
  const configured = readConfig(config).dataDir;
  const data = env.ORBIT_DATA || configured || home;
  const dataSource = env.ORBIT_DATA ? "env" : configured ? "config" : "default";
  const gpus = (env.ORBIT_GPUS ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  return {
    home,
    data,
    dataSource,
    config,
    node: env.ORBIT_NODE || hostname(),
    gpus: gpus.length > 0 ? gpus : null,
    port: Number(env.ORBIT_PORT) || DEFAULT_PORT,
    portSet: Boolean(Number(env.ORBIT_PORT)),
    daemonFile: join(home, "daemon.json"),
    daemonLog: join(home, "daemon.log"),
    db: join(home, "orbit.db"),
    runs: join(data, "runs"),
    auth: join(home, "auth.json"),
    notify: join(home, "notify.json"),
    agents: join(home, "agents.json"),
    tmp: join(home, "tmp"),
    benchmarks: join(home, "benchmarks.json"),
    bench: join(data, "bench"),
    datasets: join(home, "datasets.json"),
    nodes: join(home, "nodes.json"),
    cluster: join(home, "cluster.json"),
    bundles: join(data, "cache", "bundles"),
  };
}

export function ensureHome(paths: OrbitPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
  mkdirSync(paths.bench, { recursive: true, mode: 0o700 });
  mkdirSync(paths.bundles, { recursive: true, mode: 0o700 });
}

function privatePaths(paths: OrbitPaths): { path: string; mode: number }[] {
  return [
    ...[paths.home, paths.runs, dirname(paths.bundles), paths.bundles, paths.bench, paths.tmp].map(
      (path) => ({ path, mode: 0o700 }),
    ),
    ...[
      paths.db,
      `${paths.db}-wal`,
      `${paths.db}-shm`,
      paths.auth,
      paths.notify,
      paths.nodes,
      paths.cluster,
      paths.datasets,
      paths.benchmarks,
      join(paths.home, "policies.json"),
      paths.daemonFile,
      paths.daemonLog,
      join(paths.home, "daemon.lock"),
    ].map((path) => ({ path, mode: 0o600 })),
  ];
}

class UnsafePrivatePath extends Error {}

/** Trust an owned home symlink, but never traverse a symlink inside Orbit's state roots. */
function privateTarget(paths: OrbitPaths, path: string): string {
  const home = resolve(paths.home);
  const withinHome = relative(home, resolve(path));
  const inHome = withinHome === "" || (!withinHome.startsWith("../") && withinHome !== "..");
  let root = inHome ? home : resolve(paths.data);
  const suffix = relative(root, resolve(path));
  const st = lstatSync(root);
  if (st.isSymbolicLink()) {
    if (!inHome || st.uid !== process.getuid?.())
      throw new UnsafePrivatePath(`${root}: symlink or owned by another user`);
    root = realpathSync(root);
    const target = lstatSync(root);
    if (!target.isDirectory() || target.uid !== process.getuid?.())
      throw new UnsafePrivatePath(`${root}: not an owned directory`);
  }
  let parent = root;
  for (const part of suffix.split("/").filter(Boolean).slice(0, -1)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink())
      throw new UnsafePrivatePath(`${parent}: symlink below the state root`);
  }
  return join(root, suffix);
}

/** Only Orbit's own top-level state paths, never the contents of runs or a shared data root. */
export function tightenPrivateState(paths: OrbitPaths, log = console.error): void {
  for (const { path, mode } of privatePaths(paths)) {
    try {
      const target = privateTarget(paths, path);
      const st = lstatSync(target);
      if (st.isSymbolicLink() || st.uid !== process.getuid?.()) {
        log(
          `orbit permissions: skipped ${path} (symlink or owned by another user); run orbit doctor`,
        );
        continue;
      }
      const before = st.mode & 0o7777;
      if (before === mode) continue;
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (opened.uid !== st.uid || opened.ino !== st.ino || opened.dev !== st.dev) {
          log(`orbit permissions: skipped ${path} (changed while checking); run orbit doctor`);
          continue;
        }
        fchmodSync(fd, mode);
      } finally {
        closeSync(fd);
      }
      log(`orbit permissions: ${path} ${before.toString(8)} -> ${mode.toString(8)}`);
    } catch (e) {
      if (e instanceof UnsafePrivatePath) {
        log(`orbit permissions: skipped ${path} (${e.message}); run orbit doctor`);
        continue;
      }
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ELOOP") throw e;
      log(`orbit permissions: cannot tighten ${path} (${code}); run orbit doctor`);
    }
  }
}

export function privateStateCheck(paths: OrbitPaths): DoctorCheck {
  const warnings: string[] = [];
  for (const { path, mode } of privatePaths(paths)) {
    try {
      const st = lstatSync(privateTarget(paths, path));
      if (st.isSymbolicLink() || st.uid !== process.getuid?.())
        warnings.push(`${path}: symlink or owned by another user`);
      else if ((st.mode & 0o7777) !== mode)
        warnings.push(
          `${path}: mode ${(st.mode & 0o7777).toString(8)}, expected ${mode.toString(8)}`,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${path}: ${(e as Error).message}`);
    }
  }
  return {
    name: "private state",
    ok: true,
    warn: warnings.length > 0,
    detail: warnings.join("; ") || "Orbit directories are 0700; private state files are 0600",
  };
}

export interface RunDirs {
  root: string;
  /** Code snapshot, mounted at /workspace. */
  workspace: string;
  /** Mounted at /orbit; holds output/ and metrics.jsonl. */
  orbit: string;
  output: string;
  metrics: string;
  log: string;
  diff: string;
  /** Agent CLI homes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) under /orbit/agent; kept with the run. */
  agent: string;
}

export function runDirs(paths: OrbitPaths, runId: string): RunDirs {
  const root = join(paths.runs, runId);
  const orbit = join(root, "orbit");
  return {
    root,
    workspace: join(root, "workspace"),
    orbit,
    output: join(orbit, "output"),
    metrics: join(orbit, "metrics.jsonl"),
    log: join(root, "log.txt"),
    diff: join(root, "code.diff"),
    agent: join(orbit, "agent"),
  };
}

/** Whether a directory is on the same filesystem as `/` (where a full disk takes the system down). */
export function onSystemDisk(dir: string): boolean {
  try {
    return statSync(dir).dev === statSync("/").dev;
  } catch {
    return false;
  }
}
