// The manifest adapter's pure parts and run planning, with a listed-task fixture (no Docker).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { handle } from "../src/bench/adapter.ts";
import {
  loadManifest,
  manifestAdapter,
  readResult,
  reduce,
  render,
  select,
} from "../src/bench/manifest.ts";
import { AdapterTasksResponse, RunSpec } from "../src/contracts/index.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const MANIFEST = `
version: 1
image: example/bench@sha256:${"a".repeat(64)}
conditions: { Suite: demo }
metrics: [{ name: success, label: Success, unit: "%", primary: true }]
tasks:
  list:
    - { id: "demo:open-door", tags: { name: open-door } }
files:
  config.yaml: "task: {{json:task.tags.name}}\\nseed: {{seed}}\\n"
solve:
  command: [run, "--task={{task.tags.name}}", "--seed={{seed}}"]
  resources: { cpus: 2, memGB: 4 }
methods:
  empty: {}
  external:
    services:
      - name: policy
        image: "{{method.entrypoint}}"
        role: policy
        gpus: 1
        command: ["{{argv:method.config.command}}"]
        binds: [{ source: helper.py, target: /helper.py }]
result:
  file: "*_result.json"
  score: { path: "episodes[*].success", reduce: mean }
  metrics: { success: { path: "episodes[*].success", reduce: mean, scale: 100 } }
  invalid:
    - { path: "episodes[*].error", failure: env_step, issue: an episode errored }
