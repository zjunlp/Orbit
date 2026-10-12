import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import {
  type BenchCompare,
  type BenchJobDetail,
  type BenchJobList,
  type Benchmark,
  type BenchTask,
  type BenchUsage,
  type MethodSummary,
  type MetricSpec,
  trialRunIds,
} from "../contracts/index.ts";
import { fmtCi, fmtMetric, primaryMetric, resolveMetrics } from "../contracts/metrics.ts";
import { kv, type Print } from "./auth.ts";
import { confirmTyped } from "./confirm.ts";

type Job = BenchJobList["jobs"][number];

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** `72.5% ±3.2`: a metric's mean with the half width of its 95% CI. */
const statText = (s: MethodSummary["metrics"][string] | undefined, m: MetricSpec) =>
  s ? `${fmtMetric(s.mean, m)}${fmtCi(s, m) ? ` ${fmtCi(s, m)}` : ""}` : "-";

/**
 * `name=agent[,auth=P][,model=M][,effort=E][,bundle=DIR]`; a bare `oracle` / `empty` names itself.
 */
export function parseMethod(text: string): Record<string, string> {
  if (text === "oracle" || text === "empty") return { name: text, agent: text };
  const [head, ...rest] = text.split(",");
  const i = head?.indexOf("=") ?? -1;
  if (!head || i <= 0) throw new Error(`--method must be name=agent[,key=value...]: ${text}`);
  const m: Record<string, string> = { name: head.slice(0, i), agent: head.slice(i + 1) };
  for (const [k, v] of Object.entries(kv(rest, "--method option"))) {
    if (!["auth", "model", "effort", "bundle"].includes(k))
      throw new Error(`unknown --method key ${k} (auth, model, effort, bundle)`);
    m[k] = k === "bundle" ? resolve(v) : v;
  }
  return m;
}

