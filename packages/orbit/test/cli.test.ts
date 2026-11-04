import { describe, expect, it } from "vitest";
import { detectAgent } from "../src/cli/agent.ts";
import { expandGrid, substitute } from "../src/cli/program.ts";
import { RunSpec } from "../src/contracts/index.ts";
import { envFileText, runArgs, shellJoin } from "../src/executor/docker.ts";

describe("sweep helpers", () => {
  it("expands the cartesian product and substitutes placeholders", () => {
    const grid = expandGrid(["seed=1,2", "lr=1e-3,1e-4"]);
    expect(grid).toHaveLength(4);
    expect(grid[1]).toEqual({ seed: "1", lr: "1e-4" });
    expect(substitute(["train.py", "--seed={seed}", "{missing}"], { seed: "7" })).toEqual([
      "train.py",
      "--seed=7",
      "{missing}",
    ]);
    expect(() => expandGrid(["seed"])).toThrow();
  });
});

describe("detectAgent", () => {
  it("prefers explicit ORBIT_AGENT, then Claude Code env", () => {
    expect(detectAgent({ ORBIT_AGENT: "codex:abc" }, "/p")).toEqual({
      harness: "codex",
      sessionId: "abc",
      cwd: "/p",
    });
    expect(detectAgent({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }, "/p", [])).toEqual({
      harness: "claude-code",
      sessionId: "s1",
      cwd: "/p",
    });
  });

  it("lets the nearest agent process win when agents are nested", () => {
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1", CODEX_THREAD_ID: "t1" };
    expect(detectAgent(env, "/p", ["bash", "codex", "node", "claude"])).toEqual({
      harness: "codex",
      sessionId: "t1",
      cwd: "/p",
    });
    expect(detectAgent(env, "/p", ["bash", "claude", "codex"])?.harness).toBe("claude-code");
    expect(detectAgent({ CODEX_THREAD_ID: "t1" }, "/p", [])?.sessionId).toBe("t1");
    expect(detectAgent({}, "/p", ["bash"])).toBeUndefined();
  });
});

describe("docker run args", () => {
  const base = {
    name: "orbit-x",
    image: "img",
    command: ["python", "t.py"],
    labels: { "orbit.run": "x" },
    gpuIds: ["GPU-a", "GPU-b"],
    cpus: 2,
    memGB: 8,
    mounts: [{ source: "/d", target: "/data", mode: "ro" as const }],
    env: { A: "1" },
    workdir: "/workspace",
    network: "none" as const,
    user: "1000:1000",
  };
  it("uses CDI devices when available", () => {
    const a = runArgs({ ...base, gpuMode: "cdi" });
    expect(a).toContain("nvidia.com/gpu=GPU-a");
    expect(a).toContain("type=bind,source=/d,target=/data,readonly");
    expect(a.slice(-3)).toEqual(["img", "python", "t.py"]);
    expect(a.join(" ")).toContain("--network none");
  });
  it("falls back to --gpus", () => {
    expect(runArgs({ ...base, gpuMode: "gpus" })).toContain('"device=GPU-a,GPU-b"');
  });
  it("passes secrets by env file and supports host network", () => {
    const a = runArgs({ ...base, gpuMode: "cdi", network: "host", envFile: "/t/x.env" }).join(" ");
    expect(a).toContain("--env-file /t/x.env");
    expect(a).toContain("--network host");
    expect(runArgs({ ...base, gpuMode: "cdi", network: "bridge" })).not.toContain("--network");
    expect(envFileText({ K: "v=1" })).toBe("K=v=1\n");
    expect(() => envFileText({ K: "a\nb" })).toThrow();
  });

  it("starts service containers: no limits, networks with aliases, health check, hardening", () => {
    const a = runArgs({
      ...base,
      gpuIds: [],
      gpuMode: "cdi",
      command: [],
      cpus: null,
      memGB: null,
      init: false,
      shm: false,
      networks: [
        { name: "orbit-r-default", aliases: ["sim"] },
        { name: "orbit-r-task", aliases: ["sim"] },
      ],
      healthcheck: {
        command: ["python3", "-c", "print('ok')"],
        intervalSec: 2,
        timeoutSec: 1.5,
        startPeriodSec: 0,
        retries: 5,
      },
      readOnly: true,
      tmpfs: ["/tmp:rw,size=128m"],
      capDrop: ["ALL"],
      capAdd: ["KILL"],
      securityOpt: ["no-new-privileges:true"],
      pidsLimit: 128,
    });
    const j = a.join(" ");
    for (const f of ["--init", "--cpus", "--memory", "--shm-size", "--network none"])
      expect(j).not.toContain(f);
    expect(j).toContain(
      "--network name=orbit-r-default,alias=sim --network name=orbit-r-task,alias=sim",
    );
    expect(a[a.indexOf("--health-cmd") + 1]).toBe("python3 -c 'print('\\''ok'\\'')'");
    expect(j).toContain("--health-timeout 1.5s --health-start-period 0s --health-retries 5");
    expect(j).toContain("--read-only --tmpfs /tmp:rw,size=128m --cap-add KILL --cap-drop ALL");
    expect(j).toContain("--security-opt no-new-privileges:true --pids-limit 128");
    expect(a.at(-1)).toBe("img");
    expect(shellJoin(["a b", "c"])).toBe("'a b' c");
  });
});

