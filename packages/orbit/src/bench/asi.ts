// ASI-Bench (seed31415) wrapped with its native runner: the solve run is `asibench run` for one
// instance and prompt level as a process run (its own Docker sandbox goes through Orbit's docker
// shim), the verify run is `asibench score` against the public references.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterRequest, BenchTask, Method } from "../contracts/index.ts";
import { isCliMethod } from "../contracts/index.ts";
import { agentErrorKind } from "../harness/index.ts";
import type { AdapterHandlers, RunDescription, ScoreReply, TrialRequest } from "./adapter.ts";

/** The registered benchmark as the adapter sees it; `config.python`, `config.instances`. */
type Bench = AdapterRequest["benchmark"];
type Trial = TrialRequest["trial"];

export const ASI_SEED_SUFFIX = "__seed31415";
export const PROMPT_LEVELS = ["b1", "b2", "b3", "b4"];

export interface AsiTaskMeta {
  id: string;
  name: string | null;
  status: string | null;
  domain: string | null;
  requiresGpu: boolean;
  outputs: string[];
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * The few task_meta.yaml fields Orbit needs, read line by line (top-level scalars,
 * `difficulty.requires_gpu` and `output.files[].name`) so the daemon needs no YAML dependency.
 */
export function parseTaskMeta(text: string): AsiTaskMeta {
  const meta: AsiTaskMeta = {
    id: "",
    name: null,
    status: null,
    domain: null,
    requiresGpu: false,
    outputs: [],
  };
  let section = "";
  let sub = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (indent === 0 && top) {
      section = top[1] as string;
      sub = "";
      const v = unquote(top[2] ?? "");
      if (section === "id") meta.id = v;
      else if (section === "name") meta.name = v || null;
      else if (section === "status") meta.status = v || null;
      else if (section === "domain") meta.domain = v || null;
      continue;
    }
    const key = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (section === "difficulty" && key?.[1] === "requires_gpu")
      meta.requiresGpu = unquote(key[2] ?? "") === "true";
    if (section === "output") {
      if (indent === 2 && key) sub = key[1] as string;
      const item = /^\s*-\s+name:\s*(.+)$/.exec(line);
      if (sub === "files" && item) meta.outputs.push(unquote(item[1] as string));
    }
  }
  return meta;
}

export const instancesDir = (b: Bench) =>
  b.config.instances ?? join(b.path, "bench_runs", "instances_seed31415");

/** Task catalogue: `tasks/<domain>/<name>/task_meta.yaml`, indexed by id. */
function taskCatalog(b: Bench): Map<string, AsiTaskMeta> {
  const out = new Map<string, AsiTaskMeta>();
  const root = join(b.path, "tasks");
  const ls = (d: string) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  for (const domain of ls(root))
    for (const task of ls(join(root, domain.name))) {
      const file = join(root, domain.name, task.name, "task_meta.yaml");
      if (!existsSync(file)) continue;
      const meta = parseTaskMeta(readFileSync(file, "utf8"));
      out.set(meta.id || `${domain.name}.${task.name}`, meta);
    }
  return out;
}

function taskMeta(b: Bench, id: string): AsiTaskMeta {
  const m = taskCatalog(b).get(id);
  if (!m) throw new Error(`ASI task not found: ${id}`);
  return m;
}

