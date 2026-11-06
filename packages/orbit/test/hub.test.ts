// The Web's Benchmarks / Agents / Methods data (design §9.16): identity and domains of registrations,
// method revisions, Agent capability states and evidence, the compatibility matrix and method lines.
// Explicit fixtures over the pure builders; no runs are executed.
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { benchDomains, benchIdentity } from "../src/bench/catalog.ts";
import {
  agentBlocker,
  agentCatalog,
  authTests,
  compatibility,
  type JobWithSummary,
  jobRevision,
  methodLines,
  wired,
} from "../src/bench/hub.ts";
import { bundleDigest, methodBasis, revisionOf } from "../src/bench/revision.ts";
import { buildReport, summarize } from "../src/bench/summary.ts";
import {
  type AuthProfile,
  type Benchmark,
  type CatalogEntry,
  type Run,
  splitDomains,
  type Trial,
} from "../src/contracts/index.ts";
import { builtinRegistry } from "../src/harness/registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const reg = builtinRegistry();
const def = (name: string) => {
  const d = reg.get(name);
  if (!d) throw new Error(name);
  return d;
};
const bench = (name: string, labels?: object) =>
  ({
    name,
    adapter: "/a",
    path: "/p",
    config: {},
    env: {},
    passEnv: [],
    createdAt: "",
    updatedAt: "",
    ...(labels ? { labels } : {}),
  }) as unknown as Benchmark;

it("resolves identity from labels, then the adapter, then the registration", () => {
  const caps = {
    identity: { id: "asi-bench", name: "ASI-Bench" },
    domains: ["science", "seed31415"],
  } as never;
  expect(benchIdentity(bench("asi-b2"), caps)).toEqual({
    identity: { id: "asi-bench", name: "ASI-Bench" },
    source: "adapter",
  });
  expect(
    benchIdentity(bench("asi-b2", { identity: { id: "asi", name: "ASI" } }), caps).source,
  ).toBe("label");
  const fallback = benchIdentity(bench("TB-Sci"), null);
  expect(fallback).toMatchObject({ identity: { name: "TB-Sci" }, source: "derived" });
  expect(fallback.identity.id).toMatch(/^derived-[a-f0-9]{12}$/);
  expect(benchIdentity(bench("another-name"), null).identity.id).toBe(fallback.identity.id);
  expect(benchIdentity({ ...bench("tb-sci"), path: "/other" }, null).identity.id).not.toBe(
    fallback.identity.id,
  );
  // Labels replace the adapter's domains; values outside the vocabulary are tags.
  expect(benchDomains(bench("x"), caps)).toEqual({ domains: ["science"], tags: ["seed31415"] });
  expect(benchDomains(bench("x", { domains: ["games"] }), caps)).toEqual({
    domains: ["games"],
    tags: [],
  });
  expect(splitDomains(["airline", "conversation", "airline"])).toEqual({
    domains: ["conversation"],
    tags: ["airline"],
  });
});

it("hashes what a method is made of, not its name or credentials", () => {
  const d = mkdtempSync(join(tmpdir(), "orbit-bundle-"));
  dirs.push(d);
  mkdirSync(join(d, "skills"));
  writeFileSync(join(d, "AGENTS.md"), "be careful");
  writeFileSync(join(d, "skills", "a.md"), "x");
  symlinkSync("AGENTS.md", join(d, "link"));
  const first = bundleDigest(d);
  expect(bundleDigest(d)).toBe(first);
  writeFileSync(join(d, "skills", "a.md"), "y");
  expect(bundleDigest(d)).not.toBe(first);
  const m = { name: "a", agent: "codex", auth: "secret-profile", model: "m" } as never;
  const base = { authKind: "login", cliVersion: "1", bundleDigest: null };
  const r1 = revisionOf(methodBasis(m, base));
  expect(r1.revision).toMatch(/^[0-9a-f]{12}$/);
  expect(
    revisionOf(methodBasis({ ...(m as object), name: "b", auth: "other" } as never, base)),
  ).toEqual(r1);
  expect(revisionOf(methodBasis(m, { ...base, cliVersion: "2" })).revision).not.toBe(r1.revision);
  // An older job without a recorded revision gets an approximate one.
  const old = { spec: { methods: [m] }, revisions: {} } as never;
  expect(jobRevision(old, "a")).toMatchObject({ approximate: true });
  expect(
    jobRevision(
      { spec: { methods: [{ name: "e", agent: "empty" }] }, revisions: {} } as never,
      "e",
    ),
  ).toBeNull();
});

