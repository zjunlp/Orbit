// Synthetic immutable report fixtures; real report builder and gate core. No Agent or experiment is run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gate } from "../../src/bench/gate.ts";
import { revisionOf } from "../../src/bench/revision.ts";
import { buildReport } from "../../src/bench/summary.ts";
import { taskSetDigest } from "../../src/bench/task-sets.ts";
import {
  BenchJob,
  type BenchReport,
  type GateEvidence,
  GatePolicy,
  type MethodBasis,
  Outcome,
  Run,
  Trial,
} from "../../src/contracts/index.ts";

export const base: MethodBasis = {
  agent: "codex",
  model: "fixture-model",
  effort: "medium",
  authKind: "api-key",
  cliVersion: "1.0",
  bundleDigest: "a".repeat(64),
  entrypoint: null,
  config: null,
};
export const parent = revisionOf(base);
export const child = revisionOf({ ...base, bundleDigest: "b".repeat(64) });
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export function fixture(n = 60) {
  const evidence: GateEvidence = { jobs: [], reports: [], taskSets: [], selections: [] };
  const policy = GatePolicy.parse({
    version: 1,
    gate: { benchmark: "fixture", tasks: { file: "gate.txt", sha256: "a".repeat(64) } },
  });
  const pair = (
    set: string,
    benchmark = "fixture",
    a = Array(n).fill(50) as number[],
    b = Array(n).fill(65) as number[],
    agent = "codex",
  ) => {
    const tasks = Array.from({ length: a.length }, (_, i) => `${set}/${i}`);
    const file = `${set}.txt`;
    const content = `${tasks.join("\n")}\n`;
    const p = agent === "codex" ? parent : revisionOf({ ...parent.basis, agent });
    const c = agent === "codex" ? child : revisionOf({ ...child.basis, agent });
    const jobs = [p, c].map((revision, i) =>
      BenchJob.parse({
        id: `${set}-${i}`,
        spec: {
          benchmark,
          tasks,
          methods: [
            { name: "candidate", agent, auth: "fixture", model: "fixture-model", effort: "medium" },
          ],
          lineage: i ? { candidate: { parent: p.revision } } : {},
        },
        taskSet: taskSetDigest(tasks),
        taskFile: { sha256: sha(content) },
        revisions: { candidate: revision },
        benchmarkSnapshot: {
          name: benchmark,
          adapter: "harbor",
          path: `/fixture/${benchmark}`,
          config: {},
          env: {},
          passEnv: [],
          labels: { identity: { id: benchmark, name: benchmark, version: "1" } },
          createdAt: "",
          updatedAt: "",
        },
        source: { commit: "a".repeat(40), describe: null, dirty: false },
        state: "done",
        createdAt: `2026-11-14T00:0${i}:00Z`,
        endedAt: `2026-11-14T00:0${i}:00Z`,
      }),
    );
    const reports = jobs.map((job, i) => {
      const rows = tasks.map((task, k) =>
        Trial.parse({
          id: `${job.id}.${k}`,
          jobId: job.id,
          task,
          method: "candidate",
          seed: 1,
          state: "done",
          solveRunId: `${job.id}.${k}-solve`,
          verifyRunId: null,
          history: [],
          outcome: Outcome.parse({
            execution: "succeeded",
            evaluation: "valid",
            score: (i ? b : a)[k],
            maxScore: 100,
            issues: [],
            cleanup: "done",
          }),
          createdAt: job.createdAt,
          endedAt: job.endedAt,
        }),
      );
      return buildReport(job, rows, "finished", 1, job.createdAt, (id) =>
        Run.parse({
          id,
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
          createdAt: job.createdAt,
          startedAt: "2026-11-14T00:00:00Z",
          endedAt: "2026-11-14T00:00:10Z",
          tokens: {
            input: 100,
            output: 20,
            cachedInput: 0,
            cacheWrite: 0,
            reasoning: 0,
            calls: 1,
            source: "session",
          },
        }),
      );
    });
    const jobA = jobs[0],
      jobB = jobs[1],
      reportA = reports[0],
      reportB = reports[1];
    assert(jobA && jobB && reportA && reportB);
    evidence.jobs.push(jobA, jobB);
    evidence.reports.push(reportA, reportB);
    evidence.taskSets.push({ file, content });
    evidence.selections.push({
      set,
      parent: { job: jobA.id, revision: 1, method: "candidate" },
      child: { job: jobB.id, revision: 1, method: "candidate" },
    });
    return {
      a: jobA,
      b: jobB,
      ra: reportA,
      rb: reportB,
      dataset: { benchmark, tasks: { file, sha256: sha(content) } },
      tasks,
    };
  };
  const target = pair("gate");
  policy.gate = target.dataset;
  const check = () => gate(parent.revision, child.revision, policy, evidence);
  return { evidence, policy, pair, target, check };
}
export function method(report: BenchReport) {
  const m = report.methods[0];
  assert(m);
  return m;
}
