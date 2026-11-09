// Real store and adapter planning with explicit submission/scoring fakes; no runs are executed.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth/index.ts";
import { jobRevision } from "../src/bench/hub.ts";
import { AdapterClient } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { BenchService, summarize } from "../src/bench/service.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import {
  AdapterTasksResponse,
  BenchCatalog,
  BenchJob,
  MetricSpec,
  Outcome,
  Run,
  Trial,
} from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { AgentRegistry } from "../src/harness/registry.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

const homes: string[] = [];
const stores: Store[] = [];
const at = "2026-10-16T00:00:00.000Z";
const task = "math.example";
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

function fixture(adapter = "harbor") {
  const home = mkdtempSync(join(tmpdir(), "orbit-bench-service-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const auth = new AuthStore(paths.auth);
  const runs = new RunService({ store, paths, probe: vi.fn(), auth });
  const registry = new BenchmarkRegistry(paths.benchmarks);
  const source = join(home, "checkout");
  mkdirSync(source);
  registry.put({ name: "fixture", path: source, adapter });
  const bench = new BenchService({
    store,
    paths,
    runs,
    registry,
    auth,
    self: [process.execPath, fileURLToPath(new URL("../src/bin.ts", import.meta.url))],
  });
  const run = Run.parse({
    id: "solve",
    spec: { command: ["true"], backend: "process" },
    state: "succeeded",
    reason: null,
    exitCode: 0,
    node: "fixture",
    image: null,
    containerId: null,
    lease: null,
    code: null,
    cleanup: "done",
    note: "",
    createdAt: at,
    startedAt: at,
    endedAt: at,
  });
  const job = BenchJob.parse({
    id: "job",
    spec: { benchmark: "fixture", tasks: [task], methods: [{ name: "empty", agent: "empty" }] },
    state: "running",
    createdAt: at,
    endedAt: null,
  });
  const trial = Trial.parse({
    id: "job.1",
    jobId: job.id,
    task,
    method: "empty",
    seed: 1,
    state: "pending",
    solveRunId: null,
    verifyRunId: null,
    outcome: null,
    createdAt: at,
    endedAt: null,
  });
  const submit = vi.spyOn(runs, "submit").mockImplementation(async (spec) => {
    const queued = Run.parse({ ...run, id: "submitted", spec, state: "queued", startedAt: null });
    store.putRun(queued);
    return queued;
  });
  return { home, paths, source, store, runs, registry, bench, run, job, trial, submit, auth };
}

it("serves the supported benchmark library before any local registration or run", async () => {
  const f = fixture();
  f.registry.remove("fixture");
  const listing = vi.spyOn(AdapterClient.prototype, "tasks");
  const app = createApp({ token: "fixture", runs: f.runs, bench: f.bench } as AppDeps);
  const response = await app.request("/api/v1/bench/catalog", {
    headers: { authorization: "Bearer fixture" },
  });
  expect(response.status).toBe(200);
  const catalog = BenchCatalog.parse(await response.json());
  expect(catalog.entries).toEqual([]);
  expect(catalog.supported).toHaveLength(24);
  expect(catalog.supported.every((row) => row.registrationNames.length === 0)).toBe(true);
  expect(listing).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

it("adopts a live solve submitted before a restart instead of solving the trial twice", async () => {
  const f = fixture();
  f.store.putJob(f.job);
  f.store.putTrial(f.trial);
  const live = Run.parse({
    ...f.run,
    id: "unlinked",
    state: "running",
    endedAt: null,
    cleanup: "pending",
    spec: {
      ...f.run.spec,
      group: `bench-${f.job.id}`,
      tags: { job: f.job.id, trial: f.trial.id, phase: "solve" },
    },
  });
  f.store.putRun(live);
  const solve = vi.spyOn(AdapterClient.prototype, "solve");
  await f.bench.enforceCalibrationBudgets();
  f.bench.start();
  await expect.poll(() => f.store.getTrial(f.trial.id)?.solveRunId).toBe("unlinked");
  expect(f.store.getTrial(f.trial.id)?.state).toBe("solving");
  expect(f.submit).not.toHaveBeenCalled();
  expect(solve).not.toHaveBeenCalled();
});

it("retains registration settings through removal, restart and saved-output rescoring", async () => {
  const f = fixture();
  const executable = join(f.home, "adapter.cjs");
  const requests = join(f.home, "requests.jsonl");
  write(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  const req = JSON.parse(input), say = value => console.log(JSON.stringify(value));
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(req) + "\\n");
  if (req.op === "tasks") return say({
    tasks: [{ id: ${JSON.stringify(task)}, title: "Fixture", supported: true, reason: null }],
    capabilities: { kind: "browser", methods: ["empty", "cli"], requires: ["gui"], conditions: { actionSet: req.benchmark.config.actionSet }, scoreKind: "binary", rescore: "evidence" }
  });
  if (req.op === "score") return say({ score: req.benchmark.config.actionSet === "coord" ? 1 : 0 });
  say({ spec: { backend: "process", command: ["echo", req.benchmark.config.actionSet] } });
});
`,
  );
  chmodSync(executable, 0o755);
  f.registry.put({
    name: "fixture",
    path: f.source,
    adapter: executable,
    config: { actionSet: "coord" },
  });
  await expect(
    f.bench.submit({ benchmark: "fixture", methods: [{ name: "bad", agent: "oracle" }] }),
  ).rejects.toThrow("does not support oracle");
  await expect(
    f.bench.submit({
      benchmark: "fixture",
      methods: [{ name: "c", agent: "opencode", auth: "p" }],
    }),
  ).rejects.toThrow("needs Agent capabilities gui, which opencode does not declare");
  expect(f.store.listJobs()).toHaveLength(0);
  const submitted = await f.bench.submit({
    benchmark: "fixture",
    methods: [{ name: "empty", agent: "empty" }],
  });
  await expect.poll(() => f.submit.mock.calls.length).toBe(1);
  await expect.poll(() => f.store.trials(submitted.id)[0]?.state).toBe("solving");
  expect(submitted.capabilities?.conditions).toEqual({ actionSet: "coord" });
  if (!submitted.benchmarkSnapshot) throw new Error("missing snapshot");
  submitted.benchmarkSnapshot.config.actionSet = "caller mutation";
  expect(f.store.getJob(submitted.id)?.benchmarkSnapshot?.config.actionSet).toBe("coord");
  f.registry.put({
    name: "fixture",
    path: f.source,
    adapter: executable,
    config: { actionSet: "bid" },
  });
  f.registry.remove("fixture");
  const trial = f.store.trials(submitted.id)[0];
  const solve = trial?.solveRunId ? f.store.getRun(trial.solveRunId) : null;
  if (!trial || !solve) throw new Error("missing solve");
  f.store.putRun({
    ...solve,
    state: "succeeded",
    cleanup: "done",
    exitCode: 0,
    startedAt: at,
    endedAt: at,
  });
  mkdirSync(f.runs.dirs(solve.id).output, { recursive: true });
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);

  const store = new Store(f.paths.db);
  stores.push(store);
  const runs = new RunService({ store, paths: f.paths, probe: vi.fn() });
  let count = 0;
  vi.spyOn(runs, "submit").mockImplementation(async (spec) => {
    const queued = Run.parse({
      ...f.run,
      id: `verify-${++count}`,
      spec,
      state: "queued",
      startedAt: null,
    });
    store.putRun(queued);
    return queued;
  });
  const bench = new BenchService({
    store,
    runs,
    paths: f.paths,
    registry: new BenchmarkRegistry(f.paths.benchmarks),
  });
  bench.start();
  const finishVerification = async () => {
    await expect.poll(() => store.getTrial(trial.id)?.state).toBe("verifying");
    const id = store.getTrial(trial.id)?.verifyRunId;
    const verify = id ? store.getRun(id) : null;
    if (!verify) throw new Error("missing verifier");
    expect(verify.spec.command).toEqual(["echo", "coord"]);
    const complete = {
      ...verify,
      state: "succeeded" as const,
      cleanup: "done" as const,
      exitCode: 0,
      startedAt: at,
      endedAt: at,
    };
    store.putRun(complete);
    runs.emit("change", { run: complete });
    await expect.poll(() => store.getTrial(trial.id)?.state).toBe("done");
    expect(store.getTrial(trial.id)?.outcome?.score).toBe(1);
  };
  await finishVerification();
  await expect.poll(() => store.getJob(submitted.id)?.state).toBe("done");
  bench.rescore(submitted.id);
  await finishVerification();
  expect(store.getTrial(trial.id)?.history).toHaveLength(1);
  const recorded = readFileSync(requests, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    recorded.filter((r) => r.op !== "tasks").map((r) => [r.op, r.benchmark.config.actionSet]),
  ).toEqual([
    ["solve", "coord"],
    ["verify", "coord"],
    ["score", "coord"],
    ["verify", "coord"],
    ["score", "coord"],
  ]);
});

it("finishes a job only after its last open trial without loading all its trials", async () => {
  const f = fixture();
  f.store.putJob(f.job);
  f.store.putRun({ ...f.run, state: "cancelled" });
  const second = Run.parse({
    ...f.run,
    id: "second",
    state: "running",
    spec: { ...f.run.spec, tags: { bench: "fixture" } },
  });
  f.store.putRun(second);
  f.store.putTrial({ ...f.trial, state: "solving", solveRunId: f.run.id });
  f.store.putTrial({ ...f.trial, id: "job.2", state: "solving", solveRunId: second.id });
  const trials = vi.spyOn(f.store, "trials");
  expect(f.store.hasOpenTrials("missing")).toBe(false);
  expect(f.store.hasOpenTrials(f.job.id)).toBe(true);
  f.bench.start();
  await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("done");
  expect(f.store.getJob(f.job.id)?.state).toBe("running");
  // Finishing a trial while others are open reads no trial list.
  expect(trials).not.toHaveBeenCalled();
  f.store.putTrial({ ...f.trial, id: "other.1", jobId: "other" });
  const cancelled = { ...second, state: "cancelled" as const };
  f.store.putRun(cancelled);
  f.runs.emit("change", { run: cancelled });
  await expect.poll(() => f.store.getJob(f.job.id)?.state).toBe("done");
  expect(f.store.hasOpenTrials(f.job.id)).toBe(false);
  expect(f.store.hasOpenTrials("other")).toBe(true);
  // Only the job's last finish reads its trials, once, to write the report revision.
  expect(trials).toHaveBeenCalledTimes(1);
  expect(trials).toHaveBeenCalledWith(f.job.id);
  expect(f.store.reports(f.job.id).map((r) => r.reason)).toEqual(["finished"]);
});

it("lists jobs with one trial aggregate query and the same counts and task-weighted metrics", () => {
  const f = fixture();
  for (let j = 0; j < 3; j++) {
    const job = BenchJob.parse({
      ...f.job,
      id: `job-${j}`,
      metrics: [MetricSpec.parse({ name: "quality", label: "Quality" })],
      spec: {
        ...f.job.spec,
        methods: ["empty", "other", "no-trials"].map((name) => ({ name, agent: "empty" })),
      },
    });
    f.store.putJob(job);
    if (j === 0) continue;
    for (let i = 0; i < 24; i++) {
      const outcome =
        i % 5 === 0
          ? null
          : Outcome.parse({
              execution: "succeeded",
              evaluation: i % 7 === 0 ? "invalid" : i % 11 === 0 ? "unknown" : "valid",
              score: i % 3 === 0 ? null : i,
              maxScore: i % 4 === 0 ? 0 : 24,
              metrics: i % 3 === 0 ? undefined : { quality: i / 2, score: -999, undeclared: 10 },
              issues: [],
              cleanup: "done",
            });
      f.store.putTrial({
        ...f.trial,
        id: `${job.id}.${String(i).padStart(2, "0")}`,
        jobId: job.id,
        task: `task-${i % 3}`,
        method: i % 2 ? "empty" : "other",
        seed: i,
        sampleRef: undefined,
        state: outcome ? "done" : i % 2 ? "solving" : "verifying",
        outcome,
        history: outcome
          ? [{ verifyRunId: null, endedAt: at, outcome: { ...outcome, score: 999 } }]
          : [],
      });
    }
  }
  const expected = f.store.listJobs(2).map((job) => ({
    ...job,
    summary: summarize(
      job.spec.methods.map((m) => m.name),
      f.store.trials(job.id),
      job.metrics,
    ),
  }));
  const queries = vi.spyOn(f.store.db, "prepare");
  const parse = vi.spyOn(Trial, "parse");
  expect(f.bench.jobs(2)).toEqual({ jobs: expected });
  expect(queries).toHaveBeenCalledTimes(2);
  expect(parse).not.toHaveBeenCalled();
  expect(f.bench.jobs(3).jobs[2]?.summary).toEqual(
    ["empty", "other", "no-trials"].map((method) => ({
      method,
      trials: 0,
      valid: 0,
      invalid: 0,
      unknown: 0,
      pending: 0,
      metrics: { score: null, quality: null },
    })),
  );
  expect(f.bench.jobs(0)).toEqual({ jobs: [] });
});

it.each(["solving", "verifying"] as const)(
  "does not repeat cancellation when %s run changes synchronously notify bench",
  async (state) => {
    const f = fixture();
    const active = Run.parse({
      ...f.run,
      id: "active",
      state: "running",
      exitCode: null,
      cleanup: "pending",
      endedAt: null,
      spec: { ...f.run.spec, tags: { bench: "fixture" } },
    });
    f.store.putJob(f.job);
    f.store.putRun(f.run);
    f.store.putRun(active);
    f.store.putTrial({
      ...f.trial,
      state,
      solveRunId: state === "solving" ? active.id : f.run.id,
      verifyRunId: state === "verifying" ? active.id : null,
    });
    let notifications = 0;
    const cancel = vi.spyOn(f.runs, "cancel").mockImplementation(async (id) => {
      const run = f.store.getRun(id);
      if (!run) throw new Error("missing fixture run");
      const requested = { ...run, stopRequested: "cancel" as const };
      f.store.putRun(requested);
      // Bound the explicit fake so a regression fails without starving the test runner.
      if (++notifications <= 3) f.runs.emit("change", { run: requested });
      return requested;
    });
    await f.bench.cancel(f.job.id);
    await setImmediate();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.store.getTrial(f.trial.id)?.state).toBe(state);

    const stopped = {
      ...active,
      state: "cancelled" as const,
      cleanup: "done" as const,
      stopRequested: "cancel" as const,
      exitCode: 143,
      endedAt: at,
    };
    f.store.putRun(stopped);
    f.runs.emit("change", { run: stopped });
    await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("done");
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it("ignores ordinary run events before looking up trials, retaining tags and legacy groups", () => {
  const f = fixture();
  const lookup = vi.spyOn(f.store, "trialsByRun");
  for (let i = 0; i < 50; i++) f.runs.emit("change", { run: f.run });
  expect(lookup).not.toHaveBeenCalled();
  for (const spec of [
    { ...f.run.spec, tags: { bench: "fixture" } },
    { ...f.run.spec, group: "bench-legacy" },
  ])
    f.runs.emit("change", { run: { ...f.run, spec } });
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("keeps floating-point metric accumulation identical to job details", () => {
  const f = fixture();
  const job = BenchJob.parse({ ...f.job, metrics: [{ name: "quality", label: "Quality" }] });
  f.store.putJob(job);
  for (const [i, value] of [1e16, 1, -1e16, 0.12345678901234566, 0.23456789012345677].entries()) {
    f.store.putTrial({
      ...f.trial,
      id: `job.${i}`,
      state: "done",
      outcome: Outcome.parse({
        execution: "succeeded",
        evaluation: "valid",
        score: value,
        maxScore: 100,
        metrics: { quality: value },
        issues: [],
        cleanup: "done",
      }),
    });
  }
  expect(f.bench.jobs().jobs[0]?.summary).toEqual(f.bench.job(job.id).summary);
});

it.each([false, true])(
  "cancels all runs and returns before background scoring (failure: %s)",
  async (fail) => {
    const f = fixture();
    f.store.putJob(f.job);
    f.store.putRun(f.run);
    f.store.putRun({ ...f.run, id: "verify" });
    f.store.putRun({ ...f.run, id: "active", state: "running" });
    f.store.putTrial({
      ...f.trial,
      state: "verifying",
      solveRunId: f.run.id,
      verifyRunId: "verify",
    });
    f.store.putTrial({ ...f.trial, id: "job.2", state: "solving", solveRunId: "active" });
    f.store.putTrial({ ...f.trial, id: "job.3" });
    const cancel = vi.spyOn(f.runs, "cancel").mockImplementation(async (id) => {
      const run = f.store.getRun(id);
      if (!run) throw new Error("missing fixture run");
      const result = id === "active" ? { ...run, state: "cancelled" as const } : run;
      f.store.putRun(result);
      return result;
    });
    const gate = Promise.withResolvers<void>();
    const score = vi.spyOn(AdapterClient.prototype, "score").mockImplementation(async () => {
      expect(cancel.mock.calls.map(([id]) => id)).toEqual(["verify", "active"]);
      await gate.promise;
      if (fail) throw new Error("fixture scoring failed");
      return { score: 1, maxScore: 1, issues: [], invalid: false };
    });
    const app = createApp({ token: "fixture", runs: f.runs, bench: f.bench } as AppDeps);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(
          app.request(`/api/v1/bench/jobs/${f.job.id}/cancel`, {
            method: "POST",
            headers: { authorization: "Bearer fixture" },
          }),
        ).then(async (r) => {
          expect(r.status).toBe(200);
          return BenchJob.parse(await r.json());
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 200);
        }),
      ]);
      expect(result?.state).toBe("cancelled");
      expect(f.store.getJob(f.job.id)?.state).toBe("cancelled");
      expect(score).toHaveBeenCalledTimes(1);
      expect(f.store.getTrial(f.trial.id)?.state).toBe("verifying");
      expect((await f.bench.cancel(f.job.id)).state).toBe("cancelled");
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      clearTimeout(timer);
      gate.resolve();
      await expect.poll(() => f.store.trials(f.job.id).every((t) => t.state === "done")).toBe(true);
    }
    expect(f.store.getTrial(f.trial.id)?.outcome?.evaluation).toBe(fail ? "invalid" : "valid");
    expect(f.store.getTrial("job.3")?.outcome?.issues).toContain("job cancelled");
    expect(f.store.getJob(f.job.id)?.state).toBe("cancelled");
  },
);

describe.each(["asi", "harbor", "external"])("%s effective solve timeout", (adapter) => {
  it.each([
    { label: "adapter default", cli: undefined, defaults: undefined, taskTimeout: undefined },
    { label: "resources default", cli: undefined, defaults: 9, taskTimeout: undefined },
    { label: "task over default", cli: undefined, defaults: 9, taskTimeout: 6 },
    { label: "CLI over task", cli: 3, defaults: 9, taskTimeout: 6 },
    { label: "CLI without resources", cli: 3, defaults: undefined, taskTimeout: undefined },
  ])("resolves $label before adapter planning", async ({ cli, defaults, taskTimeout }) => {
    const f = fixture(adapter === "external" ? "harbor" : adapter);
    write(join(f.source, "tasks/math/example/task_meta.yaml"), `id: ${task}\nstatus: final\n`);
    mkdirSync(join(f.source, "bench_runs/instances_seed31415", `${task}__seed31415/reference`), {
      recursive: true,
    });
    write(
      join(f.source, "tasks", task, "task.toml"),
      `[environment]
docker_image = "fixture"
[agent]
timeout_sec = 600
[verifier]
environment_mode = "separate"
timeout_sec = 120
`,
    );
    write(join(f.source, "tasks", task, "instruction.md"), "Fixture instruction\n");
    write(join(f.source, "tasks", task, "tests/test.sh"), "#!/bin/sh\nexit 0\n");
    let executable = adapter;
    if (adapter === "external") {
      executable = join(f.home, "adapter.cjs");
      write(
        executable,
        `#!${process.execPath}
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  console.log(JSON.stringify(req.op === "tasks" ? { tasks: [{ id: "${task}", title: null, supported: true, reason: null }] } : {
    spec: { backend: "process", command: ["echo", String(req.trial.timeoutMin ?? "adapter"), String(req.trial.resources?.cpus), String(req.trial.resources?.memGB)], timeoutMin: 17 }
  }));
});
`,
      );
      chmodSync(executable, 0o755);
    }
    const resources = join(f.home, "resources.json");
    write(
      resources,
      JSON.stringify({
        version: 1,
        default: { timeoutMin: defaults, cpus: 2, memGB: 3 },
        tasks: { [task]: { timeoutMin: taskTimeout, cpus: 3 } },
      }),
    );
    f.registry.put({ name: "fixture", path: f.source, adapter: executable, resources });
    const job = await f.bench.submit({
      benchmark: "fixture",
      methods: [{ name: "empty", agent: "empty" }],
      timeoutMin: cli,
    });
    await expect.poll(() => f.store.trials(job.id)[0]?.state).toBe("solving");
    const spec = f.submit.mock.calls[0]?.[0];
    const effective = cli ?? taskTimeout ?? defaults;
    expect(spec?.timeoutMin).toBe(
      effective ?? (adapter === "harbor" ? 10 : adapter === "external" ? 17 : undefined),
    );
    if (adapter === "asi") {
      if (effective === undefined) expect(spec?.command).not.toContain("--timeout");
      else {
        const index = spec?.command?.indexOf("--timeout") ?? -1;
        expect(index).toBeGreaterThan(-1);
        expect(spec?.command?.[index + 1]).toBe(String(effective * 60));
      }
    } else if (adapter === "external") {
      expect(spec?.command).toEqual(["echo", String(effective ?? "adapter"), "3", "3"]);
      expect(spec?.resources).toMatchObject({ cpus: 3, memGB: 3 });
    }
  });
});

const agentIssue = "Agent stopped: model_unreachable (workspace routing discovery failed)";
function agentSession(f: ReturnType<typeof fixture>, recovered = false) {
  const turn = (error: unknown) =>
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error } });
  write(
    join(f.runs.dirs(f.run.id).agent, "codex/sessions/2026/10/16/rollout-fixture.jsonl"),
    `${turn({ message: "workspace routing discovery failed" })}\n${recovered ? `${turn(null)}\n` : ""}`,
  );
}

it.each(["failed", "succeeded"] as const)(
  "skips verification for an Agent failure even when the solve %s",
  async (state) => {
    const f = fixture();
    f.store.putJob(f.job);
    f.store.putTrial({ ...f.trial, state: "solving", solveRunId: f.run.id });
    f.store.putRun({ ...f.run, state });
    agentSession(f);
    f.bench.start();
    await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("done");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.store.getTrial(f.trial.id)?.outcome).toMatchObject({
      evaluation: "invalid",
      score: null,
      issues: [agentIssue, "verify skipped"],
    });
  },
);

it("verifies a recovered last turn and keeps the verifier's own timeout", async () => {
  const f = fixture();
  f.store.putJob({ ...f.job, resources: { [task]: { timeoutMin: 3 } } });
  f.store.putTrial({ ...f.trial, state: "solving", solveRunId: f.run.id });
  f.store.putRun(f.run);
  agentSession(f, true);
  vi.spyOn(AdapterClient.prototype, "verify").mockResolvedValue({
    spec: { backend: "process", command: ["true"], timeoutMin: 7 },
    issues: [],
  });
  f.bench.start();
  await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("verifying");
  expect(f.submit.mock.calls[0]?.[0].timeoutMin).toBe(7);
});

it.each([
  [false, false],
  [true, false],
  [true, true],
] as const)(
  "classifies Codex startup failure (shared verifier: %s, model responded: %s)",
  async (inline, responded) => {
    const f = fixture();
    const solve = Run.parse({
      ...f.run,
      state: "failed",
      exitCode: 1,
      spec: {
        ...f.run.spec,
        ...(inline
          ? { backend: "docker", image: "fixture", after: { command: ["true"], timeoutMin: 1 } }
          : {}),
      },
      ...(inline
        ? { after: { state: "succeeded", exitCode: 0, reason: null, startedAt: at, endedAt: at } }
        : {}),
    });
    f.store.putJob(f.job);
    f.store.putRun(solve);
    f.store.putTrial({ ...f.trial, state: "solving", solveRunId: solve.id });
    const dirs = f.runs.dirs(solve.id);
    write(join(dirs.agent, "codex/config.toml"), "");
    write(
      dirs.log,
      "Error loading config.toml: Failed to read config file /orbit/agent/codex/config.toml: Permission denied (os error 13)\n\n[orbit] after phase output:\n",
    );
    if (responded)
      write(
        join(dirs.agent, "codex/sessions/rollout.jsonl"),
        `${JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ text: "Played the game." }] },
        })}\n`,
      );
    vi.spyOn(AdapterClient.prototype, "score").mockResolvedValue({
      score: 0,
      maxScore: 1,
      invalid: false,
      issues: [],
    });
    f.bench.start();
    await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("done");
    const outcome = f.store.getTrial(f.trial.id)?.outcome;
    expect(outcome).toMatchObject({
      execution: "failed",
      evaluation: responded ? "valid" : "invalid",
      score: inline ? 0 : null,
      cleanup: "done",
    });
    expect(outcome?.failure).toBe(responded ? undefined : "infra");
    if (!responded)
      expect(outcome?.issues.join(" ")).toContain("Agent stopped: agent_configuration_failed");
    expect(f.submit).not.toHaveBeenCalled();
  },
);

it.each([false, true])("scores an Agent failure with an after phase: %s", async (inline) => {
  const f = fixture();
  const solve = Run.parse({
    ...f.run,
    spec: {
      ...f.run.spec,
      ...(inline
        ? { backend: "docker", image: "fixture", after: { command: ["true"], timeoutMin: 1 } }
        : {}),
    },
    ...(inline
      ? { after: { state: "succeeded", exitCode: 0, reason: null, startedAt: at, endedAt: at } }
      : {}),
  });
  f.store.putJob(f.job);
  f.store.putRun(solve);
  f.store.putRun({ ...f.run, id: "verify" });
  f.store.putTrial({
    ...f.trial,
    state: inline ? "solving" : "verifying",
    solveRunId: solve.id,
    verifyRunId: inline ? null : "verify",
  });
  agentSession(f);
  vi.spyOn(AdapterClient.prototype, "score").mockResolvedValue({
    score: 0.5,
    maxScore: 1,
    invalid: false,
    issues: [],
  });
  f.bench.start();
  await expect.poll(() => f.store.getTrial(f.trial.id)?.state).toBe("done");
  expect(f.store.getTrial(f.trial.id)?.outcome).toMatchObject({
    evaluation: "invalid",
    failure: "model_unavailable",
    score: 0.5,
    issues: [agentIssue],
  });
});

it.each([
  ["codex", "unavailable"],
  ["claude-code", "unavailable"],
  ["codex", "partial"],
  ["claude-code", "partial"],
  ["claude-code", "no-error"],
] as const)(
  "checks external agentTask transcripts for %s (%s), without inferring from missing actions",
  async (agent, response) => {
    const f = fixture();
    const executable = join(f.home, "agent-adapter.cjs");
    write(
      executable,
      `#!${process.execPath}
