import type { AtifTrajectory, Run, RunTokens, TokenUsage } from "../contracts/index.ts";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (values: (number | null | undefined)[]): number | null =>
  values.length && values.every((v) => v != null)
    ? count(values.reduce<number>((total, value) => total + (value ?? 0), 0))
    : null;
const fields = ["input", "cachedInput", "cacheWrite", "output", "reasoning", "calls"] as const;

function combine(values: (RunTokens | null)[], reportedCost?: number): RunTokens | null {
  if (!values.length) return null;
  const totals = Object.fromEntries(
    fields.map((key) => [key, sum(values.map((v) => v?.[key]))]),
  ) as Pick<RunTokens, (typeof fields)[number]>;
  const costs = values.map((v) => v?.costUsd);
  const costUsd =
    reportedCost ??
    (costs.length && costs.every((v) => v != null)
      ? money(costs.reduce<number>((a, b) => a + (b ?? 0), 0))
      : null);
  if (
    fields.filter((key) => key !== "calls").every((key) => totals[key] === null) &&
    costUsd === null
  )
    return null;
  return { ...totals, ...(costUsd === null ? {} : { costUsd }), source: "session" };
}

function ownTokens(t: AtifTrajectory): RunTokens | null {
  const steps = t.steps.filter(
    (s) => s.source === "agent" && !s.is_copied_context && s.llm_call_count !== 0,
  );
  if (!steps.length) return null;
  const metrics = steps.map((s) => s.metrics);
  const final = t.final_metrics;
  const extra = object(object(final?.extra).orbit);
  const native = metrics.map((m) =>
    object(object(m?.extra).native_usage ?? object(object(m?.extra).orbit).native_usage),
  );
  // An omitted final total can deliberately indicate a missing prefix; never fill it from partial steps.
  const total = (
    field: "total_prompt_tokens" | "total_completion_tokens" | "total_cached_tokens",
    step: "prompt_tokens" | "completion_tokens" | "cached_tokens",
  ) => (final ? count(final[field]) : sum(metrics.map((m) => count(m?.[step]))));
  const input = total("total_prompt_tokens", "prompt_tokens");
  const output = total("total_completion_tokens", "completion_tokens");
  const cachedInput = total("total_cached_tokens", "cached_tokens");
  const cacheWrite =
    "measured_calls" in extra && count(extra.calls) === null
      ? null
      : sum(native.map((u) => count(u.cache_creation_input_tokens ?? u.cache_write_input_tokens)));
  const reasoning =
    "measured_calls" in extra
      ? count(extra.reasoning_output_tokens)
      : sum(native.map((u) => count(u.reasoning_output_tokens)));
  const calls =
    "measured_calls" in extra ? count(extra.calls) : sum(steps.map((s) => count(s.llm_call_count)));
  const costs = metrics.map((m) => money(m?.cost_usd));
  const costUsd =
    money(final?.total_cost_usd) ??
    (costs.every((v) => v !== null)
      ? money(costs.reduce<number>((a, b) => a + (b ?? 0), 0))
      : null);
  return combine([
    {
      input,
      output,
      cachedInput,
      cacheWrite,
      reasoning,
      calls,
      ...(costUsd === null ? {} : { costUsd }),
      source: "session",
    },
  ]);
}

function reportedSessionCost(t: AtifTrajectory): number | undefined {
  if (t.agent.name !== "claude-code") return undefined;
  const metadata = t.extra?.orbit?.metadata?.native_metadata;
  if (!Array.isArray(metadata)) return undefined;
  let cost: number | undefined;
  for (const row of metadata) {
    const value = object(object(row).value);
    if (value.type === "cost-state" && value.sessionId === t.session_id)
      cost = money(value.totalCostUSD) ?? undefined;
  }
  return cost;
}

/** Root totals exclude embedded children; count each trajectory once, never its copied context. */
export function trajectoryTokens(trajectory: AtifTrajectory): RunTokens | null {
  const seen = new Set<string>();
  const values: (RunTokens | null)[] = [];
  const visit = (t: AtifTrajectory) => {
    const id = t.trajectory_id ?? t.session_id;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    if (t.steps.some((s) => s.source === "agent" && !s.is_copied_context && s.llm_call_count !== 0))
      values.push(ownTokens(t));
    for (const child of t.subagent_trajectories ?? []) visit(child);
  };
  visit(trajectory);
  // Claude cost-state is the CLI session total, already including its subagents.
  return combine(values, reportedSessionCost(trajectory));
}

export function tokenUsage(runs: Pick<Run, "id" | "tokens">[]): TokenUsage {
  const unique = [...new Map(runs.map((run) => [run.id, run])).values()];
  const recorded = unique.flatMap((run) => (run.tokens ? [run.tokens] : []));
  return { runs: unique.length, recordedRuns: recorded.length, tokens: combine(recorded) };
}