it("shows declared, wired and evidenced capabilities separately", () => {
  expect(wired(def("codex"), "mcp")).toBe(true);
  expect(wired(def("opencode"), "mcp")).toBe(false);
  expect(agentBlocker(def("opencode"), ["cli"], ["mcp"])).toMatch(/no MCP wiring/);
  expect(agentBlocker(def("opencode"), ["cli"], ["gui"])).toMatch(/needs Agent capabilities gui/);
  expect(agentBlocker(def("codex"), ["cli"], ["gui"])).toBeNull();
  expect(wired(def("codex"), "gui")).toBe(true);
  expect(agentBlocker(def("codex"), ["oracle", "empty"], [])).toMatch(/does not admit/);
  expect(agentBlocker(def("codex"), ["cli"], ["mcp"])).toBeNull();
});

const summary = (method: string, valid: number, trials = valid) =>
  ({
    method,
    trials,
    valid,
    invalid: trials - valid,
    unknown: 0,
    pending: 0,
    metrics: {},
  }) as never;
const job = (id: string, at: string, methods: object[], sums: unknown[], extra: object = {}) =>
  ({
    id,
    createdAt: at,
    state: "done",
    spec: {
      benchmark: "bfcl",
      tasks: ["t1", "t2"],
      methods: structuredClone(methods),
      seeds: 1,
      lineage: {},
      options: {},
    },
    revisions: {},
    capabilities: { requires: ["mcp"], methods: ["cli", "oracle", "empty"] },
    metrics: [],
    summary: sums,
    ...extra,
  }) as unknown as JobWithSummary;

it("builds the Agents page from jobs, profiles and auth tests", () => {
  const jobs = [
    job(
      "j1",
      "2026-11-06T01:00:00Z",
      [{ name: "c", agent: "codex", auth: "p" }],
      [summary("c", 3, 4)],
    ),
    job("j2", "2026-11-06T02:00:00Z", [{ name: "o", agent: "oracle" }], [summary("o", 2)], {
      spec: {
        benchmark: "bfcl",
        tasks: [],
        methods: [{ name: "o", agent: "oracle" }],
        calibration: {},
        lineage: {},
      },
    }),
    job(
      "j3",
      "2026-11-06T03:00:00Z",
      [{ name: "x", agent: "external", entrypoint: "pol:make" }],
      [summary("x", 1)],
    ),
  ];
  const profiles = [
    { name: "p", harness: "codex", kind: "login" },
    { name: "q", harness: "claude-code", kind: "api-key" },
  ] as AuthProfile[];
  const runs = [
    {
      id: "r1",
      state: "succeeded",
      endedAt: "2026-11-06T00:00:00Z",
      spec: { tags: { auth: "q" } },
    },
    { id: "r2", state: "failed", endedAt: "2026-11-06T04:00:00Z", spec: { tags: { auth: "q" } } },
  ] as unknown as Run[];
  const tests = authTests(runs, (r) => r.state === "succeeded");
  expect(tests.get("q")).toMatchObject({ ok: false, run: "r2" });
  const infos = ["codex", "claude-code", "opencode"].map((n) => ({
    definition: def(n),
    available: true,
    detail: "",
    version: null,
  }));
  const trial = { id: "j1.00002", endedAt: "2026-11-06T01:30:00Z" } as Trial;
  const c = agentCatalog(infos, jobs, profiles, tests, (j) => (j === "j1" ? trial : null));
  const codex = c.agents.find((a) => a.definition.name === "codex");
  expect(codex?.usage).toMatchObject({ jobs: 1, trials: 4, valid: 3, benchmarks: ["bfcl"] });
  expect(codex?.evidence).toMatchObject({ kind: "trial", ref: "j1.00002", benchmark: "bfcl" });
  expect(codex?.capabilities.mcp).toEqual({ declared: true, wired: true, evidence: true });
  expect(codex?.capabilities.gui).toEqual({ declared: true, wired: true, evidence: false });
  // The latest test of claude-code's profile failed and it never ran: no evidence.
  const claude = c.agents.find((a) => a.definition.name === "claude-code");
  expect(claude?.evidence).toBeNull();
  expect(claude?.profiles[0]?.test).toMatchObject({ ok: false });
  expect(c.agents.find((a) => a.definition.name === "opencode")?.capabilities.mcp).toEqual({
    declared: true,
    wired: false,
    evidence: false,
  });
  expect(c.external).toEqual([
    { entrypoint: "pol:make", benchmarks: ["bfcl"], jobs: 1, lastAt: "2026-11-06T03:00:00Z" },
  ]);
});

