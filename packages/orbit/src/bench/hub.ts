// The Web's Agents, compatibility and Methods views (design §9.16), built from the store and the
// Agent registry. Pure functions over what the service hands in; nothing here writes state.
import {
  type AgentCapabilities,
  type AgentCatalogEntry,
  type AgentDefinition,
  type AgentInfo,
  type AuthProfile,
  type BenchCompatibility,
  type BenchJob,
  type BenchReport,
  type CatalogEntry,
  type CompatibilityCell,
  capabilityAllows,
  type ExternalMethodEntry,
  isAgentMethod,
  isCliMethod,
  type MethodLine,
  type MethodRevision,
  type MethodRevisionEntry,
  type MethodSummary,
  type Run,
  type Trial,
} from "../contracts/index.ts";
import { pairedDiff, primaryMetric, resolveMetrics, taskMeans } from "../contracts/metrics.ts";
import { asiMethodProblem } from "./asi.ts";
import { executionCapabilities, methodBasis, revisionOf, stableDigest } from "./revision.ts";
import { planDigest } from "./summary.ts";

export type JobWithSummary = BenchJob & { summary: MethodSummary[] };
type Cap = keyof AgentCapabilities;

/** Why an Agent cannot take a benchmark with these requirements (core of submission checks), or null. */
export function agentBlocker(
  def: AgentDefinition,
  methods: readonly string[] | undefined,
  requires: readonly Cap[],
): string | null {
  if (methods && !capabilityAllows(methods, def.name))
    return "the benchmark does not admit CLI Agents";
  if (
    (requires.includes("mcp") || (requires.includes("gui") && def.capabilities.gui)) &&
    def.command.mcp.kind === "none"
  )
    return `this benchmark requires MCP tool wiring, but ${def.name} has no MCP wiring`;
  const lacking = requires.filter((k) => !def.capabilities[k]);
  if (lacking.length)
    return `this benchmark needs Agent capabilities ${lacking.join(", ")}, which ${def.name} does not declare`;
  return null;
}

/** Whether Orbit can deliver a capability to the Agent in a container. */
export function wired(def: AgentDefinition, cap: Cap): boolean {
  if (!def.capabilities[cap]) return false;
  if (cap === "mcp" || cap === "gui") return def.command.mcp.kind !== "none";
  if (cap === "multiTurn") return Boolean(def.command.resume?.length) || def.capabilities.multiTurn;
  return true;
}

interface Usage {
  jobs: number;
  trials: number;
  valid: number;
  benchmarks: Set<string>;
  lastAt: string | null;
  /** The newest job with a valid trial, and the capabilities its benchmark required. */
  evidenceJob: JobWithSummary | null;
  evidenced: Set<Cap>;
}

function usageByAgent(jobs: JobWithSummary[]): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const j of jobs) {
    if (j.spec.calibration) continue;
    for (const m of j.spec.methods) {
      if (!isCliMethod(m)) continue;
      const s = j.summary.find((x) => x.method === m.name);
      const u = out.get(m.agent) ?? {
        jobs: 0,
        trials: 0,
        valid: 0,
        benchmarks: new Set<string>(),
        lastAt: null,
        evidenceJob: null,
        evidenced: new Set<Cap>(),
      };
      u.jobs++;
      u.trials += s?.trials ?? 0;
      u.valid += s?.valid ?? 0;
      u.benchmarks.add(j.spec.benchmark);
      if (!u.lastAt || j.createdAt > u.lastAt) u.lastAt = j.createdAt;
      if ((s?.valid ?? 0) > 0) {
        if (!u.evidenceJob || j.createdAt > u.evidenceJob.createdAt) u.evidenceJob = j;
        u.evidenced.add("oneShot");
        for (const r of j.capabilities?.requires ?? []) u.evidenced.add(r);
      }
      out.set(m.agent, u);
    }
  }
  return out;
}

