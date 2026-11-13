import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import type { AtifTrajectory } from "../contracts/index.ts";

function summary(value: AtifTrajectory | null): string {
  if (!value) return "No agent trajectory recorded.";
  const orbit = value.extra?.orbit;
  return `${value.schema_version} · ${value.agent.name} · ${value.steps.length} steps · ${orbit?.completeness ?? "unknown"}\nSession: ${value.session_id ?? "unknown"}\nImporter: ${orbit?.importer.name ?? "unknown"} v${orbit?.importer.version ?? "?"}`;
}
export function registerTrajectory(program: Command, client: () => Promise<OrbitClient>): void {
  const group = program.command("trajectory").description("inspect or rebuild an Agent trajectory");
  group
    .command("show <run>")
    .option("--json", "print ATIF JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const value = await (await client()).trajectory(id);
      console.log(opts.json ? JSON.stringify(value, null, 2) : summary(value));
    });
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
