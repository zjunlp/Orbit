// biome-ignore-all lint/style/noNonNullAssertion: Fixed fixture positions are checked by the surrounding assertions.
// Real store, converters, filesystem and HTTP handlers; scheduling and worker transport are explicit doubles.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectTrajectories } from "../src/bench/trajectory-export.ts";
import { registerTrajectory } from "../src/cli/trajectory.ts";
import { OrbitClient } from "../src/client/index.ts";
import type { ClusterService } from "../src/cluster/service.ts";
import { orbitPaths } from "../src/config/paths.ts";
import {
  AtifTrajectory,
  BenchJob,
  ChatTrajectory,
  type Outcome,
  Run,
  TrajectoryExportManifest,
  TrajectoryExportRequest,
  Trial,
} from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { Redactor } from "../src/lib/redact.ts";
import { RunService } from "../src/runs/service.ts";
import { exportTrajectories } from "../src/runs/trajectory-export.ts";
import { prepareTrajectory } from "../src/sessions/export/convert.ts";
import { assertNoSecrets } from "../src/sessions/export/security.ts";
import { trajectorySummary } from "../src/sessions/trajectory.ts";
import { Store } from "../src/store/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const image = Buffer.from("development media fixture");
const mediaPath = `media/${hash(image)}.png`;
function trajectory(): AtifTrajectory {
  return AtifTrajectory.parse({
    schema_version: "ATIF-v1.7",
    extra: {
      orbit: {
        version: 1,
        importer: { name: "fixture", version: 1 },
        sources: [],
        completeness: "complete",
      },
    },
    trajectory_id: "root",
    agent: {
      name: "fixture",
      version: "1",
      tool_definitions: [
        { type: "function", function: { name: "read", parameters: { type: "object" } } },
      ],
    },
    steps: [
      { step_id: 1, source: "user", message: "inspect the file" },
      {
        step_id: 2,
        source: "agent",
        message: "reading",
        reasoning_content: "short summary",
        extra: { orbit: { reasoning: "summary" } },
        tool_calls: [
          { tool_call_id: "call-a", function_name: "read", arguments: { path: "file.txt" } },
          { tool_call_id: "call-b", function_name: "read", arguments: { path: "other.txt" } },
        ],
        observation: {
          results: [
            { source_call_id: "call-a", content: "x".repeat(9000) },
            {
              source_call_id: "call-b",
              content: [{ type: "image", source: { media_type: "image/png", path: mediaPath } }],
            },
          ],
        },
        metrics: { prompt_tokens: 10, completion_tokens: 4 },
      },
      {
        step_id: 3,
        source: "agent",
        message: "done",
        reasoning_content: "raw reasoning",
        extra: {
          orbit: { reasoning: "raw" },
          encrypted_content: "opaque blob",
          signature: "native signature",
        },
      },
    ],
    final_metrics: { total_prompt_tokens: 10, total_completion_tokens: 4 },
    subagent_trajectories: [
      {
        schema_version: "ATIF-v1.7",
        trajectory_id: "child",
        agent: { name: "fixture", version: "1" },
        steps: [
          {
            step_id: 1,
            source: "agent",
            message: "child response",
            metrics: { prompt_tokens: 0, completion_tokens: 0 },
            reasoning_content: "ciphertext",
            extra: { orbit: { reasoning: "opaque" } },
          },
        ],
      },
    ],
  });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orbit-export-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const add = (id: string, atif = trajectory()) => {
    const run = Run.parse({
      id,
      trajectory: trajectorySummary(atif),
      spec: { backend: "process", command: ["true"] },
      state: "succeeded",
      reason: null,
      exitCode: 0,
      node: "fixture",
      image: null,
      containerId: null,
      lease: null,
      code: null,
      cleanup: "done",
      note: "",
      createdAt: "2026-11-14T00:00:00Z",
      startedAt: null,
      endedAt: "2026-11-14T00:01:00Z",
    });
    store.putRun(run);
    const dir = join(runs.dirs(id).orbit, "trajectory");
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "trajectory.json"), JSON.stringify(atif));
    writeFileSync(join(dir, mediaPath), image);
    return run;
  };
  const run = add("run-a");
  const app = createApp({ runs, store, paths, token: "fixture", webDir: null } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  const client = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
  const out = join(root, "export");
  const request = (fields = {}) =>
    TrajectoryExportRequest.parse({ runs: [run.id], out, ...fields });
  return { root, home, paths, store, runs, run, add, app, client, out, request };
}
function outcome(evaluation: Outcome["evaluation"] = "valid", score = 1): Outcome {
  return {
    execution: "succeeded",
    evaluation,
    score,
    maxScore: 1,
    cleanup: "done",
    issues: [],
    review: null,
  };
}
function job(f: ReturnType<typeof fixture>) {
  const job = BenchJob.parse({
    id: "job-a",
    spec: {
      benchmark: "fixture",
      methods: [{ name: "method-a", agent: "codex", auth: "fixture" }],
    },
    revisions: {
      "method-a": {
        revision: "abcdef123456",
        approximate: false,
        basis: {
          agent: "codex",
          model: null,
          effort: null,
          authKind: "api_key",
          cliVersion: null,
          bundleDigest: null,
          entrypoint: null,
          config: null,
        },
      },
    },
    state: "done",
    createdAt: "2026-11-14T00:00:00Z",
    endedAt: null,
  });
  f.store.putJob(job);
  const addTrial = (id: string, fields = {}) => {
    const trial = Trial.parse({
      id,
      jobId: job.id,
      task: id,
      method: "method-a",
      seed: 1,
      state: "done",
      solveRunId: f.run.id,
      verifyRunId: null,
      outcome: outcome(),
      createdAt: job.createdAt,
      endedAt: null,
      ...fields,
    });
    f.store.putTrial(trial);
    return trial;
  };
  return { job, addTrial };
}

