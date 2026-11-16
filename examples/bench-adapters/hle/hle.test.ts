import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { toRunSpec } from "../../../packages/orbit/src/bench/protocol.ts";
import { AgentDefinition, RunSpec } from "../../../packages/orbit/src/contracts/index.ts";
import { runArgs } from "../../../packages/orbit/src/executor/docker.ts";
import { BUILTIN_SEEDS } from "../../../packages/orbit/src/harness/definitions.ts";

it("keeps the native HLE CLI offline while its socket gateway can reach the network", () => {
  const cwd = fileURLToPath(new URL(".", import.meta.url));
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json
from test_adapter import AdapterTests
import adapter
f = AdapterTests(); f.setUp()
try:
 print(json.dumps(adapter.plan(f.req, "solve")["spec"]))
finally: f.doCleanups()
`,
    ],
    { cwd, encoding: "utf8" },
  );
  const spec = JSON.parse(output);
  // MCP bundle writing is checked separately; this check concerns network preservation.
  spec.agentTask.tools = [];
  const method = { name: "real-cli", agent: "claude-code", auth: "relay", model: "fixture" };
  const benchmark = {
    name: "hle",
    adapter: "fixture",
    path: cwd,
    config: {},
    env: {},
    passEnv: [],
    createdAt: "",
    updatedAt: "",
  };
  const resolved = RunSpec.parse(
    toRunSpec(spec, method, benchmark, "solve", () =>
      AgentDefinition.parse(BUILTIN_SEEDS.find((d) => d.name === "claude-code")),
    ),
  );
  expect(resolved.network).toBe(false);
  const { network: _explicitNetwork, ...defaultNetwork } = spec;
  expect(
    toRunSpec(defaultNetwork, method, benchmark, "solve", () =>
      AgentDefinition.parse(BUILTIN_SEEDS.find((d) => d.name === "claude-code")),
    ).network,
  ).toBe(true);
  expect(resolved.runNetworks).toEqual([]);
  expect(resolved.services[0]?.networks).toEqual(["web"]);
  const command = runArgs({
    name: "fixture",
    image: "fixture",
    command: ["true"],
    mounts: [],
    env: {},
    workdir: null,
    user: null,
    labels: {},
    gpuIds: [],
    gpuMode: "gpus",
    cpus: 1,
    memGB: 1,
    network: "none",
    networks: [],
  });
  expect(command[command.indexOf("--network") + 1]).toBe("none");
});

it("checks HLE adapter and filter regressions with explicit fixtures", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "test_adapter"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
    stdio: "pipe",
  });
});
