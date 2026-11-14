import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { OrbitPaths } from "../config/paths.ts";
import {
  type AdapterTasksResponse,
  type BenchJob,
  type Benchmark,
  BenchSplitManifest,
  type BenchSplitRequest,
  type BenchSplitResult,
  type BenchTask,
  parseTaskFile,
  TASK_FILE_MAX_BYTES,
  type TaskBenchmark,
  type TaskFileInput,
  type TaskFileRecord,
  TaskFileTasks,
  type TaskPartition,
  taskSuite,
} from "../contracts/index.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { UserError } from "../runs/errors.ts";
import { benchIdentity } from "./catalog.ts";
import { loadResources } from "./resources.ts";
import { executionCapabilities, stableDigest } from "./revision.ts";
import { contentDigest } from "./samples.ts";

export function taskBenchmark(
  b: Benchmark,
  info: AdapterTasksResponse,
  source: BenchJob["source"],
): TaskBenchmark {
  const identity = benchIdentity(b, info.capabilities ?? null).identity;
  const { identity: _identity, ...capabilities } = executionCapabilities(info.capabilities) ?? {};
  return {
    registration: b.name,
    identity: {
      id: identity.id,
      version: identity.version ?? null,
      variant: identity.variant ?? null,
    },
    source: source ? { commit: source.commit, dirty: source.dirty } : null,
    settingsSha256: contentDigest({
      adapter: b.adapter,
      path: b.path,
      config: b.config,
      env: b.env,
      passEnv: [...b.passEnv].sort(),
      resources: b.resources ? loadResources(b.resources) : null,
      capabilities,
      official: info.official ?? null,
    }).slice(7),
  };
}

const parts: TaskPartition[] = ["evolve", "gate", "final"];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const taskSetDigest = (ids: Iterable<string>) =>
  stableDigest([...new Set(ids)].sort(compare));
export const fileSha256 = (content: string) => createHash("sha256").update(content).digest("hex");
export const taskListingDigest = (tasks: BenchTask[]) =>
  contentDigest(
    tasks
      .filter((t) => t.supported)
      .map((t) => ({ id: t.id, suite: taskSuite(t) }))
      .sort((a, b) => compare(a.id, b.id)),
  ).slice(7);

/** Largest-remainder totals, followed by suite quotas without changing the global totals. */
export function splitTasks(
  tasks: BenchTask[],
  request: BenchSplitRequest,
  benchmark: TaskBenchmark,
): { manifest: BenchSplitManifest; content: Record<TaskPartition, string> } {
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
    throw new UserError("benchmark lists duplicate task IDs");
  const supported = tasks.filter((t) => t.supported);
  const ids = TaskFileTasks.parse(supported.map((t) => t.id));
  const rank = (value: unknown) => contentDigest([request.seed, value]);
  const totals = parts.map((p) => Math.floor(ids.length * request[p]));
  const remainder = ids.length - totals.reduce((a, b) => a + b, 0);
  const order = parts
    .map((p, i) => ({ i, fraction: ids.length * request[p] - (totals[i] ?? 0), tie: rank(p) }))
    .sort((a, b) => b.fraction - a.fraction || compare(a.tie, b.tie));
  for (const item of order.slice(0, remainder)) totals[item.i] = (totals[item.i] ?? 0) + 1;
  const buckets = new Map<string, string[]>();
  for (const t of supported) {
    const suite = request.stratify ? taskSuite(t) : "";
    const bucket = buckets.get(suite) ?? [];
    bucket.push(t.id);
    buckets.set(suite, bucket);
  }
  const groups = [...buckets]
    .sort(([a], [b]) => compare(a, b))
    .map(([suite, own]) => ({
      suite,
      ids: own
        .map((id) => ({ id, rank: rank([suite, id]) }))
        .sort((a, b) => compare(a.rank, b.rank) || compare(a.id, b.id))
        .map((item) => item.id),
      counts: parts.map((p) => Math.floor(own.length * request[p])),
    }));
  const needs = totals.map(
    (total, i) => total - groups.reduce((n, g) => n + (g.counts[i] ?? 0), 0),
  );
  const remaining = groups.map((g) => g.ids.length - g.counts.reduce((a, b) => a + b, 0));
  const cells = groups
    .flatMap((g, row) =>
      parts.map((p, column) => ({
        row,
        column,
        fraction: g.ids.length * request[p] - (g.counts[column] ?? 0),
        tie: rank([g.suite, p]),
      })),
    )
    .sort((a, b) => b.fraction - a.fraction || compare(a.tie, b.tie));
  const assign = (row: number, column: number) => {
    const g = groups[row];
    if (!g || !(remaining[row] ?? 0) || !(needs[column] ?? 0)) return;
    g.counts[column] = (g.counts[column] ?? 0) + 1;
    remaining[row] = (remaining[row] ?? 0) - 1;
    needs[column] = (needs[column] ?? 0) - 1;
  };
  for (const cell of cells) assign(cell.row, cell.column);
  for (const [row] of groups.entries())
    for (const column of order.map((x) => x.i))
      while ((remaining[row] ?? 0) > 0 && (needs[column] ?? 0) > 0) assign(row, column);
  const selected: Record<TaskPartition, string[]> = { evolve: [], gate: [], final: [] };
  for (const g of groups) {
    let offset = 0;
    for (const [column, p] of parts.entries()) {
      const count = g.counts[column] ?? 0;
      selected[p].push(...g.ids.slice(offset, offset + count));
      offset += count;
    }
  }
  const content = Object.fromEntries(
    parts.map((p) => [p, selected[p].sort(compare).join("\n") + (selected[p].length ? "\n" : "")]),
  ) as Record<TaskPartition, string>;
  if (parts.some((p) => Buffer.byteLength(content[p]) > TASK_FILE_MAX_BYTES))
    throw new UserError("task file exceeds 8 MiB; use fewer tasks");
  const manifest = BenchSplitManifest.parse({
    version: 1,
    algorithm: "sha256-stratified-v1",
    benchmark,
    seed: request.seed,
    proportions: { evolve: request.evolve, gate: request.gate, final: request.final },
    stratify: request.stratify ?? null,
    population: {
      count: ids.length,
      taskSet: taskSetDigest(ids),
      listingSha256: taskListingDigest(tasks),
    },
    unsupported: tasks.length - ids.length,
    files: Object.fromEntries(
      parts.map((p) => [
        p,
        {
          path: `${p}.txt`,
          sha256: fileSha256(content[p]),
          taskSet: taskSetDigest(selected[p]),
          count: selected[p].length,
        },
      ]),
    ),
  });
  return { manifest, content };
}

