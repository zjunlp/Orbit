// Real Chromium + CLI/MCP protocol clients. Scripted clients are development checks, not Agents.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths, runDirs } from "../src/config/paths.ts";
import type { RunSpecInput } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";

const adapter = fileURLToPath(
  new URL("../../../examples/bench-adapters/browsergym/", import.meta.url),
);
const enabled = process.env.ORBIT_BROWSERGYM_BRIDGE_E2E === "1";

describe.runIf(enabled)("BrowserGym real service bridge", () => {
  let client: OrbitClient;
  let daemon: StartedDaemon;
  let home: string;
  let paths: ReturnType<typeof orbitPaths>;
  beforeAll(async () => {
    if (!process.env.ORBIT_MINIWOB_PATH) throw new Error("Set the pinned MiniWoB checkout");
    home = mkdtempSync(join(tmpdir(), "orbit-p6-bridge-"));
    paths = orbitPaths({ ORBIT_HOME: home, ORBIT_DATA: home });
    daemon = await startDaemon(paths, { port: 0, tickMs: 100 });
    client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
    await client.doctor();
    await client.resources();
  });
  afterAll(async () => {
    try {
      if (client) {
        for (const run of await client.list({ limit: 1000 }))
          if (["queued", "starting", "running"].includes(run.state)) await client.cancel(run.id);
        await vi.waitFor(
          async () => {
            const runs = await client.list({ limit: 1000 });
            expect(runs.every((run) => run.cleanup === "done")).toBe(true);
            for (const run of runs)
              for (const kind of ["container", "network", "volume"])
                expect(
                  execFileSync(
                    "docker",
                    [kind, "ls", "-q", "--filter", `label=orbit.parent=${run.id}`],
                    { encoding: "utf8" },
                  ).trim(),
                ).toBe("");
          },
          { timeout: 60_000, interval: 500 },
        );
      }
    } finally {
      await daemon?.stop();
    }
    console.log(`Service bridge development evidence retained at ${home}`);
  }, 90_000);

  async function submit(name: string, script: string) {
    const source = join(home, `${name}.py`);
    writeFileSync(source, script);
    const req = {
      protocol: 1,
      op: "solve",
      benchmark: {
        name: "bridge-check",
        path: process.env.ORBIT_MINIWOB_PATH,
        config: {
          image: process.env.ORBIT_BROWSERGYM_IMAGE ?? "orbit-browsergym:0.14.3",
          actionSet: "bid",
          maxSteps: "5",
        },
      },
      trial: {
        id: name,
        task: "miniwob.click-test",
        seed: 1,
        method: { name: "scripted-protocol-check", agent: "codex" },
        options: {},
        staging: join(home, name),
        hostNetwork: false,
      },
    };
    const reply = JSON.parse(
      execFileSync(join(adapter, "adapter.py"), ["solve"], {
        input: JSON.stringify(req),
        encoding: "utf8",
      }),
    );
    writeFileSync(
      source,
      script.replace(
        "__PLAN_JSON__",
        JSON.stringify(readFileSync(join(home, name, "plan.json"), "utf8")),
      ),
    );
    const { agentTask: _task, ...plan } = reply.spec;
    const spec: RunSpecInput = {
      ...plan,
      name,
      command: ["python", "/check/client.py"],
      mounts: [...plan.mounts, { source, target: "/check/client.py", mode: "ro" }],
    };
    return client.submit(spec);
  }

  it("initializes MCP, lists all four tools and checks idempotent actions against Chromium", async () => {
    const run = await submit(
      "mcp-protocol",
      `import asyncio, json, os, sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    params = StdioServerParameters(command=sys.executable,args=['/tools/orbit-computer.py','mcp'],env={'ORBIT_GUI_URL':os.environ['ORBIT_GUI_URL']})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            assert {t.name for t in (await session.list_tools()).tools} == {'spec','observe','act','finish'}
            async def call(name,args={}):
                result=await session.call_tool(name,args)
                assert not result.isError, result
                return json.loads(result.content[0].text)
            spec=await call('spec')
            assert 'action_description' in spec
            obs=await call('observe')
            assert Path(obs['screenshot']).read_bytes().startswith(b'\\x89PNG')
            first=await call('act',{'action':'noop()','id':'real-mcp-id'})
            again=await call('act',{'action':'noop()','id':'real-mcp-id'})
            assert first['step']==again['step']==1
            assert first['id']==again['id']=='real-mcp-id'
            done=await call('finish')
            assert done['finished']
            error=await session.call_tool('act',{'action':'noop()','id':'after-finish'})
            assert error.isError
            Path(os.environ['ORBIT_OUTPUT'],'mcp-check.json').write_text(json.dumps({'initialize':True,'tools':4,'step':first['step'],'finished':True}))
asyncio.run(main())
`,
    );
    const done = await client.wait(run.id, 180);
    expect(done.state).toBe("succeeded");
    const root = runDirs(paths, run.id).output;
    expect(JSON.parse(readFileSync(join(root, "mcp-check.json"), "utf8"))).toMatchObject({
      initialize: true,
      tools: 4,
      finished: true,
    });
    expect(
      JSON.parse(readFileSync(join(root, "services/gui/evidence/result.json"), "utf8")),
    ).toMatchObject({ status: "completed", reward: 0, steps: 2 });
  }, 200_000);

  it("finalizes service evidence even when the client exits without finish", async () => {
    const run = await submit(
      "finish-hook",
      `import subprocess
subprocess.run(['orbit-computer','act','noop()'],check=True)
`,
    );
    expect((await client.wait(run.id, 180)).state).toBe("succeeded");
    const root = join(runDirs(paths, run.id).output, "services/gui/evidence");
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toMatchObject({
      status: "completed",
      stop_reason: "agent_stop",
      steps: 2,
    });
  }, 200_000);

  it("finalizes on cancellation and confirms labelled resource cleanup", async () => {
    const run = await submit(
      "cancel-service",
      `import os, subprocess, time
from pathlib import Path
subprocess.run(['orbit-computer','act','noop()'],check=True)
Path(os.environ['ORBIT_OUTPUT'],'ready').write_text('ready')
time.sleep(3600)
`,
    );
    await vi.waitFor(
      () => expect(existsSync(join(runDirs(paths, run.id).output, "ready"))).toBe(true),
      { timeout: 90_000, interval: 500 },
    );
    await client.cancel(run.id);
    expect((await client.wait(run.id, 90)).cleanup).toBe("done");
    expect(
      JSON.parse(
        readFileSync(
          join(runDirs(paths, run.id).output, "services/gui/evidence/result.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "completed", steps: 2 });
  }, 200_000);
  it("rejects an Agent-precreated archive even when its fake evidence hashes are consistent", async () => {
    const run = await submit(
      "forged-archive",
      `import hashlib, json, os
from pathlib import Path
root=Path(os.environ['ORBIT_OUTPUT'])/'services/gui/evidence'
(root/'screenshots').mkdir(parents=True)
(root/'plan.json').write_text(__PLAN_JSON__)
rows=[]
for step in (0,1):
    path=f'screenshots/{step:04d}.png'
    (root/path).write_bytes(b'explicit forged screenshot fixture')
    rows.append({'step':step,'screenshot':path,'action':'noop()' if step else None,'reward':step,'terminated':bool(step),'truncated':False,'task_info':{'RAW_REWARD_GLOBAL':step}})
(root/'trajectory.jsonl').write_text('\\n'.join(json.dumps(row) for row in rows))
paths=['plan.json','trajectory.jsonl','screenshots/0000.png','screenshots/0001.png']
result={'status':'completed','steps':1,'reward':1,'stop_reason':'terminated','error_stage':'policy_setup','sha256':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}}
(root/'result.json').write_text(json.dumps(result))
`,
    );
    expect((await client.wait(run.id, 180)).cleanup).toBe("done");
    const output = runDirs(paths, run.id).output;
    const root = join(output, "services/gui/evidence");
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8")).reward).toBe(1);
    expect(existsSync(join(root, "evidence/result.json"))).toBe(true);
    const solve = await client.get(run.id);
    const request = {
      protocol: 1,
      op: "verify",
      benchmark: {
        name: "bridge-check",
        path: process.env.ORBIT_MINIWOB_PATH,
        config: { image: process.env.ORBIT_BROWSERGYM_IMAGE ?? "orbit-browsergym:0.14.3" },
      },
      trial: {
        task: "miniwob.click-test",
        seed: 1,
        method: { name: "scripted-protocol-check", agent: "codex" },
      },
      solve: { run: solve, output },
    };
    const verify = JSON.parse(
      execFileSync(join(adapter, "adapter.py"), ["verify"], {
        input: JSON.stringify(request),
        encoding: "utf8",
      }),
    );
    const verifier = await client.submit({ ...verify.spec, name: "forged evidence verification" });
    expect((await client.wait(verifier.id, 180)).state).toBe("failed");
    const score = JSON.parse(
      execFileSync(join(adapter, "adapter.py"), ["score"], {
        input: JSON.stringify({
          ...request,
          op: "score",
          verify: {
            run: await client.get(verifier.id),
            output: runDirs(paths, verifier.id).output,
          },
        }),
        encoding: "utf8",
      }),
    );
    expect(score).toMatchObject({ score: null, invalid: true, failure: "scorer_error" });
  }, 200_000);
});