/** The latest auth test per profile (runs of the `auth-test` group, tagged with the profile). */
export function authTests(runs: Run[], passed: (r: Run) => boolean) {
  const out = new Map<string, { ok: boolean; at: string; run: string }>();
  for (const r of runs) {
    const name = r.spec.tags.auth;
    if (!name || !r.endedAt) continue;
    const prev = out.get(name);
    if (prev && prev.at >= r.endedAt) continue;
    out.set(name, { ok: passed(r), at: r.endedAt, run: r.id });
  }
  return out;
}

export function agentCatalog(
  infos: AgentInfo[],
  jobs: JobWithSummary[],
  profiles: AuthProfile[],
  tests: Map<string, { ok: boolean; at: string; run: string }>,
  /** A valid trial id of a job and method, for the evidence link. */
  validTrial: (job: string, agent: string) => Trial | null,
): { agents: AgentCatalogEntry[]; external: ExternalMethodEntry[] } {
  const usage = usageByAgent(jobs);
  const agents = infos.map((info): AgentCatalogEntry => {
    const def = info.definition;
    const u = usage.get(def.name);
    const own = profiles.filter((p) => p.harness === def.name);
    const state = (cap: Cap) => ({
      declared: def.capabilities[cap],
      wired: wired(def, cap),
      evidence: Boolean(u?.evidenced.has(cap)),
    });
    const trial = u?.evidenceJob ? validTrial(u.evidenceJob.id, def.name) : null;
    const test = own
      .map((p) => tests.get(p.name))
      .filter((t) => t?.ok)
      .sort((a, b) => ((a?.at ?? "") < (b?.at ?? "") ? 1 : -1))[0];
    const evidence =
      trial && u?.evidenceJob
        ? {
            kind: "trial" as const,
            at: trial.endedAt ?? u.evidenceJob.createdAt,
            ref: trial.id,
            job: u.evidenceJob.id,
            benchmark: u.evidenceJob.spec.benchmark,
          }
        : test
          ? { kind: "auth-test" as const, at: test.at, ref: test.run, detail: "the model replied" }
          : null;
    return {
      definition: def,
      available: info.available,
      detail: info.detail,
      version: info.version,
      capabilities: {
        oneShot: state("oneShot"),
        multiTurn: state("multiTurn"),
        mcp: state("mcp"),
        gui: state("gui"),
      },
      profiles: own.map((p) => ({ name: p.name, kind: p.kind, test: tests.get(p.name) ?? null })),
      evidence,
      usage: {
        jobs: u?.jobs ?? 0,
        trials: u?.trials ?? 0,
        valid: u?.valid ?? 0,
        benchmarks: [...(u?.benchmarks ?? [])].sort(),
        lastAt: u?.lastAt ?? null,
      },
    };
  });
  const ext = new Map<string, ExternalMethodEntry>();
  for (const j of jobs)
    for (const m of j.spec.methods) {
      if (m.agent !== "external" || !m.entrypoint) continue;
      const e = ext.get(m.entrypoint) ?? {
        entrypoint: m.entrypoint,
        benchmarks: [],
        jobs: 0,
        lastAt: j.createdAt,
      };
      e.jobs++;
      if (!e.benchmarks.includes(j.spec.benchmark)) e.benchmarks.push(j.spec.benchmark);
      if (j.createdAt > e.lastAt) e.lastAt = j.createdAt;
      ext.set(m.entrypoint, e);
    }
  return { agents, external: [...ext.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)) };
}

