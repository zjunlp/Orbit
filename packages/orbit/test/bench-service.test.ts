// Real store and adapter planning with explicit submission/scoring fakes; no runs are executed.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterClient } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { BenchService, summarize } from "../src/bench/service.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { BenchJob, MetricSpec, Outcome, Run, Trial } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
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
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const registry = new BenchmarkRegistry(paths.benchmarks);
  const source = join(home, "checkout");
  mkdirSync(source);
  registry.put({ name: "fixture", path: source, adapter });
  const bench = new BenchService({
    store,
    paths,
    runs,
    registry,
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
  return { home, paths, source, store, runs, registry, bench, run, job, trial, submit };
}

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
  f.store.putTrial({ ...f.trial, id: "other.1", jobId: "other" });
  const cancelled = { ...second, state: "cancelled" as const };
  f.store.putRun(cancelled);
  f.runs.emit("change", { run: cancelled });
  await expect.poll(() => f.store.getJob(f.job.id)?.state).toBe("done");
  expect(f.store.hasOpenTrials(f.job.id)).toBe(false);
  expect(f.store.hasOpenTrials("other")).toBe(true);
  expect(trials).not.toHaveBeenCalled();
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

it("ignores ordinary run events before looking up trials, retaining tags and legacy groups", () => {
  const f = fixture();
  const lookup = vi.spyOn(f.store, "trialByRun");
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
    evaluation: inline ? "valid" : "invalid",
    score: 0.5,
    issues: inline ? [] : [agentIssue],
  });
});
