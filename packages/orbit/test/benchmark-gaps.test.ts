import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { findHarborTasks, harborSolveSpec, harborVerifySpec } from "../src/bench/harbor.ts";
import { toRunSpec } from "../src/bench/protocol.ts";
import {
  AdapterSpecResponse,
  AdapterTasksResponse,
  RunSpec,
  ScoreResult,
} from "../src/contracts/index.ts";
import { runCommand } from "../src/runs/phases.ts";

const wandrScore = (output: string, sub: string) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const { wandrScore } = await import(process.argv[2]); process.stdout.write(JSON.stringify(wandrScore(process.argv[3], process.argv[4])));",
        "fixture",
        fileURLToPath(
          new URL("../../../examples/bench-adapters/harbor-suites/adapter.ts", import.meta.url),
        ),
        output,
        sub,
      ],
      { encoding: "utf8" },
    ),
  );

const root = mkdtempSync(join(tmpdir(), "orbit-gap-fixtures-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

it.each(["automationbench", "chartography"])("validates %s against the real protocol", (name) => {
  const dir = fileURLToPath(new URL(`../../../examples/bench-adapters/${name}/`, import.meta.url));
  const raw = execFileSync(
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
    fixture.evidence()
    print(json.dumps({"tasks": adapter.tasks(fixture.req), "solve": adapter.plan(fixture.req, "solve"),
                      "verify": adapter.plan(fixture.req, "verify"), "score": adapter.score(fixture.req)}))
finally:
    fixture.doCleanups()
`,
      dir,
    ],
    { encoding: "utf8" },
  );
  const reply = JSON.parse(raw);
  expect(AdapterTasksResponse.parse(reply.tasks).tasks).toHaveLength(1);
  for (const phase of ["solve", "verify"])
    expect(RunSpec.parse(AdapterSpecResponse.parse(reply[phase]).spec).resources.gpus).toBe(0);
  expect(ScoreResult.parse(reply.score).invalid).toBe(false);
});

it("keeps all WANDR metrics and refuses missing, inconsistent and failed judgements", () => {
  const output = join(root, "wandr");
  const dir = join(output, "after/logs/verifier");
  const values = Object.fromEntries(
    [
      "soft_precision",
      "soft_recall",
      "soft_f1",
      "hard_precision",
      "hard_recall",
      "hard_f1",
    ].flatMap((metric) => ["full", "retrieval"].map((lineage) => [`${metric}_${lineage}`, 0.25])),
  );
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.25 }));
  const result = ScoreResult.parse(wandrScore(output, "after"));
  expect(result).toMatchObject({ score: 0.25, invalid: false, metrics: { soft_recall_full: 25 } });
  expect(Object.keys(result.metrics ?? {})).toHaveLength(12);
  write(join(dir, "reward.json"), JSON.stringify({ reward: 0 }));
  expect(wandrScore(output, "after").invalid).toBe(true);
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.5 }));
  expect(wandrScore(output, "after").invalid).toBe(true);
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.25 }));
  write(join(dir, "error.json"), '{"error":"API failed"}');
  expect(wandrScore(output, "after").score).toBeNull();
});

it("preserves task users and excludes artifact caches before independent verification", () => {
  const tasks = join(root, "harbor");
  write(
    join(tasks, "one/task.toml"),
    `schema_version = "1.3"
[[artifacts]]
source = "/app"
exclude = ["**/.git/**", "**/*.o", "./tests", "cache"]
[agent]
user = "agent"
[environment]
docker_image = "example:fixture"
[verifier]
environment_mode = "separate"
[verifier.environment]
docker_image = "example:verifier-fixture"
`,
  );
  write(join(tasks, "one/instruction.md"), "Explicit test fixture");
  const task = findHarborTasks(tasks)[0];
  if (!task) throw new Error("missing fixture");
  expect(task.supported).toBe(true);
  const solve = harborSolveSpec(task, { name: "empty", agent: "empty" }, join(root, "staging"));
  expect(solve).toMatchObject({ root: true, commandUser: "agent" });
  const output = join(root, "solve");
  write(join(output, "collected/app/src/file.c"), "source");
  write(join(output, "collected/app/src/file.o"), "binary");
  write(join(output, "collected/app/.git/config"), "private config");
  write(join(output, "collected/app/tests/test.c"), "excluded original tests");
  write(join(output, "collected/app/src/cache/deep.tmp"), "excluded cache");
  const staging = join(root, "verify");
  const verify = harborVerifySpec(task, output, staging);
  expect(readFileSync(join(staging, "artifacts/app/src/file.c"), "utf8")).toBe("source");
  expect(existsSync(join(staging, "artifacts/app/src/file.o"))).toBe(false);
  expect(existsSync(join(staging, "artifacts/app/.git/config"))).toBe(false);
  expect(existsSync(join(staging, "artifacts/app/tests"))).toBe(false);
  expect(existsSync(join(staging, "artifacts/app/src/cache"))).toBe(false);
  expect(verify.spec.commandUser).toBeUndefined();
});

it("limits command users to supported Docker runs and keeps the later phase outside the user switch", () => {
  const spec = { image: "fixture", command: ["true"], root: true, commandUser: "agent" };
  for (const change of [
    { root: false },
    { project: "/code" },
    { checkpoint: {} },
    { commandUser: "agent;id" },
    { backend: "process", image: undefined },
  ])
    expect(RunSpec.safeParse({ ...spec, ...change }).success).toBe(false);
  const command = runCommand(
    RunSpec.parse({ ...spec, after: { command: ["true"], timeoutMin: 1 } }),
  );
  expect(command.slice(0, 2)).toEqual(["/bin/sh", "/orbit/phases/run.sh"]);
  expect(command).toContain("agent");
});

it("lets explicit pass-through credentials override defaults only in their intended phase", () => {
  const benchmark = {
    name: "fixture",
    adapter: "harbor",
    path: root,
    config: {},
    env: {},
    passEnv: ["GRADER_KEY"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const method = {
    name: "fixture",
    agent: "external",
    entrypoint: "fixture",
    passEnv: ["MODEL_KEY"],
  };
  const spec = {
    image: "fixture",
    command: ["true"],
    env: { MODEL_KEY: "", KEEP: "main" },
    after: { command: ["true"], timeoutMin: 1, env: { GRADER_KEY: "", KEEP: "after" } },
  };
  const solve = toRunSpec(spec, method, benchmark, "solve", () => {
    throw new Error("This external-method fixture must not request a CLI Agent");
  });
  expect(solve.env).toEqual({ KEEP: "main" });
  expect(solve.passEnv).toEqual(["MODEL_KEY"]);
  expect(solve.after?.env).toEqual({ KEEP: "after" });
  expect(solve.after?.passEnv).toEqual(["GRADER_KEY"]);
  const verify = toRunSpec(
    { image: "fixture", command: ["true"], env: { GRADER_KEY: "", KEEP: "verify" } },
    method,
    benchmark,
    "verify",
    () => {
      throw new Error("This external-method fixture must not request a CLI Agent");
    },
  );
  expect(verify.env).toEqual({ KEEP: "verify" });
  expect(verify.passEnv).toEqual(["GRADER_KEY"]);
  expect(spec.after.env).toEqual({ GRADER_KEY: "", KEEP: "after" });
});