describe("run specs with services", () => {
  const svc = { name: "sim", image: "sim:1" };
  const ok = (extra: object) => RunSpec.safeParse({ image: "x", command: ["true"], ...extra });
  it("checks names, networks, dependencies and the backend", () => {
    expect(ok({ services: [svc], dependsOn: ["sim"] }).success).toBe(true);
    const msg = (extra: object) => {
      const r = ok(extra);
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(msg({ services: [{ ...svc, name: "main" }] })).toMatch(/main/);
    expect(msg({ services: [svc, svc] })).toMatch(/distinct/);
    expect(msg({ services: [{ ...svc, networks: ["task"] }] })).toMatch(/unknown network task/);
    expect(msg({ services: [svc], dependsOn: ["db"] })).toMatch(/unknown service db/);
    expect(
      msg({
        services: [
          { ...svc, dependsOn: ["db"] },
          { name: "db", image: "db", dependsOn: ["sim"] },
        ],
      }),
    ).toMatch(/cycle/);
    expect(msg({ services: [svc], hostNetwork: true })).toMatch(/host networking/);
    expect(msg({ dependsOn: ["sim"] })).toMatch(/need services/);
    expect(msg({ services: [{ name: "Sim", image: "x" }] })).toMatch(/lowercase/);
    // /workspace is Orbit's only when the run has a project there (Harbor tasks use it).
    const ws = { mounts: [{ source: "/tmp", target: "/workspace/data", mode: "ro" }] };
    expect(ok(ws).success).toBe(true);
    expect(msg({ ...ws, project: "/p" })).toMatch(/outside \/orbit/);
  });
});

describe("container path validation", () => {
  const parse = (extra: object) =>
    RunSpec.safeParse({ image: "fixture", command: ["true"], ...extra });

  it.each(["/./orbit", "/orbit/../orbit", "/.//orbit/output", "//orbit", "/./", "/data/../safe"])(
    "refuses reserved or traversing mount target %s",
    (target) => {
      expect(parse({ mounts: [{ source: "/fixture", target }] }).success).toBe(false);
    },
  );

  it("compares normalized mount targets and protects workspace only when it is reserved", () => {
    for (const target of ["/data/.", "/./data/", "//data//"])
      expect(
        parse({
          mounts: [
            { source: "/a", target: "/data" },
            { source: "/b", target },
          ],
        }).success,
      ).toBe(false);
    const mounts = [{ source: "/fixture", target: "/./workspace//data" }];
    expect(parse({ mounts }).success).toBe(true);
    expect(parse({ mounts, project: "/project" }).success).toBe(false);
    const result = parse({
      mounts: [{ source: "/fixture", target: "/./data//files/" }],
      collect: ["/./results//file/"],
    });
    expect(result.success && result.data.mounts[0]?.target).toBe("/data/files");
    expect(result.success && result.data.collect).toEqual(["/results/file"]);
  });

  it("normalizes collect paths in all phases while retaining the raw traversal rejection", () => {
    for (const path of ["/results/../results", "/../results", "relative"]) {
      expect(parse({ collect: [path] }).success).toBe(false);
      expect(
        parse({ services: [{ name: "sim", image: "fixture", collect: [path] }] }).success,
      ).toBe(false);
      expect(parse({ after: { command: ["true"], timeoutMin: 1, collect: [path] } }).success).toBe(
        false,
      );
    }
    const result = parse({
      services: [{ name: "sim", image: "fixture", collect: ["/./results//"] }],
      after: { command: ["true"], timeoutMin: 1, collect: ["/./results//"] },
    });
    expect(result.success && result.data.services[0]?.collect).toEqual(["/results"]);
    expect(result.success && result.data.after?.collect).toEqual(["/results"]);
  });
});
