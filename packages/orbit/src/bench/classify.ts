// Trial outcome: execution (how the solve run ended), evaluation (whether the score can be trusted)
// and cleanup are kept apart. Only `valid` outcomes enter means; `unknown` means Orbit cannot tell
// (cancelled or lost), `invalid` means the environment or verifier failed to produce a real score,
// the solve run was killed for exceeding its memory request, a service of its environment broke, or
// its Agent could not work (credentials, model access, quota, endpoint).
import type { FailureKind, Outcome, Run, ScoreResult } from "../contracts/index.ts";
import type { AgentFailure } from "../sessions/index.ts";

export const cleanupOf = (...runs: (Run | null)[]): Outcome["cleanup"] => {
  const rs = runs.filter((r): r is Run => r !== null);
  if (rs.some((r) => r.cleanup === "failed")) return "failed";
  if (rs.some((r) => r.cleanup === "pending")) return "pending";
  return "done";
};

const oomIssue = (r: Run) =>
  `ran out of memory (limit ${r.spec.resources.memGB} GB, peak ${r.usage?.peakMemGB ?? "?"} GB)`;

/** Only the Run scheduler's deadline reason denotes an execution timeout. */
export const timedOut = (r: Run): boolean =>
  r.state === "failed" && /^timeout after \d+(?:\.\d+)?(?:e[+-]?\d+)? min$/.test(r.reason ?? "");

/** Whether the solve run got far enough that its result should be verified. */
export function solveVerdict(solve: Run): {
  verify: boolean;
  evaluation?: Outcome["evaluation"];
  issue?: string;
  failure?: FailureKind;
} {
  if (solve.state === "cancelled")
    return { verify: false, evaluation: "unknown", issue: "solve cancelled" };
  if (solve.state === "lost") return { verify: false, evaluation: "unknown", issue: "solve lost" };
  // Never started: the environment (image build, auth, lease) failed, not the method.
  if (solve.startedAt === null)
    return {
      verify: false,
      evaluation: "invalid",
      issue: `environment failed: ${solve.reason ?? "not started"}`,
      failure: "infra",
    };
  // The Agent CLI could not be installed in the container: the environment failed, not the method.
  if (solve.reason?.startsWith("Agent install failed"))
    return {
      verify: false,
      evaluation: "invalid",
      issue: `environment failed: ${solve.reason}`,
      failure: "agent_install",
    };
  // Timeouts and failures are the method's result; whatever it left behind is verified.
  return { verify: true };
}

export const shouldCheckAgentFailure = (solve: Run): boolean => solveVerdict(solve).verify;

export const agentFailureKind = (failure: AgentFailure): FailureKind =>
  failure.kind === "agent_configuration_failed" ? "infra" : "model_unavailable";

export const agentFailureIssue = (failure: AgentFailure): string =>
  `Agent stopped: ${failure.kind} (${failure.message})`;

export function classify(
  solve: Run,
  verify: Run | null,
  score: ScoreResult | null,
  issues: string[] = [],
  agent: AgentFailure | null = null,
  options: { independentEpisode?: boolean } = {},
): Outcome {
  const independent = options.independentEpisode && verify !== null && score !== null;
  const base = { execution: solve.state as string, maxScore: score?.maxScore ?? 1 };
  const all = [...issues];
  if (solve.state === "failed" && timedOut(solve)) all.push("solve timed out");
  // Out of memory is the resource request's fault, not the method's: the score is kept but invalid.
  const oom = solve.usage?.oomKilled ? oomIssue(solve) : null;
  // Like OOM: the setup's fault, not the method's; the score is kept but invalid.
  const agentIssue = agent ? agentFailureIssue(agent) : null;
  // A service the task environment depends on broke while the method ran: the environment's fault.
  const serviceIssues = solve.services
    .filter((s) => s.failure)
    .map((s) => `service ${s.name} failed during the run: ${s.failure}`);
  if (!oom && solve.usage?.oomKills)
    all.push(`${solve.usage.oomKills} process(es) in the solve run killed for memory`);
  const out = (
    evaluation: Outcome["evaluation"],
    s: number | null,
    extra: string[] = [],
    failure?: FailureKind,
  ): Outcome => ({
    ...base,
    evaluation,
    score: s,
    issues: [...all, ...extra],
    cleanup: cleanupOf(solve, verify),
    // Whatever the grader produced stays reviewable, also when the score is not trusted.
    review: score?.review ?? null,
    ...(score?.metrics ? { metrics: score.metrics } : {}),
    ...(score?.episode ? { episode: score.episode } : {}),
    ...(evaluation === "invalid" && failure ? { failure } : {}),
  });
  // The first setup problem decides the failure kind: memory, Agent setup, then a service.
  const setupFailure: FailureKind | undefined = oom
    ? "budget_exceeded"
    : agent
      ? agentFailureKind(agent)
      : serviceIssues.length
        ? "infra"
        : undefined;
  const sv: ReturnType<typeof solveVerdict> = independent ? { verify: true } : solveVerdict(solve);
  if (!sv.verify)
    return out(sv.evaluation ?? "unknown", null, sv.issue ? [sv.issue] : [], sv.failure);
  const setup = independent
    ? []
    : [oom, agentIssue, ...serviceIssues].filter((x): x is string => x !== null);
  if (independent)
    all.push(
      ...[oom, ...serviceIssues]
        .filter((x): x is string => x !== null)
        .map((issue) => `shared solve: ${issue}`),
    );
  // The Agent could not work, so its leftovers are not verified (a rescore still can).
  if (!verify && agent)
    return out("invalid", null, [...setup, "verify skipped"], agentFailureKind(agent));
  if (!verify) return out("unknown", null, ["verify not run"]);
  // Verified in the solve run's container (its after phase), as Harbor's shared verifier mode.
  if (verify.id === solve.id && solve.spec.after) {
    const a = solve.after;
    if (!a || a.state === "running") return out("unknown", null, ["verify did not finish"]);
    if (a.state === "skipped" || a.state === "error")
      return out("invalid", null, [`verifier did not run: ${a.reason ?? a.state}`], "scorer_error");
    if (a.state === "timeout") return out("invalid", null, ["verify timed out"], "scorer_error");
  } else if (verify.state === "cancelled" || verify.state === "lost")
    return out("unknown", null, [`verify ${verify.state}`]);
  else if (verify.startedAt === null)
    return out(
      "invalid",
      null,
      [`verifier environment failed: ${verify.reason ?? "not started"}`],
      "infra",
    );
  else if (timedOut(verify)) return out("invalid", null, ["verify timed out"], "scorer_error");
  else if (verify.usage?.oomKilled)
    return out("invalid", null, [`verify ${oomIssue(verify)}`], "scorer_error");
  if (!score) return out("invalid", null, ["no score", ...setup], setupFailure ?? "scorer_error");
  if (score.invalid || score.score === null || setup.length)
    return out(
      "invalid",
      score.score,
      [...score.issues, ...setup],
      setupFailure ?? score.failure ?? "scorer_error",
    );
  return out("valid", score.score, score.issues);
}
