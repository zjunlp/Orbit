import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  AdapterSpecResponse,
  AdapterTasksResponse,
  GuiTrajectory,
  RunSpec,
  ScoreResult,
} from "../src/contracts/index.ts";
import { modelMatches } from "../src/resources/allocate.ts";

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

it.each(["robodojo", "robolab"])(
  "keeps %s native semantics and RTX requirements through the actual contracts",
  (kind) => {
    const dir = fileURLToPath(
      new URL("../../../examples/bench-adapters/embodied/", import.meta.url),
    );
    const output = execFileSync(
      "python3",
      [
        "-S",
        "-B",
        "-c",
        `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import adapter
from orbit_embodied.binding import digest, seed_asset, resolve_binding
kind = sys.argv[2]
reference = json.loads((Path(sys.argv[1]) / "profiles" / (kind + "-native.json")).read_text())
env = reference["environment"]
task = env["tasks"][0]
env["tasks"] = [task]
env["assets"]["digest"] = "sha256:" + "a" * 64
if kind == "robodojo":
    env["layouts"] = {task: {"0": [{"id": 0, "file": "synthetic/layout_5.json", "digest": "sha256:" + "b" * 64}]}}
    env["unsupported"] = {}
reference["reference"]["files"] = {}
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    config = {"image": "sha256:" + "a" * 64, "reference": json.dumps(reference),
              "profileDigest": digest(reference), "implementationDigest": adapter.implementation_digest(),
              "simGpus": "1", "simGpuMemGB": "16", "renderer": "vulkan"}
    content = {"taskId": task, "benchmarkProfile": reference["id"], "initialStateId": "0",
               "initialStateDigest": seed_asset(reference, task), "environmentSeed": 0,
               "policySeed": 0, "repetition": 0}
    sample = {**content, "sampleId": digest(content)}
    profile = reference["benchmarkProfile"]
    request = {"benchmark": {"path": str(root), "config": config}, "trial": {
        "id": "synthetic-trial", "task": task, "sample": sample, "sampleRef": sample["sampleId"],
        "binding": resolve_binding(profile, profile, reference["observationMap"]),
        "method": {"policySnapshot": {"profile": profile}}, "staging": str(root / "staging")}}
    listing = adapter.tasks(request)
    solve = adapter.solve(request)
    request["solve"] = {"output": str(root / "output"), "run": {"id": "synthetic-run", "spec": {
        "params": {"sampleRef": sample["sampleId"], "task": task, "method": "hold", "phase": "solve"},
        "tags": {"trial": "synthetic-trial", "embodied_evidence": "2"}}}}
    request["trial"]["method"]["name"] = "hold"
    print(json.dumps({"listing": listing, "solve": solve, "verify": adapter.verify(request)}))
`,
        dir,
        kind,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    const saved = JSON.parse(output);
    const listing = AdapterTasksResponse.parse(saved.listing);
    expect(listing.tasks).toHaveLength(1);
    expect(listing.capabilities?.scoreKind).toBe(kind === "robodojo" ? "scalar" : "binary");
    const solve = RunSpec.parse(AdapterSpecResponse.parse(saved.solve).spec);
    expect(solve.resources.gpus).toBe(1);
    expect(solve.resources.gpuMemGB).toBe(16);
    expect(solve.resources.gpuModels?.length).toBeGreaterThan(0);
    for (const card of ["NVIDIA GeForce RTX 3090", "NVIDIA L40S", "NVIDIA A10"])
      expect(modelMatches(card, solve.resources.gpuModels)).toBe(true);
    for (const card of ["NVIDIA A100", "NVIDIA H100"])
      expect(modelMatches(card, solve.resources.gpuModels)).toBe(false);
    const verify = RunSpec.parse(AdapterSpecResponse.parse(saved.verify).spec);
    expect(verify.resources.gpus).toBe(0);
    expect(verify.network).toBe(false);
    expect(verify.mounts.some((mount) => "dataset" in mount)).toBe(false);
  },
);
