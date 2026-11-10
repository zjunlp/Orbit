import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterSpecResponse, AdapterTasksResponse, RunSpec } from "../src/contracts/index.ts";

const directory = fileURLToPath(
  new URL("../../../examples/bench-adapters/embodiedlab/", import.meta.url),
);

it("checks EmbodiedLab planning, isolation and signed evidence with explicit fixtures", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", directory], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
});

it("accepts the EmbodiedLab native service plan with real Orbit contracts", () => {
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json,sys
sys.path.insert(0,sys.argv[1])
from test_adapter import EmbodiedLabAdapterTests
import adapter
fixture=EmbodiedLabAdapterTests()
fixture.setUp()
try:
    print(json.dumps({"tasks":adapter.tasks(fixture.req),"solve":adapter.solve(fixture.req)}))
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
  expect(tasks.tasks).toHaveLength(30);
  expect(tasks.capabilities?.taxonomy?.domains).toEqual(["science", "robotics"]);
  expect(spec.services[0]?.role).toBe("sim");
  expect(spec.services[0]?.gpus).toBe(1);
  expect(spec.resources.gpus).toBe(0);
  expect(spec.mounts).toEqual([]);
  expect(spec.services[0]?.collect).toEqual(["/evidence"]);
});
