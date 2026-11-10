import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterSpecResponse, AdapterTasksResponse, RunSpec } from "../src/contracts/index.ts";

const directory = fileURLToPath(
  new URL("../../../examples/bench-adapters/embodied-clbench/", import.meta.url),
);

it("checks EmbodiedCLBench sequence, visual provenance and isolation with explicit fixtures", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", directory], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
});

it("accepts the EmbodiedCLBench native MCP plan with real Orbit contracts", () => {
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json,sys
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from test_adapter import AdapterTests, adapter
fixture=AdapterTests()
fixture.setUp()
try:
    with patch.object(adapter, 'native_prompt', return_value='Native task instruction'):
        print(json.dumps({'tasks':adapter.tasks(fixture.req),'solve':adapter.solve(fixture.req)}))
finally:
    fixture.tearDown()
`,
      directory,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const result = JSON.parse(output);
  const tasks = AdapterTasksResponse.parse(result.tasks);
  const solve = AdapterSpecResponse.parse(result.solve);
  const spec = RunSpec.parse({ ...solve.spec, command: ["true"] });
  expect(tasks.tasks).toHaveLength(5);
  expect(tasks.tasks.filter((task) => task.supported)).toHaveLength(4);
  expect(tasks.capabilities?.taxonomy?.domains).toEqual(["robotics"]);
  expect(spec.resources.gpus).toBe(0);
  expect(spec.mounts.map((mount) => mount.target)).toEqual(["/tools/clbench-mcp.py"]);
  expect(spec.services[0]?.collect).toEqual(["/evidence"]);
  expect(spec.services[0]?.networks).toEqual(["embodied"]);
});
