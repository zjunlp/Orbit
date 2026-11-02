// Pure completed-record fixtures: no daemon, store, files or executor.
import { describe, expect, it } from "vitest";
import { planConsolidation, type Transport } from "../src/bench/consolidate.ts";
import {
  AuthProfile,
  BenchJob,
  type BenchJobDetail,
  Benchmark,
  Outcome,
  Run,
  Trial,
} from "../src/contracts/index.ts";
import type { AgentFailure } from "../src/sessions/index.ts";

const at = "2026-10-16T00:00:00.000Z";
function fixture() {
  const oldRuns = new Map<string, Run>();
  const detail = (id: string, tasks: string[], evaluation: "valid" | "invalid"): BenchJobDetail => {
    const job = BenchJob.parse({
      id,
      spec: {
        benchmark: "fixture",
        tasks,
        methods: [{ name: "agent", agent: "codex", auth: "host" }],
      },
      folder: id,
      state: "done",
      createdAt: at,
      endedAt: at,
    });
    const trials = tasks.map((task) => {
      const trialId = `${id}.${task}`;
      for (const phase of ["solve", "verify"]) {
        const rid = `${trialId}-${phase}`;
        oldRuns.set(
          rid,
          Run.parse({
            id: rid,
            spec: { backend: "process", command: ["true"] },
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
          }),
        );
      }
      return Trial.parse({
        id: trialId,
        jobId: id,
        task,
        method: "agent",
        seed: 1,
        state: "done",
        solveRunId: `${trialId}-solve`,
        verifyRunId: `${trialId}-verify`,
        outcome: Outcome.parse({
          execution: "succeeded",
          evaluation,
          score: 0,
          maxScore: 1,
          issues: [],
          cleanup: "done",
        }),
        createdAt: at,
        endedAt: at,
      });
    });
    return { job, trials, summary: [] };
  };
  const target = detail("target", ["a", "old"], "invalid");
  const donor = detail("donor", ["a"], "valid");
  const failures = new Map<string, AgentFailure>();
  const transport: Transport = {
    benchmarks: new Map(
      ["fixture", "alias"].map((name) => [
        name,
        Benchmark.parse({
          name,
          path: "/fixture",
          adapter: "harbor",
          env: { HTTPS_PROXY: name },
          createdAt: at,
          updatedAt: at,
        }),
      ]),
    ),
    profiles: new Map(
      ["host", "bridge"].map((name) => [
        name,
        {
          profile: AuthProfile.parse({
            name,
            harness: "codex",
            kind: "api-key",
            secretHint: "fixture",
            hostNetwork: name === "host",
            createdAt: at,
            updatedAt: at,
          }),
          secret: "explicit-fixture-secret",
        },
      ]),
    ),
  };
  return { target, donor, oldRuns, failures, transport, detail };
}
const flags = Array.from({ length: 16 }, (_, bits) => ({
  replaceFailed: Boolean(bits & 1),
  appendTasks: Boolean(bits & 2),
  pruneInvalid: Boolean(bits & 4),
  allowTransportDifferences: Boolean(bits & 8),
}));

it("compares saved benchmark conditions even when the registration has since changed", () => {
  const f = fixture();
  const registration = f.transport.benchmarks.get("fixture");
  if (!registration) throw new Error("missing fixture registration");
  f.target.job.benchmarkSnapshot = structuredClone(registration);
  f.donor.job.benchmarkSnapshot = { ...registration, config: { actionSet: "bid" } };
  const plan = () =>
    planConsolidation({
      ...f,
      donors: [f.donor],
      flags: { sources: [f.donor.job.id], allowTransportDifferences: true },
    });
  expect(plan).toThrow("incompatible source job");
  f.donor.job.benchmarkSnapshot = { ...registration, updatedAt: "2026-11-02" };
  expect(plan().adopted).toHaveLength(1);
  delete f.donor.job.benchmarkSnapshot;
  expect(plan).toThrow("incompatible source job");
});

it("allows explicit proxy-only differences using saved settings after registrations are removed", () => {
  const f = fixture();
  f.target.job.benchmarkSnapshot = f.transport.benchmarks.get("fixture");
  f.donor.job.benchmarkSnapshot = f.transport.benchmarks.get("alias");
  f.donor.job.spec.benchmark = "alias";
  const input = {
    ...f,
    transport: { ...f.transport, benchmarks: new Map() },
    donors: [f.donor],
    flags: { sources: [f.donor.job.id] },
  };
  expect(() => planConsolidation(input)).toThrow("incompatible source job");
  expect(
    planConsolidation({ ...input, flags: { ...input.flags, allowTransportDifferences: true } })
      .adopted,
  ).toHaveLength(1);
});

