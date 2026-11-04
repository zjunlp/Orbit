import { constants } from "node:fs";
import { access, readdir, readFile, stat, statfs } from "node:fs/promises";
import { availableParallelism, hostname, loadavg } from "node:os";
import { join } from "node:path";
import type { Gpu, GpuProcess, NodeDevice, NodeResources } from "../contracts/index.ts";
import { exec } from "../lib/exec.ts";
import { type ComputeApp, describeProcesses, parseComputeApps } from "./gpu-procs.ts";

/** A GPU is busy when processes outside Orbit hold more than this much memory. */
export const EXTERNAL_BUSY_MIB = 1024;

const GIB = 1024 ** 3;
/** Measured CPU use rises at once but falls with this time constant, so a brief dip does not admit runs. */
const CPU_FALL_S = 30;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface RawGpu {
  index: number;
  uuid: string;
  name: string;
  memTotalMiB: number;
  memUsedMiB: number;
  utilPct: number | null;
}

function num(s: string | undefined): number | null {
  const n = Number(s?.trim());
  return s === undefined || Number.isNaN(n) ? null : n;
}

/** Parse `nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu`. */
export function parseGpuCsv(csv: string): RawGpu[] {
  return csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, uuid, name, total, used, util] = line.split(",").map((f) => f.trim());
      const idx = num(index);
      const memTotal = num(total);
      if (idx === null || !uuid || memTotal === null) {
        throw new Error(`unexpected nvidia-smi line: ${line}`);
      }
      return {
        index: idx,
        uuid,
        name: name ?? "",
        memTotalMiB: memTotal,
        memUsedMiB: num(used) ?? 0,
        utilPct: num(util),
      };
    });
}

/**
 * Combine per-GPU memory with its compute processes. All usage counts as external; the allocator
 * handles GPUs held by Orbit leases separately.
 */
export function classifyGpus(
  raw: RawGpu[],
  apps: ComputeApp[],
  described: Map<number, GpuProcess> = new Map(),
): Gpu[] {
  return raw.map((g) => {
    const mine = apps.filter((a) => a.uuid === g.uuid);
    // Some drivers (e.g. in containers) hide processes; fall back to total used memory.
    const external = mine.length ? mine.reduce((n, a) => n + a.memMiB, 0) : g.memUsedMiB;
    const processes = mine
      .map((a) => ({
        ...(described.get(a.pid) ?? {
          pid: a.pid,
          user: null,
          command: null,
          startedAt: null,
          container: null,
          runId: null,
        }),
        memMiB: a.memMiB,
      }))
      .sort((x, y) => y.memMiB - x.memMiB);
    return { ...g, externalMemMiB: external, available: external < EXTERNAL_BUSY_MIB, processes };
  });
}

/** Parse `/proc/meminfo` into GB totals. */
export function parseMeminfo(text: string): { totalGB: number; availableGB: number } {
  const kb = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
    return m?.[1] ? (Number(m[1]) * 1024) / GIB : 0;
  };
  return { totalGB: round1(kb("MemTotal")), availableGB: round1(kb("MemAvailable")) };
}

async function probeGpus(): Promise<{ gpus: Gpu[]; error: string | null }> {
  const q = await exec("nvidia-smi", [
    "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (q.code !== 0) return { gpus: [], error: q.stderr.trim() || `nvidia-smi exited ${q.code}` };
  const apps = await exec("nvidia-smi", [
    "--query-compute-apps=gpu_uuid,pid,used_memory",
    "--format=csv,noheader,nounits",
  ]);
  try {
    const rows = apps.code === 0 ? parseComputeApps(apps.stdout) : [];
    const described = await describeProcesses(rows).catch(() => new Map<number, GpuProcess>());
    return { gpus: classifyGpus(parseGpuCsv(q.stdout), rows, described), error: null };
  } catch (e) {
    return { gpus: [], error: (e as Error).message };
  }
}

/** Keep only the GPUs named by index or UUID (`ORBIT_GPUS`); null keeps all. */
export function filterGpus<T extends { index: number; uuid: string }>(
  gpus: T[],
  only: string[] | null,
): T[] {
  if (!only) return gpus;
  return gpus.filter((g) => only.includes(String(g.index)) || only.includes(g.uuid));
}

/** Busy and total jiffies from the aggregate `cpu` line of /proc/stat (idle includes iowait). */
export function parseProcStat(text: string): { busy: number; total: number } | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  // user nice system idle iowait irq softirq steal (guest time is already in user/nice)
  const f = line?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!f || f.length < 5 || f.some(Number.isNaN)) return null;
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - (f[3] ?? 0) - (f[4] ?? 0), total };
}

/** Turns successive /proc/stat samples into "CPUs in use": fast to rise, slow to fall. */
export class CpuMeter {
  private last: { at: number; busy: number; total: number } | null = null;
  private value: number | null = null;

