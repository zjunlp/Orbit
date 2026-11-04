// Opt-in real Docker development checks; only this private daemon's labelled resources are used.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";
import * as docker from "../src/executor/docker.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-phases-real-"));
const paths = orbitPaths({ ORBIT_HOME: home });
const image = "alpine:latest";
let daemon: StartedDaemon;
let client: OrbitClient;
const start = async () => {
  daemon = await startDaemon(paths, { port: 0, tickMs: 100 });
  client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
};
const finish = async (id: string) => {
  let run = await client.get(id);
  while (
    !["succeeded", "failed", "cancelled", "lost"].includes(run.state) ||
    run.cleanup === "pending"
  )
    run = await client.wait(id, 10);
  return run;
};
const output = (id: string, file: string) => join(paths.runs, id, "orbit", "output", file);
const base = { image, root: true, network: false, resources: { gpus: 0, cpus: 1, memGB: 0.25 } };

describe.runIf(process.env.ORBIT_E2E === "1")("real durable ending phases", () => {
  beforeAll(start);
  afterAll(async () => {
    if (client)
      for (const run of await client.list({ limit: 1000 })) {
        if (!["succeeded", "failed", "cancelled", "lost"].includes(run.state)) {
          await client.cancel(run.id);
          await finish(run.id);
        }
      }
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("reattaches during a non-idempotent finalize and keeps its evidence exactly once", async () => {
    const run = await client.submit({
      ...base,
      command: ["true"],
      services: [
        {
          name: "sim",
          image,
          command: ["sleep", "3600"],
          cpus: 0.25,
          memGB: 0.1,
          collect: ["/tmp/verdict"],
        },
      ],
      hooks: [
        { command: 'echo finalize >> "$ORBIT_OUTPUT/count"', timeoutSec: 5 },
        { service: "sim", command: "sleep 4; echo verdict > /tmp/verdict", timeoutSec: 15 },
      ],
    });
    await expect
      .poll(() => existsSync(join(paths.runs, run.id, "orbit/phases/services/sim/hook-1/pid")), {
        timeout: 20000,
      })
      .toBe(true);
    await daemon.stop();
    await start();
    const done = await finish(run.id);
    expect(done).toMatchObject({
      state: "succeeded",
      cleanup: "done",
      lease: { state: "released" },
    });
    expect(readFileSync(output(run.id, "count"), "utf8")).toBe("finalize\n");
    expect(readFileSync(output(run.id, "services/sim/tmp/verdict"), "utf8")).toBe("verdict\n");
    expect(done.phases.find((p) => p.name === "finalize")).toMatchObject({
      state: "done",
      attempts: 1,
    });
    expect(
      await docker.inspectContainer(run.containerId ?? (done.containerId as string)),
    ).toBeNull();
  }, 60000);

  it("cancels the Agent but still finalizes and collects while skipping render", async () => {
    const run = await client.submit({
      ...base,
      command: ["sh", "-c", 'touch "$ORBIT_OUTPUT/started"; sleep 60'],
      after: {
        command: ["sh", "-c", "echo verdict > /tmp/verdict"],
        timeoutMin: 1,
        collect: ["/tmp/verdict"],
        render: { command: ["sh", "-c", 'touch "$ORBIT_OUTPUT/rendered"'], timeoutMin: 1 },
      },
    });
    await expect.poll(() => existsSync(output(run.id, "started")), { timeout: 20000 }).toBe(true);
    await client.cancel(run.id);
    const done = await finish(run.id);
    expect(done.after?.reason).toBeNull();
    expect(done).toMatchObject({
      state: "cancelled",
      cleanup: "done",
      after: { state: "succeeded" },
      lease: { state: "released" },
    });
    expect(done.phases.find((p) => p.name === "render")?.state).toBe("skipped");
    expect(readFileSync(output(run.id, "after/tmp/verdict"), "utf8")).toBe("verdict\n");
    expect(existsSync(output(run.id, "rendered"))).toBe(false);
  }, 60000);

  it("times out a finalizer with TERM-resistant children before collecting", async () => {
    const run = await client.submit({
      ...base,
      command: ["true"],
      after: {
        command: ["sh", "-c", '(trap "" TERM; sleep 5; echo late > "$ORBIT_OUTPUT/late") & wait'],
        timeoutMin: 0.01,
      },
    });
    const done = await finish(run.id);
    expect(done.after?.state).toBe("timeout");
    expect(done.phases.find((p) => p.name === "finalize")?.state).toBe("timeout");
    expect(done.cleanup).toBe("done");
    expect(existsSync(output(run.id, "late"))).toBe(false);
    expect(await docker.inspectContainer(done.containerId as string)).toBeNull();
  }, 60000);

  it("finalizes a service after main exits, then stops dependencies in reverse order and removes volumes", async () => {
    const run = await client.submit({
      ...base,
      command: ["true"],
      volumes: ["evidence"],
      services: [
        {
          name: "sim",
          image,
          command: ["sleep", "3600"],
          cpus: 0.25,
          memGB: 0.1,
          volumes: [{ volume: "evidence", target: "/evidence" }],
          collect: ["/evidence"],
        },
        {
          name: "monitor",
          image,
          command: ["sleep", "3600"],
          dependsOn: ["sim"],
          cpus: 0.25,
          memGB: 0.1,
        },
      ],
      hooks: [{ service: "sim", command: "echo trusted > /evidence/verdict", timeoutSec: 5 }],
    });
    const done = await finish(run.id);
    expect(done).toMatchObject({
      state: "succeeded",
      cleanup: "done",
      lease: { state: "released" },
    });
    expect(readFileSync(output(run.id, "services/sim/evidence/verdict"), "utf8")).toBe("trusted\n");
    const events = await client.events(run.id);
    expect(
      events
        .filter((e) => e.kind === "service" && e.message.endsWith(": stopped"))
        .map((e) => e.message),
    ).toEqual(["monitor: stopped", "sim: stopped"]);
    expect(await docker.containersWithLabel(docker.LABEL_PARENT, run.id)).toEqual([]);
    expect(await docker.networksWithLabel(docker.LABEL_PARENT, run.id)).toEqual([]);
    expect(await docker.volumesWithLabel(docker.LABEL_PARENT, run.id)).toEqual([]);
  }, 60000);
});
