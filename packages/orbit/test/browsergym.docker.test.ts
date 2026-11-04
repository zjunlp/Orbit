// Real BrowserGym/Chromium and original MiniWoB rewards, with an explicitly scripted policy.
// ORBIT_BROWSERGYM_E2E=1 ORBIT_MINIWOB_PATH=<pinned checkout> pnpm --filter @zjunlp/orbit test ...
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths, runDirs } from "../src/config/paths.ts";
import { GuiTrajectory } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";

const adapter = fileURLToPath(
  new URL("../../../examples/bench-adapters/browsergym/", import.meta.url),
);
const enabled = process.env.ORBIT_BROWSERGYM_E2E === "1";

describe.runIf(enabled)("BrowserGym Docker integration", () => {
  let home: string;
  let paths: ReturnType<typeof orbitPaths>;
  let daemon: StartedDaemon;
  let client: OrbitClient;
  let failed = false;
  afterEach(({ task }) => {
    if (task.result?.state !== "pass") failed = true;
  });
  beforeAll(async () => {
    if (!process.env.ORBIT_MINIWOB_PATH)
      throw new Error("Set ORBIT_MINIWOB_PATH to the pinned checkout");
    home = mkdtempSync(join(tmpdir(), "orbit-browsergym-"));
    paths = orbitPaths({ ORBIT_HOME: home });
    const policy = join(home, "policy");
    mkdirSync(policy);
    writeFileSync(
      join(policy, "calibration_policy.py"),
      readFileSync(join(adapter, "calibration_policy.py")),
    );
    writeFileSync(
      join(policy, "fixture_policy.py"),
      `import os, time
from calibration_policy import make_agent as calibration
def make_agent(context):
    assert os.environ.get("ORBIT_GUI_TEST_MODEL_KEY") == "solve-test-value"
    assert "ORBIT_GUI_TEST_GRADER_KEY" not in os.environ
    return calibration(context)
def broken(context):
    raise ConnectionError("explicit provider failure fixture")
def waiting(context):
    class Policy:
        def get_action(self, obs):
            time.sleep(3600)
    return Policy()
`,
    );
    vi.stubEnv("ORBIT_GUI_TEST_MODEL_KEY", "solve-test-value");
    vi.stubEnv("ORBIT_GUI_TEST_GRADER_KEY", "grader-test-value");
    daemon = await startDaemon(paths, { port: 0, tickMs: 100 });
    client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
    for (const actionSet of ["coord", "bid"]) {
      await client.benchmarkPut({
        name: actionSet,
        adapter: join(adapter, "adapter.py"),
        path: process.env.ORBIT_MINIWOB_PATH,
        config: {
          actionSet,
          agentDir: policy,
          maxSteps: "3",
          image: process.env.ORBIT_BROWSERGYM_IMAGE ?? "orbit-browsergym:0.14.3-2",
        },
        passEnv: ["ORBIT_GUI_TEST_GRADER_KEY"],
        resources: join(adapter, "resources.json"),
      });
    }
  });

  afterAll(async () => {
    try {
      if (client) {
        for (const job of await client.benchJobs())
          if (job.state === "running") await client.benchCancel(job.id);
        await vi.waitFor(
          async () => {
            const runs = await client.list({ limit: 1000 });
            expect(runs.every((run) => run.cleanup === "done")).toBe(true);
            for (const run of runs) {
              expect(run.lease?.state).toBe("released");
              expect(
                execFileSync("docker", ["ps", "-aq", "--filter", `label=orbit.run=${run.id}`], {
                  encoding: "utf8",
                }).trim(),
              ).toBe("");
            }
          },
          { timeout: 60_000, interval: 500 },
        );
      }
    } finally {
      await daemon?.stop();
      vi.unstubAllEnvs();
    }
    if (home && !failed) rmSync(home, { recursive: true, force: true });
    else if (home) console.error(`BrowserGym test evidence retained at ${home}`);
  }, 90_000);

  const finish = async (id: string) => {
    await vi.waitFor(
      async () => {
        const detail = await client.benchJob(id);
        expect(detail.job.state).toBe("done");
        expect(detail.trials.every((trial) => trial.state === "done")).toBe(true);
      },
      { timeout: 180_000, interval: 500 },
    );
    return client.benchJob(id);
  };

  it("gets valid zero from the original environment on five sampled empty tasks", async () => {
    const job = await client.benchSubmit({
      benchmark: "coord",
      tasks: [
        "miniwob.click-test",
        "miniwob.click-button",
        "miniwob.click-checkboxes",
        "miniwob.enter-text",
        "miniwob.choose-list",
      ],
      methods: [{ name: "empty", agent: "empty" }],
    });
    const detail = await finish(job.id);
    expect(detail.trials).toHaveLength(5);
    expect(detail.job.capabilities).toMatchObject({
      kind: "browser",
      scoreKind: "binary",
      rescore: "evidence",
    });
    for (const trial of detail.trials)
      expect(trial.outcome, `${trial.task}: ${JSON.stringify(trial.outcome)}`).toMatchObject({
        evaluation: "valid",
        score: 0,
      });
  }, 200_000);

  it("records original positive reward, separates credentials, rejects provider errors and revalidates saved evidence", async () => {
    const job = await client.benchSubmit({
      benchmark: "bid",
      tasks: ["miniwob.click-test"],
      methods: [
        {
          name: "scripted",
          agent: "external",
          entrypoint: "fixture_policy:make_agent",
          passEnv: ["ORBIT_GUI_TEST_MODEL_KEY"],
        },
        { name: "broken", agent: "external", entrypoint: "fixture_policy:broken" },
      ],
    });
    const detail = await finish(job.id);
    const scripted = detail.trials.find((t) => t.method === "scripted");
    const broken = detail.trials.find((t) => t.method === "broken");
    expect(scripted?.outcome, JSON.stringify(scripted?.outcome)).toMatchObject({
      evaluation: "valid",
      score: 1,
    });
    expect(broken?.outcome).toMatchObject({ evaluation: "invalid", score: null });
    if (!scripted?.solveRunId || !scripted.verifyRunId) throw new Error("missing runs");
    const output = runDirs(paths, scripted.solveRunId).output;
    const trajectory = GuiTrajectory.parse(
      JSON.parse(readFileSync(join(output, "trajectory-review.json"), "utf8")),
    );
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps[0]?.action).toBeNull();
    expect(trajectory.steps[1]?.screenshot).toBe("screenshots/0001.png");
    expect(scripted.outcome?.review?.files[0]?.kind).toBe("trajectory");
    const before = readFileSync(join(output, "result.json"), "utf8");
    expect(JSON.parse(before)).toMatchObject({ status: "completed", reward: 1, steps: 1 });
    const rows = readFileSync(join(output, "trajectory.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows[1].reward).toBe(Number(rows[1].task_info.RAW_REWARD_GLOBAL > 0));
    expect(readFileSync(join(output, "screenshots/0001.png")).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect((await client.get(scripted.solveRunId)).spec.auth).toBeUndefined();
    expect((await client.get(scripted.verifyRunId)).spec.passEnv).toEqual([
      "ORBIT_GUI_TEST_GRADER_KEY",
    ]);
    rmSync(join(paths.bench, job.id), { recursive: true, force: true });
    await client.benchRescore(job.id, { trials: [scripted.id] });
    const rescored = (await finish(job.id)).trials.find((t) => t.id === scripted.id);
    expect(rescored?.outcome).toMatchObject({ evaluation: "valid", score: 1 });
    expect(rescored?.solveRunId).toBe(scripted.solveRunId);
    expect(rescored?.history).toHaveLength(1);
    expect(readFileSync(join(output, "result.json"), "utf8")).toBe(before);
  }, 200_000);

  it("cancels a live browser and releases its lease after cleanup", async () => {
    const job = await client.benchSubmit({
      benchmark: "bid",
      tasks: ["miniwob.click-test"],
      methods: [{ name: "waiting", agent: "external", entrypoint: "fixture_policy:waiting" }],
    });
    await vi.waitFor(
      async () => {
        const trial = (await client.benchJob(job.id)).trials[0];
        expect(trial?.solveRunId).toBeTruthy();
        expect(
          existsSync(join(runDirs(paths, trial?.solveRunId ?? "").output, "screenshots/0000.png")),
        ).toBe(true);
      },
      { timeout: 90_000, interval: 500 },
    );
    await client.benchCancel(job.id);
    await vi.waitFor(
      async () => {
        const trial = (await client.benchJob(job.id)).trials[0];
        expect(trial?.outcome).toMatchObject({
          execution: "cancelled",
          evaluation: "unknown",
          cleanup: "done",
        });
      },
      { timeout: 30_000, interval: 500 },
    );
  }, 150_000);
});