let text = "";
process.stdin.on("data", chunk => text += chunk);
process.stdin.on("end", () => {
  const req = JSON.parse(text), say = value => console.log(JSON.stringify(value));
  if (req.op === "tasks") return say({ tasks: [{ id: "fixture", title: "Fixture", supported: true, reason: null }] });
  if (req.op === "solve") return say({ spec: { image: "fixture", agentTask: { instruction: "Complete the GUI task" } } });
  if (req.op === "verify") return say({ spec: { image: "fixture", command: ["true"] } });
  if (req.op === "score") return say({ score: 0 });
});
`,
    );
    chmodSync(executable, 0o755);
    f.registry.put({ name: "fixture", path: f.source, adapter: executable });
    const secret = "fixture-not-a-real-model-key";
    f.auth.put({ name: "fixture", harness: agent, kind: "api-key", secret });
    let runCount = 0;
    f.submit.mockImplementation(async (spec) => {
      const queued = Run.parse({
        ...f.run,
        id: `run-${++runCount}`,
        spec,
        state: "queued",
        startedAt: null,
      });
      f.store.putRun(queued);
      return queued;
    });
    const job = await f.bench.submit({
      benchmark: "fixture",
      methods: [{ name: "agent", agent, auth: "fixture" }],
    });
    await expect.poll(() => f.store.trials(job.id)[0]?.state).toBe("solving");
    const trial = f.store.trials(job.id)[0];
    if (!trial?.solveRunId) throw new Error("missing solve");
    const queued = f.runs.get(trial.solveRunId);
    if (!queued) throw new Error("missing solve run");
    expect(queued.spec.command).toContain("Complete the GUI task");
    expect(queued.spec.auth).toBe("fixture");
    const error = `Unauthorized: ${secret}`;
    const rows: unknown[] = [];
    if (agent === "codex") {
      if (response === "partial")
        rows.push({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I choose to finish without actions." }],
          },
        });
      rows.push({
        type: "event_msg",
        payload: {
          type: "task_complete",
          error: { message: error, codex_error_info: "Unauthorized" },
        },
      });
    } else {
      if (response === "partial")
        rows.push({
          type: "assistant",
          message: { content: [{ type: "text", text: "I choose to finish without actions." }] },
        });
      if (response !== "no-error")
        rows.push({
          type: "assistant",
          isApiErrorMessage: true,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: error }] },
        });
    }
    const dir = f.runs.dirs(queued.id);
    write(
      join(
        dir.agent,
        agent === "codex"
          ? "codex/sessions/2026/11/04/fixture.jsonl"
          : "claude/projects/-task/fixture.jsonl",
      ),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    mkdirSync(dir.output, { recursive: true });
    const solve = {
      ...queued,
      state: "failed" as const,
      exitCode: 1,
      reason: "exit code 1",
      startedAt: at,
      endedAt: at,
      cleanup: "done" as const,
    };
    f.store.putRun(solve);
    f.runs.emit("change", { run: solve });
    if (response === "unavailable") {
      await expect.poll(() => f.store.getTrial(trial.id)?.state).toBe("done");
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(f.store.getTrial(trial.id)?.outcome).toMatchObject({
        evaluation: "invalid",
        failure: "model_unavailable",
        score: null,
      });
      expect(f.store.getTrial(trial.id)?.outcome?.issues).toContain(
        "Agent stopped: model_authentication_failed (Unauthorized: [redacted])",
      );
      expect(JSON.stringify(f.bench.job(job.id))).not.toContain(secret);
      expect(f.bench.job(job.id).summary[0]?.valid).toBe(0);
    } else {
      await expect.poll(() => f.store.getTrial(trial.id)?.state).toBe("verifying");
      const verifyId = f.store.getTrial(trial.id)?.verifyRunId;
      const pending = verifyId ? f.runs.get(verifyId) : null;
      if (!pending) throw new Error("missing verification");
      mkdirSync(f.runs.dirs(pending.id).output, { recursive: true });
      const verify = {
        ...pending,
        state: "succeeded" as const,
        startedAt: at,
        endedAt: at,
        cleanup: "done" as const,
        exitCode: 0,
      };
      f.store.putRun(verify);
      f.runs.emit("change", { run: verify });
      await expect.poll(() => f.store.getTrial(trial.id)?.state).toBe("done");
      expect(f.store.getTrial(trial.id)?.outcome).toMatchObject({ evaluation: "valid", score: 0 });
      expect(f.bench.job(job.id).summary[0]?.valid).toBe(1);
    }
  },
);

it("runs a calibration job, rescores it once and shows it in the catalog", async () => {
  const f = fixture();
  const executable = join(f.home, "calibration-adapter.cjs");
  write(
    executable,
    `#!${process.execPath}
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  const req = JSON.parse(input), say = value => console.log(JSON.stringify(value));
  if (req.op === "tasks") return say({
    tasks: ["a.1", "a.2", "b.1"].map(id => ({ id, title: null, supported: id !== "a.2", reason: id === "a.2" ? "needs a GPU" : null, tags: { oracle: "full" } })),
    capabilities: { category: "tool-workflow", methods: ["empty", "oracle", "codex"], conditions: {}, scoreKind: "binary", rescore: "evidence" }
  });
  if (req.op === "score") return say({ score: req.trial.method.agent === "oracle" ? 1 : 0 });
  say({ spec: { backend: "process", command: ["true"] } });
});
`,
  );
  chmodSync(executable, 0o755);
  f.registry.put({ name: "fixture", path: f.source, adapter: executable });
  let n = 0;
  f.submit.mockImplementation(async (spec) => {
    const queued = Run.parse({ ...f.run, id: `r${++n}`, spec, state: "queued", startedAt: null });
    f.store.putRun(queued);
    return queued;
  });
  // Every submitted run succeeds as soon as it is seen.
  const finishRuns = async () => {
    for (const r of f.store.listRuns({}))
      if (r.state === "queued") {
        const done = {
          ...r,
          state: "succeeded" as const,
          cleanup: "done" as const,
          exitCode: 0,
          startedAt: at,
          endedAt: at,
        };
        mkdirSync(f.runs.dirs(r.id).output, { recursive: true });
        f.store.putRun(done);
        f.runs.emit("change", { run: done });
      }
  };
  const job = await f.bench.calibrate({ benchmark: "fixture", sample: 5, seeds: 2 });
  expect(job.spec.tasks).toEqual(["a.1", "b.1"]);
  expect(job.spec.calibration).toEqual({ noOracle: [], rescore: true });
  expect(f.bench.job(job.id).calibration?.phase).toBe("running");
  await expect
    .poll(
      async () => {
        await finishRuns();
        return f.bench.job(job.id).calibration?.phase;
      },
      { timeout: 15_000 },
    )
    .toBe("done");
  const report = f.bench.job(job.id).calibration;
  expect(report?.calibrated).toBe(true);
  expect(report?.checks.find((c) => c.name === "rescore reproduces scores")).toMatchObject({
    result: "passed",
  });
  expect(f.store.trials(job.id).map((t) => t.history.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  // The catalog lists in the background; once listed it shows coverage and the calibration.
  expect(f.bench.catalog().entries[0]).toMatchObject({ fidelity: "calibrated", jobs: 1 });
  await expect.poll(() => f.bench.catalog().entries[0]?.listing?.coverage.supported).toBe(2);
  const entry = f.bench.catalog().entries[0];
  expect(entry).toMatchObject({ listingError: null, methods: [] });
  expect(entry?.listing).toMatchObject({ oracleTasks: 2, coverage: { total: 3 } });
  expect(entry?.calibrations[0]?.job).toBe(job.id);
});

it("records method revisions and checks declared lineage at submission", async () => {
  const f = fixture();
  const executable = join(f.home, "rev-adapter.cjs");
  write(
    executable,
    `#!${process.execPath}
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  const req = JSON.parse(input), say = value => console.log(JSON.stringify(value));
  if (req.op === "tasks") return say({ tasks: [{ id: "t", title: null, supported: true, reason: null }],
    capabilities: { methods: ["external", "empty"], conditions: {}, scoreKind: "binary", rescore: "evidence" } });
  say({ spec: { backend: "process", command: ["true"] } });
});
`,
  );
  chmodSync(executable, 0o755);
  f.registry.put({ name: "fixture", path: f.source, adapter: executable });
  const ext = {
    name: "pol",
    agent: "external" as const,
    entrypoint: "pol:make",
    config: { k: "1" },
  };
  const a = await f.bench.submit({
    benchmark: "fixture",
    methods: [ext, { name: "empty", agent: "empty" }],
  });
  const rev = a.revisions.pol?.revision;
  expect(rev).toMatch(/^[0-9a-f]{12}$/);
  expect(a.revisions.empty).toBeUndefined();
  // Same content, other name: same revision; other config: another one.
  const b = await f.bench.submit({ benchmark: "fixture", methods: [{ ...ext, name: "pol2" }] });
  expect(b.revisions.pol2?.revision).toBe(rev);
  const evidence = f.store.trials(a.id)[0];
  if (!evidence) throw new Error("missing fixture trial");
  await expect(
    f.bench.submit({
      benchmark: "fixture",
      methods: [ext],
      lineage: { pol: { parent: rev, note: "Only metadata changed", informedBy: [evidence.id] } },
    }),
  ).rejects.toThrow("parent revision matches this method");
  const rerun = await f.bench.submit({
    benchmark: "fixture",
    methods: [ext],
    lineage: { pol: { note: "Retry the same method", informedBy: [evidence.id] } },
  });
  expect(rerun.revisions.pol?.revision).toBe(rev);
  expect(rerun.spec.lineage.pol?.parent).toBeUndefined();
  await expect(
    f.bench.submit({
      benchmark: "fixture",
      methods: [{ ...ext, config: { k: "2" } }],
      lineage: { pol: { parent: "0123456789ab" } },
    }),
  ).rejects.toThrow("parent revision 0123456789ab is not in any job");
  await expect(
    f.bench.submit({ benchmark: "fixture", methods: [ext], lineage: { other: {} } }),
  ).rejects.toThrow("lineage names no method of this job: other");
  const c = await f.bench.submit({
    benchmark: "fixture",
    methods: [{ ...ext, config: { k: "2" } }],
    lineage: { pol: { parent: rev, note: "new k" } },
  });
  expect(c.revisions.pol?.revision).not.toBe(rev);
  expect(c.spec.lineage.pol).toMatchObject({ parent: rev, note: "new k", informedBy: [] });
  f.bench.label("fixture", { identity: { id: "fx", name: "Fixture" }, domains: ["games", "x"] });
  expect(f.registry.get("fixture")?.labels?.domains).toEqual(["games", "x"]);
  const entry = f.bench.catalog().entries[0];
  expect(entry).toMatchObject({
    identity: { id: "fx" },
    identitySource: "label",
    domains: ["games"],
    tags: ["x"],
  });
});

it("persists taxonomy through the labels API and clears it without changing execution settings", async () => {
  const f = fixture();
  const app = createApp({ token: "fixture", runs: f.runs, bench: f.bench } as AppDeps);
  const labels = {
    identity: { id: "fx", name: "Fixture" },
    taxonomy: {
      domains: ["science"],
      taskTypes: ["analysis"],
      targets: null,
      participants: [],
    },
  };
  const request = (body: object) =>
    app.request("/api/v1/benchmarks/fixture/labels", {
      method: "PATCH",
      headers: { authorization: "Bearer fixture", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const before = f.registry.get("fixture");
  expect((await request(labels)).status).toBe(200);
  const persisted = new BenchmarkRegistry(f.paths.benchmarks).get("fixture");
  expect(persisted?.labels).toEqual(labels);
  expect(persisted?.config).toEqual(before?.config);
  expect(persisted?.adapter).toEqual(before?.adapter);
  expect((await request({ taxonomy: { interfaces: ["harbor"] } })).status).toBe(400);
  expect(f.registry.get("fixture")?.labels).toEqual(labels);
  expect((await request({ identity: labels.identity })).status).toBe(200);
  expect(f.registry.get("fixture")?.labels).toEqual({ identity: labels.identity });
});

it("accepts a legacy approximate parent and hashes the effective profile model without credentials", async () => {
  const f = fixture();
  vi.spyOn(AdapterClient.prototype, "tasks").mockResolvedValue(
    AdapterTasksResponse.parse({
      tasks: [{ id: "t", title: null, supported: true, reason: null }],
    }),
  );
  vi.spyOn(AgentRegistry.prototype, "info").mockImplementation(async (definition) => ({
    definition,
    available: true,
    detail: "explicit test fixture",
    version: "fixture-cli 1",
  }));
  vi.spyOn(AdapterClient.prototype, "solve").mockResolvedValue({
    spec: { backend: "process", command: ["true"] },
    issues: [],
  });
  f.auth.put({
    name: "p1",
    harness: "codex",
    kind: "api-key",
    model: "model-one",
    secret: "test-key-one",
  });
  f.auth.put({
    name: "p2",
    harness: "codex",
    kind: "api-key",
    model: "model-two",
    secret: "test-key-two",
  });
  const submit = (auth: string, model?: string) =>
    f.bench.submit({
      benchmark: "fixture",
      methods: [{ name: "sol", agent: "codex", auth, model }],
    });
  const one = await submit("p1");
  const two = await submit("p2");
  expect(one.revisions.sol?.basis.model).toBe("model-one");
  expect(two.revisions.sol?.basis.model).toBe("model-two");
  expect(one.revisions.sol?.revision).not.toBe(two.revisions.sol?.revision);
  const explicit = await submit("p2", "model-one");
  expect(explicit.revisions.sol?.revision).toBe(one.revisions.sol?.revision);
  expect(JSON.stringify(one.revisions)).not.toContain("test-key");
  const legacy = {
    ...one,
    id: "legacy",
    revisions: {},
    spec: {
      ...one.spec,
      methods: [{ name: "sol", agent: "codex", auth: "p1", model: "legacy-model" }],
    },
  };
  f.store.putJob(legacy);
  const parent = jobRevision(legacy, "sol");
  expect(parent?.approximate).toBe(true);
  const child = await f.bench.submit({
    benchmark: "fixture",
    methods: [{ name: "sol", agent: "codex", auth: "p1", model: "new-model" }],
    lineage: { sol: { parent: parent?.revision } },
  });
  expect(child.spec.lineage.sol?.parent).toBe(parent?.revision);
});