it("answers which Agent can take which benchmark by the submission checks", () => {
  const entry = (name: string, caps: object | null) =>
    ({ benchmark: { name }, capabilities: caps }) as unknown as CatalogEntry;
  const entries = [
    entry("bfcl", { methods: ["cli", "oracle"], requires: ["mcp"] }),
    entry("miniwob", { methods: ["cli", "empty"], requires: ["gui"] }),
    entry("humaneval", { methods: ["oracle", "empty", "external"], requires: [] }),
    entry("new", null),
  ];
  const jobs = [
    job(
      "j1",
      "2026-11-06T01:00:00Z",
      [{ name: "c", agent: "codex", auth: "p" }],
      [summary("c", 3, 4)],
    ),
  ];
  const m = compatibility([def("codex"), def("opencode"), def("claude-code")], entries, jobs, [
    { name: "p", harness: "codex", kind: "login" },
  ] as AuthProfile[]);
  const cell = (b: string, a: string) => m.rows.find((r) => r.benchmark === b)?.cells[a];
  expect(cell("bfcl", "codex")).toMatchObject({ state: "ran", valid: 3, trials: 4, job: "j1" });
  expect(cell("bfcl", "opencode")).toMatchObject({ state: "blocked" });
  expect(cell("bfcl", "claude-code")).toMatchObject({ state: "needs-auth" });
  expect(cell("miniwob", "codex")).toEqual({ state: "allowed" });
  expect(cell("miniwob", "opencode")).toMatchObject({
    state: "blocked",
    reason: expect.stringMatching(/gui/),
  });
  expect(cell("humaneval", "codex")?.reason).toMatch(/does not admit/);
  expect(cell("new", "codex")?.state).toBe("unknown");
});

it("lines up revisions of a method and compares each with its parent on the same benchmark", () => {
  const rev = (r: string) => ({
    revision: r,
    basis: {
      agent: "codex",
      model: null,
      effort: null,
      authKind: null,
      cliVersion: null,
      bundleDigest: null,
      entrypoint: null,
      config: null,
    },
    approximate: false,
  });
  const m = [{ name: "sol", agent: "codex", auth: "p" }];
  const a = job("a", "2026-11-06T01:00:00Z", m, [summary("sol", 2)], {
    revisions: { sol: rev("aaaaaaaaaaaa") },
  });
  const b = job("b", "2026-11-06T02:00:00Z", m, [summary("sol", 2)], {
    revisions: { sol: rev("bbbbbbbbbbbb") },
    spec: {
      benchmark: "bfcl",
      tasks: ["t1"],
      methods: m,
      seeds: 1,
      options: {},
      lineage: { sol: { parent: "aaaaaaaaaaaa", note: "retry tools", informedBy: ["a.00002"] } },
    },
  });
  const trial = (job: string, task: string, score: number) =>
    ({
      id: `${job}.${task}`,
      jobId: job,
      task,
      method: "sol",
      seed: 1,
      state: "done",
      outcome: {
        evaluation: "valid",
        score,
        maxScore: 1,
        execution: "succeeded",
        issues: [],
        cleanup: "done",
        review: null,
      },
      history: [],
    }) as unknown as Trial;
  const trials: Record<string, Trial[]> = {
    a: [trial("a", "t1", 0), trial("a", "t2", 1)],
    b: [trial("b", "t1", 1)],
  };
  const [line] = methodLines([b, a], (id) => trials[id] ?? []);
  expect(line?.name).toBe("sol");
  expect(line?.revisions.map((r) => r.revision)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
  const newer = line?.revisions[0];
  expect(newer?.lineage).toMatchObject({ parent: "aaaaaaaaaaaa", informedBy: ["a.00002"] });
  expect(newer?.results[0]?.versus).toMatchObject({
    revision: "aaaaaaaaaaaa",
    job: "a",
    pairedTasks: 1,
    subset: true,
  });
  expect(newer?.results[0]?.versus?.diff?.mean).toBe(100);
  expect(line?.revisions[1]?.results[0]?.versus).toBeNull();
});

it("hashes dereferenced bundle content and refuses cycles and oversized files before reading", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-bundle-links-"));
  dirs.push(root);
  const bundle = join(root, "bundle");
  const skills = join(root, "skills");
  mkdirSync(bundle);
  mkdirSync(skills);
  writeFileSync(join(skills, "instruction.md"), "first");
  symlinkSync(skills, join(bundle, "skills"));
  const first = bundleDigest(bundle);
  writeFileSync(join(skills, "instruction.md"), "second");
  expect(bundleDigest(bundle)).not.toBe(first);
  const content = bundleDigest(bundle);
  chmodSync(join(skills, "instruction.md"), 0o755);
  expect(bundleDigest(bundle)).not.toBe(content);
  symlinkSync(bundle, join(skills, "cycle"));
  expect(() => bundleDigest(bundle)).toThrow("symlink cycle");
  rmSync(join(skills, "cycle"));
  const fd = openSync(join(skills, "huge"), "w");
  ftruncateSync(fd, 65 * 1024 * 1024);
  closeSync(fd);
  expect(() => bundleDigest(bundle)).toThrow("over 64 MiB");
});

