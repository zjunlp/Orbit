import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { OrbitClient } from "../client/index.ts";
import { GatePolicy, type GateRecord, GateSubmission } from "../contracts/index.ts";
import type { Print } from "./auth.ts";
import { readBounded } from "./task-file.ts";

const textFile = (file: string, limit: number) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readBounded(file, limit));
export function readGateInput(
  file: string,
  parent: string,
  child: string,
  reports?: string,
  aa = false,
) {
  const source = resolve(file);
  const policy = GatePolicy.parse(parse(textFile(source, 1024 * 1024), { maxAliasCount: 50 }));
  const files = [
    ...new Set([policy.gate, ...policy.guard, ...policy.final].map((d) => d.tasks.file)),
  ];
  return GateSubmission.parse({
    parent,
    child,
    policy,
    mode: aa ? "calibration-aa" : "promotion",
    taskSets: files.map((file) => ({
      file,
      content: textFile(resolve(dirname(source), file), 8 * 1024 * 1024),
    })),
    selections: reports ? JSON.parse(textFile(resolve(reports), 1024 * 1024)) : [],
  });
}
export function formatGate(record: GateRecord): string {
  const v = record.verdict;
  return [
    `${record.id} · ${record.mode} · ${v.decision}${v.level ? ` · ${v.level}` : ""}`,
    `${v.inputs.parent} → ${v.inputs.child} · round ${v.alpha.round} · alpha ${v.alpha.level}`,
    ...v.checks.map(
      (c) =>
        `${c.required ? "" : "optional "}${c.set} ${c.kind}: ${c.status} — ${c.reason}${c.lower != null ? ` (bounds ${c.lower}, ${c.upper})` : ""}`,
    ),
    `regressions: ${v.regressions.length} · policy ${v.inputs.policyDigest}`,
  ].join("\n");
}
export function registerGate(bench: Command, client: () => Promise<OrbitClient>, print: Print) {
  const command = bench
    .command("gate")
    .description("evaluate frozen evidence and save an immutable verdict")
    .option("--policy <file>", "frozen YAML policy; task paths are relative to this file")
    .option("--parent <revision>", "parent configuration revision")
    .option("--child <revision>", "child configuration revision")
    .option("--reports <file>", "JSON array of explicit parent/child report selections by set")
    .option("--calibration-aa", "compare independent runs of identical content for calibration")
    .option("--json", "print the complete record as JSON")
    .action(
      async (options: {
        policy?: string;
        parent?: string;
        child?: string;
        reports?: string;
        calibrationAa?: boolean;
        json?: boolean;
      }) => {
        if (!options.policy || !options.parent || !options.child)
          throw new Error("--policy, --parent and --child are required");
        const input = readGateInput(
          options.policy,
          options.parent,
          options.child,
          options.reports,
          options.calibrationAa,
        );
        const record = await (await client()).benchGate(input);
        print(options.json, record, () => formatGate(record));
        process.exitCode =
          record.verdict.decision === "accept" ? 0 : record.verdict.decision === "reject" ? 2 : 3;
      },
    );
  command
    .command("list")
    .description("list saved verdicts")
    .option("--child <revision>", "filter by child revision")
    .option("--json", "print JSON")
    .action(async (options: { child?: string; json?: boolean }) => {
      const records = await (await client()).benchGates(options.child);
      print(options.json, records, () =>
        records
          .map((r) => `${r.id} ${r.mode} ${r.verdict.inputs.child} ${r.verdict.decision}`)
          .join("\n"),
      );
    });
  command
    .command("show <id>")
    .description("read a saved verdict and its evidence")
    .option("--json", "print JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const record = await (await client()).benchGateRecord(id);
      print(options.json, record, () => formatGate(record));
    });
}
