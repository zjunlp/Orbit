import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { OrbitClient } from "../client/index.ts";
import {
  type GateBundleCheck,
  type GatePlan,
  GatePolicy,
  type GateRecord,
  GateSubmission,
} from "../contracts/index.ts";
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
  return GateSubmission.parse({
    parent,
    child,
    ...readGateFiles(file),
    mode: aa ? "calibration-aa" : "promotion",
    selections: reports ? JSON.parse(textFile(resolve(reports), 1024 * 1024)) : [],
  });
}
export function readGateFiles(file: string) {
  const source = resolve(file);
  const policy = GatePolicy.parse(parse(textFile(source, 1024 * 1024), { maxAliasCount: 50 }));
  const declarations = [policy.gate, ...policy.guard, ...policy.final];
  if (declarations.length > 32) throw new Error("at most 32 gate datasets are supported");
  const files = [...new Set(declarations.map((d) => d.tasks.file))];
  let bytes = 0;
  return {
    policy,
    taskSets: files.map((file) => {
      const content = textFile(resolve(dirname(source), file), 8 * 1024 * 1024);
      bytes += Buffer.byteLength(content);
      if (bytes > 32 * 1024 * 1024)
        throw new Error("gate task snapshots exceed the 32 MiB total limit");
      return { file, content };
    }),
  };
}

export function shellCommand(args: string[]): string {
  return args
    .map((word) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\"'\"'")}'`,
    )
    .join(" ");
}
export function formatGatePlan(plan: GatePlan): string {
  return [
    `${plan.parent} → ${plan.child} · policy ${plan.policyDigest}`,
    "Read-only plan. Suggested commands require explicit execution.",
    ...plan.rows.flatMap((row) => [
      `${row.set} ${row.side}: ${row.status} — ${row.reason}`,
      ...row.candidates.map((ref) => `  report ${ref.job}@${ref.revision}:${ref.method}`),
      ...(row.status === "pending" ? row.jobs.map((job) => `  wait: orbit bench show ${job}`) : []),
      ...(row.command ? [`  ${shellCommand(row.command)}`] : []),
    ]),
    ...plan.checks
      .filter((c) => c.prerequisite && c.status !== "pass")
      .map(
        (c) =>
          `${c.required ? "required" : "optional"} prerequisite ${c.set}/${c.kind}: ${c.reason}`,
      ),
  ].join("\n");
}
export function formatBundleCheck(check: GateBundleCheck): string {
  return [
    `${check.passed ? "passed" : "failed"} · ${check.files} files · ${check.bytes} bytes · digest ${check.digest ?? "unavailable"}`,
    ...check.checks.map((c) => `${c.kind}: ${c.result} — ${c.detail}`),
    ...check.findings.map((f) => `${f.kind} ${JSON.stringify(f.file)}: ${f.detail}`),
    ...(check.truncated
      ? ["Additional findings omitted; resolve the reported issues and check again."]
      : []),
  ].join("\n");
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
    .command("plan")
    .description("list missing frozen evidence and suggest bounded evaluation commands")
    .option("--policy <file>")
    .option("--parent <revision>")
    .option("--child <revision>")
    .option("--reports <file>")
    .option("--calibration-aa")
    .option("--json")
    .action(
      async (options: {
        policy?: string;
        parent?: string;
        child?: string;
        reports?: string;
        calibrationAa?: boolean;
        json?: boolean;
      }) => {
        options = { ...command.opts(), ...options };
        if (!options.policy || !options.parent || !options.child)
          throw new Error("--policy, --parent and --child are required");
        const result = await (await client()).benchGatePlan(
          readGateInput(
            options.policy,
            options.parent,
            options.child,
            options.reports,
            options.calibrationAa,
          ),
        );
        for (const row of result.rows)
          if (row.command) {
            const index = row.command.indexOf("--tasks-file");
            if (index >= 0)
              row.command[index + 1] = resolve(dirname(resolve(options.policy)), row.tasksFile);
          }
        print(options.json, result, () => formatGatePlan(result));
        process.exitCode =
          result.rows.some((row) => !row.set.startsWith("final:") && row.status !== "available") ||
          result.checks.some((c) => c.required && c.prerequisite && c.status !== "pass")
            ? 2
            : 0;
      },
    );
  command
    .command("check-bundle <directory>")
    .description("inspect a local method bundle before exposing held-out evaluations")
    .option("--policy <file>")
    .option("--json")
    .action(async (directory: string, options: { policy?: string; json?: boolean }) => {
      options = { ...command.opts(), ...options };
      if (!options.policy) throw new Error("--policy is required");
      const result = await (await client()).benchGateBundleCheck({
        directory: resolve(directory),
        ...readGateFiles(options.policy),
      });
      print(options.json, result, () => formatBundleCheck(result));
      process.exitCode = result.passed ? 0 : 2;
    });
  command
    .command("list")
    .description("list saved verdicts")
    .option("--child <revision>", "filter by child revision")
    .option("--json", "print JSON")
    .action(async (options: { child?: string; json?: boolean }) => {
      options = { ...command.opts(), ...options };
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
      options = { ...command.opts(), ...options };
      const record = await (await client()).benchGateRecord(id);
      print(options.json, record, () => formatGate(record));
    });
}
