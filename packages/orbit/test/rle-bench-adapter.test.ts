import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterTasksResponse } from "../src/contracts/index.ts";

const directory = fileURLToPath(
  new URL("../../../examples/bench-adapters/rle-bench/", import.meta.url),
);

it("checks RLE native fault flags, source integrity and budget preservation with explicit fixtures", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", directory], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
});

it("accepts RLE harness metadata and a nonzero native reference floor", () => {
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json,sys
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import adapter
native={"tasks":[{"id":"task08","title":"synthetic task","supported":True,"reason":None,"tags":{}}]}
with patch.object(adapter,"delegate",return_value=native), patch.object(adapter,"catalog",return_value={"task08":"task08"}):
    print(json.dumps(adapter.tasks({"benchmark":{"path":"/synthetic"}})))
`,
      directory,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const result = AdapterTasksResponse.parse(JSON.parse(output));
  expect(result.capabilities?.identity?.id).toBe("rle-bench");
  expect(result.capabilities?.taxonomy?.domains).toEqual(["robotics"]);
  expect(result.capabilities?.calibration?.oracle).toEqual({ min: 0.64, max: 1 });
  expect(result.tasks[0]?.tags.evaluation).toBe("coding-agent-harness");
});