it("keeps historical evidence separate from current compatibility and links a valid job", () => {
  const d = def("codex");
  const entries = [
    { benchmark: { name: "bfcl" }, capabilities: { methods: ["cli"], requires: [] } },
  ] as unknown as CatalogEntry[];
  const m = [{ name: "c", agent: "codex", auth: "p" }];
  const jobs = [
    job("bad", "2026-11-06T02:00:00Z", m, [summary("c", 0, 1)]),
    job("good", "2026-11-06T01:00:00Z", m, [summary("c", 1)]),
  ];
  const profile = { name: "p", harness: "codex", kind: "api-key" } as AuthProfile;
  const cell = (definitions = [d], profiles = [profile]) =>
    compatibility(definitions, entries, jobs, profiles).rows[0]?.cells.codex;
  expect(cell()).toMatchObject({ state: "ran", job: "good", valid: 1 });
  expect(cell([d], [])).toMatchObject({ state: "needs-auth", job: "good", valid: 1 });
  expect(cell([{ ...d, auth: { ...d.auth, kinds: ["login"] } }])).toMatchObject({
    state: "needs-auth",
    job: "good",
  });
  const caps = entries[0]?.capabilities;
  if (!caps) throw new Error("fixture missing capabilities");
  caps.methods = ["oracle"];
  expect(cell()).toMatchObject({ state: "blocked", job: "good", valid: 1 });
});

function comparisonFixture() {
  const method = { name: "sol", agent: "codex", auth: "p", model: "m" };
  const methods = [method];
  const revision = (bundle: string) =>
    revisionOf(methodBasis(method, { authKind: "api-key", cliVersion: "1", bundleDigest: bundle }));
  const a = job("a", "2026-11-06T01:00:00Z", methods, [summary("sol", 2)], {
    revisions: { sol: revision("a") },
  });
  const b = job("b", "2026-11-06T02:00:00Z", methods, [summary("sol", 2)], {
    revisions: { sol: revision("b") },
  });
  const trial = (id: string, task: string, score: number) =>
    ({
      id: `${id}.${task}`,
      jobId: id,
      task,
      method: "sol",
      seed: 1,
      state: "done",
      solveRunId: null,
      verifyRunId: null,
      history: [],
      outcome: {
        evaluation: "valid",
        score,
        maxScore: 1,
        metrics: { latency: score * 10 },
        execution: "succeeded",
        issues: [],
        cleanup: "done",
        review: null,
      },
    }) as unknown as Trial;
  const trials = {
    a: [trial("a", "t1", 0), trial("a", "t2", 1)],
    b: [trial("b", "t1", 1), trial("b", "t2", 1)],
  };
  const read = (id: string) => trials[id as keyof typeof trials] ?? [];
  const newer = () => methodLines([a, b], read)[0]?.revisions[0]?.results[0];
  return { a, b, trials, read, newer };
}

