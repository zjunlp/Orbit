import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import { type TransferMatrix, TransferQuery } from "../contracts/index.ts";
import type { Print } from "./auth.ts";

const number = (n: number) => Number(n.toPrecision(5)).toString();
export function formatTransfer(matrix: TransferMatrix): string {
  const lines = [
    "Transfer evidence · saved gate records only",
    "Δ = child − parent. 95% CI is descriptive; saved gate decisions use one-sided t bounds.",
  ];
  if (!matrix.rows.length) lines.push("No saved evidence for this bundle change.");
  for (const row of matrix.rows) {
    lines.push(`${row.parentBundle} → ${row.childBundle}`);
    for (const col of matrix.columns) {
      const cell = row.cells.find((c) => c.column === col.id);
      const condition = col.parent ?? col.child;
      lines.push(
        `${col.benchmark} · ${col.agent ?? "unknown Agent"} / ${condition?.model ?? "unknown model"} · ${col.role} · ${col.metric} · condition ${col.id.slice(-12)}`,
      );
      if (!cell) {
        lines.push("  — No evidence");
        continue;
      }
      for (const a of cell.assessments) {
        const d = a.delta;
        lines.push(
          `  ${a.record} / ${a.set}: ${a.status} · gate decision ${a.decision}`,
          d
            ? `  Δ ${number(d.mean)}; 95% CI ${d.ci ? `[${d.ci.map(number).join(", ")}]` : "unavailable"}; paired ${d.tasks}/${a.eligible ?? "?"} eligible tasks${condition?.metric ? `; ${condition.metric.higherIsBetter ? "higher" : "lower"} is better` : ""}`
            : "  — No comparable estimate",
          `  parent ${a.parent ? `${a.parent.job}@${a.parent.revision}:${a.parent.method}` : "not selected"}; child ${a.child ? `${a.child.job}@${a.child.revision}:${a.child.method}` : "not selected"}`,
        );
        for (const check of a.checks.filter((c) => c.status !== "pass"))
          lines.push(`  ${check.kind}: ${check.reason}`);
        if (a.status === "incompatible")
          lines.push("  Frozen versions, resources or other evaluation conditions do not match.");
      }
    }
  }
  if (matrix.omitted.length)
    lines.push(
      `Omitted records: ${matrix.omitted.map((r) => `${r.record} (${r.reason})`).join(", ")}`,
    );
  return lines.join("\n");
}

export function registerTransfer(bench: Command, client: () => Promise<OrbitClient>, print: Print) {
  bench
    .command("transfer")
    .description("review saved transfer evidence for a bundle change without running evaluations")
    .requiredOption("--parent-bundle <digest>", "full parent bundle SHA-256")
    .requiredOption("--child-bundle <digest>", "full child bundle SHA-256")
    .option("--json", "print the evidence matrix as JSON")
    .action(async (options: { parentBundle: string; childBundle: string; json?: boolean }) => {
      const query = TransferQuery.parse({
        parentBundle: options.parentBundle,
        childBundle: options.childBundle,
      });
      const result = await (await client()).benchTransfer(query);
      print(options.json, result, () => formatTransfer(result));
    });
}
