/** Export study evidence through the existing read-only API; never reads the database. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentDigest } from "../packages/orbit/src/bench/samples.ts";
import { tryConnect } from "../packages/orbit/src/client/index.ts";
import { orbitPaths } from "../packages/orbit/src/config/paths.ts";
import type { BenchJob, BenchReport, Run } from "../packages/orbit/src/contracts/index.ts";
import type { FrozenStudy, StudyEvidence } from "./evolution-study.ts";
import { studyBudget } from "./evolution-study.ts";

export interface StudyCapture
  extends Omit<StudyEvidence, "jobs" | "reports" | "runs" | "allocation"> {
  sources: {
    home: string;
    jobs: { id: string; owner: string }[];
    /** Editors and additional model calls, including failures before a candidate exists. */
    runs: { id: string; owner: string }[];
  }[];
}
export async function captureStudy(
  study: FrozenStudy,
  index: StudyCapture,
): Promise<StudyEvidence> {
  studyBudget(study, []);
  assert(index.planDigest === study.digest, "capture index names another plan");
  const jobs = new Map<string, BenchJob>(),
    reports = new Map<string, BenchReport>(),
    runs = new Map<string, Run>();
  const owners = new Map<string, string>();
  const add = <T>(map: Map<string, T>, key: string, value: T) => {
    const old = map.get(key);
    assert(!old || contentDigest(old) === contentDigest(value), `conflicting snapshot: ${key}`);
    map.set(key, value);
  };
  // Gate snapshots preserve historical lineage even if old jobs have been removed.
  for (const round of index.rounds)
    if (round.gate) {
      for (const job of round.gate.evidence.jobs) add(jobs, job.id, job);
      for (const report of round.gate.evidence.reports)
        add(reports, `${report.jobId}@${report.revision}`, report);
    }
  for (const source of index.sources) {
    const client = await tryConnect(
      orbitPaths({ ...process.env, ORBIT_HOME: resolve(source.home), ORBIT_DATA: undefined }),
    );
    assert(client, "start the study daemon before capturing evidence");
    const captureRun = async (id: string, owner: string) => {
      const run = await client.get(id);
      // Historical learning/baseline evidence belongs to provenance, not the new-run budget.
      if (Date.parse(run.createdAt) < Date.parse(study.frozenAt)) return;
      assert(!owners.has(id) || owners.get(id) === owner, `conflicting allocation: ${id}`);
      add(runs, id, run);
      owners.set(id, owner);
    };
    for (const item of source.jobs) {
      const detail = await client.benchJob(item.id),
        snapshots = await client.benchReports(item.id);
      add(jobs, item.id, detail.job);
      for (const report of snapshots) add(reports, `${report.jobId}@${report.revision}`, report);
      const attempts = new Set(
        detail.trials
          .flatMap((t) => [t.solveRunId, ...(t.priorAttempts ?? []).map((a) => a.solveRunId)])
          .filter((id): id is string => Boolean(id)),
      );
      for (const report of snapshots)
        for (const method of report.methods)
          for (const cost of method.costs ?? []) attempts.add(cost.run);
      for (const id of attempts) await captureRun(id, item.owner);
    }
    for (const item of source.runs) await captureRun(item.id, item.owner);
  }
  return {
    planDigest: index.planDigest,
    rounds: index.rounds,
    closed: index.closed,
    finals: index.finals,
    jobs: [...jobs.values()],
    reports: [...reports.values()],
    runs: [...runs.values()],
    allocation: [...owners].map(([run, owner]) => ({ run, owner })),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [frozen, index, out] = process.argv.slice(2);
    assert(
      frozen && index && out && process.argv.length === 5,
      "usage: evolution-study-capture.ts FROZEN INDEX OUTPUT",
    );
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
    const evidence = await captureStudy(read(frozen), read(index));
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        jobs: evidence.jobs.length,
        reports: evidence.reports.length,
        modelRuns: evidence.runs.length,
      }),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
