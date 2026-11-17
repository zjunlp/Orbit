import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterTasksResponse, RunSpec } from "../../../packages/orbit/src/contracts/index.ts";

it("keeps native simulator resources separate from the Agent under the real contracts", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const result = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json, sys
sys.path.insert(0, sys.argv[1])
import adapter
from test_adapter import AdapterTest
fixture = AdapterTest()
fixture.setUp()
try:
    print(json.dumps({"listing": adapter.tasks(fixture.req), "spec": fixture.solve()}))
finally:
    fixture.doCleanups()
`,
      dir,
    ],
    { encoding: "utf8" },
  );
  const saved = JSON.parse(result);
  const listing = AdapterTasksResponse.parse(saved.listing);
  expect(listing.capabilities?.requires).toEqual(["mcp"]);
  const spec = RunSpec.parse(saved.spec);
  expect(spec.services[0]?.role).toBe("sim");
  expect(spec.services[0]?.gpus).toBe(1);
  expect(spec.resources.gpus).toBe(0);
  expect(spec.hooks[0]?.timeoutSec).toBe(600);
  expect(spec.mounts.some((m) => "source" in m && m.source?.endsWith("private.pem"))).toBe(false);
});
