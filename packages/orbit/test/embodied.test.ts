// Real contracts/store/planning; submitted runs and adapter execution are explicitly synthetic.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyRegistry } from "../src/bench/policies.ts";
import { AdapterClient } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { checkSamplePlan, contentDigest, resolveBinding } from "../src/bench/samples.ts";
import { BenchService } from "../src/bench/service.ts";
import { buildReport, compareJobs, planDigest } from "../src/bench/summary.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import {
  AdapterRequest,
  AdapterTasksResponse,
  BenchJob,
  BenchJobSpec,
  EpisodeSample,
  isAgentMethod,
  Method,
  PolicyDefinition,
  Run,
  SampleIdentity,
  SemanticProfile,
  Trial,
} from "../src/contracts/index.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

const reference = JSON.parse(
  readFileSync(
    new URL("../../../examples/bench-adapters/embodied/reference.json", import.meta.url),
    "utf8",
  ),
);
const benchmarkProfile = SemanticProfile.parse(reference.benchmarkProfile);
const policyProfile = SemanticProfile.parse(reference.policyProfile);
const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sample(initialStateId = "0", initialStateDigest = `sha256:${"a".repeat(64)}`) {
  const content = {
    taskId: "synthetic:task",
    benchmarkProfile: reference.id,
    initialStateId,
    initialStateDigest,
    environmentSeed: 7,
    policySeed: 0,
    repetition: 0,
  };
  return EpisodeSample.parse({ ...content, sampleId: contentDigest(content) });
}

function plan() {
  const items = [sample("0"), sample("1")];
  return checkSamplePlan({ version: 1, items, digest: contentDigest(items) });
}

function policy() {
  return PolicyDefinition.parse({
    name: "synthetic-policy",
    version: "1",
    connector: "openpi-ws",
    profile: policyProfile,
    checkpointDigest: `sha256:${"b".repeat(64)}`,
    normalizationDigest: `sha256:${"c".repeat(64)}`,
    service: {
      name: "policy",
      role: "policy",
      image: `synthetic-model@sha256:${"e".repeat(64)}`,
      command: ["true"],
      gpus: 0,
      healthcheck: { command: ["true"] },
    },
  });
}

function comparisonFixture() {
  const job = BenchJob.parse({
    id: "synthetic-job",
    spec: {
      benchmark: "synthetic",
      tasks: ["synthetic:task"],
      samplePlan: plan(),
      methods: [
        { name: "p", agent: "policy", policyRef: "synthetic-policy", policySnapshot: policy() },
      ],
    },
    benchmarkSnapshot: {
      name: "synthetic",
      adapter: "harbor",
      path: "/synthetic-benchmark",
      createdAt: "2026-11-06",
      updatedAt: "2026-11-06",
    },
    resources: { "synthetic:task": { cpus: 2, memGB: 4, gpus: 0, timeoutMin: 10 } },
    state: "done",
    createdAt: "2026-11-06",
    endedAt: "2026-11-06",
  });
  const trials = plan().items.map((item, i) =>
    Trial.parse({
      id: `synthetic-trial-${i}`,
      jobId: job.id,
      task: item.taskId,
      method: "p",
      sampleRef: item.sampleId,
      state: "done",
      solveRunId: null,
      verifyRunId: null,
      createdAt: job.createdAt,
      endedAt: job.endedAt,
      outcome: {
        execution: "succeeded",
        evaluation: "valid",
        score: i,
        maxScore: 1,
        cleanup: "done",
        issues: [],
      },
    }),
  );
  return { job, trials };
}

it.each([
  [
    "environment",
    (job: BenchJob) => {
      if (job.benchmarkSnapshot) job.benchmarkSnapshot.env.RENDERER = "other";
    },
  ],
  [
    "options",
    (job: BenchJob) => {
      job.spec.options.protocol = "other";
    },
  ],
  [
    "job timeout",
    (job: BenchJob) => {
      job.spec.timeoutMin = 20;
    },
  ],
  [
    "task timeout",
    (job: BenchJob) => {
      job.resources = {
        "synthetic:task": { ...job.resources?.["synthetic:task"], timeoutMin: 20 },
      };
    },
  ],
  ...(["cpus", "memGB", "gpus", "gpuMemGB"] as const).map(
    (field) =>
      [
        field,
        (job: BenchJob) => {
          job.resources = {
            "synthetic:task": { ...job.resources?.["synthetic:task"], [field]: 8 },
          };
        },
      ] as const,
  ),
  [
    "source",
    (job: BenchJob) => {
      job.source = { commit: "other", describe: null, dirty: false };
    },
  ],
  [
    "declared conditions",
    (job: BenchJob) => {
      job.capabilities = AdapterTasksResponse.parse({
        tasks: [],
        capabilities: {
          methods: ["policy"],
          scoreKind: "binary",
          rescore: "evidence",
          conditions: { Protocol: "other" },
        },
      }).capabilities;
    },
  ],
] as const)(
  "fingerprints %s and excludes mismatched conditions from paired statistics",
  (_label, change) => {
    const original = comparisonFixture();
    const other = structuredClone(original);
    other.job.id = "other-job";
    change(other.job);
    expect(planDigest(other.job)).not.toBe(planDigest(original.job));
    const comparison = compareJobs([original, other]);
    expect(comparison.stats.score?.pairedTasks).toBe(0);
    expect(
      Object.values(comparison.stats.score?.columns ?? {}).every((column) => column.diff === null),
    ).toBe(true);
  },
);

