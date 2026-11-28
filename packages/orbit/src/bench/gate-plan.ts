import { type Benchmark, GatePlan, isCliMethod, type MethodRevision } from "../contracts/index.ts";
import type { Store } from "../store/index.ts";
import { gate, gateBenchmark } from "./gate.ts";
import { resolveGateEvidence } from "./gates.ts";
import { benchmarkExecutionDigest, benchmarkExecutionSettings } from "./revision.ts";
import { contentDigest } from "./samples.ts";

/** Read saved evidence only. Planning neither saves a verdict nor submits/backfills a job. */
export function planGate(store: Store, input: unknown, registrations: Benchmark[]): GatePlan {
  return store.tx(() => {
    const { request, evidence, sets, parentRevision, childRevision } = resolveGateEvidence(
      store,
      input,
      true,
    );
    const preview = gate(request.parent, request.child, request.policy, evidence, request.mode);
    const rows: GatePlan["rows"] = [];
    for (const set of sets)
      for (const side of ["parent", "child"] as const) {
        const target = side === "parent" ? parentRevision : childRevision;
        const matches = (r: MethodRevision) =>
          set.agent
            ? r.basis.agent === set.agent && r.basis.bundleDigest === target.basis.bundleDigest
            : r.revision === target.revision;
        const jobs = evidence.jobs.filter(
          (job) =>
            gateBenchmark(job) === set.dataset.benchmark &&
            job.taskFile?.sha256 === set.dataset.tasks.sha256 &&
            Object.values(job.revisions).some(matches),
        );
        const selected =
          evidence.selections.find((s) => s.set === set.set)?.[side] ??
          (set[side].length === 1 && request.mode !== "calibration-aa" ? set[side][0] : null) ??
          null;
        const row: GatePlan["rows"][number] = {
          set: set.set,
          side,
          benchmark: set.dataset.benchmark,
          tasksFile: set.dataset.tasks.file,
          revision: target.revision,
          status: "missing",
          reason: "No frozen report for this task set and version.",
          candidates: set[side],
          selected,
          jobs: jobs.map((j) => j.id),
          command: null,
        };
        rows.push(row);
        if (selected) {
          const chosen = evidence.jobs.find((j) => j.id === selected.job)?.revisions[
            selected.method
          ];
          row.revision = chosen?.revision ?? null;
          row.status =
            chosen &&
            matches(chosen) &&
            row.candidates.some(
              (ref) =>
                ref.job === selected.job &&
                ref.revision === selected.revision &&
                ref.method === selected.method,
            )
              ? "available"
              : "blocked";
          row.reason =
            row.status === "available"
              ? "Exact immutable report selected; review the shared prerequisite checks."
              : "Selected report does not match this side, benchmark, task file or metric.";
          continue;
        }
        if (set[side].length > 1 || (request.mode === "calibration-aa" && set[side].length)) {
          row.status = "ambiguous";
          row.reason =
            "Select both report references explicitly with --reports; no newest/best report is inferred.";
          continue;
        }
        const pending = jobs.filter(
          (j) => store.getJob(j.id) && (j.state === "running" || store.hasOpenTrials(j.id)),
        );
        if (pending.length) {
          row.status = "pending";
          row.reason =
            "Matching job still has pending work; wait for it instead of starting a duplicate.";
          row.jobs = pending.map((j) => j.id);
          continue;
        }
        const unpublished = jobs.filter(
          (j) => store.getJob(j.id) && store.reports(j.id).length === 0,
        );
        if (unpublished.length === 1) {
          row.reason = "Finished job has no saved report; inspect/backfill it before rerunning.";
          row.command = ["orbit", "bench", "report", unpublished[0]?.id ?? "", "--json"];
          continue;
        }
        if (unpublished.length > 1) {
          row.status = "ambiguous";
          row.reason =
            "Multiple unreported jobs; choose one explicitly before creating report evidence.";
          continue;
        }
        if (jobs.length) {
          row.status = "blocked";
          row.reason =
            "Stored reports do not contain the requested metric/method; reconcile report evidence before rerunning.";
          continue;
        }
        const methodSources = evidence.jobs.flatMap((job) =>
          Object.entries(job.revisions)
            .filter(([, r]) => matches(r))
            .flatMap(([name, revision]) => {
              const method = job.spec.methods.find((m) => m.name === name);
              return method ? [{ job, method, revision }] : [];
            }),
        );
        const methods = [
          ...new Map(
            methodSources.map((s) => [
              contentDigest({
                method: s.method,
                lineage: s.job.spec.lineage[s.method.name] ?? null,
              }),
              s,
            ]),
          ).values(),
        ];
        const templates = evidence.jobs.filter(
          (j) =>
            gateBenchmark(j) === set.dataset.benchmark &&
            j.benchmarkSnapshot &&
            !j.spec.calibration,
        );
        const exact = templates.filter((j) => j.taskFile?.sha256 === set.dataset.tasks.sha256);
        const configurations = [
          ...new Map(
            (exact.length ? exact : templates).map((j) => [
              contentDigest({
                benchmark: benchmarkExecutionSettings(j.benchmarkSnapshot as Benchmark),
                options: j.spec.options,
                seeds: j.spec.seeds,
                samplePlan: j.spec.samplePlan ?? null,
                timeout: j.spec.timeoutMin ?? null,
                checkpoint: j.spec.checkpoint ?? null,
                source: j.source,
              }),
              j,
            ]),
          ).values(),
        ];
        const template = configurations.length === 1 ? configurations[0] : undefined;
        const source = methods.length === 1 ? methods[0] : undefined;
        const block = (reason: string) => {
          row.status = "blocked";
          row.reason = reason;
        };
        if (!source || !template) {
          block(
            "Need an unambiguous saved method/lineage and benchmark execution template. Run an evolve smoke first; no auth, seeds or options are guessed.",
          );
          row.revision = source?.revision.revision ?? null;
          continue;
        }
        row.revision = source.revision.revision;
        const { method, revision } = source;
        if (
          !isCliMethod(method) ||
          !method.bundle ||
          revision.approximate ||
          !revision.basis.bundleDigest
        ) {
          block("A fully recorded CLI method with a bundle is required for a rerun command.");
          continue;
        }
        const benchmark = registrations.find((b) => b.name === template.spec.benchmark);
        if (
          !benchmark ||
          !template.benchmarkSnapshot ||
          benchmarkExecutionDigest(benchmark) !==
            benchmarkExecutionDigest(template.benchmarkSnapshot)
        ) {
          block(
            "The recorded benchmark registration is missing or its execution settings changed; reconcile it first.",
          );
          continue;
        }
        if (template.spec.samplePlan) {
          block(
            "This benchmark requires a frozen sample-plan file; export/select that plan explicitly before submission.",
          );
          continue;
        }
        const lineage = source.job.spec.lineage[method.name];
        const values = [
          method.name,
          method.agent,
          method.auth,
          method.model,
          method.effort,
          method.bundle,
        ];
        if (values.some((v) => v && /[,\r\n\0]/.test(v))) {
          block(
            "Saved method values cannot be represented by --method; use an explicit methods file.",
          );
          continue;
        }
        const spec = `${method.name}=${method.agent}${(
          ["auth", "model", "effort", "bundle"] as const
        )
          .flatMap((key) => (method[key] ? [`,${key}=${method[key]}`] : []))
          .join("")}`;
        row.command = [
          "orbit",
          "bench",
          "run",
          benchmark.name,
          "--tasks-file",
          set.dataset.tasks.file,
          "--expect-tasks-sha256",
          set.dataset.tasks.sha256,
          "--method",
          spec,
          "--expect-revision",
          revision.revision,
          "--seeds",
          String(template.spec.seeds),
          ...Object.entries(template.spec.options).flatMap(([key, value]) => [
            "--option",
            `${key}=${value}`,
          ]),
          ...(template.spec.timeoutMin === undefined
            ? []
            : ["--timeout", String(template.spec.timeoutMin)]),
          ...(template.spec.checkpoint
            ? ["--checkpoint", String(template.spec.checkpoint.maxSizeGB)]
            : []),
          ...(lineage?.parent ? ["--parent", lineage.parent] : []),
          ...(lineage?.note ? ["--note", lineage.note] : []),
          ...(lineage?.informedBy ?? []).flatMap((trial) => ["--informed-by", trial]),
          "--json",
        ];
        row.reason =
          "Suggested submission from saved method and benchmark settings; expected revision is checked before any job is created.";
      }
    return GatePlan.parse({
      parent: request.parent,
      child: request.child,
      policyDigest: preview.inputs.policyDigest,
      checks: preview.checks,
      rows,
    });
  });
}