`;
writeFileSync(join(dir, "orbit-bench.yaml"), MANIFEST);
writeFileSync(join(dir, "helper.py"), "");
const benchmark = { name: "demo", path: dir, config: {} };
const trial = (agent: string, extra = {}) => ({
  id: "t1",
  task: "demo:open-door",
  method: { name: agent, agent, ...extra },
  seed: 3,
  options: {},
  staging: join(dir, "staging"),
  hostNetwork: false,
});

it("selects, reduces and renders without evaluating anything", () => {
  const doc = { a: [{ b: 1 }, { b: 0 }, { c: 2 }] };
  expect(select(doc, "a[*].b")).toEqual([1, 0]);
  expect(select(doc, "a[1].b")).toEqual([0]);
  expect(reduce([1, 0], "mean")).toBe(0.5);
  expect(reduce([true, false], "all")).toBe(0);
  expect(reduce(["x"], "mean")).toBeNull();
  expect(render("x={{json:a}}", { a: 'q"' })).toBe('x="q\\""');
  expect(() => render("{{missing}}", {})).toThrow(/unknown placeholder/);
});

it("declares tasks, metrics and capabilities from the manifest", () => {
  const reply = AdapterTasksResponse.parse(
    handle(manifestAdapter, { protocol: 1, op: "tasks", benchmark }),
  );
  expect(reply.tasks.map((t) => t.id)).toEqual(["demo:open-door"]);
  expect(reply.capabilities).toMatchObject({ methods: ["empty", "external"], rescore: "evidence" });
  expect(reply.capabilities?.conditions.Suite).toBe("demo");
  expect(reply.metrics[0]?.name).toBe("success");
});

it("plans a method's solve run with staged files and manifest-relative binds", () => {
  const empty = manifestAdapter.solve({
    protocol: 1,
    op: "solve",
    benchmark,
    trial: trial("empty"),
  } as never);
  expect(empty.spec.command).toEqual(["run", "--task=open-door", "--seed=3"]);
  expect(empty.spec.mounts?.[0]).toMatchObject({ target: "/orbit-config", mode: "ro" });
  expect(empty.issues).toEqual([]);
  const ext = manifestAdapter.solve({
    protocol: 1,
    op: "solve",
    benchmark,
    trial: trial("external", {
      entrypoint: "ghcr.io/x/policy:1",
      config: { command: '["serve","--port","8000"]' },
    }),
  } as never);
  const svc = ext.spec.services?.[0];
  expect(svc).toMatchObject({ image: "ghcr.io/x/policy:1", command: ["serve", "--port", "8000"] });
  expect(svc?.binds?.[0]?.source).toBe(join(dir, "helper.py"));
  expect(RunSpec.safeParse({ ...ext.spec, name: "x" }).success).toBe(true);
  expect(() =>
    manifestAdapter.solve({ protocol: 1, op: "solve", benchmark, trial: trial("oracle") } as never),
  ).toThrow(/does not declare a oracle method/);
});

it("reads the score and marks upstream errors invalid", () => {
  const { m } = loadManifest(benchmark);
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  expect(readResult(m, out)).toMatchObject({ invalid: true, failure: "scorer_error" });
  writeFileSync(
    join(out, "A_result.json"),
    JSON.stringify({ episodes: [{ success: 1 }, { success: 0 }] }),
  );
  expect(readResult(m, out)).toMatchObject({
    score: 0.5,
    invalid: false,
    metrics: { success: 50 },
  });
  writeFileSync(
    join(out, "B_result.json"),
    JSON.stringify({ episodes: [{ success: 0, error: "sim crashed" }] }),
  );
  expect(readResult(m, out)).toMatchObject({ score: null, invalid: true, failure: "env_step" });
});

it("refuses paths leaving the manifest directory and unknown config", () => {
  writeFileSync(
    join(dir, "bad.yaml"),
    MANIFEST.replace(
      "  resources: { cpus: 2, memGB: 4 }",
      "  mounts: [{ source: ../x, target: /x }]",
    ),
  );
  expect(() => loadManifest({ ...benchmark, config: { manifest: "bad.yaml" } })).toThrow(
    /inside the manifest directory/,
  );
  writeFileSync(join(dir, "bad2.yaml"), MANIFEST.replace("source: helper.py", "source: /etc"));
  const bad2 = { ...benchmark, config: { manifest: "bad2.yaml" } };
  expect(() =>
    manifestAdapter.solve({
      protocol: 1,
      op: "solve",
      benchmark: bad2,
      trial: trial("external", { entrypoint: "x", config: { command: "[]" } }),
    } as never),
  ).toThrow(/inside the manifest directory/);
  expect(() => loadManifest({ ...benchmark, config: { other: "1" } })).toThrow(
    /unknown manifest config/,
  );
});

it("keeps the Python adapter SDK's failure kinds equal to the contract", async () => {
  const { readFileSync } = await import("node:fs");
  const { FAILURE_KINDS } = await import("../src/contracts/index.ts");
  const py = readFileSync(
    join(import.meta.dirname, "../../../examples/sdk/orbit_bench/protocol.py"),
    "utf8",
  );
  const block = /FAILURE_KINDS = \(([\s\S]*?)\)/.exec(py)?.[1] ?? "";
  const kinds = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  expect(kinds.sort()).toEqual([...FAILURE_KINDS].sort());
});

it("never scores a missing value as 0 and merges method resources with solve", () => {
  const { m } = loadManifest(benchmark);
  const out = join(dir, "out-count");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "A_result.json"), JSON.stringify({ renamed: [] }));
  const counting = {
    ...m,
    result: {
      ...m.result,
      score: { path: "episodes[*].success", reduce: "count" as const, scale: 1 },
    },
  };
  expect(readResult(counting, out)).toMatchObject({
    score: null,
    invalid: true,
    failure: "scorer_error",
  });
  writeFileSync(
    join(dir, "merge.yaml"),
    MANIFEST.replace("  empty: {}", "  empty: { resources: { gpus: 1 }, env: { X: '1' } }").replace(
      "  resources: { cpus: 2, memGB: 4 }",
      "  resources: { cpus: 6, memGB: 9 }\n  env: { BASE: '1' }",
    ),
  );
  const spec = manifestAdapter.solve({
    protocol: 1,
    op: "solve",
    benchmark: { ...benchmark, config: { manifest: "merge.yaml" } },
    trial: trial("empty"),
  } as never).spec;
  expect(spec.resources).toMatchObject({ cpus: 6, memGB: 9, gpus: 1 });
  expect(spec.env).toEqual({ BASE: "1", X: "1" });
});