it("pairs common samples with equivalent effective budgets despite registration metadata", () => {
  const original = comparisonFixture();
  const other = structuredClone(original);
  other.job.id = "other-job";
  other.job.spec.timeoutMin = 10;
  other.job.resources = { "synthetic:task": { cpus: 2, memGB: 4, gpus: 0, timeoutMin: 99 } };
  if (!other.job.benchmarkSnapshot) throw new Error("missing synthetic snapshot");
  other.job.benchmarkSnapshot.updatedAt = "2026-11-07";
  other.job.benchmarkSnapshot.resources = "/synthetic-other-resources.json";
  expect(planDigest(other.job)).toBe(planDigest(original.job));
  other.job.spec.tasks.push("synthetic:unpaired-task");
  other.job.resources["synthetic:unpaired-task"] = { cpus: 32 };
  const comparison = compareJobs([original, other]);
  expect(comparison.stats.score?.pairedTasks).toBe(1);
  expect(Object.values(comparison.stats.score?.columns ?? {}).at(1)?.diff?.mean).toBe(0);
});

describe("planned sample and explicit binding contracts", () => {
  it("retains required legacy seeds and rejects mixed identities and submission parameters", () => {
    expect(SampleIdentity.parse({ seed: 1 })).toEqual({ seed: 1 });
    expect(SampleIdentity.parse({ sampleRef: sample().sampleId })).not.toHaveProperty("seed");
    expect(SampleIdentity.safeParse({}).success).toBe(false);
    expect(SampleIdentity.safeParse({ seed: 1, sampleRef: sample().sampleId }).success).toBe(false);
    const input = {
      benchmark: "synthetic",
      methods: [{ name: "p", agent: "policy", policyRef: "synthetic-policy" }],
    };
    expect(BenchJobSpec.parse({ ...input, samplePlan: plan() }).seeds).toBeUndefined();
    expect(BenchJobSpec.safeParse({ ...input, samplePlan: plan(), seeds: 1 }).success).toBe(false);
    expect(Method.safeParse({ name: "p", agent: "policy" }).success).toBe(false);
    expect(isAgentMethod({ agent: "policy", policySnapshot: { kind: "calibration" } })).toBe(false);
    expect(isAgentMethod({ agent: "policy", policySnapshot: { kind: "model" } })).toBe(true);
  });

  it("checks content digests and duplicate samples, including initial-state identity", () => {
    const original = plan();
    expect(original.items[0]?.sampleId).not.toBe(original.items[1]?.sampleId);
    expect(() => checkSamplePlan({ ...original, digest: `sha256:${"d".repeat(64)}` })).toThrow(
      "digest mismatch",
    );
    const repeated = [sample(), sample()];
    expect(() =>
      checkSamplePlan({ version: 1, items: repeated, digest: contentDigest(repeated) }),
    ).toThrow("duplicate");
    const changed = structuredClone(original);
    if (changed.items[0]) changed.items[0].initialStateId = "9";
    expect(() => checkSamplePlan(changed)).toThrow("sampleId");
  });

  it("rejects missing mappings and frame/action mismatches instead of inferring them", () => {
    const mapping = reference.observationMap;
    const binding = resolveBinding(benchmarkProfile, policyProfile, mapping);
    expect(binding.digest).toMatch(/^sha256:/);
    expect(resolveBinding(benchmarkProfile, policyProfile, mapping)).toEqual(binding);
    expect(() => resolveBinding(benchmarkProfile, policyProfile, {})).toThrow("exactly");
    const changed = structuredClone(policyProfile);
    if (changed.observations.eef_position) changed.observations.eef_position.frame = "tool";
    expect(() => resolveBinding(benchmarkProfile, changed, mapping)).toThrow("semantics");
    expect(() =>
      resolveBinding(
        benchmarkProfile,
        { ...policyProfile, action: { ...policyProfile.action, unit: "metre" } },
        mapping,
      ),
    ).toThrow("action semantics");
  });
});

