// A benchmark job end to end through the daemon: process-backend solve and verify runs, scoring and
// aggregation. The "python" of the ASI benchmark is a fake runner, so no Docker or model is needed.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OrbitClient, tryConnect } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";
import { probeNode } from "../src/resources/probe.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-bench-daemon-"));
// Small state and run data in separate directories, as on a machine with a large data disk.
const paths = orbitPaths({ ORBIT_HOME: join(home, "orbit"), ORBIT_DATA: join(home, "data") });
const asi = join(home, "asi");
let daemon: StartedDaemon;
let client: OrbitClient;

// `python -m ai4sci_bench.cli run|score ...`: `run` records whether a real agent command was given,
// `score` gives 100 to the oracle's results and 0 otherwise.
const FAKE_RUNNER = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
const get = (f) => a[a.indexOf(f) + 1];
if (a[2] === "run") {
  const task = get("--tasks"), level = get("--prompt-levels"), out = get("--output-dir");
  const oracle = (get("--agent-cmd") ?? "").includes("/reference");
  fs.mkdirSync(path.join(out, task), { recursive: true });
  const inst = task + "__seed31415";
  fs.writeFileSync(path.join(out, task, inst + "__" + level + ".json"),
    JSON.stringify({ instance_id: inst, prompt_level: level, status: "completed", oracle }));
} else if (a[2] === "score") {
  const dir = get("--results-dir"), results = [];
  for (const t of fs.readdirSync(dir))
    for (const f of fs.readdirSync(path.join(dir, t)).filter((f) => f.endsWith(".json"))) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, t, f), "utf8"));
      results.push({ instance_id: r.instance_id, prompt_level: r.prompt_level, attempt: 1,
        final_score: r.oracle ? 100 : 0, max_score: 100 });
    }
  fs.writeFileSync(get("--output"), JSON.stringify({ results }));
} else process.exit(2);
`;

// An external adapter: process runs; the oracle writes the answer, the verifier copies it to a score.
const EXTERNAL_ADAPTER = `#!${process.execPath}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const say = (v) => console.log(JSON.stringify(v));
  if (req.benchmark.config.broken) { console.error("checkout has no tasks/"); process.exit(1); }
  if (req.op === "tasks")
    return say({
      tasks: [{ id: "t1", title: "one", supported: true, reason: null }],
      metrics: [{ name: "answer", label: "Answer", unit: "pts", primary: true }],
      capabilities: req.benchmark.config.gui ? { kind: "browser", methods: ["empty"], conditions: { actionSet: "coord" }, scoreKind: "binary", rescore: "evidence" } : undefined,
    });
  const node = ${JSON.stringify(process.execPath)};
  if (req.op === "solve") {
    const v = req.trial.method.agent === "oracle" ? "7" : "0";
    const release = req.benchmark.config.usageReleaseFile ?? "";
    const wait = release ? 'while [ ! -f "$ORBIT_TEST_USAGE_RELEASE" ]; do sleep 0.05; done; ' : "sleep 0.5; ";
    // An Agent whose only turn ended because Codex could not reach its model.
    const turn = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "workspace routing discovery failed", codex_error_info: "other" } } });
    const fail = req.benchmark.config.agentFail
      ? "; d=$ORBIT_OUTPUT/../agent/codex/sessions/2026/10/13; mkdir -p $d; echo '" + turn + "' > $d/rollout-x.jsonl; exit 1"
      : "";
    return say({ spec: { backend: "process", resources: { cpus: 1, memGB: 1 }, env: { ORBIT_TEST_USAGE_RELEASE: release }, command: ["sh", "-c", wait + "echo " + v + " > $ORBIT_OUTPUT/answer" + fail] } });
  }
  if (req.op === "verify")
    return say({ spec: { backend: "process", command: ["sh", "-c", "cp " + req.solve.output + "/answer $ORBIT_OUTPUT/score"] } });
  const fs = require("node:fs");
  const n = Number(fs.readFileSync(req.verify.output + "/score", "utf8"));
  say({ score: n, maxScore: 7, metrics: { answer: n } });
});
`;

beforeAll(async () => {
  for (const [task, status] of [
    ["math.a", "final"],
    ["math.b", "final"],
    ["math.draft", "draft"],
  ] as const) {
    const t = join(asi, "tasks", "math", task.slice(5));
    mkdirSync(t, { recursive: true });
    writeFileSync(
      join(t, "task_meta.yaml"),
      `id: ${task}\nstatus: ${status}\ndomain: math\noutput:\n  files:\n    - name: out.txt\n`,
    );
    mkdirSync(join(asi, "bench_runs", "instances_seed31415", `${task}__seed31415`, "reference"), {
      recursive: true,
    });
  }
  const runner = join(home, "fake-python");
  writeFileSync(runner, FAKE_RUNNER);
  chmodSync(runner, 0o755);
  daemon = await startDaemon(paths, {
    port: 0,
    tickMs: 100,
    usageMs: 200,
    self: [process.execPath, fileURLToPath(new URL("../src/bin.ts", import.meta.url))],
    // ASI solve runs lease 8 GB; small CI runners have less, and these runs are tiny fake runners.
    probe: async () => ({
      ...(await probeNode(paths.data, { node: paths.node, gpus: paths.gpus })),
      cpu: { count: 16, load1: 0, busy: 0 },
      memory: { totalGB: 64, availableGB: 64 },
    }),
  });
  const c = await tryConnect(paths);
  if (!c) throw new Error("daemon not reachable");
  client = c;
  await client.benchmarkPut({ name: "asi", adapter: "asi", path: asi, config: { python: runner } });
  const external = join(home, "adapter.cjs");
  writeFileSync(external, EXTERNAL_ADAPTER);
  chmodSync(external, 0o755);
  await client.benchmarkPut({ name: "ext", adapter: external, path: home });
});
afterAll(async () => {
  // Let run cleanup finish before the home directory goes away.
  for (let i = 0; i < 50; i++) {
    const runs = client ? await client.list({ limit: 1000 }) : [];
    if (runs.every((r) => r.cleanup !== "pending")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("bench jobs", () => {
  it("exposes optional adapter capabilities without changing the tasks-only client", async () => {
    const registration = await client.benchmarkPut({
      name: "gui",
      adapter: join(home, "adapter.cjs"),
      path: home,
      config: { gui: "1" },
    });
    const info = await client.benchInfo(registration.name);
    expect(info.capabilities).toEqual({
      kind: "browser",
      methods: ["empty"],
      conditions: { actionSet: "coord" },
      scoreKind: "binary",
      rescore: "evidence",
    });
    expect(info.metrics[0]?.name).toBe("answer");
    expect(await client.benchTasks(registration.name)).toEqual(info.tasks);
    await expect(
      client.benchSubmit({
        benchmark: registration.name,
        methods: [{ name: "oracle", agent: "oracle" }],
      }),
    ).rejects.toThrow("does not support oracle");
    await client.benchmarkRemove(registration.name);
    expect((await client.benchInfo("ext")).capabilities).toBeUndefined();
  });

  it("accepts external policy methods without CLI auth through the HTTP client", async () => {
    const method = {
      name: "policy",
      agent: "external" as const,
      entrypoint: "fixture:make_agent",
      model: "fixture",
      config: { test: "yes" },
      passEnv: ["ORBIT_TEST_MODEL_KEY"],
    };
    const job = await client.benchSubmit({ benchmark: "ext", methods: [method] });
    let detail = await client.benchJob(job.id);
    for (let i = 0; i < 300 && detail.job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      detail = await client.benchJob(job.id);
    }
    expect(detail.job.state).toBe("done");
    expect(detail.job.spec.methods).toEqual([method]);
    const trial = detail.trials[0];
    expect(trial?.outcome).toMatchObject({ evaluation: "valid", score: 0 });
    if (!trial?.solveRunId || !trial.verifyRunId) throw new Error("missing runs");
    const solve = await client.get(trial.solveRunId);
    expect(solve.spec.passEnv).toEqual(method.passEnv);
    expect(solve.spec.auth).toBeUndefined();
    expect((await client.get(trial.verifyRunId)).spec.passEnv).toEqual([]);
  }, 45_000);

  it("retains benchmark input defaults and rejects malformed registrations", async () => {
    const registered = await client.benchmarkPut({
      name: "defaults",
      adapter: join(home, "adapter.cjs"),
      path: home,
    });
    try {
      expect(registered).toMatchObject({ config: {}, env: {}, passEnv: [] });
      expect(registered.resources).toBeUndefined();
      await expect(
        client.benchmarkPut({ name: "bad/path", adapter: join(home, "adapter.cjs"), path: home }),
      ).rejects.toMatchObject({ status: 400 });
      expect((await client.benchmarks()).some((b) => b.name === "bad/path")).toBe(false);
    } finally {
      await client.benchmarkRemove("defaults");
    }
  });

  it("lists tasks and rejects unsupported ones and bad methods", async () => {
    const tasks = await client.benchTasks("asi");
    expect(tasks.map((t) => [t.id, t.supported])).toEqual([
      ["math.a", true],
      ["math.b", true],
      ["math.draft", false],
    ]);
    await expect(
      client.benchSubmit({
        benchmark: "asi",
        tasks: ["math.draft"],
        methods: [{ name: "oracle", agent: "oracle" }],
      }),
    ).rejects.toThrow(/not supported/);
    await expect(
      client.benchSubmit({
        benchmark: "asi",
        methods: [{ name: "c", agent: "codex", auth: "nope" }],
      }),
    ).rejects.toThrow(/auth profile not found/);
  });

  // Four solve/verify pairs need the full 30 s job wait on slower CI runners.
  it("runs oracle and empty as separate solve and verify runs and aggregates valid scores", async () => {
    const job = await client.benchSubmit({
      name: "smoke",
      benchmark: "asi",
      methods: [
        { name: "oracle", agent: "oracle" },
        { name: "empty", agent: "empty" },
      ],
    });
    let d = await client.benchJob(job.id);
    for (let i = 0; i < 300 && d.job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      d = await client.benchJob(job.id);
    }
    expect(d.job.state).toBe("done");
    expect(d.trials).toHaveLength(4);
    for (const t of d.trials) {
      expect(t.outcome?.evaluation, JSON.stringify(t.outcome)).toBe("valid");
      expect(t.solveRunId).not.toBe(t.verifyRunId);
    }
    expect(d.summary.map((s) => [s.method, s.metrics.score?.mean, s.valid])).toEqual([
      ["oracle", 100, 2],
      ["empty", 0, 2],
    ]);
    const verify = await client.get(d.trials[0]?.verifyRunId ?? "");
    expect(verify.spec.priority).toBe(1);
    expect(verify.spec.tags).toMatchObject({ bench: "asi", job: job.id, phase: "verify" });
    // Staging copies are removed when trials finish.
    expect(
      existsSync(join(paths.bench, job.id)) ? readdirSync(join(paths.bench, job.id)) : [],
    ).toEqual([]);

    const c = await client.benchCompare([job.id]);
    expect(c.metrics.map((m) => m.name)).toEqual(["score", "fullMarks"]);
    const cols = c.stats.score?.columns;
    expect([cols?.oracle?.paired?.mean, cols?.empty?.paired?.mean]).toEqual([100, 0]);
    expect(cols?.empty?.diff).toMatchObject({ mean: -100, tasks: 2 });
    expect((await client.benchJobs()).map((j) => j.id)).toContain(job.id);
  }, 45_000);

  it("runs an external adapter and refuses to register one that fails", async () => {
    const adapter = join(home, "adapter.cjs");
    await expect(
      client.benchmarkPut({ name: "bad", adapter, path: home, config: { broken: "1" } }),
    ).rejects.toThrow(/adapter tasks: exit 1: checkout has no tasks/);
    await expect(client.benchmarkPut({ name: "bad", adapter: home, path: home })).rejects.toThrow(
      /not an executable file/,
    );
    expect((await client.benchmarks()).map((b) => b.name)).toEqual(["asi", "ext"]);

    const job = await client.benchSubmit({
      benchmark: "ext",
      methods: [
        { name: "oracle", agent: "oracle" },
        { name: "empty", agent: "empty" },
      ],
    });
    let d = await client.benchJob(job.id);
    for (let i = 0; i < 300 && d.job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      d = await client.benchJob(job.id);
    }
    expect(d.job.state).toBe("done");
    expect(d.trials.map((t) => [t.method, t.outcome?.evaluation, t.outcome?.score])).toEqual([
      ["oracle", "valid", 7],
      ["empty", "valid", 0],
    ]);
    expect(d.job.metrics.map((m) => [m.name, m.primary])).toEqual([
      ["score", false],
      ["answer", true],
    ]);
    expect(d.summary.map((s) => [s.method, s.metrics.score?.mean, s.metrics.answer?.mean])).toEqual(
      [
        ["oracle", 100, 7],
        ["empty", 0, 0],
      ],
    );
    // The trial's metrics are also a line of its verify run's metrics.
    const oracle = d.trials.find((t) => t.method === "oracle");
    expect((await client.metrics(oracle?.verifyRunId ?? "")).summary).toEqual({
      "bench/score": 100,
      "bench/answer": 7,
    });
  });

  it("files jobs in folders with their runs, keeps data out of home and exports a folder", async () => {
    expect(paths.runs).toBe(join(home, "data", "runs"));
    await expect(
      client.benchSubmit({ benchmark: "ext", methods: [{ name: "o", agent: "oracle" }] }, "../x"),
    ).rejects.toThrow(/folder must be/);
    const job = await client.benchSubmit(
      { benchmark: "ext", methods: [{ name: "oracle", agent: "oracle" }] },
      "rcb/noskills",
    );
    let d = await client.benchJob(job.id);
    for (
      let i = 0;
      i < 300 &&
      (d.job.state === "running" ||
        d.trials.some((t) => !t.outcome || t.outcome.cleanup === "pending"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
      d = await client.benchJob(job.id);
    }
    const ids = d.trials.flatMap((t) => [t.solveRunId, t.verifyRunId]).filter(Boolean) as string[];
    expect(ids).toHaveLength(2);
    expect(existsSync(join(home, "data", "runs", ids[0] as string))).toBe(true);
    expect(existsSync(join(home, "orbit", "runs"))).toBe(false);
    expect((await client.list({ folder: "rcb" })).map((r) => r.id).sort()).toEqual([...ids].sort());
    // Moving one of its runs moves the whole job.
    const r = await client.move([ids[0] as string], "rcb/archive");
    expect(r.jobs).toEqual([job.id]);
    expect((await client.benchJob(job.id)).job.folder).toBe("rcb/archive");
    expect((await client.list({ folder: "rcb/noskills" })).length).toBe(0);
    let fs = await client.folders();
    for (let i = 0; i < 50 && !fs.find((f) => f.path === "rcb/archive" && f.sizeBytes > 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
      fs = await client.folders();
    }
    expect(fs.find((f) => f.path === "rcb/archive")).toMatchObject({ runs: 2, jobs: 1, active: 0 });
    expect(fs.find((f) => f.path === "rcb/archive")?.sizeBytes).toBeGreaterThan(0);

    const dest = join(home, "export");
    const x = await client.exportFolder("rcb", dest);
    expect(x).toMatchObject({ runs: 2, jobs: 1, skipped: [] });
    expect(existsSync(join(dest, "runs", ids[0] as string, "run.json"))).toBe(true);
    expect(existsSync(join(dest, "jobs", `${job.id}.json`))).toBe(true);
    await expect(client.exportFolder("rcb", dest)).rejects.toThrow(/not empty/);
    await expect(client.exportFolder("none", join(home, "e2"))).rejects.toThrow(
      /empty or does not exist/,
    );
    await client.move([job.id], "");
    expect(await client.folders()).toEqual([]);
  });

  it("applies a resources file to solve runs, records usage and suggests from it", async () => {
    const adapter = join(home, "adapter.cjs");
    const res = join(home, "resources.json");
    writeFileSync(res, JSON.stringify({ version: 1, tasks: { nope: { memGB: 2 } } }));
    await expect(
      client.benchmarkPut({ name: "res", adapter, path: home, resources: res }),
    ).rejects.toThrow(/unknown tasks: nope/);
    writeFileSync(
      res,
      JSON.stringify({
        version: 1,
        default: { cpus: 2, memGB: 3, timeoutMin: 5 },
        tasks: { t1: { memGB: 4, evidence: "measured", confidence: "high" } },
      }),
    );
    const release = join(home, "usage-sampled");
    await client.benchmarkPut({
      name: "res",
      adapter,
      path: home,
      resources: res,
      config: { usageReleaseFile: release },
    });
    const job = await client.benchSubmit({
      benchmark: "res",
      methods: [{ name: "oracle", agent: "oracle" }],
    });
    expect(job.resources).toEqual({ t1: { cpus: 2, memGB: 4, timeoutMin: 5 } });
    // A fixed sleep can end before Docker discovery and the first real process sample on CI.
    try {
      await expect
        .poll(
          async () => {
            const detail = await client.benchJob(job.id);
            const id = detail.trials[0]?.solveRunId;
            return id ? ((await client.get(id)).usage?.peakMemGB ?? 0) : 0;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBeGreaterThan(0);
    } finally {
      writeFileSync(release, "sampled");
    }
    let d = await client.benchJob(job.id);
    for (let i = 0; i < 300 && d.job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      d = await client.benchJob(job.id);
    }
    const solve = await client.get(d.trials[0]?.solveRunId ?? "");
    expect(solve.spec.resources).toMatchObject({ cpus: 2, memGB: 4 });
    expect(solve.spec.timeoutMin).toBe(5);
    expect(solve.usage?.peakMemGB).toBeGreaterThan(0);
    // The verify run keeps the adapter's own resources.
    const verify = await client.get(d.trials[0]?.verifyRunId ?? "");
    expect(verify.spec.resources.memGB).not.toBe(4);
    // Oracle runs say nothing about what a task needs: they are left out of the suggestions.
    expect((await client.benchUsage([job.id])).rows).toEqual([]);
  }, 30_000);

  it("deletes finished runs and whole jobs, and refuses what is not finished or belongs to a job", async () => {
    const run = await client.submit({
      backend: "process",
      snapshot: false,
      resources: { cpus: 1, memGB: 1 },
      command: ["sh", "-c", "echo hi > $ORBIT_OUTPUT/x; sleep 1"],
    });
    await expect(client.deleteRuns([run.id])).rejects.toThrow(/cancel it and wait/);
    let r = await client.wait(run.id, 30);
    for (let i = 0; i < 50 && r.cleanup === "pending"; i++) r = await client.wait(run.id, 5);
    expect(existsSync(join(paths.runs, run.id))).toBe(true);
    expect(await client.deleteRuns([run.id])).toEqual({ deleted: [run.id], leftovers: [] });
    expect(existsSync(join(paths.runs, run.id))).toBe(false);
    await expect(client.get(run.id)).rejects.toThrow(/not found/);
    await expect(client.deleteRuns([run.id])).rejects.toThrow(/not found/);

    const job = (await client.benchJobs()).find((j) => j.spec.benchmark === "ext");
    if (!job) throw new Error("ext job missing");
    const d = await client.benchJob(job.id);
    const ids = d.trials.flatMap((t) => [t.solveRunId, t.verifyRunId]).filter(Boolean) as string[];
    await expect(client.deleteRuns([ids[0] as string])).rejects.toThrow(/delete the job instead/);
    const out = await client.benchDeleteJob(job.id);
    expect(out.deleted.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(existsSync(join(paths.runs, id))).toBe(false);
    await expect(client.benchJob(job.id)).rejects.toThrow(/not found/);
  });

  it("does not verify a solve whose Agent could not reach its model, unless rescored", async () => {
    await client.benchmarkPut({
      name: "ext-down",
      adapter: join(home, "adapter.cjs"),
      path: home,
      config: { agentFail: "1" },
    });
    const job = await client.benchSubmit({
      benchmark: "ext-down",
      methods: [{ name: "empty", agent: "empty" }],
    });
    const settled = async (ok: (d: Awaited<ReturnType<typeof client.benchJob>>) => boolean) => {
      let d = await client.benchJob(job.id);
      for (let i = 0; i < 300 && !ok(d); i++) {
        await new Promise((r) => setTimeout(r, 100));
        d = await client.benchJob(job.id);
      }
      return d;
    };
    const d = await settled((x) => x.job.state === "done");
    const t = d.trials[0];
    expect(t).toMatchObject({ verifyRunId: null });
    expect(t?.outcome).toMatchObject({ execution: "failed", evaluation: "invalid", score: null });
    expect(t?.outcome?.issues).toEqual([
      "Agent stopped: model_unreachable (workspace routing discovery failed)",
      "verify skipped",
    ]);
    expect(d.summary[0]?.valid).toBe(0);
    // An explicit rescore still verifies; the score is kept but not trusted.
    await client.benchRescore(job.id, {});
    const r = await settled((x) => x.trials.every((y) => y.state === "done"));
    expect(r.trials[0]?.verifyRunId).toBeTruthy();
    expect(r.trials[0]?.outcome).toMatchObject({ evaluation: "invalid", score: 0 });
  });

  it("rescores finished trials from the saved solve output and keeps the earlier scoring", async () => {
    const job = await client.benchSubmit({
      benchmark: "ext",
      methods: [{ name: "oracle", agent: "oracle" }],
    });
    await expect(client.benchRescore(job.id, {})).rejects.toThrow(/is running/);
    const settled = async (ok: (d: Awaited<ReturnType<typeof client.benchJob>>) => boolean) => {
      let d = await client.benchJob(job.id);
      for (let i = 0; i < 300 && !ok(d); i++) {
        await new Promise((r) => setTimeout(r, 100));
        d = await client.benchJob(job.id);
      }
      return d;
    };
    const first = await settled((d) => d.job.state === "done");
    const before = first.trials[0];
    if (!before?.solveRunId || !before.verifyRunId) throw new Error("trial without runs");
    expect(before.outcome?.score).toBe(7);

    await expect(client.benchRescore(job.id, { tasks: ["nope"] })).rejects.toThrow(
      /not in job .*: task nope/,
    );
    // A changed grader, as seen through the solve output it reads.
    writeFileSync(join(paths.runs, before.solveRunId, "orbit", "output", "answer"), "5\n");
    const r = await client.benchRescore(job.id, { methods: ["oracle"] });
    expect(r).toEqual({ trials: [before.id], skipped: [] });
    const d = await settled((x) => x.trials.every((t) => t.state === "done"));
    const after = d.trials[0];
    expect(d.job.state).toBe("done");
    expect(after?.solveRunId).toBe(before.solveRunId);
    expect(after?.verifyRunId).not.toBe(before.verifyRunId);
    expect(after?.outcome).toMatchObject({ evaluation: "valid", score: 5 });
    expect(after?.history).toEqual([
      { verifyRunId: before.verifyRunId, outcome: before.outcome, endedAt: before.endedAt },
    ]);
    expect(d.summary[0]?.metrics.answer?.mean).toBe(5);

    // The earlier verify run still belongs to the job and goes with it.
    await expect(client.deleteRuns([before.verifyRunId])).rejects.toThrow(/delete the job instead/);
    for (let i = 0; i < 50; i++) {
      const runs = await client.list({ group: `bench-${job.id}` });
      if (runs.every((x) => x.cleanup !== "pending")) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const out = await client.benchDeleteJob(job.id);
    expect(out.deleted.sort()).toEqual(
      [before.solveRunId, before.verifyRunId, after?.verifyRunId as string].sort(),
    );
  });
});
