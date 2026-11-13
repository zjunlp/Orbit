import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usageRow } from "../src/bench/resources.ts";
import { buildReport, compareJobs } from "../src/bench/summary.ts";
import { formatCompare } from "../src/cli/bench.ts";
import { formatRun, formatTokens } from "../src/cli/format.ts";
import { BenchJob, Run, type RunTokens, Trial } from "../src/contracts/index.ts";
import { convertClaudeTrajectory } from "../src/sessions/claude.ts";
import { convertCodexTrajectory } from "../src/sessions/codex.ts";
import { tokenUsage, trajectoryTokens } from "../src/sessions/tokens.ts";

function known<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
const native = (name: string) =>
  readFileSync(new URL(`fixtures/atif/${name}.jsonl`, import.meta.url), "utf8");
const codex = () => convertCodexTrajectory(native("codex")).trajectory;
const claude = () => convertClaudeTrajectory(native("claude")).trajectory;
const measured = (): RunTokens => ({
  input: 220,
  cachedInput: 130,
  cacheWrite: null,
  output: 22,
  reasoning: 2,
  calls: 2,
  source: "session",
});
const at = "2026-11-13T00:00:00Z";
const run = (id: string, tokens: RunTokens | null) =>
  Run.parse({
    id,
    tokens,
    spec: { backend: "process", command: ["true"] },
    state: "succeeded",
    reason: null,
    exitCode: 0,
    node: "fixture",
    image: null,
    containerId: null,
    lease: null,
    code: null,
    cleanup: "done",
    note: "",
    createdAt: at,
    startedAt: at,
    endedAt: at,
  });

describe("session token accounting", () => {
  it("uses native deduplicated calls with inclusive input/output and optional breakdowns", () => {
    expect(trajectoryTokens(codex())).toEqual(measured());
    expect(trajectoryTokens(claude())).toEqual({
      input: 30,
      cachedInput: 6,
      cacheWrite: 4,
      output: 8,
      reasoning: null,
      calls: 2,
      source: "session",
    });
  });
  it("distinguishes unreported usage from reported zero and does not estimate cost", () => {
    const t = codex();
    delete t.final_metrics;
    for (const step of t.steps) delete step.metrics;
    expect(trajectoryTokens(t)).toBeNull();
    for (const step of t.steps.filter((s) => s.source === "agent"))
      step.metrics = { prompt_tokens: 0, completion_tokens: 0 };
    expect(trajectoryTokens(t)).toEqual({
      ...measured(),
      input: 0,
      cachedInput: null,
      output: 0,
      reasoning: null,
    });
    expect(formatTokens(null)).toBe("Not recorded");
    expect(formatTokens(trajectoryTokens(t))).toContain("input 0");
    expect(formatTokens(trajectoryTokens(t))).not.toContain("$");
    expect(formatRun(run("unknown", null))).toContain("Not recorded");
  });
  it("reads Codex cache writes when explicitly reported, without filling missing prefixes", () => {
    const t = codex();
    for (const step of t.steps.filter((s) => s.source === "agent")) {
      const raw = (known(step.metrics?.extra).orbit as { native_usage: Record<string, unknown> })
        .native_usage as Record<string, unknown>;
      raw.cache_write_input_tokens = 0;
    }
    expect(trajectoryTokens(t)?.cacheWrite).toBe(0);
    delete (known(t.final_metrics?.extra).orbit as Record<string, unknown>).calls;
    expect(trajectoryTokens(t)?.cacheWrite).toBeNull();
  });
  it("preserves deliberately missing prefix totals instead of summing partial steps", () => {
    const t = codex();
    t.final_metrics = { total_steps: t.steps.length, extra: { orbit: { measured_calls: 2 } } };
    expect(trajectoryTokens(t)).toBeNull();
    t.final_metrics.total_completion_tokens = 22;
    expect(trajectoryTokens(t)).toMatchObject({
      input: null,
      cachedInput: null,
      output: 22,
      reasoning: null,
      calls: null,
    });
  });
  it("counts embedded children once and ignores copied context and synthetic calls", () => {
    const t = codex();
    const child = claude();
    child.session_id = "child";
    child.trajectory_id = "child";
    delete child.final_metrics;
    child.steps.push({ ...known(child.steps[10]), step_id: 14, is_copied_context: true });
    child.steps.push({ ...known(child.steps[10]), step_id: 15, llm_call_count: 0 });
    t.subagent_trajectories = [child, structuredClone(child)];
    expect(trajectoryTokens(t)).toEqual({
      ...measured(),
      input: 250,
      cachedInput: 136,
      output: 30,
      reasoning: null,
      calls: 4,
    });
    delete known(child.steps[10]).metrics;
    expect(trajectoryTokens(t)).toBeNull();
  });
  it("only sums explicitly reported costs and rejects overflowing counts", () => {
    const t = codex();
    known(t.final_metrics).total_cost_usd = 0.123;
    expect(trajectoryTokens(t)?.costUsd).toBe(0.123);
    delete t.final_metrics;
    for (const step of t.steps.filter((s) => s.source === "agent"))
      known(step.metrics).cost_usd = 0.1;
    expect(trajectoryTokens(t)?.costUsd).toBe(0.2);
    delete known(known(t.steps[2]).metrics).cost_usd;
    expect(trajectoryTokens(t)?.costUsd).toBeUndefined();
    const huge = { ...measured(), input: Number.MAX_SAFE_INTEGER };
    expect(tokenUsage([run("a", huge), run("b", huge)]).tokens?.input).toBeNull();
  });
  it("takes the last matching CLI session cost once, including children, without repricing", () => {
    const base = claude();
    const cost = (totalCostUSD: unknown, sessionId = base.session_id) =>
      JSON.stringify({ type: "cost-state", sessionId, totalCostUSD });
    const t = convertClaudeTrajectory(
      `${native("claude")}\n${cost(0.1)}\n${cost(0.25)}\n${cost(999, "other-session")}`,
    ).trajectory;
    const child = codex();
    child.trajectory_id = "child";
    known(child.final_metrics).total_cost_usd = 0.2;
    t.subagent_trajectories = [child];
    expect(trajectoryTokens(t)?.costUsd).toBe(0.25);
    const zero = convertClaudeTrajectory(`${native("claude")}\n${cost(0)}`).trajectory;
    expect(trajectoryTokens(zero)?.costUsd).toBe(0);
    zero.steps = zero.steps.filter((step) => step.source !== "agent");
    expect(trajectoryTokens(zero)).toBeNull();
    const invalid = convertClaudeTrajectory(
      `${native("claude")}\n${cost(0.1)}\n${cost(-1)}`,
    ).trajectory;
    expect(trajectoryTokens(invalid)?.costUsd).toBeUndefined();
  });
  it("deduplicates shared runs and exposes coverage without zero-filling missing fields", () => {
    const a = run("a", measured());
    const usage = tokenUsage([
      a,
      a,
      run("missing", null),
      run("b", { ...measured(), reasoning: null }),
    ]);
    expect(usage).toEqual({
      runs: 3,
      recordedRuns: 2,
      tokens: {
        ...measured(),
        input: 440,
        cachedInput: 260,
        output: 44,
        reasoning: null,
        calls: 4,
      },
    });
    expect(tokenUsage([run("missing", null)])).toEqual({ runs: 1, recordedRuns: 0, tokens: null });
    expect(usageRow("task", {}, [a]).tokenUsage).toEqual(tokenUsage([a]));
  });
});

