// Opt-in real CLI Agent + Chromium. Credentials enter only the isolated daemon's auth API.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths, runDirs } from "../src/config/paths.ts";
import type { AuthProfileInput } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";

const enabled = process.env.ORBIT_BROWSERGYM_CLI_E2E === "1";
const adapter = fileURLToPath(
  new URL("../../../examples/bench-adapters/browsergym/", import.meta.url),
);

describe.runIf(enabled)("BrowserGym real CLI Agent bridge", () => {
  let daemon: StartedDaemon;
  let client: OrbitClient;
  let paths: ReturnType<typeof orbitPaths>;
  let method: { name: string; agent: string; auth: string };
  beforeAll(async () => {
    const source = process.env.ORBIT_BROWSERGYM_AUTH_SOURCE;
    const name = process.env.ORBIT_BROWSERGYM_AUTH_PROFILE;
    const claudeSettings = process.env.ORBIT_BROWSERGYM_CLAUDE_SETTINGS;
    if ((!claudeSettings && (!source || !name)) || !process.env.ORBIT_MINIWOB_PATH)
      throw new Error(
        "Set existing auth source/profile or Claude settings and the pinned MiniWoB checkout",
      );
    const home = mkdtempSync(join(tmpdir(), "orbit-p6-cli-"));
    paths = orbitPaths({ ORBIT_HOME: home, ORBIT_DATA: home });
    daemon = await startDaemon(paths, { port: 0, tickMs: 100 });
    client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
    let input: AuthProfileInput;
    if (claudeSettings) {
      const env = JSON.parse(readFileSync(claudeSettings, "utf8")).env as Record<string, string>;
      if (!env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL)
        throw new Error("Existing Claude relay settings are incomplete");
      input = {
        name: "gui-check",
        harness: "claude-code",
        kind: "relay",
        baseUrl: env.ANTHROPIC_BASE_URL,
        model: env.ANTHROPIC_MODEL,
        secret: env.ANTHROPIC_AUTH_TOKEN,
      };
    } else {
      const entries = JSON.parse(readFileSync(source as string, "utf8")).profiles as {
        profile: AuthProfileInput;
        secret: string;
      }[];
      const selected = entries.find((entry) => entry.profile.name === name);
      if (!selected || selected.profile.hostNetwork)
        throw new Error("Use an existing profile that supports bridged container networking");
      input = {
        ...selected.profile,
        name: "gui-check",
        secret:
          process.env.ORBIT_BROWSERGYM_LOGIN_SOURCE &&
          selected.profile.harness === "codex" &&
          selected.profile.kind === "login"
            ? readFileSync(process.env.ORBIT_BROWSERGYM_LOGIN_SOURCE, "utf8")
            : selected.secret,
      };
    }
    await client.authPut(input);
    method = { name: "real-cli", agent: input.harness, auth: "gui-check" };
    const doctor = await client.doctor();
    console.log("Isolated prerequisites", JSON.stringify(doctor));
    await client.resources();
    await client.benchmarkPut({
      name: "miniwob-cli",
      adapter: join(adapter, "adapter.py"),
      path: process.env.ORBIT_MINIWOB_PATH,
      config: {
        actionSet: "bid",
        maxSteps: "12",
        image: process.env.ORBIT_BROWSERGYM_IMAGE ?? "orbit-browsergym:0.14.3-3",
      },
    });
    writeFileSync("/tmp/orbit-p6-cli-latest-home", home, { mode: 0o600 });
    console.log(`Real CLI evidence retained at ${home}`);
  }, 60_000);

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
              for (const kind of ["container", "network", "volume"])
                expect(
                  execFileSync(
                    "docker",
                    [kind, "ls", "-q", "--filter", `label=orbit.parent=${run.id}`],
                    { encoding: "utf8" },
                  ).trim(),
                ).toBe("");
            }
          },
          { timeout: 60_000, interval: 500 },
        );
      }
    } finally {
      await daemon?.stop();
    }
  }, 90_000);

  it("runs five original tasks through a real Agent and keeps service-only evidence", async () => {
    const job = await client.benchSubmit({
      benchmark: "miniwob-cli",
      name: "CLI bridge validation",
      tasks: [
        "miniwob.click-test",
        "miniwob.click-button",
        "miniwob.click-checkboxes",
        "miniwob.enter-text",
        "miniwob.choose-list",
      ],
      methods: [method],
      timeoutMin: 4,
    });
    await vi.waitFor(
      async () => {
        const detail = await client.benchJob(job.id);
        expect(
          detail.trials.every(
            (trial) => trial.state === "done" && trial.outcome?.cleanup === "done",
          ),
        ).toBe(true);
      },
      { timeout: 900_000, interval: 1000 },
    );
    const detail = await client.benchJob(job.id);
    console.log(
      "Real CLI validation",
      JSON.stringify(
        detail.trials.map((trial) => ({
          task: trial.task,
          solve: trial.solveRunId,
          outcome: trial.outcome,
        })),
      ),
    );
    expect(detail.trials).toHaveLength(5);
    for (const trial of detail.trials) {
      expect(trial.outcome, `${trial.task}: ${JSON.stringify(trial.outcome)}`).toMatchObject({
        evaluation: "valid",
        cleanup: "done",
      });
      if (!trial.solveRunId) throw new Error("Missing solve run");
      const run = await client.get(trial.solveRunId);
      expect(
        run.spec.mounts.every(
          (mount) => !["/adapter", "/miniwob", "/evidence"].includes(mount.target),
        ),
      ).toBe(true);
      expect(run.spec.services[0]?.networks).toEqual(["gui"]);
      const root = join(runDirs(paths, trial.solveRunId).output, "services/gui/evidence");
      const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
      const rows = readFileSync(join(root, "trajectory.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(result.status).toBe("completed");
      expect(result.reward).toBe(Number(rows.at(-1).task_info.RAW_REWARD_GLOBAL > 0));
      expect(rows.some((row) => typeof row.action_id === "string")).toBe(true);
      const mcpTools = [
        ...new Set(
          ((await client.session(run.id)).agent?.messages ?? [])
            .filter(
              (message) =>
                message.kind === "tool_call" &&
                /^mcp[_.]/.test(message.name ?? "") &&
                /orbit[-_]computer/.test(message.name ?? ""),
            )
            .map((message) => message.name as string),
        ),
      ];
      expect(
        mcpTools.length,
        `${trial.task}: expected real orbit-computer MCP calls`,
      ).toBeGreaterThan(0);
      for (const name of mcpTools)
        expect(trial.outcome?.review?.details.mcpToolsUsed?.split(", ")).toContain(name);
      expect(trial.outcome?.review?.files[0]?.path).toBe(
        "services/gui/evidence/trajectory-review.json",
      );
      expect(existsSync(join(root, "evidence-signature.json"))).toBe(true);
      expect(existsSync(join(root, "evidence-private.pem"))).toBe(false);
      const service = run.spec.services.find((item) => item.name === "gui");
      expect(service?.env.ORBIT_GUI_EVIDENCE_PUBLIC_KEY).toBeTruthy();
      const staging = service?.binds.find((bind) => bind.target === "/adapter")?.source;
      expect(staging && existsSync(staging)).toBe(false);
    }
    const first = detail.trials[0];
    if (!first) throw new Error("Missing calibration trial");
    await client.benchRescore(job.id, { trials: [first.id] });
    await vi.waitFor(
      async () => {
        const rescored = (await client.benchJob(job.id)).trials.find(
          (item) => item.id === first.id,
        );
        expect(rescored?.history).toHaveLength(1);
        expect(rescored?.outcome).toMatchObject({
          evaluation: "valid",
          score: first.outcome?.score,
          cleanup: "done",
        });
      },
      { timeout: 120_000, interval: 500 },
    );
  }, 950_000);
});