/** Agent × benchmark: what a submission would say, and what already ran. */
export function compatibility(
  defs: AgentDefinition[],
  entries: CatalogEntry[],
  jobs: JobWithSummary[],
  profiles: AuthProfile[],
): BenchCompatibility {
  const rows = entries.map((e) => {
    const caps = e.capabilities;
    const cells: Record<string, CompatibilityCell> = {};
    for (const def of defs) {
      const ran = jobs
        .filter((j) => j.spec.benchmark === e.benchmark.name && !j.spec.calibration)
        .flatMap((j) =>
          j.spec.methods
            .filter((m) => m.agent === def.name)
            .map((m) => ({ j, s: j.summary.find((x) => x.method === m.name) })),
        );
      const valid = ran.reduce((n, r) => n + (r.s?.valid ?? 0), 0);
      const latest = ran
        .filter((r) => (r.s?.valid ?? 0) > 0)
        .sort((a, b) => b.j.createdAt.localeCompare(a.j.createdAt))[0];
      const evidence =
        valid > 0
          ? {
              valid,
              trials: ran.reduce((n, r) => n + (r.s?.trials ?? 0), 0),
              job: latest?.j.id,
            }
          : {};
      const native = e.benchmark.adapter === "asi" ? asiMethodProblem({ agent: def.name }) : null;
      if (native) {
        cells[def.name] = { ...evidence, state: "blocked", reason: native };
      } else if (!caps) {
        cells[def.name] = {
          ...evidence,
          state: "unknown",
          reason: "the task listing is not available yet",
        };
      } else {
        const why = agentBlocker(def, caps.methods, caps.requires);
        if (why) cells[def.name] = { ...evidence, state: "blocked", reason: why };
        else if (!profiles.some((p) => p.harness === def.name && def.auth.kinds.includes(p.kind)))
          cells[def.name] = {
            ...evidence,
            state: "needs-auth",
            reason: `no compatible auth profile for ${def.name}`,
          };
        else cells[def.name] = { ...evidence, state: valid > 0 ? "ran" : "allowed" };
      }
    }
    return { benchmark: e.benchmark.name, cells };
  });
  return { agents: defs.map((d) => d.name), rows };
}

/** A job's revision of a method: recorded at submission, else computed from what the job kept. */
export function jobRevision(j: BenchJob, method: string): MethodRevision | null {
  const recorded = j.revisions[method];
  if (recorded) return recorded;
  const m = j.spec.methods.find((x) => x.name === method);
  if (!m || !isAgentMethod(m)) return null;
  return revisionOf(methodBasis(m, { authKind: null, cliVersion: null, bundleDigest: null }), true);
}

/** Source and scoring conditions must match before a method change can be compared. */
export function comparisonCondition(j: BenchJob): string {
  const b = j.benchmarkSnapshot;
  return stableDigest({
    benchmark: j.spec.benchmark,
    source: j.source ?? null,
    // A dirty flag has no content digest, so different dirty checkouts cannot be equated.
    dirtyJob: j.source?.dirty ? j.id : null,
    benchmarkSettings: b
      ? {
          adapter: b.adapter,
          path: b.path,
          config: b.config,
          env: b.env,
          passEnv: b.passEnv,
        }
      : null,
    capabilities: executionCapabilities(j.capabilities) ?? null,
    options: j.spec.options,
    seeds: j.spec.seeds,
    timeoutMin: j.spec.timeoutMin,
    metrics: resolveMetrics(j.metrics),
    official: j.official ?? null,
  });
}

