// Opt-in real Docker check; only this private daemon's labelled resources are touched.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toRunSpec } from "../src/bench/protocol.ts";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-command-user-"));
const paths = orbitPaths({ ORBIT_HOME: home });
let daemon: StartedDaemon;
let client: OrbitClient;
const finish = async (id: string) => {
  let run = await client.get(id);
  while (
    !["succeeded", "failed", "cancelled", "lost"].includes(run.state) ||
    run.cleanup === "pending"
  )
    run = await client.wait(id, 10);
  return run;
};

describe.runIf(process.env.ORBIT_E2E === "1")("real command account isolation", () => {
  beforeAll(async () => {
    daemon = await startDaemon(paths, { port: 0, tickMs: 100 });
    client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
  });
  afterAll(async () => {
    if (client)
      for (const run of await client.list({ limit: 100 })) {
        if (!["succeeded", "failed", "cancelled", "lost"].includes(run.state)) {
          await client.cancel(run.id);
          await finish(run.id);
        }
      }
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
  });
  it("writes readable evidence as nobody and keeps independent verification as root", async () => {
    const run = await finish(
      (
        await client.submit({
          image: process.env.ORBIT_COMMAND_USER_IMAGE ?? "python:3.13-slim-bookworm",
          root: true,
          commandUser: "nobody",
          network: false,
          command: [
            "python",
            "-c",
            `import os,pathlib
assert os.getuid() != 0
assert not os.access('/root', os.R_OK)
pathlib.Path('/orbit/agent/probe').write_text('private agent state')
p=pathlib.Path(os.environ['ORBIT_OUTPUT'])/'nested'
p.mkdir(); (p/'identity').write_text(str(os.getuid()))
`,
          ],
          resources: { cpus: 1, memGB: 1, gpus: 0 },
          timeoutMin: 1,
          after: {
            command: [
              "python",
              "-c",
              "import os,pathlib; assert os.getuid()==0; pathlib.Path('/tmp/verified').write_text('root verifier')",
            ],
            timeoutMin: 1,
            collect: ["/tmp/verified"],
          },
        })
      ).id,
    );
    expect(run).toMatchObject({ state: "succeeded", exitCode: 0, cleanup: "done" });
    expect(run.after?.state).toBe("succeeded");
    expect(
      Number(readFileSync(join(paths.runs, run.id, "orbit/output/nested/identity"), "utf8")),
    ).toBeGreaterThan(0);
    expect(readFileSync(join(paths.runs, run.id, "orbit/output/after/tmp/verified"), "utf8")).toBe(
      "root verifier",
    );
    expect(readFileSync(join(paths.runs, run.id, "orbit/agent/probe"), "utf8")).toBe(
      "private agent state",
    );
  }, 180_000);
  it("passes declared model and grader values over native empty defaults in separate phases", async () => {
    const names = ["TEST_MODEL_KEY", "TEST_GRADER_KEY"];
    const original = names.map((name) => process.env[name]);
    process.env.TEST_MODEL_KEY = "explicit-model-fixture";
    process.env.TEST_GRADER_KEY = "explicit-grader-fixture";
    try {
      const spec = toRunSpec(
        {
          image: process.env.ORBIT_COMMAND_USER_IMAGE ?? "python:3.13-slim-bookworm",
          network: false,
          resources: { cpus: 1, memGB: 1, gpus: 0 },
          timeoutMin: 1,
          env: { TEST_MODEL_KEY: "" },
          command: [
            "python",
            "-c",
            "import os; assert os.environ['TEST_MODEL_KEY']=='explicit-model-fixture'; assert 'TEST_GRADER_KEY' not in os.environ",
          ],
          after: {
            command: [
              "python",
              "-c",
              "import os,pathlib; assert os.environ['TEST_GRADER_KEY']=='explicit-grader-fixture'; pathlib.Path('/tmp/credential-checked').write_text('passed')",
            ],
            env: { TEST_GRADER_KEY: "" },
            timeoutMin: 1,
            collect: ["/tmp/credential-checked"],
          },
        },
        { name: "fixture", agent: "external", entrypoint: "fixture", passEnv: ["TEST_MODEL_KEY"] },
        {
          name: "fixture",
          adapter: "harbor",
          path: home,
          config: {},
          env: {},
          passEnv: ["TEST_GRADER_KEY"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "solve",
        () => {
          throw new Error("This external-method fixture must not request a CLI Agent");
        },
      );
      const run = await finish((await client.submit(spec)).id);
      expect(run).toMatchObject({ state: "succeeded", cleanup: "done" });
      expect(run.after?.state).toBe("succeeded");
      expect(
        readFileSync(join(paths.runs, run.id, "orbit/output/after/tmp/credential-checked"), "utf8"),
      ).toBe("passed");
    } finally {
      for (const [i, name] of names.entries()) {
        if (original[i] === undefined) delete process.env[name];
        else process.env[name] = original[i];
      }
    }
  }, 180_000);
});