/** Check the exact client-side bytes and frozen provenance before any trials are created. */
export function resolveTaskFile(
  input: TaskFileInput,
  tasks: string[],
  all: BenchTask[],
  benchmark: TaskBenchmark,
): { tasks: string[]; record: TaskFileRecord } {
  if (Buffer.byteLength(input.content) > TASK_FILE_MAX_BYTES)
    throw new UserError("task file exceeds 8 MiB");
  if (fileSha256(input.content) !== input.sha256) throw new UserError("task file SHA-256 mismatch");
  const ids = parseTaskFile(input.content);
  if (tasks.length && taskSetDigest(tasks) !== taskSetDigest(ids))
    throw new UserError("task file and submitted task set differ");
  if (input.frozen) {
    const { manifest, partition } = input.frozen;
    const expected = manifest.files[partition];
    if (
      expected.sha256 !== input.sha256 ||
      expected.taskSet !== taskSetDigest(ids) ||
      expected.count !== ids.length
    )
      throw new UserError("task file differs from the frozen split; create a new split");
    if (contentDigest(manifest.benchmark) !== contentDigest(benchmark))
      throw new UserError("benchmark identity, version or settings differ from the frozen split");
    if (
      manifest.population.taskSet !==
        taskSetDigest(all.filter((t) => t.supported).map((t) => t.id)) ||
      manifest.population.listingSha256 !== taskListingDigest(all)
    )
      throw new UserError("benchmark task listing differs from the frozen split");
    const regenerated = splitTasks(
      all,
      {
        ...manifest.proportions,
        seed: manifest.seed,
        stratify: manifest.stratify ?? undefined,
        out: "/",
      },
      benchmark,
    );
    if (contentDigest(regenerated.manifest.files) !== contentDigest(manifest.files))
      throw new UserError("frozen split does not match its seed, proportions or suite allocation");
  }
  return {
    tasks: ids,
    record: { sha256: input.sha256, ...(input.frozen ? { frozen: input.frozen } : {}) },
  };
}

export async function writeTaskSplit(
  paths: OrbitPaths,
  request: BenchSplitRequest,
  value: ReturnType<typeof splitTasks>,
): Promise<BenchSplitResult> {
  if (!isAbsolute(request.out))
    throw new UserError("split output must be an absolute path on the daemon host");
  const out = join(await realpath(dirname(resolve(request.out))), basename(resolve(request.out)));
  for (const root of [paths.home, paths.data]) {
    const actual = await realpath(root).catch(() => resolve(root));
    if (out === actual || out.startsWith(actual + sep))
      throw new UserError("write task sets outside Orbit's home and data directories");
  }
  if (
    await lstat(out).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    })
  )
    throw new UserError("split output already exists; choose a new directory");
  const stage = await mkdtemp(join(dirname(out), ".orbit-task-split-"));
  let reserved = false;
  let published = false;
  try {
    for (const p of parts)
      await writeFile(join(stage, `${p}.txt`), value.content[p], { mode: 0o600, flag: "wx" });
    writePrivateJson(join(stage, "split.json"), value.manifest);
    await mkdir(out, { mode: 0o700 });
    reserved = true;
    await rename(stage, out);
    published = true;
    return { out, manifest: value.manifest };
  } finally {
    if (!published) {
      await rm(stage, { recursive: true, force: true });
      if (reserved) await rmdir(out).catch(() => {});
    }
  }
}