describe("trajectory export", () => {
  it("round-trips full ATIF and media with verifiable hashes and tool pairings", async () => {
    const f = fixture();
    const result = await f.client.exportTrajectories(f.request());
    const manifest = TrajectoryExportManifest.parse(
      JSON.parse(readFileSync(result.manifest, "utf8")),
    );
    const saved = AtifTrajectory.parse(
      JSON.parse(readFileSync(join(f.out, manifest.entries[0]!.path), "utf8")),
    );
    expect(saved.steps).toHaveLength(3);
    expect(saved.steps[1]!.observation).toEqual(trajectory().steps[1]!.observation);
    expect(saved.steps[1]!.tool_calls).toEqual(trajectory().steps[1]!.tool_calls);
    expect(saved.steps[1]!.reasoning_content).toBe("short summary");
    expect(saved.steps[2]!.reasoning_content).toBeUndefined();
    expect(saved.steps[2]!.extra).not.toHaveProperty("encrypted_content");
    expect(saved.subagent_trajectories![0]!.steps[0]!.reasoning_content).toBeUndefined();
    expect(manifest.entries[0]).toMatchObject({
      execution: "succeeded",
      cleanup: "done",
      steps: 4,
      trajectories: 2,
      tokens: { input: 10, output: 4 },
    });
    expect(manifest.licenseNotice).toContain("licenses");
    for (const file of manifest.files) {
      const data = readFileSync(join(f.out, file.path));
      expect(hash(data)).toBe(file.sha256);
      expect(data.length).toBe(file.bytes);
      expect(statSync(join(f.out, file.path)).mode & 0o777).toBe(0o600);
    }
  });
  it("exports Chat JSONL without truncation, with separate child rows and portable media", async () => {
    const f = fixture();
    await f.client.exportTrajectories(f.request({ format: "chat-jsonl", reasoning: "none" }));
    const rows = readFileSync(join(f.out, "dataset.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => ChatTrajectory.parse(JSON.parse(line)));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tools).toEqual(trajectory().agent.tool_definitions);
    expect(rows[0]!.messages.find((m) => m.tool_call_id === "call-a")!.content).toBe(
      "x".repeat(9000),
    );
    expect(rows[0]!.messages.find((m) => m.tool_calls)!.tool_calls!.map((c) => c.id)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(rows[0]!.messages.find((m) => m.tool_call_id === "call-b")!.content).toEqual([
      { type: "image", source: { media_type: "image/png", path: `runs/1/${mediaPath}` } },
    ]);
    expect(rows[1]).toMatchObject({ trajectory_id: "child", parent_trajectory_id: "root" });
    expect(JSON.stringify(rows)).not.toMatch(
      /raw reasoning|short summary|ciphertext|opaque blob|native signature/,
    );
  });
  it("never exports opaque reasoning, including nested native extras", () => {
    const source = trajectory();
    source.extra = { native: { type: "reasoning", encrypted_content: "secret ciphertext" } };
    expect(prepareTrajectory(source, "raw").steps[2]!.reasoning_content).toBe("raw reasoning");
    const raw = JSON.stringify(prepareTrajectory(source, "raw"));
    expect(raw).not.toMatch(/ciphertext|opaque blob|native signature/);
    expect(JSON.stringify(source)).toContain("secret ciphertext");
  });
  it("fails unknown secret fixtures without publishing output or echoing the value", async () => {
    const f = fixture();
    const source = trajectory();
    const secret = `sk-proj-${"x".repeat(40)}`;
    source.steps[0]!.message = `credential ${secret}`;
    f.add(f.run.id, source);
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(
      /secret pattern at entries\[0\]/,
    );
    expect(existsSync(f.out)).toBe(false);
    expect(
      readdirSync(f.root).filter((name) => name.startsWith(".orbit-trajectory-export-")),
    ).toEqual([]);
    try {
      assertNoSecrets({ text: secret }, "fixture");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
  it.each([
    "AKIA1234567890ABCDEF",
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "-----BEGIN PRIVATE KEY-----",
    '{"api_key":"abcdefgh12345678"}',
    "OPENAI_API_KEY=abcdefgh12345678",
  ])("detects additional credential shapes (%#)", (value) => {
    expect(() => assertNoSecrets({ text: value }, "fixture")).toThrow(/secret/);
  });
  it("applies the existing redactor before scanning", async () => {
    const f = fixture();
    const source = trajectory();
    const secret = `sk-proj-${"y".repeat(40)}`;
    source.steps[0]!.message = secret;
    f.add(f.run.id, source);
    vi.spyOn(f.runs, "redactor").mockReturnValue(new Redactor([secret]));
    await f.client.exportTrajectories(f.request());
    expect(readFileSync(join(f.out, "runs/1/trajectory.json"), "utf8")).toContain("[redacted]");
  });
  it("deduplicates shared batch Runs and filters only valid scores", () => {
    const f = fixture();
    const { addTrial } = job(f);
    addTrial("pass");
    addTrial("also-pass");
    f.add("run-fail");
    f.add("run-invalid");
    addTrial("fail", { solveRunId: "run-fail", outcome: outcome("valid", 0) });
    addTrial("invalid", { solveRunId: "run-invalid", outcome: outcome("invalid", 0) });
    const base = { runs: [], jobs: ["job-a"] };
    const all = selectTrajectories(f.store, f.request(base));
    expect(all).toHaveLength(3);
    expect(all[0]!.contexts).toHaveLength(2);
    expect(
      selectTrajectories(f.store, f.request({ ...base, outcome: "fail" }))[0]!.contexts.map(
        (c) => c.task,
      ),
    ).toEqual(["fail"]);
    expect(
      selectTrajectories(f.store, f.request({ ...base, outcome: "pass" }))[0]!.contexts.map(
        (c) => c.task,
      ),
    ).toEqual(["also-pass", "pass"]);
    expect(
      selectTrajectories(
        f.store,
        f.request({
          ...base,
          validOnly: true,
          tasks: ["pass", "also-pass"],
          methods: ["method-a"],
        }),
      )[0]!.contexts,
    ).toHaveLength(2);
    expect(() => selectTrajectories(f.store, f.request({ ...base, tasks: ["pass"] }))).toThrow(
      /shared with excluded/,
    );
    expect(() => selectTrajectories(f.store, f.request({ ...base, methods: ["missing"] }))).toThrow(
      /no trajectories/,
    );
  });
  it("uses an explicitly selected prior Run's scoring and phase", () => {
    const f = fixture();
    f.add("run-new");
    f.add("verify-old");
    const { addTrial } = job(f);
    addTrial("task", {
      solveRunId: "run-new",
      outcome: outcome("valid", 1),
      priorAttempts: [
        {
          solveRunId: f.run.id,
          verifyRunId: "verify-old",
          outcome: outcome("valid", 0),
          history: [],
        },
      ],
    });
    expect(
      selectTrajectories(f.store, f.request({ outcome: "fail" }))[0]!.contexts[0],
    ).toMatchObject({ priorAttempt: true, phase: "solve", outcome: { score: 0 } });
    expect(
      selectTrajectories(f.store, f.request({ runs: ["verify-old"], outcome: "fail" }))[0]!
        .contexts[0]!.phase,
    ).toBe("verify");
    expect(() => selectTrajectories(f.store, f.request({ outcome: "pass" }))).toThrow(
      /no trajectories/,
    );
  });
  it("refuses active Runs, existing output and paths inside Orbit state", async () => {
    const f = fixture();
    f.store.putRun({ ...f.run, state: "running" });
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/finished/);
    f.store.putRun(f.run);
    mkdirSync(f.out);
    writeFileSync(join(f.out, "keep.txt"), "untouched");
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/already exists/);
    expect(readFileSync(join(f.out, "keep.txt"), "utf8")).toBe("untouched");
    await expect(
      f.client.exportTrajectories(f.request({ out: join(f.home, "export") })),
    ).rejects.toThrow(/outside Orbit/);
    symlinkSync(f.home, join(f.root, "home-link"));
    await expect(
      f.client.exportTrajectories(f.request({ out: join(f.root, "home-link", "export") })),
    ).rejects.toThrow(/outside Orbit/);
  });
  it("fails a missing or changed media file and retains source evidence", async () => {
    const f = fixture();
    const media = join(f.runs.dirs(f.run.id).orbit, "trajectory", mediaPath);
    writeFileSync(media, "changed");
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/hash mismatch/);
    expect(existsSync(f.out)).toBe(false);
    rmSync(media);
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/media unavailable/);
    expect(existsSync(join(f.runs.dirs(f.run.id).orbit, "trajectory/trajectory.json"))).toBe(true);
  });
  it("reads remote trajectory and media through existing worker APIs", async () => {
    const f = fixture();
    const run = { ...f.run, remote: true } as Run;
    f.store.putRun(run);
    const cluster = {
      trajectory: vi.fn(async () => trajectory()),
      trajectoryFile: vi.fn(async () => new Response(image)),
    } as unknown as ClusterService;
    const app = createApp({
      runs: f.runs,
      store: f.store,
      paths: f.paths,
      cluster,
      token: "fixture",
      webDir: null,
    } as AppDeps);
    const response = await app.request("http://orbit.test/api/v1/trajectory/export", {
      method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json" },
      body: JSON.stringify(f.request()),
    });
    expect(await response.json()).toMatchObject({ runs: 1 });
    expect(cluster.trajectoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.run.id }),
      mediaPath,
    );
    expect(readFileSync(join(f.out, "runs/1", mediaPath))).toEqual(image);
  });
  it("requires one selector category and sends tasks-file filters through the CLI", async () => {
    const f = fixture();
    const { addTrial } = job(f);
    addTrial("task-a");
    const tasks = join(f.root, "tasks.txt");
    writeFileSync(tasks, "task-a\r\n\n");
    const program = new Command();
    registerTrajectory(program, async () => f.client);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(
      [
        "trajectory",
        "export",
        "--job",
        "job-a",
        "--tasks-file",
        tasks,
        "--method",
        "method-a",
        "--valid-only",
        "--outcome",
        "pass",
        "--out",
        f.out,
        "--json",
      ],
      { from: "user" },
    );
    const manifest = JSON.parse(readFileSync(join(f.out, "manifest.json"), "utf8"));
    expect(manifest.filters).toMatchObject({
      jobs: ["job-a"],
      tasks: ["task-a"],
      methods: ["method-a"],
      reasoning: "summary",
    });
    expect(manifest.entries[0].contexts[0]).toMatchObject({
      trial: "task-a",
      job: "job-a",
      method: "method-a",
      revision: "abcdef123456",
      revisionApproximate: false,
      outcome: { evaluation: "valid", score: 1 },
    });
    expect(() => f.request({ jobs: ["job-a"] })).toThrow(/exactly one/);
  });
  it("rejects unsafe media, external child files and secret manifest metadata", async () => {
    const f = fixture();
    const source = trajectory();
    source.steps[0]!.message = [
      { type: "image", source: { media_type: "image/png", path: "../../private.png" } },
    ];
    f.add(f.run.id, source);
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/unsafe.*media/);
    const external = trajectory();
    external.steps[1]!.observation!.results[0]!.subagent_trajectory_ref = [
      { trajectory_path: "child.json" },
    ];
    f.add(f.run.id, external);
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(/external subagent/);
    f.add(f.run.id);
    const { addTrial } = job(f);
    addTrial(`sk-proj-${"z".repeat(40)}`);
    await expect(f.client.exportTrajectories(f.request())).rejects.toThrow(
      /secret pattern at manifest/,
    );
    expect(existsSync(f.out)).toBe(false);
    expect(
      readdirSync(f.root).filter((name) => name.startsWith(".orbit-trajectory-export-")),
    ).toEqual([]);
  });
  it("bounds worker media reads and refuses absent trajectories", async () => {
    const f = fixture();
    const deps = {
      selected: [{ run: f.run, contexts: [] }],
      protectedRoots: [],
      redactor: () => new Redactor([]),
      trajectory: async () => trajectory(),
      media: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
    };
    await expect(exportTrajectories(f.request(), deps)).rejects.toThrow(/exceeds export limit/);
    await expect(
      exportTrajectories(f.request(), { ...deps, trajectory: async () => null }),
    ).rejects.toThrow(/no Agent trajectory/);
    expect(existsSync(f.out)).toBe(false);
  });
  it("cleans staging on cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    await expect(
      exportTrajectories(f.request(), {
        selected: [{ run: f.run, contexts: [] }],
        protectedRoots: [],
        redactor: () => new Redactor([]),
        trajectory: async () => trajectory(),
        media: async () => {
          controller.abort();
          return new ReadableStream();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(existsSync(f.out)).toBe(false);
    expect(
      readdirSync(f.root).filter((name) => name.startsWith(".orbit-trajectory-export-")),
    ).toEqual([]);
  });
});