describe.each(flags)("planner flags %o", (flags) => {
  it("retains compatible retries and rejects conflicting artifact policies without mutating inputs", () => {
    const { target, donor, oldRuns, failures, transport } = fixture();
    const input = {
      target,
      donors: [donor],
      oldRuns,
      failures,
      transport,
      flags: { ...flags, sources: [donor.job.id] },
    };
    const before = structuredClone(input);
    const plan = () => planConsolidation(input);
    if (flags.pruneInvalid && (flags.appendTasks || flags.replaceFailed)) {
      expect(plan).toThrow(/preserves.*artifacts/);
    } else {
      const out = plan();
      expect(out.adopted).toEqual([
        { task: "a", sourceJob: "donor", sourceTrial: "donor.a", trial: "target.a" },
      ]);
      expect(out.removedRuns).toContain("target.a-solve");
      expect(out.removedRuns.includes("target.old-solve")).toBe(flags.pruneInvalid);
      expect(out.moved.map((r) => r.spec.tags.trial)).toEqual(["target.a", "target.a"]);
      expect(out.digest).toBe(plan().digest);
      expect(out.trials[0]?.outcome?.score).toBe(0);
    }
    expect(input).toEqual(before);
  });
});

it.each([false, true])(
  "replaces a scored failed solve only when replaceFailed=%s",
  (replaceFailed) => {
    const f = fixture();
    const trial = f.target.trials[0] as Trial;
    if (!trial.outcome) throw new Error("fixture");
    trial.outcome.evaluation = "valid";
    trial.outcome.score = 1;
    const run = f.oldRuns.get(trial.solveRunId as string) as Run;
    run.state = "failed";
    const input = { ...f, donors: [f.donor], flags: { sources: ["donor"], replaceFailed } };
    if (replaceFailed) expect(planConsolidation(input).trials[0]?.outcome?.score).toBe(0);
    else expect(() => planConsolidation(input)).toThrow("refusing to replace valid");
  },
);

it.each([false, true])(
  "appends invalid tasks with artifacts only when appendTasks=%s",
  (appendTasks) => {
    const f = fixture();
    const extra = f.detail("extra", ["new"], "invalid");
    extra.job.resources = { new: { cpus: 2 } };
    const input = { ...f, donors: [extra], flags: { sources: ["extra"], appendTasks } };
    if (!appendTasks)
      return expect(() => planConsolidation(input)).toThrow("not in the target matrix");
    const plan = planConsolidation(input);
    expect(plan.job.spec.tasks).toEqual(["a", "old", "new"]);
    expect(plan.job.resources?.new).toEqual({ cpus: 2 });
    expect(plan.trials.at(-1)).toMatchObject({
      jobId: "target",
      outcome: { evaluation: "invalid" },
      solveRunId: "extra.new-solve",
    });
    expect(plan.removedRuns).not.toContain("extra.new-verify");
  },
);

it.each([false, true])(
  "accepts equivalent transport only when allowTransportDifferences=%s",
  (allowTransportDifferences) => {
    const f = fixture();
    f.donor.job.spec.benchmark = "alias";
    const method = f.donor.job.spec.methods[0];
    if (!method) throw new Error("fixture");
    method.auth = "bridge";
    const input = {
      ...f,
      donors: [f.donor],
      flags: { sources: ["donor"], allowTransportDifferences },
    };
    if (allowTransportDifferences) expect(planConsolidation(input).adopted).toHaveLength(1);
    else expect(() => planConsolidation(input)).toThrow("incompatible source");
    f.donor.job.source = { commit: "different", describe: null, dirty: false };
    expect(() => planConsolidation(input)).toThrow("incompatible source");
  },
);

it("retains freshly reclassified evidence, then produces a new digest for a later prune", () => {
  const f = fixture();
  const trial = f.target.trials[0] as Trial;
  if (!trial.outcome) throw new Error("fixture");
  trial.outcome.evaluation = "valid";
  trial.history = [{ verifyRunId: null, endedAt: at, outcome: structuredClone(trial.outcome) }];
  f.failures.set(trial.solveRunId as string, {
    kind: "model_unreachable",
    message: "fixture endpoint unavailable",
  });
  const input = {
    target: f.target,
    donors: [],
    oldRuns: f.oldRuns,
    failures: f.failures,
    flags: { pruneInvalid: true },
  };
  const before = structuredClone(input);
  const plan = planConsolidation(input);
  expect(plan.reclassified).toEqual([
    { job: "target", trial: trial.id, task: "a", kind: "model_unreachable" },
  ]);
  expect(plan.removedRuns).not.toContain(trial.solveRunId);
  expect(plan.trials[0]?.history[0]?.outcome.evaluation).toBe("invalid");
  expect(input).toEqual(before);
  const later = { ...input, target: { ...input.target, job: plan.job, trials: plan.trials } };
  expect(planConsolidation(later).digest).not.toBe(plan.digest);
  expect(() =>
    planConsolidation({
      ...later,
      flags: { pruneInvalid: true, dryRun: false, expect: plan.digest },
    }),
  ).toThrow("plan changed");
});
