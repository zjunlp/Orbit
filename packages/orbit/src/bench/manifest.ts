// The `manifest` built-in adapter (design §9.14, L1): a benchmark described by `orbit-bench.yaml` —
// an image, how to list tasks, the run of each calibration/external method and where the result is —
// instead of an adapter program. It compiles to adapter protocol 1 like any other adapter.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type AdapterRequest,
  BenchCapabilities,
  BenchCategory,
  BenchIdentity,
  BenchTask,
  CalibrationExpect,
  FailureKind,
  legacySeed,
  MetricSpec,
  OfficialRule,
} from "../contracts/index.ts";
import type { AdapterHandlers, RunDescription, ScoreReply, TrialRequest } from "./adapter.ts";

export const MANIFEST_FILE = "orbit-bench.yaml";
const CONFIG_DIR = "/orbit-config";

const RelPath = z
  .string()
  .min(1)
  .refine(
    (p) => !isAbsolute(p) && !p.split(/[\\/]/).includes(".."),
    "a path inside the manifest directory",
  );
const ManifestMount = z.object({
  source: RelPath,
  target: z.string().startsWith("/"),
  mode: z.enum(["ro", "rw"]).default("ro"),
});
const ManifestRun = z
  .object({
    image: z.string().min(1),
    entrypoint: z.string().min(1),
    command: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()),
    resources: z.object({
      cpus: z.number().positive().optional(),
      memGB: z.number().positive().optional(),
      gpus: z.number().int().min(0).optional(),
      gpuMemGB: z.number().positive().optional(),
    }),
    network: z.boolean(),
    root: z.boolean(),
    timeoutMin: z.number().positive(),
    mounts: z.array(ManifestMount),
    /** Service containers (Orbit `ServiceSpec`s); `binds` sources are manifest-relative. */
    services: z.array(z.looseObject({ name: z.string() })),
  })
  .partial();
type ManifestRun = z.infer<typeof ManifestRun>;

/** `a.b[*].c[0]`: object keys, every array element, or one element. */
const Path = z
  .string()
  .regex(/^[A-Za-z_][\w-]*(\[(\*|\d+)\]|\.[A-Za-z_][\w-]*)*$/, "a path like a.b[*].c");
const Reduce = z.enum(["mean", "sum", "min", "max", "first", "last", "count", "all", "any"]);
const Selection = z.object({
  path: Path,
  reduce: Reduce.default("first"),
  scale: z.number().default(1),
});