function listTasks(b: Bench): BenchTask[] {
  const catalog = taskCatalog(b);
  let names: string[] = [];
  try {
    names = readdirSync(instancesDir(b)).filter((n) => n.endsWith(ASI_SEED_SUFFIX));
  } catch {
    return [];
  }
  return names.sort().map((n) => {
    const id = n.slice(0, -ASI_SEED_SUFFIX.length);
    const meta = catalog.get(id);
    const problems: string[] = [];
    if (!meta) problems.push("no task_meta.yaml in tasks/");
    else if (meta.status !== "final") problems.push(`status ${meta.status ?? "unknown"}`);
    if (!existsSync(join(instancesDir(b), n, "reference"))) problems.push("no public reference");
    return {
      id,
      title: meta?.name ?? null,
      supported: problems.length === 0,
      reason: problems.length ? problems.join("; ") : null,
      tags: (meta?.domain ? { domain: meta.domain } : {}) as Record<string, string>,
    };
  });
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** `--agent-cmd` template copying the reference outputs (runner expands `{...}` placeholders). */
export function oracleTemplate(instances: string, outputs: string[]): string {
  const copy =
    'src=$1; dst=$2; shift 2; for f in "$@"; do if [ -e "$src/$f" ]; then ' +
    'mkdir -p "$(dirname "$dst/$f")"; cp -R "$src/$f" "$dst/$f"; fi; done';
  return [
    "sh -c",
    q(copy),
    "oracle",
    `${q(instances)}/{instance_id}/reference`,
    "{workspace}",
    ...outputs.map(q),
  ].join(" ");
}

/** Agents ASI's own runner can launch; others are refused rather than mapped to one of these. */
const ASI_AGENTS: Record<string, string> = { codex: "codex_cli", "claude-code": "claude_code_cli" };

/** Why ASI cannot run a method, or null; checked when a job is submitted. */
export function asiMethodProblem(method: Pick<Method, "agent">): string | null {
  if (method.agent === "external") return "ASI does not support external methods";
  if (isCliMethod(method) && !ASI_AGENTS[method.agent])
    return `ASI runs only codex and claude-code through its native runner; ${method.agent} is not adapted`;
  return null;
}

function asiAgent(method: Method): string {
  const a = ASI_AGENTS[method.agent];
  if (!a)
    throw new Error(
      `ASI runs only codex and claude-code through its native runner; ${method.agent} is not adapted`,
    );
  return a;
}

function agentArgs(method: Method): string[] {
  if (!isCliMethod(method)) return [];
  const config: Record<string, string> = {};
  if (method.model) config.model = method.model;
  if (method.effort) config.effort = method.effort;
  return ["--agent", asiAgent(method), "--agent-config", JSON.stringify(config), "--sandbox", "os"];
}

/** `sh -c 'exec "$@" <flag> "$ORBIT_OUTPUT/<sub>"'`: output paths are known only at launch. */
const withOutput = (flag: string, sub: string, argv: string[]) => [
  "sh",
  "-c",
  `exec "$@" ${flag} "$ORBIT_OUTPUT/${sub}"`,
  "sh",
  ...argv,
];

function baseEnv(b: Bench): Record<string, string> {
  return { PYTHONPATH: b.path, PYTHONDONTWRITEBYTECODE: "1" };
}

function asiCli(b: Bench): string[] {
  return [b.config.python ?? "python3", "-m", "ai4sci_bench.cli"];
}

// Inspect the selected checkout without importing it or changing its files.
const RUNNER_COMPATIBILITY = `
import ast
from pathlib import Path
import sys

def check():
    root = Path(sys.argv[1]) / "ai4sci_bench"
    try:
        adapter = ast.parse((root / "adapters" / (sys.argv[2] + ".py")).read_text(encoding="utf-8"))
        cli = ast.parse((root / "cli.py").read_text(encoding="utf-8"))
    except (OSError, SyntaxError) as error:
        return "ASI requires a complete, readable Python source checkout: " + str(error)
    for node in ast.walk(adapter):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        warning_first = (isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Constant) and test.left.value == "timed out"
            and len(test.ops) == 1 and isinstance(test.ops[0], ast.In)
            and isinstance(test.comparators[0], ast.Name) and test.comparators[0].id == "log")
        marks_timeout = any(isinstance(item, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "status" for target in item.targets)
            and isinstance(item.value, ast.Attribute) and item.value.attr == "TIMEOUT"
            and isinstance(item.value.value, ast.Name) and item.value.value.id == "RunStatus"
            for item in node.body)
        success_after = (node.orelse and isinstance(node.orelse[0], ast.If)
            and isinstance(node.orelse[0].test, ast.Name) and node.orelse[0].test.id == "success")
        if warning_first and marks_timeout and success_after:
            return ("Known ASI false timeout bug: update the registered ASI checkout's "
                + sys.argv[2] + " adapter to check sandbox success before timeout text. "
                "This Orbit version refuses to launch an Agent with the affected runner.")
    has_flag = any(isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute) and node.func.attr == "option"
        and any(isinstance(arg, ast.Constant) and arg.value == "--fail-on-agent-error" for arg in node.args)
        for node in ast.walk(cli))
    if not has_flag:
        return "Update the registered ASI checkout: its CLI must support --fail-on-agent-error."
    return ""

print(check())
`;

function requireCompatibleRunner(b: Bench, method: Method): void {
  if (!isCliMethod(method)) return;
  const adapter = asiAgent(method);
  const result = spawnSync(
    b.config.python ?? "python3",
    ["-c", RUNNER_COMPATIBILITY, b.path, adapter],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Cannot check ASI runner compatibility; check config.python and the registered source checkout: ${
        result.error?.message ?? result.stderr?.trim().slice(-2000) ?? "Python probe failed"
      }`,
    );
  if (result.stdout.trim()) throw new Error(result.stdout.trim());
}

export function asiSolveSpec(b: Bench, ctx: Trial): RunDescription {
  if (ctx.method.agent === "external") throw new Error("ASI does not support external methods");
  const meta = taskMeta(b, ctx.task);
  const level = ctx.options.promptLevel ?? "b1";
  if (!PROMPT_LEVELS.includes(level)) throw new Error(`unknown ASI prompt level: ${level}`);
  const m = ctx.method;
  requireCompatibleRunner(b, m);
  const argv = [
    ...asiCli(b),
    "run",
    "--tasks",
    ctx.task,
    "--prompt-levels",
    level,
    "--instances-dir",
    instancesDir(b),
    "--tasks-dir",
    join(b.path, "tasks"),
    "--parallel",
    "1",
    "--retries",
    "1",
    "--fail-on-agent-error",
  ];
  if (ctx.timeoutMin) argv.push("--timeout", String(Math.round(ctx.timeoutMin * 60)));
  if (m.agent === "oracle")
    argv.push("--agent-cmd", oracleTemplate(instancesDir(b), meta.outputs), "--sandbox", "none");
  else if (m.agent === "empty") argv.push("--agent-cmd", "true", "--sandbox", "none");
  else argv.push(...agentArgs(m));
  const env = baseEnv(b);
  if (ctx.hostNetwork) env.AI4SCI_DOCKER_NETWORK = "host";
  return {
    backend: "process",
    command: withOutput("--output-dir", "native", argv),
    resources: { gpus: meta.requiresGpu ? 1 : 0, cpus: 2, memGB: 8 },
    env,
    timeoutMin: ctx.timeoutMin,
  };
}

/**
 * The runner persists `<result>.outputs/` only when the Agent produced a declared output file, and
 * `asibench score` rejects results without it. The verify run therefore scores a copy of the solve
 * results in which a missing directory becomes an empty one: "produced nothing" scores through the
 * real scorer (to 0) instead of failing the run. The solve run's output stays untouched.
 */
const PREPARE_RESULTS =
  'set -e; r="$ORBIT_OUTPUT/results"; cp -R "$1" "$r"; shift; ' +
  'for f in "$r"/*/*.json; do case "$f" in *.trajectory.*|*.agent_model_output.*) continue;; esac; ' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  '[ -e "$f" ] && mkdir -p "${f%.json}.outputs"; done; ' +
  'exec "$@" --results-dir "$r" --output "$ORBIT_OUTPUT/score.json"';

const VERIFY_TIMEOUT_MIN: Record<string, number> = {
  "computer_science.euclidean_tsp_tour_optimization": 90,
  "computer_science.max3sat_assignment_optimization": 60,
};

export function asiVerifySpec(b: Bench, solveOutput: string, task = ""): RunDescription {
  return {
    backend: "process",
    command: [
      "sh",
      "-c",
      PREPARE_RESULTS,
      "sh",
      join(solveOutput, "native"),
      ...asiCli(b),
      "score",
      "--repo",
      "seed31415",
      "--instances-dir",
      instancesDir(b),
      "--tasks-dir",
      join(b.path, "tasks"),
    ],
    resources: { gpus: 0, cpus: 1, memGB: 4 },
    env: baseEnv(b),
    // Native solver budgets are 60/30 minutes; startup and collection need headroom.
    timeoutMin: VERIFY_TIMEOUT_MIN[task] ?? 30,
  };
}

interface NativeResult {
  instance_id?: string;
  prompt_level?: string;
  attempt?: number;
  status?: string;
  agent_output?: { status?: string; error_message?: unknown };
}

/** Result JSONs written by `asibench run` (`<native>/<task>/<instance>__<level>.json`). */
export function nativeResults(nativeDir: string): NativeResult[] {
  const out: NativeResult[] = [];
  let tasks: string[] = [];
  try {
    tasks = readdirSync(nativeDir);
  } catch {
    return out;
  }
  for (const t of tasks) {
    let files: string[] = [];
    try {
      files = readdirSync(join(nativeDir, t));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json") || f.includes(".trajectory.") || f.includes(".agent_model_output."))
        continue;
      try {
        const v = JSON.parse(readFileSync(join(nativeDir, t, f), "utf8")) as NativeResult;
        if (v && typeof v === "object" && v.instance_id) out.push(v);
      } catch {}
    }
  }
  return out;
}

function latestNativeResult(ctx: Trial, solveOutput: string): NativeResult | undefined {
  return nativeResults(join(solveOutput, "native"))
    .filter(
      (r) =>
        r.instance_id === `${ctx.task}${ASI_SEED_SUFFIX}` &&
        r.prompt_level === (ctx.options.promptLevel ?? "b1"),
    )
    .sort((a, b) => (b.attempt ?? 1) - (a.attempt ?? 1))[0];
}

function attemptStatus(result: NativeResult | undefined): string {
  const statuses = [result?.status, result?.agent_output?.status].filter(
    (s): s is string => typeof s === "string",
  );
  if (statuses.includes("timeout")) return "execution_timeout";
  if (statuses.includes("failed")) return "execution_failed";
  if (statuses.length && statuses.every((s) => s === "success" || s === "completed"))
    return "completed";
  return "execution_incomplete";
}

/**
 * A model the harness could not use (credentials, model access, quota, endpoint): a zero from such a
 * run measures the setup, not the method. Reads the JSON event lines the CLI adapters record; the
 * final `turn.failed` wins over earlier errors, and reconnect notices do not count.
 */
export function modelError(message: unknown): string | null {
  if (typeof message !== "string" || !message) return null;
  let found: string | null = null;
  for (const line of message.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let ev: { type?: string; message?: unknown; error?: unknown };
    try {
      ev = JSON.parse(text);
    } catch {
      continue;
    }
    if (ev.type !== "error" && ev.type !== "turn.failed") continue;
    const detail = JSON.stringify(ev.error ?? ev.message ?? "");
    if (ev.type === "error" && detail.includes("Reconnecting...")) continue;
    const kind = agentErrorKind(detail);
    if (ev.type === "turn.failed") return kind;
    found = kind ?? found;
  }
  return found;
}

interface ScoreDetail {
  scorer_name?: string;
  message?: unknown;
  details?: Record<string, unknown> | null;
}

/**
 * Scorer problems hidden inside a report item: a judge that could not be reached scores 0 with
 * `details.evaluator_unavailable` (the score is not a real one), and a scorer that could not find a
 * file says so in its error (worth a look: the scorer's setup or the Agent's missing output).
 */
export function scorerIssues(item: { gate_results?: unknown; score_results?: unknown }): {
  judgeUnavailable: string[];
  missingFile: string[];
} {
  const judgeUnavailable: string[] = [];
  const missingFile: string[] = [];
  const all = [item.gate_results, item.score_results].flatMap((x) => (Array.isArray(x) ? x : []));
  for (const d of all as ScoreDetail[]) {
    const name = d?.scorer_name ?? "scorer";
    if (d?.details?.evaluator_unavailable === true) judgeUnavailable.push(name);
    const text = `${String(d?.details?.error ?? "")} ${String(d?.details?.setup_error ?? "")} ${String(d?.message ?? "")}`;
    if (/FileNotFoundError|No such file or directory/.test(text)) missingFile.push(name);
  }
  return { judgeUnavailable, missingFile };
}

interface ScoreItem {
  instance_id?: string;
  prompt_level?: string;
  attempt?: number;
  final_score?: number;
  max_score?: number;
  scorer_internal_error?: boolean;
  gate_results?: unknown;
  score_results?: unknown;
}

export function asiScore(ctx: Trial, solveOutput: string, verifyOutput: string): ScoreReply {
  const instance = `${ctx.task}${ASI_SEED_SUFFIX}`;
  const level = ctx.options.promptLevel ?? "b1";
  const bad = (issue: string): ScoreReply => ({
    score: null,
    maxScore: 100,
    issues: [issue],
    invalid: true,
  });
  const native = latestNativeResult(ctx, solveOutput);
  if (!native) return bad("runner wrote no result for the instance");
  const reportFile = join(verifyOutput, "score.json");
  if (!existsSync(reportFile)) return bad("scorer wrote no report");
  let items: ScoreItem[];
  try {
    items =
      (JSON.parse(readFileSync(reportFile, "utf8")) as { results?: ScoreItem[] }).results ?? [];
  } catch {
    return bad("score report is not valid JSON");
  }
  const item = items
    .filter((r) => r.instance_id === instance && r.prompt_level === level)
    .sort((a, b) => (b.attempt ?? 1) - (a.attempt ?? 1))[0];
  if (!item || typeof item.final_score !== "number")
    return bad("instance missing from score report");
  const maxScore = typeof item.max_score === "number" && item.max_score > 0 ? item.max_score : 100;
  const issues: string[] = [];
  if (!existsSync(join(solveOutput, "native", ctx.task, `${instance}__${level}.outputs`)))
    issues.push("no declared output files produced");
  if (item.scorer_internal_error) issues.push("scorer_internal_error");
  const hidden = scorerIssues(item);
  if (hidden.judgeUnavailable.length)
    issues.push(`judge unavailable: ${hidden.judgeUnavailable.join(", ")}`);
  if (hidden.missingFile.length)
    issues.push(`scorer could not find a file: ${hidden.missingFile.join(", ")}`);
  const err = modelError(native.agent_output?.error_message);
  if (err && item.final_score === 0) issues.push(err);
  const status = native.status;
  if (status && status !== "success" && status !== "completed")
    issues.push(`runner status ${status}`);
  const invalid =
    Boolean(item.scorer_internal_error) ||
    hidden.judgeUnavailable.length > 0 ||
    (err !== null && item.final_score === 0);
  return {
    score: item.final_score,
    maxScore,
    issues,
    invalid,
    metrics: { fullMarks: item.final_score >= maxScore ? 100 : 0 },
  };
}

/** The native result of the instance and the scorer report, for the trial page. */
export function asiReview(
  ctx: Trial,
  solveOutput: string,
  verifyOutput: string,
): ScoreReply["review"] {
  const level = ctx.options.promptLevel ?? "b1";
  const name = `${ctx.task}${ASI_SEED_SUFFIX}__${level}.json`;
  const files: NonNullable<ScoreReply["review"]>["files"] = [];
  if (existsSync(join(solveOutput, "native", ctx.task, name)))
    files.push({
      label: "Runner result",
      phase: "solve",
      kind: "json",
      path: join("native", ctx.task, name),
    });
  if (existsSync(join(verifyOutput, "score.json")))
    files.push({ label: "Score report", phase: "verify", kind: "json", path: "score.json" });
  return {
    files,
    items: [],
    details: {
      "prompt level": level,
      attempt_status: attemptStatus(latestNativeResult(ctx, solveOutput)),
      score_scope: "non-official seed31415",
    },
  };
}

export const asiAdapter: AdapterHandlers = {
  // `score` (final score in percent of the instance's maximum) is the headline.
  metrics: [
    {
      name: "fullMarks",
      label: "Full marks",
      description: "trials scoring the instance's maximum",
      unit: "%",
      range: [0, 100],
    },
  ],
  info: () => ({
    capabilities: {
      identity: { id: "asi-bench", name: "ASI-Bench" },
      taxonomy: { domains: ["science"] },
      methods: ["oracle", "empty", "codex", "claude-code"],
      conditions: { Runner: "Native ASI runner and scorer" },
      scoreKind: "scalar",
      rescore: "evidence",
    },
  }),
  tasks: (req) => listTasks(req.benchmark),
  solve: ({ benchmark, trial }) => ({ spec: asiSolveSpec(benchmark, trial) }),
  verify: ({ benchmark, solve, trial }) => ({
    spec: asiVerifySpec(benchmark, solve.output, trial.task),
  }),
  score: ({ trial, solve, verify }) => ({
    ...asiScore(trial, solve.output, verify.output),
    review: asiReview(trial, solve.output, verify.output),
  }),
};
