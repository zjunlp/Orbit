// Explicit metadata doubles isolate declaration/profile admission; no Agent or model is invoked.
import { expect, it, vi } from "vitest";
import { agentCompatibility } from "../src/bench/hub.ts";
import { BenchService } from "../src/bench/service.ts";
import { type AuthProfile, BenchCapabilities, type Method } from "../src/contracts/index.ts";
import { builtinRegistry } from "../src/harness/registry.ts";

it("targeted admission and submit share MCP, requires, auth-kind and harness rules", async () => {
  const original = builtinRegistry().get("codex");
  if (!original) throw new Error("missing built-in codex definition");
  const def = structuredClone(original);
  def.auth.kinds = ["api-key"];
  const profiles: AuthProfile[] = [];
  const service = Object.create(BenchService.prototype) as BenchService;
  Object.assign(service, {
    agents: { list: () => [def], get: () => def },
    deps: {
      auth: {
        list: () => profiles,
        get: (name: string) => {
          const profile = profiles.find((p) => p.name === name);
          return profile ? { profile } : null;
        },
      },
    },
  });
  vi.spyOn(service, "benchmark").mockReturnValue({ name: "fixture" } as ReturnType<
    BenchService["benchmark"]
  >);
  const caps = BenchCapabilities.parse({
    methods: ["cli"],
    conditions: {},
    scoreKind: "binary",
    rescore: "score",
  });
  vi.spyOn(service, "infoOf").mockImplementation(async () => ({
    tasks: [],
    metrics: [],
    capabilities: caps,
  }));
  const method = { name: "m", agent: "codex", auth: "profile" };
  const check = (requires = caps.requires) =>
    (service as unknown as { checkMethod(m: Method, requires: string[]): void }).checkMethod(
      method,
      requires,
    );
  const state = async () => (await service.benchmarkCompatibility("fixture")).rows[0]?.cells.codex;
  expect(await state()).toMatchObject({ state: "needs-auth" });
  expect(check).toThrow("auth profile not found");
  const profile = { name: "profile", harness: "codex", kind: "login" } as AuthProfile;
  profiles.push(profile);
  expect(await state()).toMatchObject({ state: "needs-auth" });
  expect(check).toThrow("does not support login");
  profile.kind = "api-key";
  profile.harness = "claude-code";
  expect(await state()).toMatchObject({ state: "needs-auth" });
  expect(check).toThrow("not codex");
  profile.harness = "codex";
  expect(await state()).toMatchObject({ state: "allowed" });
  expect(check).not.toThrow();
  caps.requires = ["mcp"];
  def.command.mcp = { kind: "none" };
  expect(await state()).toMatchObject({ state: "blocked", reason: expect.stringContaining("MCP") });
  expect(check).toThrow("MCP");
  caps.requires = ["multiTurn"];
  def.capabilities.multiTurn = false;
  expect(await state()).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("multiTurn"),
  });
  expect(check).toThrow("multiTurn");
  expect(agentCompatibility(def, undefined, profiles)).toMatchObject({ state: "unknown" });
});