/** Method revisions and comparable results, preferring immutable report evidence when available. */
export function methodLines(
  jobs: JobWithSummary[],
  trialsOf: (job: string) => Trial[],
  reportsOf: (job: string) => BenchReport[] = () => [],
  selectedMetric?: string,
): MethodLine[] {
  const lines = new Map<string, Map<string, MethodRevisionEntry>>();
  const agents = new Map<string, Set<string>>();
  const records = new Map<
    string,
    {
      tasks: Set<string>;
      means: ReturnType<typeof taskMeans>;
      resources: BenchJob["resources"];
    }
  >();
  const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const j of ordered) {
    if (j.spec.calibration) continue;
    const metrics = resolveMetrics(j.metrics);
    const metric = metrics.find((m) => m.name === selectedMetric) ?? primaryMetric(metrics);
    const report = reportsOf(j.id)
      .filter((r) => r.metric === metric.name && r.planDigest === planDigest(j))
      .at(-1);
    const condition = comparisonCondition(j);
    let trials: Trial[] | undefined;
    for (const m of j.spec.methods) {
      const rev = jobRevision(j, m.name);
      const live = j.summary.find((s) => s.method === m.name);
      if (!rev || !live) continue;
      const saved = report?.methods.find((r) => r.method === m.name);
      const summary: MethodSummary = saved
        ? {
            method: m.name,
            trials: saved.planned,
            valid: saved.valid,
            invalid: saved.invalid,
            unknown: saved.unknown,
            pending: saved.planned - saved.completed,
            metrics: { [metric.name]: saved.orbit },
            ...(saved.official ? { official: saved.official } : {}),
          }
        : live;
      const tasks = new Set(saved ? saved.entries.map((e) => e.task) : j.spec.tasks);
      if (!saved && !trials) trials = trialsOf(j.id);
      const means = saved
        ? taskMeans(
            saved.entries
              .filter((e) => e.evaluation === "valid")
              .map((e) => ({
                task: e.task,
                outcome:
                  e.value === null
                    ? null
                    : { score: null, maxScore: 1, metrics: { saved: e.value } },
              })),
            "saved",
          )
        : taskMeans(
            (trials ?? []).filter((t) => t.method === m.name && t.outcome?.evaluation === "valid"),
            metric.name,
          );
      records.set(`${j.id}/${m.name}`, { tasks, means, resources: j.resources });
      const line = lines.get(m.name) ?? new Map<string, MethodRevisionEntry>();
      const entry = line.get(rev.revision) ?? {
        revision: rev.revision,
        basis: rev.basis,
        approximate: rev.approximate,
        lineage: j.spec.lineage[m.name] ?? null,
        firstAt: j.createdAt,
        results: [],
      };
      if (!entry.lineage && j.spec.lineage[m.name]) entry.lineage = j.spec.lineage[m.name] ?? null;
      entry.results.push({
        benchmark: j.spec.benchmark,
        job: j.id,
        method: m.name,
        at: j.createdAt,
        tasks: tasks.size,
        taskSet: stableDigest([...tasks].sort()),
        condition,
        metric,
        metrics,
        reportRevision: saved && report ? report.revision : null,
        summary,
        versus: null,
      });
      line.set(rev.revision, entry);
      lines.set(m.name, line);
      agents.set(m.name, (agents.get(m.name) ?? new Set()).add(m.agent));
    }
  }
  const all = [...lines.values()].flatMap((revs) => [...revs.values()]);
  return [...lines].map(([name, revs]) => {
    const list = [...revs.values()];
    for (const entry of list) {
      for (const r of entry.results) {
        const parent = entry.lineage?.parent;
        const candidates = parent
          ? all.filter((x) => x.revision === parent)
          : list.filter((x) => x.revision !== entry.revision);
        const earlier = candidates
          .flatMap((x) => x.results.map((res) => ({ x, res })))
          .filter(
            ({ res }) =>
              res.benchmark === r.benchmark && res.condition === r.condition && res.at < r.at,
          )
          .sort((a, b) => b.res.at.localeCompare(a.res.at));
        const current = records.get(`${r.job}/${r.method}`);
        if (!current) continue;
        for (const pick of earlier) {
          const previous = records.get(`${pick.res.job}/${pick.res.method}`);
          if (!previous) continue;
          const resourceMismatch = [...current.tasks].some(
            (task) =>
              previous.tasks.has(task) &&
              stableDigest(current.resources?.[task] ?? {}) !==
                stableDigest(previous.resources?.[task] ?? {}),
          );
          if (resourceMismatch) continue;
          const diff = pairedDiff(previous.means, current.means);
          if (!diff) continue;
          r.versus = {
            revision: pick.x.revision,
            job: pick.res.job,
            method: pick.res.method,
            pairedTasks: diff.tasks,
            diff,
            subset:
              current.tasks.size < previous.tasks.size &&
              [...current.tasks].every((t) => previous.tasks.has(t)),
          };
          break;
        }
      }
    }
    return {
      name,
      agents: [...(agents.get(name) ?? [])].sort(),
      revisions: list.sort((a, b) => b.firstAt.localeCompare(a.firstAt)),
    };
  });
}
