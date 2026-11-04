import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  AdapterSpecResponse,
  GuiTrajectory,
  RunSpec,
  ScoreResult,
} from "../src/contracts/index.ts";

it.each([
  "posttrainbench",
  "researchclawbench",
  "longds",
  "browsergym",
  "cua-bench",
  "cua-lite",
  "mobileworld",
  "osworld-v2",
])("checks the %s Python adapter", (name) => {
  const dir = fileURLToPath(new URL(`../../../examples/bench-adapters/${name}/`, import.meta.url));
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", dir], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
});

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

it.each(["webharbor.webvoyager", "online_mind2web"])(
  "plans the %s native service and judge phase with the real Run contract",
  (suite) => {
    const dir = fileURLToPath(
      new URL("../../../examples/bench-adapters/cua-lite/", import.meta.url),
    );
    const result = execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `
import json, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import adapter
from test_web import WebAdapterTest
fixture = WebAdapterTest()
fixture.setUp()
try:
    request = fixture.request(sys.argv[2])
    with patch.object(adapter, 'settings', return_value=(fixture.root, request['benchmark']['config'], 10)), patch.object(adapter, 'readiness', return_value=None), patch.object(adapter, 'web_readiness', return_value=None):
        print(json.dumps(adapter.solve(request)))
finally:
    fixture.doCleanups()
`,
        dir,
        suite,
      ],
      { encoding: "utf8" },
    );
    const response = AdapterSpecResponse.parse(JSON.parse(result));
    const spec = RunSpec.parse(response.spec);
    expect(spec.services).toHaveLength(1);
    expect(spec.after?.command).toEqual(["python", "/adapter/judge.py"]);
    expect(spec.after?.passEnv).toEqual([]);
    expect(spec.services[0]?.healthcheck?.command[0]).toBe("python");
    expect(spec.services[0]?.env).not.toHaveProperty("OPENAI_API_KEY");
  },
);

it.each(["mobileworld", "osworld-v2"])(
  "checks saved %s fixture evidence against the shared score and GUI contracts",
  (name) => {
    const dir = fileURLToPath(
      new URL(`../../../examples/bench-adapters/${name}/`, import.meta.url),
    );
    const result = execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `
import json, sys
sys.path.insert(0, sys.argv[1])
import adapter, evidence
from test_adapter import AdapterTests
fixture = AdapterTests()
fixture.setUp()
try:
    fixture.saved()
    report = evidence.validate(fixture.root)
    evidence.write(fixture.root / 'validation.json', report)
    request = {'trial': evidence.read(fixture.root / 'plan.json'),
               'solve': {'output': str(fixture.root)}, 'verify': {'output': str(fixture.root)}}
    print(json.dumps({'score': adapter.score(request),
                      'trajectory': evidence.read(fixture.root / 'trajectory-review.json')}))
finally:
    fixture.doCleanups()
`,
        dir,
      ],
      { encoding: "utf8" },
    );
    const saved = JSON.parse(result);
    const score = ScoreResult.parse(saved.score);
    const trajectory = GuiTrajectory.parse(saved.trajectory);
    expect(score.invalid).toBe(false);
    expect(score.score).toBe(0);
    expect(trajectory.steps[0]?.action).toBeNull();
    expect(score.review?.files.some((file) => file.kind === "trajectory")).toBe(true);
  },
);
