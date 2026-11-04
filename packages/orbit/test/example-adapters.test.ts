import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterSpecResponse, RunSpec } from "../src/contracts/index.ts";

it.each(["posttrainbench", "researchclawbench", "longds", "browsergym", "cua-bench", "cua-lite"])(
  "checks the %s Python adapter",
  (name) => {
    const dir = fileURLToPath(
      new URL(`../../../examples/bench-adapters/${name}/`, import.meta.url),
    );
    execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", dir], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: "pipe",
    });
  },
);

it("plans a Cua desktop service with the real Run contract", () => {
  const dir = fileURLToPath(
    new URL("../../../examples/bench-adapters/cua-bench/", import.meta.url),
  );
  const result = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json, sys
sys.path.insert(0, sys.argv[1])
from test_adapter import AdapterTest
fixture = AdapterTest()
fixture.setUp()
try:
    print(json.dumps({"spec": fixture.solve()}))
finally:
    fixture.doCleanups()
`,
      dir,
    ],
    { encoding: "utf8" },
  );
  const response = AdapterSpecResponse.parse(JSON.parse(result));
  const spec = RunSpec.parse(response.spec);
  expect(spec.services[0]?.healthcheck?.command).toEqual([
    "sh",
    "-c",
    "test -s /run/cua/env-token",
  ]);
  expect(spec.volumeMounts[0]?.mode).toBe("ro");
  expect(spec.services[0]?.collect).toEqual([]);
});
