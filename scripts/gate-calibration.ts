/** Development calibration over exported immutable records; never submits or changes experiments. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gate } from "../packages/orbit/src/bench/gate.ts";
import { GateRecord } from "../packages/orbit/src/contracts/index.ts";
import { lowerBound, pairedDiff, resolveMetrics } from "../packages/orbit/src/contracts/metrics.ts";

export function calibrateGateRecords(
  aa: GateRecord,
  destructive: GateRecord,
  draws = 5000,
  seed = 42,
) {
  if (!Number.isSafeInteger(draws) || draws < 100 || draws > 100000 || !Number.isSafeInteger(seed))
    throw new Error("draws must be 100–100000 and seed must be an integer");
  for (const record of [aa, destructive]) {
    const v = record.verdict;
    const replay = gate(
      v.inputs.parent,
      v.inputs.child,
      record.policy,
      record.evidence,
      record.mode,
    );
    if (JSON.stringify(replay) !== JSON.stringify(v))
      throw new Error("saved verdict does not match its frozen evidence");
  }
  const prerequisite = (r: GateRecord) =>
    r.verdict.checks.filter((c) => c.required && c.prerequisite).every((c) => c.status === "pass");
  const selection = aa.evidence.selections.find((s) => s.set === "gate");
  if (aa.mode !== "calibration-aa" || !selection || !prerequisite(aa))
    throw new Error("A/A needs comparable independent runs with sufficient evidence");
  const entries = (ref: typeof selection.parent) =>
    aa.evidence.reports
      .find((r) => r.jobId === ref.job && r.revision === ref.revision)
      ?.methods.find((m) => m.method === ref.method)?.entries ?? [];
  const excluded = new Set(
    aa.verdict.inputs.taskSets.find((t) => t.set === "gate")?.excluded.map((t) => t.task),
  );
  const right = new Map(entries(selection.child).map((e) => [e.sample, e]));
  const byTask = new Map<string, number[]>();
  for (const a of entries(selection.parent)) {
    const b = right.get(a.sample);
    if (
      !b ||
      excluded.has(a.task) ||
      a.evaluation !== "valid" ||
      b.evaluation !== "valid" ||
      a.value === null ||
      b.value === null
    )
      continue;
    const values = byTask.get(a.task) ?? [];
    values.push(b.value - a.value);
    byTask.set(a.task, values);
  }
  const job = aa.evidence.jobs.find((j) => j.id === selection.parent.job);
  const metric = resolveMetrics(job?.metrics ?? []).find(
    (m) => m.name === (aa.policy.gate.metric ?? aa.policy.metric),
  );
  if (!metric) throw new Error("calibration metric is unavailable");
  const direction = metric.higherIsBetter ? 1 : -1;
  const differences = [...byTask.values()].map(
    (xs) => (direction * xs.reduce((a, b) => a + b, 0)) / xs.length,
  );
  if (differences.length < 2) throw new Error("at least two paired tasks are required");
  const center = differences.reduce((a, b) => a + b, 0) / differences.length;
  const centered = differences.map((d) => d - center);
  let state = seed | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const baseline = new Map(differences.map((_, i) => [String(i), { mean: 0 }]));
  let accepted = 0;
  for (let draw = 0; draw < draws; draw++) {
    const sampled = new Map(
      differences.map((_, i) => [
        String(i),
        { mean: centered[Math.floor(random() * centered.length)] ?? 0 },
      ]),
    );
    if ((lowerBound(pairedDiff(baseline, sampled), aa.verdict.alpha.level) ?? -Infinity) > 0)
      accepted++;
  }
  const aaImprovement = aa.verdict.checks.find((c) => c.set === "gate" && c.kind === "improvement");
  const aaPassed = Boolean(aaImprovement && aaImprovement.status !== "pass");
  const destructivePassed =
    destructive.mode === "promotion" &&
    prerequisite(destructive) &&
    destructive.verdict.decision === "reject" &&
    destructive.verdict.checks.some(
      (c) => c.set === "gate" && c.kind === "improvement" && c.status === "fail",
    );
  return {
    passed: aaPassed && destructivePassed,
    checks: {
      aa: aaPassed ? "passed" : "failed",
      destructive: destructivePassed ? "passed" : "failed",
    },
    records: { aa: aa.id, destructive: destructive.id },
    resampling: {
      method: "task-paired centered bootstrap",
      seed,
      draws,
      tasks: differences.length,
      alpha: aa.verdict.alpha.level,
      acceptanceRate: accepted / draws,
      degenerate: centered.every((d) => d === 0),
    },
    limitation:
      "A development calibration on these tasks; degenerate A/A differences cannot estimate nonzero run noise, and this is not a guarantee for adaptive gate reuse.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      aa: { type: "string" },
      destructive: { type: "string" },
      draws: { type: "string", default: "5000" },
      seed: { type: "string", default: "42" },
    },
  });
  if (!values.aa || !values.destructive)
    throw new Error("--aa RECORD.json and --destructive RECORD.json are required");
  const load = (file: string) => GateRecord.parse(JSON.parse(readFileSync(file, "utf8")));
  const report = calibrateGateRecords(
    load(values.aa),
    load(values.destructive),
    Number(values.draws),
    Number(values.seed),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
