// Synthetic adapter fixtures; real subprocess listing, store, filesystem, API and CLI. Trial execution is paused.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { methodLines } from "../src/bench/hub.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { stableDigest } from "../src/bench/revision.ts";
import { BenchService } from "../src/bench/service.ts";
import { fileSha256, resolveTaskFile, splitTasks, taskSetDigest } from "../src/bench/task-sets.ts";
import { registerBench } from "../src/cli/bench.ts";
import { readTaskFile } from "../src/cli/task-file.ts";
import { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import {
  BenchJob,
  BenchSplitManifest,
  BenchSplitRequest,
  type BenchTask,
  parseTaskFile,
  type TaskBenchmark,
} from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const tasks = (sizes = [10, 10, 10]): BenchTask[] =>
  sizes.flatMap((n, suite) =>
    Array.from({ length: n }, (_, index) => ({
      id: `suite-${suite}/${index}`,
      title: null,
      supported: true,
      reason: null,
      tags: { suite: `suite-${suite}` },
    })),
  );
const fingerprint: TaskBenchmark = {
  registration: "fixture",
  identity: { id: "fixture", version: "1", variant: null },
  source: null,
  settingsSha256: "a".repeat(64),
};
const request = (fields = {}) =>
  BenchSplitRequest.parse({
    evolve: 0.6,
    gate: 0.2,
    final: 0.2,
    seed: 42,
    out: "/unused",
    ...fields,
  });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orbit-task-sets-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = orbitPaths({ ORBIT_HOME: join(root, "home") });
  ensureHome(paths);
  const source = join(root, "checkout");
  mkdirSync(source);
  const catalogue = [
    ...tasks(),
    { id: "unsupported", title: null, supported: false, reason: "fixture restriction", tags: {} },
  ];
  writeFileSync(join(source, "catalog.json"), JSON.stringify(catalogue));
  const adapter = join(root, "adapter.mjs");
  writeFileSync(
    adapter,
    `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconst r=JSON.parse(readFileSync(0,'utf8'));\nconsole.log(JSON.stringify(r.op==='tasks'?{tasks:JSON.parse(readFileSync(r.benchmark.path+'/catalog.json','utf8'))}:{spec:{backend:'process',command:['true']}}));\n`,
    { mode: 0o700 },
  );
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({
    name: "fixture",
    path: source,
    adapter,
    labels: { identity: { id: "fixture", name: "Development fixture", version: "1" } },
  });
  const store = new Store(paths.db);
  cleanups.push(() => store.close());
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const bench = new BenchService({ store, paths, runs, registry });
  bench.stop();
  const app = createApp({
    token: "fixture",
    paths,
    runs,
    bench,
    store,
    benchmarks: registry,
    webDir: null,
  } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  const client = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
  const out = join(root, "split");
  const split = () => client.benchSplit("fixture", request({ out, stratify: "suite" }));
  const submit = (fields = {}) =>
    client.benchSubmit({
      benchmark: "fixture",
      methods: [{ name: "empty", agent: "empty" }],
      ...fields,
    });
  return { root, paths, source, registry, store, runs, bench, app, client, out, split, submit };
}

describe("deterministic task splits", () => {
  it.each([undefined, "suite"])(
    "ignores listing order and output path, with %s stratification",
    (stratify) => {
      const a = splitTasks(tasks(), request({ stratify }), fingerprint);
      const b = splitTasks(tasks().reverse(), request({ stratify, out: "/another" }), fingerprint);
      expect(b).toEqual(a);
      const sets = Object.values(a.content).map(parseTaskFile);
      expect(sets.map((ids) => ids.length)).toEqual([18, 6, 6]);
      expect(new Set(sets.flat()).size).toBe(30);
      expect(sets.flat().sort()).toEqual(
        tasks()
          .map((t) => t.id)
          .sort(),
      );
      expect(splitTasks(tasks(), request({ stratify, seed: 43 }), fingerprint).content).not.toEqual(
        a.content,
      );
      for (const part of ["evolve", "gate", "final"] as const)
        expect(fileSha256(a.content[part])).toBe(a.manifest.files[part].sha256);
    },
  );
  it("stratifies suites and preserves global counts even with many tiny suites", () => {
    const split = splitTasks(tasks(), request({ stratify: "suite" }), fingerprint);
    for (const ids of Object.values(split.content).map(parseTaskFile)) {
      const counts = new Set(
        [0, 1, 2].map((s) => ids.filter((id) => id.startsWith(`suite-${s}/`)).length),
      );
      expect(counts.size).toBe(1);
    }
    for (let seed = 0; seed < 20; seed++) {
      const tiny = splitTasks(
        tasks(Array(17).fill(1)),
        request({ stratify: "suite", seed }),
        fingerprint,
      );
      expect(
        Object.values(tiny.manifest.files)
          .map((file) => file.count)
          .sort((a, b) => b - a),
      ).toEqual([10, 4, 3]);
      expect(new Set(Object.values(tiny.content).flatMap(parseTaskFile)).size).toBe(17);
    }
  });
  it("accepts zero proportions, rejects invalid ratios and unsafe task IDs", () => {
    const all = splitTasks(tasks(), request({ evolve: 1, gate: 0, final: 0 }), fingerprint);
    expect(all.content.gate).toBe("");
    expect(all.content.final).toBe("");
    for (const values of [{ evolve: 0.7 }, { gate: -0.1 }, { seed: 1.5 }, { stratify: "unknown" }])
      expect(() => request(values)).toThrow();
    const duplicate = [...tasks(), ...tasks()];
    expect(() => splitTasks(duplicate, request(), fingerprint)).toThrow(/duplicate/);
    const unsafe = tasks();
    const first = unsafe[0];
    assert(first);
    first.id = "bad\nid";
    expect(() => splitTasks(unsafe, request(), fingerprint)).toThrow(/one line/);
    expect(() => splitTasks([], request(), fingerprint)).toThrow();
  });
  it("uses the existing order-insensitive task-set digest", () => {
    expect(taskSetDigest(["b", "a"])).toBe(stableDigest(["a", "b"]));
    expect(taskSetDigest(["a", "b"])).toBe(taskSetDigest(["b", "a"]));
    expect(parseTaskFile("\uFEFFa\r\n\n b\r\n")).toEqual(["a", "b"]);
    expect(() => parseTaskFile("a\na\n")).toThrow(/duplicate/);
    expect(() => parseTaskFile("\n")).toThrow();
  });
});

describe("frozen task files", () => {
  it("writes a portable manifest without storing task-set entities and records jobs durably", async () => {
    const f = fixture();
    const saved = await f.split();
    const manifest = BenchSplitManifest.parse(
      JSON.parse(readFileSync(join(f.out, "split.json"), "utf8")),
    );
    expect(manifest).toEqual(saved.manifest);
    expect(manifest.benchmark.identity).toMatchObject({ id: "fixture", version: "1" });
    expect(manifest.unsupported).toBe(1);
    expect(f.store.listJobs(100)).toEqual([]);
    expect(readdirSync(f.out).sort()).toEqual([
      "evolve.txt",
      "final.txt",
      "gate.txt",
      "split.json",
    ]);
    for (const file of Object.values(manifest.files))
      expect(statSync(join(f.out, file.path)).mode & 0o777).toBe(0o600);
    const selected = readTaskFile(join(f.out, "gate.txt"));
    const job = await f.submit(selected);
    expect(job.taskSet).toBe(manifest.files.gate.taskSet);
    expect(job.taskFile).toMatchObject({
      sha256: manifest.files.gate.sha256,
      frozen: { partition: "gate" },
    });
    expect(job.spec).not.toHaveProperty("tasksFile");
    expect(
      f.store
        .trials(job.id)
        .map((t) => t.task)
        .sort(),
    ).toEqual(selected.tasks.sort());
    rmSync(f.out, { recursive: true });
    expect(f.store.getJob(job.id)?.taskSet).toBe(manifest.files.gate.taskSet);
    const reopened = new Store(f.paths.db);
    try {
      expect(reopened.getJob(job.id)?.taskFile).toEqual(job.taskFile);
    } finally {
      reopened.close();
    }
  });
  it("rejects tampered bytes, selection digests and split metadata before creating jobs", async () => {
    const f = fixture();
    await f.split();
    const selected = readTaskFile(join(f.out, "gate.txt"));
    await expect(
      f.submit({ ...selected, tasksFile: { ...selected.tasksFile, sha256: "b".repeat(64) } }),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(f.submit({ ...selected, tasks: ["suite-0/0"] })).rejects.toThrow(
      /submitted task set/,
    );
    await expect(f.submit({ ...selected, taskSet: "000000000000" })).rejects.toThrow(/digest/);
    const manifest = structuredClone(selected.tasksFile.frozen?.manifest);
    assert(manifest);
    manifest.files.gate.taskSet = "000000000000";
    await expect(
      f.submit({
        ...selected,
        tasksFile: { ...selected.tasksFile, frozen: { partition: "gate", manifest } },
      }),
    ).rejects.toThrow(/frozen split/);
    const changedSeed = structuredClone(selected.tasksFile.frozen?.manifest);
    assert(changedSeed);
    changedSeed.seed += 1;
    await expect(
      f.submit({
        ...selected,
        tasksFile: { ...selected.tasksFile, frozen: { partition: "gate", manifest: changedSeed } },
      }),
    ).rejects.toThrow(/seed, proportions/);
    writeFileSync(join(f.out, "gate.txt"), "suite-0/0\n");
    expect(() => readTaskFile(join(f.out, "gate.txt"))).toThrow(/differs from split.json/);
    expect(f.store.listJobs(100)).toEqual([]);
  });
  it("rejects changed benchmark versions, execution settings and task populations", async () => {
    const f = fixture();
    await f.split();
    const selected = readTaskFile(join(f.out, "gate.txt"));
    const b = f.registry.get("fixture");
    assert(b);
    f.registry.put({
      ...b,
      labels: { identity: { id: "fixture", name: "Fixture", version: "2" } },
    });
    await expect(f.submit(selected)).rejects.toThrow(/identity, version or settings/);
    f.registry.put({ ...b, config: { changed: "yes" } });
    await expect(f.submit(selected)).rejects.toThrow(/identity, version or settings/);
    f.registry.put(b);
    writeFileSync(join(f.source, "catalog.json"), JSON.stringify(tasks([11, 10, 10])));
    await expect(f.submit(selected)).rejects.toThrow(/task listing/);
    expect(f.store.listJobs(100)).toEqual([]);
  });
  it("supports plain UTF-8 files and saves digests for direct/default selections", async () => {
    const f = fixture();
    const file = join(f.root, "plain.txt");
    writeFileSync(file, "\uFEFFsuite-0/1\r\nsuite-1/1\r\n");
    const selected = readTaskFile(file);
    const plain = await f.submit(selected);
    expect(plain.taskFile?.sha256).toBe(fileSha256(selected.tasksFile.content));
    expect(plain.taskFile?.frozen).toBeUndefined();
    const direct = await f.submit({ tasks: ["suite-1/1", "suite-0/1"] });
    expect(direct.taskSet).toBe(plain.taskSet);
    const defaults = await f.submit();
    expect(defaults.taskSet).toBe(taskSetDigest(tasks().map((t) => t.id)));
    await expect(f.submit({ tasks: ["suite-0/1", "suite-0/1"] })).rejects.toThrow(/duplicate/);
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => readTaskFile(file)).toThrow();
    truncateSync(file, 8 * 1024 * 1024 + 1);
    expect(() => readTaskFile(file)).toThrow(/exceeds/);
  });
  it("refuses existing destinations and symlinks into Orbit state", async () => {
    const f = fixture();
    await f.split();
    const original = readFileSync(join(f.out, "split.json"), "utf8");
    await expect(f.split()).rejects.toThrow(/already exists/);
    expect(readFileSync(join(f.out, "split.json"), "utf8")).toBe(original);
    symlinkSync(f.paths.home, join(f.root, "home-link"));
    await expect(
      f.client.benchSplit("fixture", request({ out: join(f.root, "home-link", "split") })),
    ).rejects.toThrow(/outside Orbit/);
    expect(readdirSync(f.root).filter((p) => p.startsWith(".orbit-task-split-"))).toEqual([]);
  });
  it("passes split and frozen run options through the actual CLI and rejects -t conflicts", async () => {
    const f = fixture();
    const print = vi.fn();
    const program = () => {
      const command = new Command();
      registerBench(command, async () => f.client, print);
      return command;
    };
    await program().parseAsync(
      [
        "bench",
        "split",
        "fixture",
        "--evolve",
        "0.6",
        "--gate",
        "0.2",
        "--final",
        "0.2",
        "--seed",
        "42",
        "--stratify",
        "suite",
        "--out",
        f.out,
        "--json",
      ],
      { from: "user" },
    );
    const file = join(f.out, "evolve.txt");
    await program().parseAsync(
      ["bench", "run", "fixture", "--tasks-file", file, "-m", "empty", "--json"],
      { from: "user" },
    );
    expect(f.store.listJobs(10)[0]?.taskFile?.frozen?.partition).toBe("evolve");
    await expect(
      program().parseAsync(
        ["bench", "run", "fixture", "--tasks-file", file, "-t", "suite-0/0", "-m", "empty"],
        { from: "user" },
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });
  it("uses persisted job task sets in method views and leaves legacy jobs unchanged", () => {
    const spec = {
      benchmark: "fixture",
      tasks: ["a", "b"],
      methods: [{ name: "method", agent: "external", entrypoint: "fixture" }],
    };
    const old = BenchJob.parse({
      id: "legacy",
      spec,
      state: "done",
      createdAt: "2026-11-14T00:00:00Z",
      endedAt: null,
    });
    const job = {
      ...old,
      taskSet: taskSetDigest(spec.tasks),
      summary: [
        { method: "method", trials: 2, valid: 0, invalid: 0, unknown: 0, pending: 2, metrics: {} },
      ],
    };
    expect(methodLines([job], () => [])[0]?.revisions[0]?.results[0]?.taskSet).toBe(job.taskSet);
    expect(old.taskSet).toBeUndefined();
  });
  it("rejects oversized file content before parsing", () => {
    expect(() =>
      resolveTaskFile(
        { content: "x".repeat(8 * 1024 * 1024 + 1), sha256: "a".repeat(64) },
        [],
        tasks(),
        fingerprint,
      ),
    ).toThrow(/8 MiB/);
  });
});
