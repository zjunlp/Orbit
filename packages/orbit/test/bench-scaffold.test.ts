import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { handle } from "../src/bench/adapter.ts";
import { loadManifest, manifestAdapter } from "../src/bench/manifest.ts";
import { scaffoldBenchmark } from "../src/bench/scaffold.ts";
import {
  AdapterSpecResponse,
  AdapterTasksResponse,
  BenchmarkInput,
  ScoreResult,
} from "../src/contracts/index.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-scaffold-"));
const paths = { home: join(root, "home"), data: join(root, "data") };
mkdirSync(paths.home);
mkdirSync(paths.data);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("generates a standalone adapter using real protocol schemas and independent private grading", async () => {
  const directory = join(root, "adapter space ' quote");
  const result = await scaffoldBenchmark(paths, {
    name: "tutorial",
    directory,
    template: "adapter",
  });
  expect(result.tutorial).toBe(true);
  expect(result.nextSteps[0]).toContain("'\\''");
  BenchmarkInput.parse(JSON.parse(readFileSync(join(directory, "benchmark.json"), "utf8")));
  const invoke = (op: string, extra = {}) => {
    const p = spawnSync(join(directory, "adapter.py"), [op], {
      input: JSON.stringify({
        protocol: 1,
        op,
        benchmark: { name: "tutorial", path: directory, config: {} },
        ...extra,
      }),
      encoding: "utf8",
    });
    expect(p.status, p.stderr).toBe(0);
    return JSON.parse(p.stdout);
  };
  expect(AdapterTasksResponse.parse(invoke("tasks")).tasks).toHaveLength(1);
  const trial = { method: { name: "oracle", agent: "oracle" } };
  const spec = AdapterSpecResponse.parse(invoke("solve", { trial })).spec;
  expect(spec.mounts).toEqual([expect.objectContaining({ target: "/tutorial/runtime.py" })]);
  const agent = AdapterSpecResponse.parse(
    invoke("solve", { trial: { method: { agent: "codex" } } }),
  ).spec;
  expect(agent.agentTask).toBeDefined();
  expect(agent.network).toBe(true);
  expect(spec.network).toBe(false);
  expect(agent.mounts).toEqual([]);
  const solve = join(root, "solve");
  const verify = join(root, "verify");
  mkdirSync(solve);
  mkdirSync(verify);
  const grade = () => {
    const p = spawnSync("python3", [join(directory, "grader.py"), solve], {
      env: { ...process.env, ORBIT_OUTPUT: verify },
      encoding: "utf8",
    });
    expect(p.status, p.stderr).toBe(0);
    return ScoreResult.parse(invoke("score", { verify: { output: verify } }));
  };
  expect(grade()).toMatchObject({ score: 0, invalid: false });
  const reference = spawnSync("python3", [join(directory, "runtime.py"), "oracle"], {
    env: { ...process.env, ORBIT_OUTPUT: solve },
  });
  expect(reference.status).toBe(0);
  expect(grade()).toMatchObject({ score: 1, invalid: false });
  writeFileSync(join(solve, "answer.txt"), Buffer.from([255, 254]));
  expect(grade()).toMatchObject({ score: 0, invalid: false });
  writeFileSync(join(solve, "answer.txt"), `42${" ".repeat(1024)}`);
  expect(grade()).toMatchObject({ score: 0, invalid: false });
  rmSync(join(solve, "answer.txt"));
  mkdirSync(join(solve, "answer.txt"));
  expect(grade()).toMatchObject({ score: 0, invalid: false });
  writeFileSync(
    join(verify, "result.json"),
    JSON.stringify({ score: null, invalid: true, error: "grader crashed" }),
  );
  expect(ScoreResult.parse(invoke("score", { verify: { output: verify } }))).toMatchObject({
    invalid: true,
    failure: "scorer_error",
  });
  writeFileSync(join(verify, "result.json"), "bad json");
  expect(ScoreResult.parse(invoke("score", { verify: { output: verify } })).invalid).toBe(true);
  AdapterSpecResponse.parse(invoke("verify", { solve: { output: solve } }));
});

it("generates a manifest accepted by the existing loader with only trusted runner controls", async () => {
  const directory = join(root, "manifest");
  await scaffoldBenchmark(paths, { name: "manifest-tutorial", directory, template: "manifest" });
  const benchmark = { name: "manifest-tutorial", path: directory, config: {} };
  expect(Object.keys(loadManifest(benchmark).m.methods)).toEqual(["empty", "oracle"]);
  expect(
    AdapterTasksResponse.parse(handle(manifestAdapter, { protocol: 1, op: "tasks", benchmark }))
      .tasks,
  ).toHaveLength(1);
  const req = {
    protocol: 1 as const,
    op: "solve" as const,
    benchmark,
    trial: {
      id: "trial",
      task: "addition",
      method: { name: "oracle", agent: "oracle" },
      seed: 1,
      options: {},
      staging: join(root, "staging"),
      hostNetwork: false,
    },
  };
  AdapterSpecResponse.parse(handle(manifestAdapter, req));
  expect(readFileSync(join(directory, "README.md"), "utf8")).toContain("does not rerun the grader");
});

it("refuses overwrite, symlinks, relative paths, invalid names and state directories", async () => {
  const create = (directory: string, name = "safe") =>
    scaffoldBenchmark(paths, { directory, name, template: "adapter" });
  const existing = join(root, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep"), "kept");
  await expect(create(existing)).rejects.toThrow("already exists");
  expect(readFileSync(join(existing, "keep"), "utf8")).toBe("kept");
  const link = join(root, "link");
  symlinkSync(existing, link);
  await expect(create(join(link, "child"))).rejects.toThrow("symlink");
  await expect(create(link)).rejects.toThrow("already exists");
  await expect(create("relative")).rejects.toThrow("absolute");
  await expect(create(join(root, "bad"), "bad/name")).rejects.toThrow();
  await expect(create(join(paths.home, "child"))).rejects.toThrow("outside Orbit");
  await expect(create(join(paths.data, "child"))).rejects.toThrow("outside Orbit");
});
