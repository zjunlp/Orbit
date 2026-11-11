import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TrialRequest } from "../src/bench/adapter.ts";
import { asiAdapter, asiReview, asiScore, asiSolveSpec } from "../src/bench/asi.ts";
import { AdapterRequest, BenchCapabilities, type Run } from "../src/contracts/index.ts";

const tmp = mkdtempSync(join(tmpdir(), "orbit-asi-status-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const write = (file: string, value: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, value);
};
const cli = `@click.option("--fail-on-agent-error", is_flag=True)
def run(): pass
`;
const legacy = `def solve(self, task_instance):
    if "timed out" in log:
        status = RunStatus.TIMEOUT
    elif success:
        status = RunStatus.COMPLETED
    else:
        status = RunStatus.FAILED
`;
const fixed = `def solve(self, task_instance):
    status = sandbox_agent_status(success, log)
`;
const ctx: TrialRequest["trial"] = {
  id: "job.1",
  task: "math.example",
  seed: 1,
  options: { promptLevel: "b4" },
  staging: tmp,
  hostNetwork: false,
  timeoutMin: 180,
  method: { name: "max", agent: "codex", auth: "profile", model: "gpt-6.1-sol", effort: "max" },
};
const instance = `${ctx.task}__seed31415`;

function checkout(source = fixed): TrialRequest["benchmark"] {
  const path = mkdtempSync(join(tmp, "checkout-"));
  write(join(path, "tasks/math/example/task_meta.yaml"), `id: ${ctx.task}\nstatus: final\n`);
  write(join(path, "ai4sci_bench/cli.py"), cli);
  for (const agent of ["codex_cli", "claude_code_cli"])
    write(join(path, `ai4sci_bench/adapters/${agent}.py`), source);
  return { name: "asi", path, config: { python: "python3" } };
}

describe("ASI runner compatibility", () => {
  it.each(["codex", "claude-code"] as const)(
    "rejects the known false-timeout source before starting %s",
    (agent) => {
      const b = checkout(legacy);
      expect(() => asiSolveSpec(b, { ...ctx, method: { ...ctx.method, agent } })).toThrow(
        /false timeout.*update.*registered ASI checkout/i,
      );
    },
  );

  it("parses Python instead of matching warnings, comments or docstrings", () => {
    const b = checkout(`"""${legacy}"""\n${fixed}\n# request timed out\n`);
    const original = readFileSync(join(b.path, "ai4sci_bench/adapters/codex_cli.py"));
    expect(asiSolveSpec(b, ctx).command).toContain("--fail-on-agent-error");
    expect(readFileSync(join(b.path, "ai4sci_bench/adapters/codex_cli.py"))).toEqual(original);
  });

  it("recognizes equivalent quoting, comments and spacing in the broken condition", () => {
    const source = legacy
      .replace('"timed out"', "'timed out'")
      .replace("in log:", "in log:  # catalog warning")
      .replace("status = RunStatus.TIMEOUT", "status  =  RunStatus.TIMEOUT");
    expect(() => asiSolveSpec(checkout(source), ctx)).toThrow(/false timeout/i);
  });

  it("keeps model, effort, sandbox and timeout while requiring failure propagation", () => {
    const spec = asiSolveSpec(checkout(), ctx);
    expect(spec.command).toContain("--fail-on-agent-error");
    expect(spec.command).toContain('{"model":"gpt-6.1-sol","effort":"max"}');
    expect(spec.command?.slice(-6)).toContain("os");
    expect(spec.command).toContain("10800");
    expect(spec.timeoutMin).toBe(180);
  });

  it("accepts an alternative fix that checks successful execution first", () => {
    const b = checkout(`def solve(self, task_instance):
    if success:
        status = RunStatus.COMPLETED
    elif "timed out" in log:
        status = RunStatus.TIMEOUT
    else:
        status = RunStatus.FAILED
`);
    expect(asiSolveSpec(b, ctx).command).toContain("--fail-on-agent-error");
  });

  it("requires a runner with --fail-on-agent-error and a complete source checkout", () => {
    const b = checkout();
    write(join(b.path, "ai4sci_bench/cli.py"), '"--fail-on-agent-error"\ndef run(): pass\n');
    expect(() => asiSolveSpec(b, ctx)).toThrow(/--fail-on-agent-error/);
    rmSync(join(b.path, "ai4sci_bench/adapters/codex_cli.py"));
    expect(() => asiSolveSpec(b, ctx)).toThrow(/source checkout/i);
  });

  it("reports an unusable configured Python without launching the runner", () => {
    const b = checkout();
    b.config.python = join(tmp, "missing-python");
    expect(() => asiSolveSpec(b, ctx)).toThrow(/Cannot check ASI runner compatibility/);
  });

  it.each(["oracle", "empty"] as const)(
    "keeps %s available without an agent adapter but propagates runner failures",
    (agent) => {
      const b = checkout(legacy);
      const spec = asiSolveSpec(b, { ...ctx, method: { name: agent, agent } });
      expect(spec.command).toContain("--fail-on-agent-error");
    },
  );
});

describe("ASI verification budgets", () => {
  it.each([
    ["computer_science.euclidean_tsp_tour_optimization", 90],
    ["computer_science.max3sat_assignment_optimization", 60],
    ["math.example", 30],
  ])("covers the native solver budget for %s", async (task, timeout) => {
    const b = checkout();
    const result = await asiAdapter.verify({
      protocol: 1,
      op: "verify",
      benchmark: b,
      trial: { ...ctx, task: String(task) },
      solve: { run: { id: "unused-fixture-run" } as Run, output: join(tmp, "saved-solve") },
    });
    expect(result.spec.timeoutMin).toBe(timeout);
    expect(result.spec.resources).toEqual({ gpus: 0, cpus: 1, memGB: 4 });
    expect(result.spec.command).toContain("score");
    expect(result.spec.command).toContain(join(tmp, "saved-solve", "native"));
    expect(result.spec.command).not.toContain("--timeout");
  });
});

describe("ASI execution and evaluation remain independent", () => {
  function outputs() {
    const solve = mkdtempSync(join(tmp, "solve-"));
    const verify = mkdtempSync(join(tmp, "verify-"));
    const nativeDir = join(solve, "native", ctx.task);
    mkdirSync(join(nativeDir, `${instance}__b4.outputs`), { recursive: true });
    write(
      join(verify, "score.json"),
      JSON.stringify({ results: [{ instance_id: instance, prompt_level: "b4", final_score: 80 }] }),
    );
    const result = (status: string, attempt = 1, error: string | null = null) =>
      write(
        join(nativeDir, `${instance}__b4.attempt${attempt}.json`),
        JSON.stringify({
          instance_id: instance,
          prompt_level: "b4",
          attempt,
          status,
          agent_output: { status, error_message: error, log: "request timed out" },
        }),
      );
    return { solve, verify, result };
  }

  it.each([
    ["completed", "completed"],
    ["failed", "execution_failed"],
    ["timeout", "execution_timeout"],
  ])("keeps %s execution even when the score is valid", (status, attempt) => {
    const { solve, verify, result } = outputs();
    result(status);
    expect(asiScore(ctx, solve, verify)).toMatchObject({ score: 80, invalid: false });
    expect(asiReview(ctx, solve, verify)?.details).toMatchObject({ attempt_status: attempt });
  });

  it("uses the highest attempt number for both the review and failure issues", () => {
    const { solve, verify, result } = outputs();
    result("timeout", 2);
    result("completed", 10);
    expect(asiScore(ctx, solve, verify).issues).not.toContain("runner status timeout");
    expect(asiReview(ctx, solve, verify)?.details).toMatchObject({ attempt_status: "completed" });
    result("failed", 11);
    expect(asiScore(ctx, solve, verify).issues).toContain("runner status failed");
    expect(asiReview(ctx, solve, verify)?.details).toMatchObject({
      attempt_status: "execution_failed",
    });
  });
});

it("declares its identity and the native runner's actual Agent admission", () => {
  const req = AdapterRequest.parse({ protocol: 1, op: "tasks", benchmark: checkout() });
  const info = asiAdapter.info?.(req, []);
  const caps = BenchCapabilities.parse(info?.capabilities);
  expect(caps.identity?.id).toBe("asi-bench");
  expect(caps.taxonomy?.domains).toContain("science");
  expect(caps.methods).toEqual(["oracle", "empty", "codex", "claude-code"]);
});
