import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { checkGateBundle } from "../src/bench/gate-bundle.ts";
import { evaluateGate } from "../src/bench/gates.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { bundleDigest, methodBasis, revisionOf } from "../src/bench/revision.ts";
import { BenchService } from "../src/bench/service.ts";
import { registerBench } from "../src/cli/bench.ts";
import { registerGate, shellCommand } from "../src/cli/gate.ts";
import { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import type { GateSubmissionInput, Method } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";
import { child, fixture, parent } from "./fixtures/gate.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function setup() {
  const root = mkdtempSync(join(tmpdir(), "orbit-e4-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = orbitPaths({ ORBIT_HOME: join(root, "home") });
  ensureHome(paths);
  const store = new Store(paths.db);
  cleanups.push(() => store.close());
  const f = fixture(6);
  f.policy.min_paired_tasks = 2;
  for (const job of f.evidence.jobs) {
    const method = job.spec.methods[0];
    assert(method);
    method.bundle = `/fixture/bundle ${job.id}`;
  }
  const registry = new BenchmarkRegistry(paths.benchmarks);
  assert(f.target.a.benchmarkSnapshot);
  registry.put(f.target.a.benchmarkSnapshot);
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
  const save = (reports = true) => {
    for (const job of f.evidence.jobs) store.putJob(job);
    if (reports) for (const report of f.evidence.reports) store.addReport(report);
  };
  const input = (): GateSubmissionInput => ({
    parent: parent.revision,
    child: child.revision,
    policy: f.policy,
    taskSets: f.evidence.taskSets,
  });
  const directory = join(root, "bundle");
  mkdirSync(directory);
  const bundle = () => ({ directory, policy: f.policy, taskSets: f.evidence.taskSets });
  return {
    ...f,
    root,
    paths,
    store,
    registry,
    bench,
    runs,
    app,
    client,
    save,
    input,
    directory,
    bundle,
  };
}
it("plans exact stored reports without writing a verdict, job, Run or backfilled report", async () => {
  const f = setup();
  f.save();
  const result = await f.client.benchGatePlan(f.input());
  expect(result.rows.map((r) => r.status)).toEqual(["available", "available"]);
  expect(result.rows.every((r) => r.command === null)).toBe(true);
  expect(
    result.checks.filter((c) => c.required && c.prerequisite).every((c) => c.status === "pass"),
  ).toBe(true);
  expect(f.store.gateRecords()).toEqual([]);
  expect(f.store.listJobs(-1)).toHaveLength(2);
  expect(f.store.listRuns()).toEqual([]);
});
it("prints a frozen missing-side command and preserves seeds, options, lineage and shell literals", async () => {
  const f = setup();
  const evolve = structuredClone(f.target.b);
  evolve.id = "evolve";
  evolve.taskFile = { sha256: sha("evolve/task\n") };
  evolve.spec.tasks = ["evolve/task"];
  f.store.putJob(f.target.a);
  f.store.addReport(f.target.ra);
  f.store.putJob(evolve);
  const result = await f.client.benchGatePlan(f.input());
  const row = result.rows.find((r) => r.side === "child");
  assert(row?.command);
  expect(row.status).toBe("missing");
  expect(row.command).toContain("--expect-revision");
  expect(row.command).toContain(child.revision);
  expect(row.command).toContain("--expect-tasks-sha256");
  expect(row.command).toContain(f.policy.gate.tasks.sha256);
  expect(row.command).toContain("--parent");
  expect(row.command).toContain(parent.revision);
  expect(
    row.command.slice(row.command.indexOf("--seeds"), row.command.indexOf("--seeds") + 2),
  ).toEqual(["--seeds", "1"]);
  const values = ["spaces ' quotes", "$(touch /tmp/forbidden)", "`printf wrong`", "a; b", ""];
  const command = shellCommand([
    process.execPath,
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...values,
  ]);
  expect(JSON.parse(execFileSync("sh", ["-c", command], { encoding: "utf8" }))).toEqual(values);
  expect(f.store.listJobs(-1)).toHaveLength(2);
  expect(f.store.gateRecords()).toEqual([]);
});
it("distinguishes pending work from finished unreported work without backfilling", async () => {
  const f = setup();
  f.save(false);
  const running = structuredClone(f.target.b);
  running.state = "running";
  f.store.putJob(running);
  const plan = await f.client.benchGatePlan(f.input());
  expect(plan.rows[0]).toMatchObject({
    status: "missing",
    command: ["orbit", "bench", "report", f.target.a.id, "--json"],
  });
  expect(plan.rows[1]).toMatchObject({ status: "pending", command: null });
  expect(f.store.reports(f.target.a.id)).toEqual([]);
});
it("requires explicit rescore choices and keeps saved verdict history readable after deletion", async () => {
  const f = setup();
  f.save();
  const newer = structuredClone(f.target.rb);
  newer.revision = 2;
  f.store.addReport(newer);
  const ambiguous = await f.client.benchGatePlan(f.input());
  expect(ambiguous.rows[1]).toMatchObject({ status: "ambiguous", selected: null, command: null });
  expect(ambiguous.rows[1]?.candidates).toHaveLength(2);
  const explicit = { ...f.input(), selections: f.evidence.selections };
  expect((await f.client.benchGatePlan(explicit)).rows[1]?.selected?.revision).toBe(1);
  evaluateGate(f.store, explicit);
  f.store.deleteJob(f.target.a.id);
  f.store.deleteJob(f.target.b.id);
  expect((await f.client.benchGatePlan(explicit)).rows.every((r) => r.status === "available")).toBe(
    true,
  );
  expect(f.store.listJobs(-1)).toEqual([]);
  expect(f.store.gateRecords()).toHaveLength(1);
});
it("shows stale conditions and cannot claim a plan is ready just because reports exist", async () => {
  const f = setup();
  f.target.a.source = { commit: "different", dirty: false, describe: null };
  f.save();
  const plan = await f.client.benchGatePlan(f.input());
  expect(plan.rows.every((r) => r.status === "available")).toBe(true);
  expect(plan.checks.some((c) => c.kind === "conditions" && c.status === "insufficient")).toBe(
    true,
  );
  const cli = new Command();
  registerGate(cli, async () => f.client, vi.fn());
  const policy = join(f.root, "gate.yaml");
  writeFileSync(policy, JSON.stringify(f.policy));
  writeFileSync(join(f.root, "gate.txt"), f.evidence.taskSets[0]?.content ?? "");
  await cli.parseAsync(
    [
      "gate",
      "plan",
      "--policy",
      policy,
      "--parent",
      parent.revision,
      "--child",
      child.revision,
      "--json",
    ],
    { from: "user" },
  );
  expect(process.exitCode).toBe(2);
  expect(f.store.gateRecords()).toEqual([]);
});
it("blocks unknown revisions, changed task files and unauthenticated planning", async () => {
  const f = setup();
  f.save();
  await expect(f.client.benchGatePlan({ ...f.input(), child: "f".repeat(12) })).rejects.toThrow(
    "revision not found",
  );
  await expect(
    f.client.benchGatePlan({
      ...f.input(),
      taskSets: [{ file: "gate.txt", content: "changed\n" }],
    }),
  ).rejects.toThrow("changed task file");
  expect(
    (
      await f.app.request("/api/v1/bench/gates/plan", {
        method: "POST",
        body: JSON.stringify(f.input()),
      })
    ).status,
  ).toBe(401);
});
it("checks all regular bundle bytes using the existing stable revision digest", async () => {
  const f = setup();
  const file = join(f.directory, "AGENTS.md");
  writeFileSync(file, "Check the saved outputs before submitting.\n");
  chmodSync(file, 0o755);
  const result = await f.client.benchGateBundleCheck(f.bundle());
  expect(result).toMatchObject({
    passed: true,
    complete: true,
    files: 1,
    digest: bundleDigest(f.directory),
  });
  expect(result.checks.find((c) => c.kind === "reference-hashes")?.result).toBe("not_run");
  const expected = createHash("sha256")
    .update("AGENTS.md\0")
    .update("73\0")
    .update(String(readFileSync(file).length))
    .update("\0")
    .update(readFileSync(file))
    .digest("hex");
  expect(result.digest).toBe(expected);
});
it("rejects literal held-out IDs, binary reference files and credentials without echoing values", () => {
  const f = setup();
  const secret = `sk-${"x".repeat(32)}`,
    reference = "Synthetic reference answer bytes";
  f.policy.bundle = {
    max_bytes: 64 * 1024 * 1024,
    max_files: 2000,
    reference_sha256: [sha(reference)],
  };
  writeFileSync(join(f.directory, "AGENTS.md"), `Use gate/0. api_key=${secret}\n`);
  writeFileSync(join(f.directory, "answer.bin"), reference);
  const result = checkGateBundle(f.bundle());
  expect(result.passed).toBe(false);
  expect(result.complete).toBe(true);
  expect(new Set(result.findings.map((r) => r.kind))).toEqual(
    new Set(["secrets", "task-ids", "reference-hashes"]),
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(reference);
  writeFileSync(join(f.directory, "AGENTS.md"), f.policy.bundle.reference_sha256[0] ?? "");
  expect(
    checkGateBundle(f.bundle()).findings.filter((r) => r.kind === "reference-hashes"),
  ).toHaveLength(2);
});
it("fails closed for size limits, links outside the bundle, cycles and special files", () => {
  const f = setup();
  writeFileSync(join(f.directory, "a"), "over budget");
  const limited = { ...f.bundle(), policy: { ...f.policy, bundle: { max_bytes: 2 } } };
  expect(checkGateBundle(limited)).toMatchObject({ passed: false, complete: false, digest: null });
  writeFileSync(join(f.root, "outside"), "outside");
  symlinkSync(join(f.root, "outside"), join(f.directory, "link"));
  expect(checkGateBundle(f.bundle()).findings[0]?.detail).toContain("outside");
  rmSync(join(f.directory, "link"));
  symlinkSync(f.directory, join(f.directory, "cycle"));
  expect(checkGateBundle(f.bundle()).findings[0]?.detail).toContain("cycle");
  rmSync(join(f.directory, "cycle"));
  execFileSync("mkfifo", [join(f.directory, "fifo")]);
  expect(checkGateBundle(f.bundle()).findings[0]?.detail).toContain("non-regular");
});
it("rejects a changed content revision before any job or Run is created", async () => {
  const f = setup();
  const listing = vi.spyOn(f.bench, "infoOf").mockResolvedValue({
    metrics: [],
    tasks: [{ id: "t", title: "t", supported: true, reason: null, tags: {} }],
  });
  const method: Method = { name: "candidate", agent: "external", entrypoint: "synthetic" };
  const actual = revisionOf(
    methodBasis(method, { authKind: null, cliVersion: null, bundleDigest: null }),
    true,
  );
  await expect(
    f.bench.submit({
      benchmark: "fixture",
      tasks: ["t"],
      methods: [{ name: "candidate", agent: "external", entrypoint: "synthetic" }],
      expectedRevisions: { candidate: parent.revision },
    }),
  ).rejects.toThrow("expected configuration revision");
  expect(listing).toHaveBeenCalledOnce();
  expect(f.store.listJobs(-1)).toEqual([]);
  expect(f.store.listRuns()).toEqual([]);
  const accepted = await f.bench.submit({
    benchmark: "fixture",
    tasks: ["t"],
    methods: [{ name: "candidate", agent: "external", entrypoint: "synthetic" }],
    expectedRevisions: { candidate: actual.revision },
  });
  expect(accepted.revisions.candidate).toEqual(actual);
  expect(accepted.spec).not.toHaveProperty("expectedRevisions");
  expect(f.store.listRuns()).toEqual([]);
});
it("rejects task-file drift in a planned CLI command before contacting the daemon", async () => {
  const f = setup();
  const file = join(f.root, "tasks.txt");
  writeFileSync(file, "t\n");
  const client = vi.fn();
  const cli = new Command();
  registerBench(cli, client, vi.fn());
  await expect(
    cli.parseAsync(
      [
        "bench",
        "run",
        "fixture",
        "--tasks-file",
        file,
        "--expect-tasks-sha256",
        "a".repeat(64),
        "--method",
        "empty",
      ],
      { from: "user" },
    ),
  ).rejects.toThrow("does not match");
  expect(client).not.toHaveBeenCalled();
});

it("detects encoded JSON credential fields and redacts suspicious file names", () => {
  const f = setup();
  const value = "synthetic".repeat(4);
  writeFileSync(join(f.directory, "config.json"), JSON.stringify({ nested: { token: value } }));
  const name = `sk-${"z".repeat(30)}`;
  writeFileSync(join(f.directory, name), "public");
  const check = checkGateBundle(f.bundle());
  expect(check.passed).toBe(false);
  expect(check.findings.filter((v) => v.kind === "secrets")).toHaveLength(2);
  expect(JSON.stringify(check)).not.toContain(value);
  expect(JSON.stringify(check)).not.toContain(name);
});

it("blocks a mismatched report metric instead of recommending duplicate evaluations", async () => {
  const f = setup();
  f.save();
  f.policy.metric = "unreported";
  const plan = await f.client.benchGatePlan(f.input());
  expect(plan.rows.every((row) => row.status === "blocked" && row.command === null)).toBe(true);
  expect(plan.rows[0]?.reason).toContain("requested metric/method");
});
it("retains explicit A/A report selection requirements in the planner", async () => {
  const f = setup();
  f.save();
  const plan = await f.client.benchGatePlan({
    ...f.input(),
    child: parent.revision,
    mode: "calibration-aa",
  });
  expect(plan.rows.every((row) => row.status === "ambiguous" && row.selected === null)).toBe(true);
  expect(f.store.gateRecords()).toEqual([]);
});