  /** `fallback` (the load average) is used until two samples are at least a second apart. */
  sample(
    stat: { busy: number; total: number } | null,
    count: number,
    fallback: number,
    at = Date.now(),
  ): number {
    if (!stat) return this.value ?? Math.min(fallback, count);
    if (!this.last || stat.total < this.last.total) {
      this.last = { at, ...stat };
      return this.value ?? Math.min(fallback, count);
    }
    const dt = (at - this.last.at) / 1000;
    if (dt < 1) return this.value ?? Math.min(fallback, count);
    const dTotal = stat.total - this.last.total;
    const now = dTotal > 0 ? (count * (stat.busy - this.last.busy)) / dTotal : 0;
    const prev = this.value ?? now;
    this.value = now >= prev ? now : prev + (now - prev) * (1 - Math.exp(-dt / CPU_FALL_S));
    this.last = { at, ...stat };
    return this.value;
  }
}

type DeviceProbe = {
  readDir: (path: string) => Promise<string[]>;
  readWrite: (path: string) => Promise<void>;
  adb: () => Promise<{ code: number; stderr: string }>;
};

/** Non-root checks; unavailable capabilities remain visible with a diagnostic. */
export async function probeDevices(overrides: Partial<DeviceProbe> = {}): Promise<NodeDevice[]> {
  const probe: DeviceProbe = {
    readDir: (path) => readdir(path),
    readWrite: async (path) => {
      await access(path, constants.R_OK | constants.W_OK);
      if (!(await stat(path)).isCharacterDevice()) throw new Error("not a character device");
    },
    adb: () => exec("adb", ["version"], { timeoutMs: 3000 }),
    ...overrides,
  };
  const reason = (e: unknown) =>
    e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.message) : String(e);
  const nodes = async (cls: string, paths: string[], exclusive = false): Promise<NodeDevice> => {
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          await probe.readWrite(path);
          return { path, error: null };
        } catch (e) {
          return { path, error: reason(e) };
        }
      }),
    );
    const available = results.filter((r) => r.error === null).map((r) => r.path);
    const errors = results.filter((r) => r.error !== null).map((r) => `${r.path}: ${r.error}`);
    return {
      class: cls,
      count: available.length,
      exclusive,
      paths: available,
      detail: [...available, ...errors].join("; ") || "no matching device nodes",
    };
  };
  const directory = async (cls: string, dir: string, pattern: RegExp, exclusive = false) => {
    try {
      return await nodes(
        cls,
        (await probe.readDir(dir))
          .filter((p) => pattern.test(p))
          .sort()
          .map((p) => join(dir, p)),
        exclusive,
      );
    } catch (e) {
      return { class: cls, count: 0, exclusive, paths: [], detail: `${dir}: ${reason(e)}` };
    }
  };
  const android = async (): Promise<NodeDevice> => {
    try {
      const result = await probe.adb();
      return {
        class: "android",
        count: result.code === 0 ? 1 : 0,
        exclusive: true,
        paths: [],
        detail:
          result.code === 0
            ? "adb available (capability only; attached devices not probed)"
            : `adb unavailable: ${result.stderr.trim() || `exit ${result.code}`}`,
      };
    } catch (e) {
      return {
        class: "android",
        count: 0,
        exclusive: true,
        paths: [],
        detail: `adb: ${reason(e)}`,
      };
    }
  };
  return Promise.all([
    nodes("kvm", ["/dev/kvm"]),
    directory("dri", "/dev/dri", /^renderD\d+$/),
    nodes("net-tun", ["/dev/net/tun"]),
    android(),
    directory("serial", "/dev", /^tty(?:USB|ACM)\d+$/),
  ]);
}

/** One meter per process: every daemon in it measures the same machine. */
const cpuMeter = new CpuMeter();

export async function probeNode(
  diskPath: string,
  opts: { node?: string; gpus?: string[] | null } = {},
): Promise<NodeResources> {
  const [gpu, meminfo, fs, stat, devices] = await Promise.all([
    probeGpus(),
    readFile("/proc/meminfo", "utf8"),
    statfs(diskPath),
    readFile("/proc/stat", "utf8").catch(() => ""),
    probeDevices(),
  ]);
  const count = availableParallelism();
  const load1 = loadavg()[0] ?? 0;
  return {
    node: opts.node ?? hostname(),
    probedAt: new Date().toISOString(),
    gpus: filterGpus(gpu.gpus, opts.gpus ?? null),
    gpuError: gpu.error,
    devices,
    cpu: {
      count,
      load1: round1(load1),
      busy: round1(cpuMeter.sample(parseProcStat(stat), count, load1)),
    },
    memory: parseMeminfo(meminfo),
    disk: {
      path: diskPath,
      totalGB: round1((fs.blocks * fs.bsize) / GIB),
      freeGB: round1((fs.bavail * fs.bsize) / GIB),
    },
  };
}