const Manifest = z.object({
  version: z.literal(1),
  /** Default image of every run (a digest pins the conditions; a tag is recorded as mutable). */
  image: z.string().min(1),
  /** Integration category and profiles (docs/integration-categories.md). */
  category: BenchCategory.optional(),
  profiles: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  identity: BenchIdentity.optional(),
  calibration: CalibrationExpect.optional(),
  /**
   * Initial states (episodes) per task: a trial runs one, seed n is episode n-1 (`{{episode}}`), and
   * seeds beyond it are refused. Without it, seeds are repeats of the same task.
   */
  episodes: z.number().int().positive().max(100_000).optional(),
  kind: z.enum(["browser", "desktop", "mobile", "other"]).default("other"),
  scoreKind: BenchCapabilities.shape.scoreKind.default("scalar"),
  conditions: z.record(z.string().max(80), z.string().max(2000)).default({}),
  official: OfficialRule.optional(),
  metrics: z.array(MetricSpec).max(20).default([]),
  tasks: z.union([
    z.object({
      list: z.array(BenchTask.partial({ title: true, supported: true, reason: true })).min(1),
    }),
    z.object({
      /** Run in `image` without network; prints a JSON array of `{id, title?, tags?}` as its last `[` line. */
      command: z.array(z.string()).min(1),
      entrypoint: z.string().min(1).optional(),
      /** Per-task `{{...}}` of the listing command output turned into the task id (default `{{id}}`). */
      id: z.string().default("{{id}}"),
    }),
  ]),
  /** Files written into the trial's staging directory, mounted read-only at /orbit-config. */
  files: z.record(z.string().regex(/^[\w.-]+$/), z.string()).default({}),
  /** Settings every method's solve run starts from. */
  solve: ManifestRun.default({}),
  /** The methods this benchmark admits, each overriding `solve`. */
  methods: z
    .partialRecord(z.enum(["empty", "oracle", "external"]), ManifestRun)
    .refine((m) => Object.keys(m).length > 0, "declare at least one method"),
  result: z.object({
    /** File in the solve output, `*` matching within one path segment; the last match by name wins. */
    file: z.string().min(1),
    score: Selection,
    maxScore: z.number().positive().default(1),
    metrics: z.record(z.string(), Selection).default({}),
    /** Conditions that make a trial invalid (an environment fault, not the method's result). */
    invalid: z
      .array(
        z.object({
          path: Path,
          when: z.enum(["truthy", "present"]).default("truthy"),
          failure: FailureKind,
          issue: z.string().max(200),
        }),
      )
      .default([]),
    /** Values the result must record for this trial (e.g. the planned episode); else invalid. */
    expect: z.array(z.object({ path: Path, equals: z.string().max(200) })).default([]),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

export function loadManifest(benchmark: AdapterRequest["benchmark"]): { m: Manifest; dir: string } {
  const unknown = Object.keys(benchmark.config).filter((k) => k !== "manifest");
  if (unknown.length) throw new Error(`unknown manifest config: ${unknown.join(", ")}`);
  const file = benchmark.config.manifest
    ? resolve(benchmark.path, benchmark.config.manifest)
    : join(benchmark.path, MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`no ${relative(benchmark.path, file) || file} found`);
  const r = Manifest.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!r.success)
    throw new Error(
      `invalid manifest: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const caps = BenchCapabilities.safeParse(capabilities(r.data));
  if (!caps.success)
    throw new Error(`invalid manifest: ${caps.error.issues.map((i) => i.message).join("; ")}`);
  return { m: r.data, dir: dirname(file) };
}

/** Values selected by a path; missing keys select nothing. */
export function select(value: unknown, path: string): unknown[] {
  let cur: unknown[] = [value];
  for (const [, key, index] of path.matchAll(/\.?([A-Za-z_][\w-]*)|\[(\*|\d+)\]/g)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (key !== undefined) {
        if (v && typeof v === "object" && !Array.isArray(v) && key in v)
          next.push((v as Record<string, unknown>)[key]);
      } else if (Array.isArray(v)) {
        if (index === "*") next.push(...v);
        else if (Number(index) < v.length) next.push(v[Number(index)]);
      }
    }
    cur = next;
  }
  return cur;
}

export function reduce(values: unknown[], how: z.infer<typeof Reduce>): number | null {
  if (how === "count") return values.length;
  const truthy = (v: unknown) => Boolean(v) && !(Array.isArray(v) && v.length === 0);
  if (how === "all") return values.length ? (values.every(truthy) ? 1 : 0) : null;
  if (how === "any") return values.some(truthy) ? 1 : 0;
  const nums = values.map((v) => (typeof v === "boolean" ? Number(v) : v));
  if (!nums.length || !nums.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const xs = nums as number[];
  if (how === "first") return xs[0] as number;
  if (how === "last") return xs[xs.length - 1] as number;
  if (how === "sum" || how === "mean") {
    const s = xs.reduce((a, b) => a + b, 0);
    return how === "sum" ? s : s / xs.length;
  }
  return how === "min" ? Math.min(...xs) : Math.max(...xs);
}

/**
 * `{{a.b}}` in a string (`{{json:a.b}}` JSON-encodes the value); an argv element that is exactly
 * `{{argv:a.b}}` expands to that list (a JSON array string in a method's config is parsed).
 */
export function render(text: string, ctx: Record<string, unknown>): string {
  return text.replace(
    /\{\{\s*(json:)?([A-Za-z_][\w.-]*)\s*\}\}/g,
    (_m, json?: string, path = "") => {
      const v = lookup(ctx, path as string);
      return json ? JSON.stringify(v) : typeof v === "string" ? v : JSON.stringify(v);
    },
  );
}
function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let v: unknown = ctx;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object" || !(k in v))
      throw new Error(`unknown placeholder {{${path}}}`);
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
function renderArgv(argv: string[], ctx: Record<string, unknown>): string[] {
  return argv.flatMap((a) => {
    const m = /^\{\{\s*argv:([A-Za-z_][\w.-]*)\s*\}\}$/.exec(a);
    if (!m) return [render(a, ctx)];
    let v = lookup(ctx, m[1] as string);
    if (typeof v === "string") v = JSON.parse(v);
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
      throw new Error(`{{argv:${m[1]}}} is not a list of strings`);
    return v as string[];
  });
}
function renderDeep<T>(v: T, ctx: Record<string, unknown>): T {
  if (typeof v === "string") return render(v, ctx) as T;
  if (Array.isArray(v))
    return (
      v.every((x) => typeof x === "string")
        ? renderArgv(v as string[], ctx)
        : v.map((x) => renderDeep(x, ctx))
    ) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, ctx)])) as T;
  return v;
}

const inside = (dir: string, rel: string) => {
  const p = resolve(dir, rel);
  if (p !== dir && !p.startsWith(dir + sep))
    throw new Error(`${rel} leaves the manifest directory`);
  return p;
};

/** A path this user owns that is not a link (the listing cache lives in the shared temp dir). */
function owned(path: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st && !st.isSymbolicLink() && st.uid === process.getuid?.() ? st : null;
}

function listTasks(m: Manifest): BenchTask[] {
  if ("list" in m.tasks)
    return m.tasks.list.map((t) =>
      BenchTask.parse({ title: null, supported: true, reason: null, ...t }),
    );
  // Listed once per manifest and image (the adapter answers within Orbit's 120 s budget); the
  // listing container is labelled, limited and removed even when it overruns.
  const key = createHash("sha256")
    .update(JSON.stringify([m.image, m.tasks]))
    .digest("hex")
    .slice(0, 16);
  const cache = join(tmpdir(), `orbit-manifest-tasks-${process.getuid?.() ?? "u"}`, `${key}.json`);
  const cached = lstatSync(cache, { throwIfNoEntry: false })?.isFile()
    ? readFileSync(cache, "utf8")
    : null;
  if (cached) return (JSON.parse(cached) as unknown[]).map((t) => BenchTask.parse(t));
  const name = `orbit-manifest-tasks-${key}-${process.pid}`;
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--label",
    "orbit.manifest-tasks=1",
  ];
  args.push("--cpus", "2", "--memory", "4g");
  if (m.tasks.entrypoint) args.push("--entrypoint", m.tasks.entrypoint);
  const r = spawnSync("docker", [...args, m.image, ...m.tasks.command], {
    encoding: "utf8",
    timeout: 100_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    spawnSync("docker", ["rm", "-f", name], { timeout: 20_000 });
    throw new Error(
      `listing tasks failed${r.error ? " (timed out; pull the image first)" : ""}: ${(r.stderr || r.error?.message || "").trim().split("\n").pop()}`,
    );
  }
  const line = r.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("["));
  if (!line) throw new Error("the task listing printed no JSON array");
  const idTemplate = m.tasks.id;
  const tasks = (JSON.parse(line) as Record<string, unknown>[]).map((row) =>
    BenchTask.parse({
      id: render(idTemplate, row),
      title: typeof row.title === "string" && row.title ? row.title : null,
      supported: true,
      reason: null,
      tags: Object.fromEntries(
        Object.entries(row.tags ?? row).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
    }),
  );
  mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  if (owned(dirname(cache))?.isDirectory() && !lstatSync(cache, { throwIfNoEntry: false }))
    writeFileSync(cache, JSON.stringify(tasks), { mode: 0o600, flag: "wx" });
  return tasks;
}

/** The episode a trial runs (seed n → n-1), refusing seeds the benchmark has no episode for. */
export function episodeOf(m: Manifest, seed: number): number {
  if (m.episodes && (seed < 1 || seed > m.episodes))
    throw new Error(
      `seed ${seed} has no episode: this benchmark has episodes 1..${m.episodes} per task`,
    );
  return seed - 1;
}

function capabilities(m: Manifest) {
  return {
    ...(m.category ? { category: m.category } : {}),
    profiles: m.profiles,
    domains: m.domains,
    ...(m.identity ? { identity: m.identity } : {}),
    ...(m.calibration ? { calibration: m.calibration } : {}),
    kind: m.kind,
    methods: Object.keys(m.methods),
    scoreKind: m.scoreKind,
    rescore: "evidence" as const,
    requires: [],
    conditions: {
      Image: m.image,
      ...(m.image.includes("@sha256:") ? {} : { "Image pin": "mutable tag (not a digest)" }),
      ...m.conditions,
    },
  };
}

function resultFiles(out: string, pattern: string): string[] {
  const parts = pattern.split("/");
  let dirs = [out];
  for (const part of parts) {
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    const next: string[] = [];
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(d).sort();
      } catch {}
      for (const n of names) {
        if (!re.test(n)) continue;
        // The run wrote this tree: follow no links out of it.
        const st = lstatSync(join(d, n), { throwIfNoEntry: false });
        if (st && (st.isFile() || st.isDirectory())) next.push(join(d, n));
      }
    }
    dirs = next;
  }
  return dirs;
}

/** The trial's result from the files a run left, as protocol 1's score reply. */
export function readResult(
  m: Manifest,
  out: string,
  ctx: Record<string, unknown> = {},
): ScoreReply & { file: string | null } {
  const files = resultFiles(out, m.result.file);
  const file = files.filter((f) => lstatSync(f).isFile()).pop() ?? null;
  const several =
    files.length > 1
      ? [`${files.length} files match ${m.result.file}; the last by name is used`]
      : [];
  const fail = (issue: string, failure: FailureKind = "scorer_error") => ({
    score: null,
    maxScore: m.result.maxScore,
    invalid: true,
    failure,
    issues: [issue],
    file,
  });
  if (!file) return fail(`no result file matching ${m.result.file}`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fail("the result file is not valid JSON");
  }
  for (const rule of m.result.invalid) {
    const vs = select(doc, rule.path);
    if (rule.when === "present" ? vs.length > 0 : reduce(vs, "any") === 1)
      return fail(rule.issue, rule.failure);
  }
  for (const e of m.result.expect) {
    const want = render(e.equals, ctx);
    const got = select(doc, e.path);
    if (got.length !== 1 || String(got[0]) !== want)
      return fail(
        `the result records ${e.path} = ${got.map(String).join(", ") || "nothing"}, planned ${want}`,
      );
  }
  // A missing score is the grader's problem, never a 0 (count/any would otherwise give 0).
  const picked = select(doc, m.result.score.path);
  const s = picked.length ? reduce(picked, m.result.score.reduce) : null;
  if (s === null) return fail(`no numeric score at ${m.result.score.path}`);
  const metrics: Record<string, number> = {};
  for (const [k, sel] of Object.entries(m.result.metrics)) {
    const v = reduce(select(doc, sel.path), sel.reduce);
    if (v !== null) metrics[k] = v * sel.scale;
  }
  return {
    score: s * m.result.score.scale,
    maxScore: m.result.maxScore,
    invalid: false,
    issues: several,
    metrics,
    file,
  };
}

/** What `result.expect` templates see: the trial's task, seed, episode and options. */
function resultContext(m: Manifest, trial: TrialRequest["trial"]): Record<string, unknown> {
  return {
    task: listTasks(m).find((t) => t.id === trial.task),
    seed: legacySeed(trial),
    episode: episodeOf(m, legacySeed(trial)),
    option: trial.options,
  };
}

export const manifestAdapter: AdapterHandlers = {
  tasks: (req) => listTasks(loadManifest(req.benchmark).m),
  info: (req, _tasks) => {
    const { m } = loadManifest(req.benchmark);
    return {
      metrics: m.metrics,
      capabilities: capabilities(m),
      ...(m.official ? { official: m.official } : {}),
    };
  },
  solve: ({ benchmark, trial }) => {
    const { m, dir } = loadManifest(benchmark);
    const method = m.methods[trial.method.agent as keyof Manifest["methods"]];
    if (!method)
      throw new Error(`${benchmark.name} does not declare a ${trial.method.agent} method`);
    const task = listTasks(m).find((t) => t.id === trial.task);
    if (!task) throw new Error(`task not found: ${trial.task}`);
    const ctx = {
      task,
      seed: legacySeed(trial),
      episode: episodeOf(m, legacySeed(trial)),
      option: trial.options,
      method: {
        name: trial.method.name,
        agent: trial.method.agent,
        entrypoint: trial.method.entrypoint ?? "",
        config: trial.method.config ?? {},
      },
    };
    // Methods override solve per key; resources and env merge, so a method's GPU keeps solve's CPUs.
    const merged: ManifestRun = {
      ...m.solve,
      ...method,
      resources: { ...m.solve.resources, ...method.resources },
      env: { ...m.solve.env, ...method.env },
    };
    const run = renderDeep(merged, ctx);
    if (!run.command) throw new Error(`the ${trial.method.agent} method has no command`);
    mkdirSync(trial.staging, { recursive: true });
    for (const [name, text] of Object.entries(m.files))
      writeFileSync(join(trial.staging, name), render(text, ctx), { mode: 0o644 });
    const mounts = [
      ...(Object.keys(m.files).length
        ? [{ source: trial.staging, target: CONFIG_DIR, mode: "ro" as const }]
        : []),
      ...(run.mounts ?? []).map((x) => ({ ...x, source: inside(dir, x.source) })),
    ];
    const services = (run.services ?? []).map((s) => ({
      ...s,
      ...(Array.isArray(s.binds)
        ? {
            binds: (s.binds as { source: string }[]).map((b) => ({
              ...b,
              source: inside(dir, RelPath.parse(b.source)),
            })),
          }
        : {}),
    }));
    const spec: RunDescription = {
      image: run.image ?? m.image,
      command: run.command,
      ...(run.entrypoint ? { entrypoint: run.entrypoint } : {}),
      env: run.env ?? {},
      resources: { cpus: 2, memGB: 4, gpus: 0, ...run.resources },
      network: run.network ?? false,
      ...(run.root ? { root: true } : {}),
      timeoutMin: trial.timeoutMin ?? run.timeoutMin ?? 30,
      mounts,
      ...(services.length ? { services: services as RunDescription["services"] } : {}),
    };
    return {
      spec,
      issues: m.image.includes("@sha256:") ? [] : [`image ${m.image} is a mutable tag`],
    };
  },
  verify: ({ benchmark, trial, solve }) => {
    const { m } = loadManifest(benchmark);
    const file = readResult(m, solve.output, resultContext(m, trial)).file;
    if (!file) throw new Error(`the solve run left no result matching ${m.result.file}`);
    const rel = relative(solve.output, file);
    // An independent copy of the result taken after the solve run ended (what rescore reads).
    return {
      spec: {
        image: m.image,
        entrypoint: "/bin/sh",
        command: [
          "-c",
          'mkdir -p "$ORBIT_OUTPUT/result" && cp "/solve/$1" "$ORBIT_OUTPUT/result/"',
          "sh",
          rel,
        ],
        mounts: [{ source: solve.output, target: "/solve", mode: "ro" }],
        network: false,
        resources: { cpus: 1, memGB: 1, gpus: 0 },
        timeoutMin: 5,
      },
    };
  },
  score: ({ benchmark, trial, solve, verify }) => {
    const { m } = loadManifest(benchmark);
    const r = readResult(m, solve.output, resultContext(m, trial));
    const copy = r.file ? join(verify.output, "result", r.file.split(sep).pop() as string) : null;
    const { file, ...reply } = r;
    const review = {
      files: file
        ? [
            {
              label: "Result",
              phase: "solve" as const,
              kind: "json",
              path: relative(solve.output, file),
            },
          ]
        : [],
      items: [],
      details: {},
    };
    if (
      file &&
      (!copy || !existsSync(copy) || readFileSync(copy, "utf8") !== readFileSync(file, "utf8"))
    )
      return {
        score: null,
        maxScore: m.result.maxScore,
        invalid: true,
        failure: "scorer_error",
        issues: ["the verified copy of the result differs from the solve output"],
        review,
      };
    return { ...reply, review };
  },
};
