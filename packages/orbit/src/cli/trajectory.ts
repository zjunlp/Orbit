import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import {
  AtifSource,
  type AtifTrajectory,
  EnvironmentKind,
  TrajectoryExportRequest,
} from "../contracts/index.ts";
import { collect } from "./options.ts";

function summary(value: AtifTrajectory | null): string {
  if (!value) return "No agent trajectory recorded.";
  const orbit = value.extra?.orbit;
  return `${value.schema_version} · ${value.agent.name} · ${value.steps.length} steps · ${orbit?.completeness ?? "unknown"}\nSession: ${value.session_id ?? "unknown"}\nImporter: ${orbit?.importer.name ?? "unknown"} v${orbit?.importer.version ?? "?"}`;
}
export function registerTrajectory(program: Command, client: () => Promise<OrbitClient>): void {
  const group = program
    .command("trajectory")
    .description("inspect, rebuild or export Agent trajectories");
  group
    .command("export")
    .description("export ATIF packages or Chat JSONL on the daemon host")
    .option("--run <id>", "select a Run (repeatable)", collect, [])
    .option("--trial <id>", "select a trial's solve Run (repeatable)", collect, [])
    .option("--job <id>", "select a job's solve Runs (repeatable)", collect, [])
    .option("--tasks-file <path>", "UTF-8 task IDs, one per line")
    .option("--method <name>", "filter method name (repeatable)", collect, [])
    .option("--valid-only", "include only valid evaluations")
    .option("--outcome <result>", "pass or fail (valid scores only)")
    .option("--format <format>", "atif or chat-jsonl", "atif")
    .option("--reasoning <policy>", "raw, summary or none", "summary")
    .requiredOption("--out <directory>", "new output directory on the daemon host")
    .option("--json", "print export result as JSON")
    .action(
      async (opts: {
        run: string[];
        trial: string[];
        job: string[];
        method: string[];
        tasksFile?: string;
        validOnly?: boolean;
        outcome?: string;
        format: string;
        reasoning: string;
        out: string;
        json?: boolean;
      }) => {
        const tasks = opts.tasksFile
          ? readFileSync(opts.tasksFile, "utf8")
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : [];
        if (opts.tasksFile && !tasks.length) throw new Error("tasks file is empty");
        const input = TrajectoryExportRequest.parse({
          runs: opts.run,
          trials: opts.trial,
          jobs: opts.job,
          tasks,
          methods: opts.method,
          validOnly: opts.validOnly,
          outcome: opts.outcome,
          format: opts.format,
          reasoning: opts.reasoning,
          out: resolve(opts.out),
        });
        const result = await (await client()).exportTrajectories(input);
        console.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : `Exported ${result.runs} Runs to ${result.out}\nManifest: ${result.manifest}`,
        );
      },
    );
  group
    .command("show <run>")
    .option("--json", "print ATIF JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const value = await (await client()).trajectory(id);
      console.log(opts.json ? JSON.stringify(value, null, 2) : summary(value));
    });
  group
    .command("import <run> <path>")
    .description("adopt native ATIF from a saved output file; preserve the previous trajectory")
    .option("--json", "print imported ATIF JSON")
    .action(async (id: string, path: string, opts: { json?: boolean }) => {
      const value = await (await client()).rebuildTrajectory(
        id,
        AtifSource.parse({ format: "atif", path }),
      );
      console.log(opts.json ? JSON.stringify(value, null, 2) : summary(value));
    });
  group
    .command("environment <run> <path>")
    .description("show a saved environment record linked to Agent steps")
    .requiredOption("--kind <kind>", "gui, episode or conversation")
    .option("--session <run>", "Run containing the Agent session (default: the same Run)")
    .option("--json", "print the linked environment JSON")
    .action(
      async (
        id: string,
        path: string,
        opts: { kind: string; session?: string; json?: boolean },
      ) => {
        const kind = EnvironmentKind.parse(opts.kind);
        const value = await (await client()).environment(id, path, kind, opts.session);
        console.log(
          opts.json
            ? JSON.stringify(value, null, 2)
            : `${kind} · ${value.completeness} · Session Run: ${value.sessionRunId}`,
        );
      },
    );
  group
    .command("rebuild <runs...>")
    .description(
      "rebuild ended runs from their native sessions; retain the previous importer version",
    )
    .option("--json", "print results as JSON")
    .action(async (ids: string[], opts: { json?: boolean }) => {
      const c = await client();
      const results = [];
      for (const id of ids) {
        try {
          results.push({ id, trajectory: await c.rebuildTrajectory(id) });
        } catch (error) {
          results.push({ id, error: (error as Error).message });
          process.exitCode = 1;
        }
      }
      console.log(
        opts.json
          ? JSON.stringify(results, null, 2)
          : results
              .map((r) => `${r.id}: ${"error" in r ? r.error : summary(r.trajectory)}`)
              .join("\n"),
      );
    });
}