it("reports selected tokens per entry and all distinct solve attempts per method, independent of scores", () => {
  const job = BenchJob.parse({
    id: "job",
    spec: {
      benchmark: "fixture",
      tasks: ["a", "b"],
      methods: [{ name: "m", agent: "codex", auth: "fixture" }],
      seeds: 1,
    },
    state: "done",
    createdAt: at,
    endedAt: at,
  });
  const makeTrial = (id: string, task: string, solveRunId: string, valid: boolean) =>
    Trial.parse({
      id,
      task,
      jobId: "job",
      method: "m",
      seed: 1,
      solveRunId,
      verifyRunId: "verify",
      state: "done",
      createdAt: at,
      endedAt: at,
      outcome: {
        execution: valid ? "succeeded" : "failed",
        evaluation: valid ? "valid" : "invalid",
        score: valid ? 1 : null,
        maxScore: 1,
        cleanup: "done",
        issues: [],
      },
    });
  const a = makeTrial("a", "a", "shared", true);
  const b = makeTrial("b", "b", "shared", true);
  a.priorAttempts = [
    {
      solveRunId: "retry",
      verifyRunId: null,
      outcome: makeTrial("old", "a", "retry", false).outcome,
      history: [],
    },
  ];
  const c = makeTrial("c", "b", "missing", false);
  const runs = [
    run("shared", measured()),
    { ...run("retry", measured()), state: "failed" as const },
    run("missing", null),
    run("verify", measured()),
  ];
  const lookup = (id: string) => runs.find((r) => r.id === id) ?? null;
  const trials = [a, b, c];
  const plain = buildReport(job, trials, "finished", 1, at);
  const report = buildReport(job, trials, "finished", 1, at, lookup);
  const method = known(report.methods[0]);
  expect(method.orbit).toEqual(plain.methods[0]?.orbit);
  expect(method.entries.map((e) => e.tokens)).toEqual([measured(), measured(), null]);
  expect(method.tokenUsage).toEqual({
    runs: 3,
    recordedRuns: 2,
    tokens: { ...measured(), input: 440, cachedInput: 260, output: 44, reasoning: 4, calls: 4 },
  });
  const compare = compareJobs([{ job, trials }], lookup);
  expect(compare.columns[0]?.tokenUsage).toEqual(method.tokenUsage);
  expect(compare.stats).toEqual(compareJobs([{ job, trials }]).stats);
  expect(formatCompare(compare)).toContain("2/3 runs recorded");
  expect(plain.methods[0]?.tokenUsage).toBeUndefined();
  expect(plain.methods[0]?.entries[0]?.tokens).toBeUndefined();
});
