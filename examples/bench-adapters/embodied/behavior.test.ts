import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AdapterTasksResponse, RunSpec } from "../../../packages/orbit/src/contracts/index.ts";

it("plans BEHAVIOR as native Policy execution with frozen public instances and CPU verification", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const result = execFileSync(
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
from orbit_embodied.behavior1k import profile, SOURCE
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    semantic = profile()
    reference = {"id": "behavior1k-2026-r1pro-public/1",
        "environment": {"kind": "behavior1k", "tasks": ["fixture"],
            "environmentSeed": 0, "initialStateCounts": {"fixture": 20}, "horizons": {"fixture": 100},
            "assets": {"dataset": "fixture-data", "target": "/behavior-data", "digest": "sha256:" + "a"*64}},
        "parameters": {"settleSteps": 0, "renderSize": 224, "controlHz": 30, "replanSteps": 1},
        "benchmarkProfile": semantic, "observationMap": {key:key for key in semantic["observations"]},
        "reference": {"evaluation": SOURCE, "files": {}}}
    content = {"taskId": "fixture", "benchmarkProfile": reference["id"], "initialStateId": "0",
        "initialStateDigest": seed_asset(reference, "fixture"), "environmentSeed": 0,
        "policySeed": 0, "repetition": 0}
    sample = {**content, "sampleId": digest(content)}
    config = {"image": "sha256:" + "a"*64, "reference": json.dumps(reference),
        "implementationDigest": adapter.implementation_digest(), "profileDigest": digest(reference),
        "simGpus": "1", "simGpuMemGB": "16", "renderer": "vulkan"}
    request = {"benchmark": {"path": str(root), "config": config}, "trial": {
        "id": "fixture-trial", "task": "fixture", "sample": sample, "sampleRef": sample["sampleId"],
        "binding": resolve_binding(semantic, semantic, reference["observationMap"]),
        "method": {"name": "fixture", "policySnapshot": {"profile": semantic, "connector": "policy-ws", "replanSteps": 1}},
        "staging": str(root/"stage")}}
    listing = adapter.tasks(request)
    solve = adapter.solve(request)
    request["solve"] = {"output": str(root/"solve"), "run": {"id": "fixture-run", "spec": {
        "params": {"sampleRef": sample["sampleId"], "task": "fixture", "method": "fixture", "phase": "solve"},
        "tags": {"trial": "fixture-trial", "embodied_evidence": "2"}}}}
    print(json.dumps({"listing": listing, "solve": solve, "verify": adapter.verify(request)}))
`,
      dir,
    ],
    { encoding: "utf8" },
  );
  const saved = JSON.parse(result);
  const listing = AdapterTasksResponse.parse(saved.listing);
  expect(listing.capabilities?.scoreKind).toBe("scalar");
  expect(listing.capabilities?.embodied?.batch).toBeUndefined();
  const solve = RunSpec.parse(saved.solve.spec);
  expect(solve.resources.memGB).toBe(32);
  expect(solve.resources.gpus).toBe(1);
  expect(solve.mounts.some((m) => "dataset" in m && m.dataset === "fixture-data")).toBe(true);
  const verify = RunSpec.parse(saved.verify.spec);
  expect(verify.resources.gpus).toBe(0);
  expect(verify.network).toBe(false);
  expect(verify.mounts.some((m) => "dataset" in m)).toBe(false);
});