function summaryLine(s: MethodSummary, m: MetricSpec): string {
  const bad = [
    s.invalid ? `${s.invalid} invalid` : "",
    s.unknown ? `${s.unknown} unknown` : "",
    s.pending ? `${s.pending} pending` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${s.method} ${statText(s.metrics[m.name], m)} (${s.valid}/${s.trials} valid${bad ? `; ${bad}` : ""})`;
}

function formatBenchmarks(bs: Benchmark[]): string {
  if (bs.length === 0) return "no benchmarks; add one with `orbit bench add`";
  return table([
    ["NAME", "ADAPTER", "PATH", "RESOURCES"],
    ...bs.map((b) => [b.name, b.adapter, b.path, b.resources ?? "-"]),
  ]);
}

function formatTasks(ts: BenchTask[]): string {
  if (ts.length === 0) return "no tasks";
  const ok = ts.filter((t) => t.supported).length;
  const rows = [["TASK", "OK", "TITLE / REASON"]];
  for (const t of ts)
    rows.push([t.id, t.supported ? "yes" : "no", (t.supported ? t.title : t.reason) ?? ""]);
  return `${table(rows)}\n${ok}/${ts.length} supported`;
}

function formatJobs(jobs: Job[]): string {
  if (jobs.length === 0) return "no bench jobs";
  const rows = [["ID", "STATE", "BENCHMARK", "NAME", "METRIC", "METHODS"]];
  for (const j of jobs) {
    const m = primaryMetric(resolveMetrics(j.metrics));
    rows.push([
      j.id,
      j.state,
      j.spec.benchmark,
      j.spec.name ?? "-",
      m.label,
      j.summary.map((s) => summaryLine(s, m)).join(" | "),
    ]);
  }
  return table(rows);
}

function formatJob(d: BenchJobDetail): string {
  const { job } = d;
  const metrics = resolveMetrics(job.metrics);
  const lines = [
    `${job.id}  ${job.state}  ${job.spec.benchmark}${job.spec.name ? `  (${job.spec.name})` : ""}`,
    ...(job.source
      ? [
          `benchmark at ${job.source.describe ?? job.source.commit.slice(0, 12)}${job.source.dirty && !job.source.describe?.endsWith("-dirty") ? " (dirty)" : ""}`,
        ]
      : []),
    "",
    table([
      ["METHOD", "VALID", ...metrics.map((m) => m.label.toUpperCase())],
      ...d.summary.map((s) => [
        s.method,
        `${s.valid}/${s.trials}`,
        ...metrics.map((m) => statText(s.metrics[m.name], m)),
      ]),
    ]),
    "Means over tasks of the per-task mean of valid trials; ± is the 95% CI clustered by task.",
    "",
  ];
  const rows = [["TASK", "METHOD", "SEED", "STATE", "EVAL", "SCORE", "SOLVE", "VERIFY", "ISSUES"]];
  for (const t of d.trials) {
    const o = t.outcome;
    rows.push([
      t.task,
      t.method,
      String(t.seed),
      t.state,
      o?.evaluation ?? "-",
      (o?.score == null ? "-" : `${o.score}/${o.maxScore}`) +
        (t.history.length
          ? ` (was ${t.history.map((h) => h.outcome.score ?? h.outcome.evaluation).join(", ")})`
          : ""),
      t.solveRunId ?? "-",
      t.verifyRunId ?? "-",
      (o?.issues ?? t.issues).join("; "),
    ]);
  }
  return [...lines, table(rows)].join("\n");
}

const gb = (v: number | null | undefined) => (v == null ? "-" : String(v));

function formatUsageTable(u: BenchUsage): string {
  if (u.rows.length === 0) return "no finished solve runs";
  const rows = [
    [
      "TASK",
      "RUNS",
      "MEM GB peak/req",
      "GPU GB peak/req",
      "CPU peak/req",
      "MIN max/limit",
      "SUGGEST",
      "NOTES",
    ],
  ];
  for (const r of u.rows) {
    const q = r.requested;
    rows.push([
      r.task,
      String(r.runs),
      `${gb(r.peakMemGB)}/${gb(q.memGB)}`,
      q.gpus ? `${gb(r.peakGpuMemGB)}/${gb(q.gpuMemGB)}` : "-",
      `${gb(r.peakCpus)}/${gb(q.cpus)}`,
      `${gb(r.maxMinutes)}/${gb(q.timeoutMin)}`,
      Object.entries(r.suggest)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "-",
      r.notes.join("; "),
    ]);
  }
  return `${table(rows)}\nSuggestions are not applied: edit the resources file (bench add --resources) yourself.`;
}

/** Suggested changes as `tasks` entries of a resources file, with the measurements as evidence. */
export function suggestFragment(u: BenchUsage): { tasks: Record<string, object> } {
  const tasks: Record<string, object> = {};
  for (const r of u.rows) {
    if (Object.keys(r.suggest).length === 0) continue;
    tasks[r.task] = {
      ...r.suggest,
      evidence:
        `orbit bench usage ${u.jobs.join(" ")}: ${r.runs} run(s), peak memory ${gb(r.peakMemGB)} GB, ` +
        `peak GPU memory ${gb(r.peakGpuMemGB)} GB, peak CPU ${gb(r.peakCpus)}, longest ${gb(r.maxMinutes)} min` +
        (r.notes.length ? `; ${r.notes.join("; ")}` : ""),
    };
  }
  return { tasks };
}

/** One metric of a comparison: per-task cells, means over all and paired tasks, Δ to the first column. */
export function formatCompare(c: BenchCompare, metric?: string): string {
  const m = metric ? c.metrics.find((x) => x.name === metric) : primaryMetric(c.metrics);
  if (!m)
    throw new Error(
      `metric ${metric} is not shared by these jobs (${c.metrics.map((x) => x.name).join(", ")})`,
    );
  const st = c.stats[m.name];
  const keys = c.columns.map((x) => x.key);
  const col = (k: string) => st?.columns[k];
  const rows = [[`TASK · ${m.label}`, ...keys]];
  for (const r of c.rows)
    rows.push([
      r.task,
      ...keys.map((k) => {
        const n = r.counts[k];
        return n ? `${fmtMetric(r.values[m.name]?.[k], m)} (${n})` : "";
      }),
    ]);
  rows.push(["mean (all tasks)", ...keys.map((k) => statText(col(k)?.all ?? undefined, m))]);
  rows.push([
    `mean (paired, ${st?.pairedTasks ?? 0} tasks)`,
    ...keys.map((k) => statText(col(k)?.paired ?? undefined, m)),
  ]);
  rows.push([
    `Δ vs ${keys[0] ?? "-"} (paired)`,
    ...keys.map((k, i) => {
      const d = col(k)?.diff;
      if (i === 0 || !d) return i === 0 ? "" : "-";
      const ci = fmtCi(d, m);
      return `${fmtMetric(d.mean, m, true)}${ci ? ` ${ci}` : ""}`;
    }),
  ]);
  const others = c.metrics.filter((x) => x.name !== m.name).map((x) => x.name);
  return [
    table(rows),
    "± is the 95% CI clustered by task; Δ is the mean per-task difference on tasks both columns have.",
    ...(others.length ? [`other metrics: ${others.join(", ")} (--metric <name>)`] : []),
  ].join("\n");
}

export function registerBench(program: Command, client: () => Promise<OrbitClient>, print: Print) {
  const bench = program
    .command("bench")
    .description("benchmarks: trials of task × method × seed as solve + verify runs");

  bench
    .command("add <name> <path>")
    .description("register a benchmark checkout (its adapter must list the tasks)")
    .requiredOption(
      "--adapter <adapter>",
      "harbor (task.toml tasks) | asi (ASI-Bench seed31415) | path of an adapter executable",
    )
    .option(
      "-c, --config <KEY=VALUE>",
      "adapter setting, e.g. python=/venv/bin/python for asi",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "-e, --env <KEY=VALUE>",
      "non-secret variable for every run",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "--pass-env <VAR>",
      "variable copied from the daemon environment into verify runs (e.g. a judge API key)",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "--resources <file>",
      "JSON file of per-task solve resources (default + tasks); see the bench adapter guide",
    )
    .option("--json", "print JSON")
    .action(
      async (
        name: string,
        path: string,
        o: {
          adapter: string;
          resources?: string;
          config: string[];
          env: string[];
          passEnv: string[];
          json?: boolean;
        },
      ) => {
        const b = await (await client()).benchmarkPut({
          name,
          adapter: o.adapter.includes("/") ? resolve(o.adapter) : o.adapter,
          path: resolve(path),
          config: kv(o.config, "--config"),
          env: kv(o.env, "--env"),
          passEnv: o.passEnv,
          resources: o.resources ? resolve(o.resources) : undefined,
        });
        print(o.json, b, () => `saved ${b.name}: ${b.adapter} ${b.path}`);
      },
    );

  bench
    .command("ls")
    .description("list registered benchmarks")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const bs = await (await client()).benchmarks();
      print(o.json, bs, () => formatBenchmarks(bs));
    });

  bench
    .command("rm <name>")
    .description("unregister a benchmark (its jobs are kept)")
    .action(async (name: string) => {
      await (await client()).benchmarkRemove(name);
      console.log(`removed ${name}`);
    });

  bench
    .command("tasks <benchmark>")
    .description("list tasks and whether Orbit can run them")
    .option("--json", "print JSON")
    .action(async (name: string, o: { json?: boolean }) => {
      const ts = await (await client()).benchTasks(name);
      print(o.json, ts, () => formatTasks(ts));
    });

  bench
    .command("run <benchmark>")
    .description("start a job: every task × method × seed becomes a trial")
    .option(
      "-m, --method <spec>",
      "name=agent[,auth=P,model=M,effort=E,bundle=DIR]; agent: codex | claude-code | oracle | empty",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option("--methods-file <file>", "JSON array of methods")
    .option(
      "-t, --task <id>",
      "task id (repeatable; default: all supported)",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option("--seeds <n>", "repetitions per task × method", (v) => Number.parseInt(v, 10), 1)
    .option("--timeout <min>", "solve timeout per trial in minutes", Number.parseFloat)
    .option(
      "--option <KEY=VALUE>",
      "adapter option, e.g. promptLevel=b2 for asi",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option("-n, --name <name>", "job name")
    .option("-f, --folder <path>", "file the job and its runs in a folder, e.g. rcb/noskills")
    .option("--json", "print JSON")
    .action(
      async (
        name: string,
        o: {
          method: string[];
          methodsFile?: string;
          task: string[];
          seeds: number;
          timeout?: number;
          option: string[];
          name?: string;
          folder?: string;
          json?: boolean;
        },
      ) => {
        const methods: unknown[] = o.method.map(parseMethod);
        if (o.methodsFile)
          methods.push(...(JSON.parse(readFileSync(o.methodsFile, "utf8")) as unknown[]));
        if (methods.length === 0)
          throw new Error("give at least one --method (e.g. --method oracle)");
        const job = await (await client()).benchSubmit(
          {
            name: o.name,
            benchmark: name,
            tasks: o.task,
            methods: methods as never,
            seeds: o.seeds,
            options: kv(o.option, "--option"),
            timeoutMin: o.timeout,
          },
          o.folder,
        );
        print(
          o.json,
          job,
          () =>
            `started ${job.id}: ${job.spec.tasks.length} tasks × ${job.spec.methods.length} methods × ${job.spec.seeds} seeds`,
        );
      },
    );

  bench
    .command("jobs")
    .description("list jobs with per-method results")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const jobs = await (await client()).benchJobs();
      print(o.json, jobs, () => formatJobs(jobs));
    });

  bench
    .command("show <job>")
    .description("trials of a job with their outcome and runs")
    .option("--json", "print JSON")
    .action(async (id: string, o: { json?: boolean }) => {
      const d = await (await client()).benchJob(id);
      print(o.json, d, () => formatJob(d));
    });

  bench
    .command("cancel <job>")
    .description("cancel a job's open trials (they end as unknown)")
    .action(async (id: string) => {
      const j = await (await client()).benchCancel(id);
      console.log(`${j.id} ${j.state}`);
    });

  bench
    .command("consolidate <job> [sources...]")
    .description("merge valid retries into invalid slots and remove consumed source jobs")
    .option("--append-tasks", "append new tasks, keeping invalid outcomes and artifacts")
    .option(
      "--allow-transport-differences",
      "allow proxy/network aliases of the same checkout and credentials",
    )
    .option("--prune-invalid", "delete invalid run artifacts, keeping task outcomes")
    .option("--apply", "apply the plan (default: preview only)")
    .option("--yes", "confirm permanent deletion")
    .option("--json", "print JSON")
    .action(
      async (
        id: string,
        sources: string[],
        o: {
          appendTasks?: boolean;
          allowTransportDifferences?: boolean;
          pruneInvalid?: boolean;
          apply?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const c = await client();
        const body = {
          sources,
          appendTasks: !!o.appendTasks,
          allowTransportDifferences: !!o.allowTransportDifferences,
          pruneInvalid: !!o.pruneInvalid,
          dryRun: true,
        };
        const plan = await c.benchConsolidate(id, body);
        if (o.apply) {
          await confirmTyped(
            `merge ${plan.adopted.length} trials and delete ${plan.removedRuns.length} runs and ${plan.removedJobs.length} source jobs`,
            id,
            o.yes,
          );
        }
        const result = o.apply ? await c.benchConsolidate(id, { ...body, dryRun: false }) : plan;
        print(o.json, result, () => JSON.stringify(result, null, 2));
      },
    );

  bench
    .command("rescore <job>")
    .description(
      "score finished trials again from their saved solve output (no Agent rerun); earlier scores are kept",
    )
    .option("-t, --task <id>", "only this task (repeatable)", (v, p: string[]) => [...p, v], [])
    .option(
      "-m, --method <name>",
      "only this method (repeatable)",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option("--trial <id>", "only this trial (repeatable)", (v, p: string[]) => [...p, v], [])
    .option("--json", "print JSON")
    .action(
      async (
        id: string,
        o: { task: string[]; method: string[]; trial: string[]; json?: boolean },
      ) => {
        const r = await (await client()).benchRescore(id, {
          tasks: o.task,
          methods: o.method,
          trials: o.trial,
        });
        print(o.json, r, () =>
          [
            `rescoring ${r.trials.length} trial(s) of ${id}; follow with: orbit bench show ${id}`,
            ...r.skipped.map((x) => `  skipped ${x.trial}: ${x.reason}`),
          ].join("\n"),
        );
      },
    );

  bench
    .command("rm-job <job>")
    .description(
      "permanently delete a finished or cancelled job with all its trials and runs; asks you to type the job id",
    )
    .option("-y, --yes", "skip the typed confirmation (required without a terminal)")
    .option("--json", "print JSON")
    .action(async (id: string, o: { yes?: boolean; json?: boolean }) => {
      const c = await client();
      const d = await c.benchJob(id);
      const runs = d.trials.flatMap(trialRunIds).length;
      await confirmTyped(
        `delete bench job ${id}${d.job.spec.name ? ` (${d.job.spec.name})` : ""}: ${d.trials.length} trial(s), ${runs} run(s) and their outputs`,
        id,
        o.yes,
      );
      const r = await c.benchDeleteJob(id);
      print(o.json, r, () =>
        [
          `deleted job ${id} and ${r.deleted.length} run(s)`,
          ...r.leftovers.map((dir) => `could not remove all files of ${dir}`),
        ].join("\n"),
      );
    });

  bench
    .command("usage <jobs...>")
    .description(
      "measured solve use per task and suggested resources (printed only; edit the resources file yourself)",
    )
    .option("--json", "print JSON")
    .option("--suggest", "print only the suggested changes as a resources-file fragment")
    .action(async (ids: string[], o: { json?: boolean; suggest?: boolean }) => {
      const u = await (await client()).benchUsage(ids);
      if (o.suggest) return console.log(JSON.stringify(suggestFragment(u), null, 2));
      print(o.json, u, () => formatUsageTable(u));
    });

  bench
    .command("compare <jobs...>")
    .description("per-task method comparison; paired means use tasks valid for every method")
    .option("--metric <name>", "metric to compare (default: the primary one)")
    .option("--json", "print JSON")
    .action(async (ids: string[], o: { json?: boolean; metric?: string }) => {
      const c = await (await client()).benchCompare(ids);
      print(o.json, c, () => formatCompare(c, o.metric));
    });
}
