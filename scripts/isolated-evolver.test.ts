import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AuthProfile,
  Run,
  TrajectoryExportManifest,
} from "../packages/orbit/src/contracts/index.ts";
import { inspectBundle } from "../packages/orbit/src/lib/bundle.ts";
import {
  checkChanges,
  instructionEntries,
  sha256,
  snapshot,
  writeSnapshot,
} from "../plugin/skills/orbit-evolve/scripts/isolated-files.mjs";
import {
  checkParent,
  checkProfile,
  checkRun,
  evidenceTrials,
  requestFrom,
  runArgs,
  verifyExport,
} from "../plugin/skills/orbit-evolve/scripts/run-isolated.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "orbit-isolated-"));
  roots.push(root);
  const parent = join(root, "parent");
  mkdirSync(join(parent, "skills/test/empty"), { recursive: true });
  writeFileSync(join(parent, "AGENTS.md"), "Use feedback.\n");
  writeFileSync(join(parent, "skills/test/SKILL.md"), "Verify the result.\n");
  const request = requestFrom({
    parent,
    out: join(root, "round"),
    evolveTasks: join(root, "evolve.txt"),
    policy: join(root, "gate.json"),
    parentRevision: "a".repeat(12),
    parentDigest: inspectBundle(parent).digest,
    evolveJob: "job",
    evolveMethod: "baseline",
    auth: "codex-profile",
    model: "example-model",
    effort: "low",
    image: "python:3.12-slim",
    limits: { changedLines: 10, changedBytes: 4096, editorTokens: 10000, timeoutMin: 5 },
  });
  return { root, parent, request };
}
function manifest() {
  return TrajectoryExportManifest.parse({
    version: 1,
    exporter: { name: "orbit", version: "test" },
    createdAt: "now",
    format: "atif",
    reasoning: "none",
    filters: { jobs: ["job"], validOnly: true, outcome: "fail", format: "atif", reasoning: "none" },
    licenseNotice: "fixture",
    entries: [
      {
        run: "solve",
        path: "runs/1/trajectory.json",
        execution: "succeeded",
        cleanup: "done",
        exitCode: 0,
        tokens: null,
        completeness: null,
        steps: 1,
        trajectories: 1,
        contexts: [
          {
            trial: "trial",
            job: "job",
            benchmark: "bench",
            task: "evolve-task",
            method: "baseline",
            revision: "a".repeat(12),
            revisionApproximate: false,
            sample: { seed: 1 },
            phase: "solve",
            priorAttempt: false,
            outcome: {
              execution: "succeeded",
              evaluation: "valid",
              score: 0,
              maxScore: 1,
              cleanup: "done",
            },
          },
        ],
      },
    ],
    files: [{ path: "runs/1/trajectory.json", bytes: 3, sha256: sha256("{}\n") }],
  });
}
it("copies only regular instruction trees without changing the canonical parent digest", () => {
  const { root, parent } = setup();
  const entries = instructionEntries(snapshot(parent));
  writeSnapshot(join(root, "copy"), entries);
  expect(inspectBundle(join(root, "copy"))).toEqual(inspectBundle(parent));
  expect(readFileSync(join(parent, "AGENTS.md"), "utf8")).toBe("Use feedback.\n");
});
it("rejects symlinks, hard links, executable instructions and arbitrary configuration files", () => {
  const { root, parent } = setup();
  symlinkSync("/etc/passwd", join(parent, "leak"));
  expect(() => snapshot(parent)).toThrow(/symlink/);
  rmSync(join(parent, "leak"));
  linkSync(join(parent, "AGENTS.md"), join(root, "alias"));
  expect(() => snapshot(parent)).toThrow(/private regular/);
  rmSync(join(root, "alias"));
  chmodSync(join(parent, "AGENTS.md"), 0o700);
  expect(() => snapshot(parent)).toThrow(/executable/);
  chmodSync(join(parent, "AGENTS.md"), 0o600);
  writeFileSync(join(parent, "config.toml"), "model='changed'");
  expect(() => instructionEntries(snapshot(parent))).toThrow(/Markdown/);
});
it("does not materialize escaping, duplicate or binary candidate entries", () => {
  for (const path of ["../escape.md", "/tmp/escape.md", "skills/../escape.md", "skills\\escape.md"])
    expect(() => instructionEntries([{ path, body: "YQo=" }])).toThrow();
  expect(() => instructionEntries([{ path: "AGENTS.md", body: "AA==" }])).toThrow(/text/);
  expect(() => instructionEntries([{ path: "AGENTS.md", body: "/w==" }])).toThrow();
  expect(() =>
    instructionEntries([
      { path: "AGENTS.md", body: "YQo=" },
      { path: "AGENTS.md", body: "Ygo=" },
    ]),
  ).toThrow(/duplicate/);
  expect(() => instructionEntries([{ path: "skills/a.md", body: "YQo=" }])).toThrow(/directory/);
});
it("charges changed spans and whole changed files, including deletions, and rejects empty changes", () => {
  const { parent } = setup(),
    before = instructionEntries(snapshot(parent));
  const after = before.map((e) =>
    e.path === "AGENTS.md"
      ? { ...e, body: Buffer.from("Use feedback.\nCheck prerequisites.\n").toString("base64") }
      : e,
  );
  expect(checkChanges(before, after, { changedLines: 1, changedBytes: 100 })).toEqual({
    changedLines: 1,
    changedBytes: 35,
  });
  expect(() => checkChanges(before, after, { changedLines: 1, changedBytes: 20 })).toThrow(
    /budget/,
  );
  expect(() => checkChanges(before, before, { changedLines: 10, changedBytes: 100 })).toThrow(
    /no instruction/,
  );
  expect(
    checkChanges(
      before,
      before.filter((e) => e.path !== "AGENTS.md"),
      { changedLines: 10, changedBytes: 100 },
    ).changedBytes,
  ).toBe(14);
});
it("uses only exact parent solve evidence within the evolve partition and retains every trial", () => {
  const { request } = setup(),
    source = manifest(),
    tasks = new Set(["evolve-task"]);
  expect(evidenceTrials(source, tasks, request)).toEqual(["trial"]);
  const entry = source.entries[0],
    context = entry?.contexts[0];
  assert(entry && context);
  for (const patch of [
    { task: "held-out" },
    { revision: "b".repeat(12) },
    { revisionApproximate: true },
    { phase: "verify" },
    { priorAttempt: true },
    { job: "other-job" },
  ]) {
    const changed = structuredClone(source);
    const context = changed.entries[0]?.contexts[0];
    assert(context);
    Object.assign(context, patch);
    expect(() => evidenceTrials(changed, tasks, request)).toThrow(/outside/);
  }
  entry.contexts.push({ ...context, trial: "another-trial" });
  expect(evidenceTrials(source, tasks, request)).toEqual(["another-trial", "trial"]);
});
it("verifies exported files and rejects extra material, forged sizes and symlinked media", () => {
  const { root } = setup(),
    evidence = join(root, "evidence");
  mkdirSync(join(evidence, "runs/1"), { recursive: true });
  const source = manifest();
  writeFileSync(join(evidence, "manifest.json"), JSON.stringify(source));
  writeFileSync(join(evidence, "runs/1/trajectory.json"), "{}\n");
  verifyExport(evidence, source);
  writeFileSync(join(evidence, "gate.txt"), "secret");
  expect(() => verifyExport(evidence, source)).toThrow(/unexpected/);
  rmSync(join(evidence, "gate.txt"));
  writeFileSync(join(evidence, "runs/1/trajectory.json"), "bad");
  expect(() => verifyExport(evidence, source)).toThrow(/integrity/);
  rmSync(join(evidence, "runs/1/trajectory.json"));
  symlinkSync("/etc/passwd", join(evidence, "runs/1/trajectory.json"));
  expect(() => verifyExport(evidence, source)).toThrow(/symlink/);
});
it("rejects host-network and environment overrides before submitting", () => {
  const profile = AuthProfile.parse({
    name: "p",
    harness: "codex",
    kind: "login",
    secretHint: null,
    createdAt: "now",
    updatedAt: "now",
  });
  checkProfile(profile);
  expect(() => checkProfile({ ...profile, hostNetwork: true })).toThrow(/host networking/);
  expect(() => checkProfile({ ...profile, env: { CODEX_HOME: "/data" } })).toThrow(/environment/);
  checkProfile({ ...profile, env: { HTTPS_PROXY: "http://proxy:8080" } });
  const { request } = setup();
  const args = runArgs(request);
  expect(args).toContain("--no-project");
  expect(args).not.toContain("--host-network");
  expect(args[args.indexOf("--mount") + 1]).toBe(`${request.out}/input:/evolve-input:ro`);
  expect(args).not.toContain(request.policy);
  expect(args).not.toContain(request.evolveTasks);
});
it("requires explicit budgets and rejects arbitrary mount, prompt and environment extensions", () => {
  const { request } = setup();
  expect(() => requestFrom({ ...request, limits: { ...request.limits, editorTokens: 0 } })).toThrow(
    /positive/,
  );
  for (const extra of [{ mounts: [] }, { prompt: "read gate" }, { hostNetwork: true }, { env: {} }])
    expect(() => requestFrom({ ...request, ...extra })).toThrow(/unknown/);
});
it("collects only succeeded clean isolated Runs with known in-budget tokens", () => {
  const { request } = setup();
  const run = Run.parse({
    id: "editor",
    spec: {
      image: request.image,
      command: ["python3", "/evolve-input/editor.py"],
      auth: request.auth,
      mounts: [{ source: join(request.out, "input"), target: "/evolve-input", mode: "ro" }],
    },
    state: "succeeded",
    reason: null,
    exitCode: 0,
    node: "local",
    image: request.image,
    containerId: null,
    lease: null,
    code: null,
    cleanup: "done",
    note: "",
    tokens: {
      input: 500,
      cachedInput: 300,
      output: 10,
      cacheWrite: 0,
      reasoning: 0,
      calls: 1,
      source: "session",
    },
    createdAt: "now",
    startedAt: "now",
    endedAt: "now",
  });
  checkRun(run, run, request);
  for (const patch of [
    { state: "failed" },
    { cleanup: "pending" },
    { cleanup: "failed" },
    { tokens: null },
    { tokens: { ...run.tokens, input: null } },
    { tokens: { ...run.tokens, input: 10001 } },
  ])
    expect(() => checkRun(Run.parse({ ...run, ...patch }), run, request)).toThrow();
  expect(() =>
    checkRun(Run.parse({ ...run, spec: { ...run.spec, hostNetwork: true } }), run, request),
  ).toThrow(/unsafe/);
  expect(() =>
    checkRun(Run.parse({ ...run, spec: { ...run.spec, mounts: [] } }), run, request),
  ).toThrow(/changed/);
});

it("binds the exact parent bundle to the saved evolve method revision", () => {
  const { request } = setup();
  const parent = {
    revision: request.parentRevision,
    approximate: false,
    basis: {
      agent: "codex",
      model: "example-model",
      effort: "low",
      authKind: "login",
      cliVersion: "test",
      bundleDigest: request.parentDigest,
      entrypoint: null,
      config: null,
    },
  };
  checkParent(parent, request);
  expect(() => checkParent(undefined, request)).toThrow(/saved/);
  expect(() => checkParent({ ...parent, approximate: true }, request)).toThrow(/saved/);
  expect(() =>
    checkParent({ ...parent, basis: { ...parent.basis, bundleDigest: "b".repeat(64) } }, request),
  ).toThrow(/saved/);
  expect(() => checkParent({ ...parent, revision: "b".repeat(12) }, request)).toThrow(/saved/);
});
