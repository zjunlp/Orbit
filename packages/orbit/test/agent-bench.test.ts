import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asiMethodProblem } from "../src/bench/asi.ts";
import { solveVerdict } from "../src/bench/classify.ts";
import { toRunSpec } from "../src/bench/protocol.ts";
import {
  type AuthProfile,
  BenchCapabilities,
  BenchJobSpec,
  type Benchmark,
  capabilityAllows,
  isCliMethod,
  Method,
  Run,
  RunSpec,
} from "../src/contracts/index.ts";
import { AgentRegistry } from "../src/harness/registry.ts";
import { AGENT_SETUP_FAILED, AGENT_SETUP_FILE, withAgentSetup } from "../src/runs/launch.ts";
import { localBlocker } from "../src/runs/preflight.ts";
import { requireAgent } from "../test-support/agents.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-agent-bench-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bench methods name registered Agents", () => {
  it("accepts any Agent name and keeps the special kinds", () => {
    for (const agent of ["codex", "claude-code", "pi", "kimi-cli", "my-agent"]) {
      const r = BenchJobSpec.safeParse({
        benchmark: "b",
        methods: [{ name: "m", agent, auth: "p" }],
      });
      expect(r.success, agent).toBe(true);
    }
    expect(Method.safeParse({ name: "m", agent: "pi" }).success).toBe(false); // needs auth
    expect(Method.safeParse({ name: "m", agent: "empty" }).success).toBe(true);
    expect(Method.safeParse({ name: "m", agent: "policy" }).success).toBe(false);
    expect(Method.safeParse({ name: "m", agent: "Bad Name" }).success).toBe(false);
    expect(isCliMethod({ agent: "kimi-cli" })).toBe(true);
    for (const a of ["external", "oracle", "empty", "policy"])
      expect(isCliMethod({ agent: a })).toBe(false);
  });

  it("keeps concrete capability names exact and makes `cli` explicit", () => {
    const old = BenchCapabilities.parse({
      kind: "browser",
      methods: ["external", "empty"],
      conditions: {},
      scoreKind: "binary",
      rescore: "evidence",
    });
    expect(capabilityAllows(old.methods, "external")).toBe(true);
    expect(capabilityAllows(old.methods, "codex")).toBe(false);
    expect(capabilityAllows(["codex"], "codex")).toBe(true);
    expect(capabilityAllows(["codex"], "kimi-cli")).toBe(false);
    expect(capabilityAllows(["cli", "empty"], "kimi-cli")).toBe(true);
    expect(capabilityAllows(["cli"], "oracle")).toBe(false);
  });

  it("refuses reserved names as Agent definitions", () => {
    const reg = new AgentRegistry(join(dir, "agents.json"));
    const def = {
      install: { kind: "image", binary: "x" },
      command: { run: ["x", "{instruction}"] },
    } as const;
    for (const name of ["external", "oracle", "empty", "policy"])
      expect(() => reg.put({ name, ...def } as never)).toThrow(/reserved/);
  });

  it("renders a registered Agent's command for an agentTask", () => {
    const b = { name: "x", adapter: "harbor", path: dir, config: {}, env: {}, passEnv: [] };
    const m = { name: "k", agent: "kimi-cli", auth: "p", model: "kimi-k2" };
    const spec = toRunSpec(
      { image: "img", agentTask: { instruction: "do it" } },
      m,
      b as unknown as Benchmark,
      "solve",
      () => requireAgent("kimi-cli"),
    );
    expect(spec.command?.[0]).toBe("kimi");
    expect(spec.command).toContain("do it");
    expect(spec.auth).toBe("p");
  });

  it("refuses Agents ASI's native runner does not launch instead of routing them to Claude", () => {
    expect(asiMethodProblem({ agent: "codex" })).toBeNull();
    expect(asiMethodProblem({ agent: "claude-code" })).toBeNull();
    expect(asiMethodProblem({ agent: "oracle" })).toBeNull();
    expect(asiMethodProblem({ agent: "kimi-cli" })).toMatch(/not adapted/);
    expect(asiMethodProblem({ agent: "external" })).toMatch(/external/);
  });
});

describe("Agents installed inside the run", () => {
  const sh = (agentDir: string, script: string, command: string[]) => {
    writeFileSync(join(agentDir, AGENT_SETUP_FILE), script);
    const [cmd, ...args] = withAgentSetup(command);
    // The wrapper hard-codes /orbit/agent; run it with that path rewritten to the test directory.
    const patched = args.map((a) => a.replaceAll("/orbit/agent", agentDir));
    return spawnSync(cmd as string, patched, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: dir },
    });
  };

  it("runs the install script, then the command with the install prefix on PATH", () => {
    const agentDir = join(dir, "ok");
    mkdirSync(agentDir);
    const r = sh(agentDir, "echo installing", ["sh", "-c", "echo ran; echo $PATH"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ran");
    expect(r.stdout).toContain(`${dir}/.local/bin`);
    expect(readFileSync(join(agentDir, "setup.log"), "utf8")).toContain("installing");
  });

  it("stops before the command and marks the failure when the install fails", () => {
    const agentDir = join(dir, "bad");
    mkdirSync(agentDir);
    const r = sh(agentDir, "echo no network >&2; exit 7", ["sh", "-c", "echo should-not-run"]);
    expect(r.status).toBe(125);
    expect(r.stdout).not.toContain("should-not-run");
    expect(r.stderr).toContain("Agent install failed (exit 7)");
    expect(readFileSync(join(agentDir, AGENT_SETUP_FAILED), "utf8").trim()).toBe("7");
  });

  it("counts a failed install as an environment failure, not the method's result", () => {
    const at = "2026-01-01T00:00:00Z";
    const run = Run.parse({
      id: "r",
      spec: { image: "img", command: ["kimi"] },
      state: "failed",
      reason: "Agent install failed (exit 7); see orbit/agent/setup.log",
      exitCode: 125,
      node: "n",
      image: "img",
      containerId: null,
      lease: null,
      code: null,
      cleanup: "done",
      note: "",
      createdAt: at,
      startedAt: at,
      endedAt: at,
    });
    expect(solveVerdict(run)).toMatchObject({ verify: false, evaluation: "invalid" });
  });
});

describe("placement of runs with an installed Agent", () => {
  it("does not require a host CLI for an Agent that installs inside the run", async () => {
    const profile = { name: "p", kind: "api-key", harness: "dsh" } as AuthProfile;
    const ctx = {
      node: "n",
      deps: {
        auth: { get: () => ({ profile, secret: "s" }) },
        agents: { get: (n: string) => requireAgent(n), host: async () => null },
      },
      resources: async () => ({
        node: "n",
        probedAt: "",
        gpus: [],
        gpuError: null,
        cpu: { count: 8, load1: 0, busy: 0 },
        memory: { totalGB: 64, availableGB: 64 },
        disk: { path: "/", totalGB: 100, freeGB: 100 },
      }),
    } as never;
    const spec = RunSpec.parse({
      image: "img",
      command: ["x"],
      auth: "p",
      resources: { cpus: 1, memGB: 1 },
    });
    expect(await localBlocker(ctx, spec)).toBeNull();
    profile.harness = "codex";
    expect(await localBlocker(ctx, spec)).toMatch(/codex CLI not found/);
  });
});