it("registers policies independently and freezes their definitions and bindings per job", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-embodied-test-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({ name: "synthetic", adapter: "harbor", path: home });
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const bench = new BenchService({ store, paths, runs, registry, self: [process.execPath] });
  bench.policies.put(policy());
  expect(new PolicyRegistry(join(home, "policies.json")).list()).toHaveLength(1);
  vi.spyOn(AdapterClient.prototype, "tasks").mockResolvedValue(
    AdapterTasksResponse.parse({
      tasks: [
        {
          id: "synthetic:task",
          title: "Synthetic task",
          supported: true,
          reason: null,
          tags: { initialStateDigest: `sha256:${"a".repeat(64)}` },
        },
      ],
      capabilities: {
        methods: ["policy"],
        conditions: {},
        scoreKind: "binary",
        rescore: "evidence",
        embodied: {
          profile: reference.id,
          semanticProfile: benchmarkProfile,
          observationMap: reference.observationMap,
        },
      },
    }),
  );
  const solve = vi.spyOn(AdapterClient.prototype, "solve").mockResolvedValue({
    spec: { image: "synthetic-benchmark", command: ["true"] },
    issues: [],
  });
  const verify = vi.spyOn(AdapterClient.prototype, "verify").mockResolvedValue({
    spec: { image: "synthetic-verifier", command: ["true"] },
    issues: [],
  });
  vi.spyOn(AdapterClient.prototype, "score").mockResolvedValue({
    score: 1,
    maxScore: 1,
    invalid: false,
    issues: [],
  });
  let ordinal = 0;
  const submit = vi.spyOn(runs, "submit").mockImplementation(async (spec) => {
    const run = Run.parse({
      id: `synthetic-${++ordinal}`,
      spec,
      state: "queued",
      node: "synthetic",
      reason: null,
      exitCode: null,
      image: null,
      containerId: null,
      lease: null,
      code: null,
      cleanup: "pending",
      note: "",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    });
    store.putRun(run);
    mkdirSync(runs.dirs(run.id).output, { recursive: true });
    return run;
  });
  const mismatched = [sample("0", `sha256:${"f".repeat(64)}`)];
  await expect(
    bench.submit({
      benchmark: "synthetic",
      samplePlan: checkSamplePlan({
        version: 1,
        items: mismatched,
        digest: contentDigest(mismatched),
      }),
      methods: [{ name: "p", agent: "policy", policyRef: "synthetic-policy" }],
    }),
  ).rejects.toThrow("initial-state asset");
  expect(submit).not.toHaveBeenCalled();
  expect(store.listJobs()).toHaveLength(0);
  const job = await bench.submit({
    benchmark: "synthetic",
    samplePlan: plan(),
    methods: [{ name: "p", agent: "policy", policyRef: "synthetic-policy" }],
  });
  await expect.poll(() => store.trials(job.id).filter((t) => t.state === "solving").length).toBe(2);
  expect(job.spec.tasks).toEqual(["synthetic:task"]);
  const changedRuntime = structuredClone(job);
  const frozenPolicy = changedRuntime.spec.methods[0]?.policySnapshot;
  if (!frozenPolicy) throw new Error("missing policy snapshot");
  frozenPolicy.service.image = `synthetic-model@sha256:${"f".repeat(64)}`;
  expect(planDigest(changedRuntime)).not.toBe(planDigest(job));
  const changedBinding = structuredClone(job);
  if (!changedBinding.resolvedBindings?.p) throw new Error("missing resolved binding");
  changedBinding.resolvedBindings.p.digest = `sha256:${"f".repeat(64)}`;
  expect(planDigest(changedBinding)).not.toBe(planDigest(job));
  expect(store.trials(job.id).every((t) => !Object.hasOwn(t, "seed"))).toBe(true);
  expect(solve.mock.calls[0]?.[0].binding).toEqual(job.resolvedBindings?.p);
  expect(submit.mock.calls[0]?.[0].services?.[0]).toMatchObject({
    name: "policy",
    role: "policy",
    gpus: 0,
  });
  expect(submit.mock.calls[0]?.[0].tags?.execution_trial).toBe(store.trials(job.id)[0]?.id);
  bench.policies.remove("synthetic-policy");
  expect(store.getJob(job.id)?.spec.methods[0]?.policySnapshot?.checkpointDigest).toBe(
    policy().checkpointDigest,
  );
  function finish(id: string | null) {
    if (!id) throw new Error("missing synthetic run");
    const run = store.getRun(id);
    if (!run) throw new Error("missing synthetic run record");
    const complete = {
      ...run,
      state: "succeeded" as const,
      cleanup: "done" as const,
      exitCode: 0,
      startedAt: job.createdAt,
      endedAt: new Date().toISOString(),
    };
    store.putRun(complete);
    runs.emit("change", { run: complete });
  }
  for (const trial of store.trials(job.id)) finish(trial.solveRunId);
  await expect.poll(() => verify.mock.calls.length).toBe(2);
  await expect
    .poll(() => store.trials(job.id).filter((t) => t.state === "verifying").length)
    .toBe(2);
  expect(submit.mock.calls.slice(2).every(([spec]) => !spec.services?.length)).toBe(true);
  for (const trial of store.trials(job.id)) finish(trial.verifyRunId);
  await expect.poll(() => store.getJob(job.id)?.state).toBe("done");
  const before = store.trials(job.id);
  const first = before[0];
  if (!first) throw new Error("missing planned trial");
  bench.rescore(job.id, { trials: [first.id] });
  await expect.poll(() => verify.mock.calls.length).toBe(3);
  const rescored = store.trials(job.id).find((t) => t.id === first.id);
  finish(rescored?.verifyRunId ?? null);
  await expect.poll(() => store.trials(job.id).find((t) => t.id === first.id)?.state).toBe("done");
  expect(solve).toHaveBeenCalledTimes(2);
  expect(store.trials(job.id)[1]).toEqual(before[1]);
  expect(store.trials(job.id)[0]?.history).toHaveLength(1);
  const report = buildReport(
    store.getJob(job.id) ?? job,
    store.trials(job.id),
    "rescore",
    1,
    new Date().toISOString(),
  );
  expect(report.methods[0]?.entries.map((entry) => entry.sample).sort()).toEqual(
    plan()
      .items.map((item) => item.sampleId)
      .sort(),
  );
  expect(report.aggregator).toBe("orbit-report/2");
  const alternate = [sample("9")];
  const alternatePlan = checkSamplePlan({
    version: 1,
    items: alternate,
    digest: contentDigest(alternate),
  });
  const otherJob = BenchJob.parse({
    ...job,
    id: "synthetic-other",
    spec: { ...job.spec, seeds: undefined, samplePlan: alternatePlan },
  });
  const otherTrials = [
    Trial.parse({
      ...before[0],
      id: "synthetic-other.1",
      jobId: otherJob.id,
      sampleRef: alternate[0]?.sampleId,
    }),
  ];
  const comparison = compareJobs([
    { job, trials: store.trials(job.id) },
    { job: otherJob, trials: otherTrials },
  ]);
  expect(comparison.stats.score?.pairedTasks).toBe(0);
  expect(
    Object.values(comparison.stats.score?.columns ?? {}).every((column) => column.diff === null),
  ).toBe(true);

  expect(
    AdapterRequest.safeParse({
      protocol: 1,
      op: "solve",
      benchmark: { name: "x", path: home, config: {} },
      trial: { ...solve.mock.calls[0]?.[0], seed: 1 },
    }).success,
  ).toBe(false);

  // Simulate legacy evidence with no execution_trial, then adopt it twice and rescore.
  const sourceTrial = store.trials(job.id)[0];
  if (!sourceTrial?.solveRunId) throw new Error("missing source solve");
  const sourceRun = store.getRun(sourceTrial.solveRunId);
  if (!sourceRun) throw new Error("missing source Run");
  delete sourceRun.spec.tags.execution_trial;
  store.putRun(sourceRun);
  let sourceJob = store.getJob(job.id) ?? job;
  for (const id of ["synthetic-merge-one", "synthetic-merge-two"]) {
    const target = { ...structuredClone(sourceJob), id };
    store.putJob(target);
    for (const [i, trial] of store.trials(sourceJob.id).entries()) {
      store.putTrial(
        Trial.parse({
          ...trial,
          id: `${id}.${i}`,
          jobId: id,
          outcome: null,
          solveRunId: null,
          verifyRunId: null,
          history: [],
          state: "done",
        }),
      );
    }
    const preview = await bench.consolidate(id, { sources: [sourceJob.id] });
    await bench.consolidate(id, { sources: [sourceJob.id], dryRun: false, expect: preview.digest });
    sourceJob = store.getJob(id) ?? target;
    expect(store.getRun(sourceRun.id)?.spec.tags.execution_trial).toBe(sourceTrial.id);
  }
  const adopted = store.trials(sourceJob.id).find((trial) => trial.solveRunId === sourceRun.id);
  if (!adopted) throw new Error("missing adopted trial");
  bench.rescore(sourceJob.id, { trials: [adopted.id] });
  await expect.poll(() => verify.mock.calls.length).toBe(4);
  expect(verify.mock.calls.at(-1)?.[1]?.run.spec.tags).toMatchObject({
    trial: adopted.id,
    execution_trial: sourceTrial.id,
  });
  finish(store.getTrial(adopted.id)?.verifyRunId ?? null);
  await expect.poll(() => store.getTrial(adopted.id)?.outcome?.evaluation).toBe("valid");
  expect(solve).toHaveBeenCalledTimes(2);
});