it("compares only matching source and scoring conditions and identifies actual subsets", () => {
  const f = comparisonFixture();
  expect(f.newer()?.versus?.diff?.mean).toBe(50);
  expect(f.newer()?.metric.name).toBe("score");
  f.b.spec.options = { judge: "other" };
  expect(f.newer()?.versus).toBeNull();
  f.b.spec.options = {};
  f.a.source = { commit: "a", describe: null, dirty: false };
  f.b.source = { commit: "b", describe: null, dirty: false };
  expect(f.newer()?.versus).toBeNull();
  f.b.source = { ...f.a.source };
  expect(f.newer()?.versus).not.toBeNull();
  f.a.source.dirty = true;
  f.b.source.dirty = true;
  expect(f.newer()?.versus).toBeNull();
  f.a.source = f.b.source = null;
  f.b.spec.tasks = ["t1", "other"];
  expect(f.newer()?.versus?.subset).toBe(false);
  f.b.spec.tasks = ["t1"];
  expect(f.newer()?.versus?.subset).toBe(true);
  expect(f.newer()?.taskSet).not.toBe(
    methodLines([f.a], f.read)[0]?.revisions[0]?.results[0]?.taskSet,
  );
});

it("uses a named parent across method names without silently substituting another revision", () => {
  const f = comparisonFixture();
  const m = f.b.spec.methods[0];
  const revision = f.b.revisions.sol;
  const methodSummary = f.b.summary[0];
  if (!m || !revision || !methodSummary) throw new Error("missing fixture method");
  m.name = "derived";
  f.b.revisions.derived = revision;
  delete f.b.revisions.sol;
  methodSummary.method = "derived";
  for (const t of f.trials.b) t.method = "derived";
  f.b.spec.lineage.derived = { parent: f.a.revisions.sol?.revision, informedBy: [] };
  const result = () =>
    methodLines([f.a, f.b], f.read).find((l) => l.name === "derived")?.revisions[0]?.results[0];
  expect(result()?.versus).toMatchObject({ job: "a", method: "sol" });
  f.b.spec.lineage.derived.parent = "0123456789ab";
  expect(result()?.versus).toBeNull();
});

it("uses the selected metric and immutable report values for the report metric", () => {
  const f = comparisonFixture();
  f.a.metrics = f.b.metrics = [
    { name: "latency", label: "Latency", unit: "s", primary: true, higherIsBetter: false },
  ];
  const report = buildReport(f.b, f.trials.b, "finished", 3, f.b.createdAt);
  for (const j of [f.a, f.b]) j.summary = summarize(["sol"], f.read(j.id), j.metrics);
  const outcome = f.trials.b[0]?.outcome;
  if (!outcome) throw new Error("missing fixture outcome");
  outcome.metrics = { ...outcome.metrics, latency: 100 };
  f.b.summary = summarize(["sol"], f.trials.b, f.b.metrics);
  const reports = (id: string) => (id === "b" ? [report] : []);
  const primary = methodLines([f.a, f.b], f.read, reports)[0]?.revisions[0]?.results[0];
  expect(primary).toMatchObject({ metric: { name: "latency" }, reportRevision: 3 });
  expect(primary?.summary.metrics.latency?.mean).toBe(10);
  expect(primary?.versus?.diff?.mean).toBe(5);
  const score = methodLines([f.a, f.b], f.read, reports, "score")[0]?.revisions[0]?.results[0];
  expect(score).toMatchObject({ metric: { name: "score" }, reportRevision: null });
  expect(score?.versus?.diff?.mean).toBe(50);
  expect(score?.condition).toBe(primary?.condition);
  expect(score?.taskSet).toBe(primary?.taskSet);
});

it("requires equal resource overrides on shared tasks without rejecting compatible subsets", () => {
  const f = comparisonFixture();
  f.a.resources = { t1: { memGB: 2, timeoutMin: 10 }, t2: { memGB: 4 } };
  f.b.resources = { t1: { memGB: 2, timeoutMin: 10 } };
  f.b.spec.tasks = ["t1"];
  f.trials.b = f.trials.b.filter((t) => t.task === "t1");
  expect(f.newer()?.versus).toMatchObject({ subset: true, pairedTasks: 1 });
  f.b.resources.t1 = { memGB: 3, timeoutMin: 10 };
  expect(f.newer()?.versus).toBeNull();
  f.b.resources.t1 = { memGB: 2, timeoutMin: 20 };
  expect(f.newer()?.versus).toBeNull();
  f.b.resources.t1 = { timeoutMin: 10, memGB: 2 };
  expect(f.newer()?.versus).toMatchObject({ subset: true, pairedTasks: 1 });
});
