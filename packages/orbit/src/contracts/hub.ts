// What the Web's Agents and Methods pages show (design §9.16): every Agent with what it can do and
// the evidence for it, which Agent can take which benchmark, and method revisions with their results.
import { z } from "zod";
import { AgentDefinition } from "./agent.ts";
import { MethodBasis, MethodLineage, MethodSummary, MetricSpec, MetricStat } from "./bench.ts";

/** A capability as declared, as wired into containers, and as shown by a real run. */
export const CapabilityState = z.object({
  declared: z.boolean(),
  /** Orbit can deliver it (MCP servers written into the Agent's config, GUI bridge present). */
  wired: z.boolean(),
  /** A valid trial of a benchmark that requires it. */
  evidence: z.boolean(),
});
export type CapabilityState = z.infer<typeof CapabilityState>;

const Evidence = z.object({
  kind: z.enum(["trial", "auth-test"]),
  at: z.string(),
  /** Trial (`job.n`) or run id. */
  ref: z.string(),
  job: z.string().optional(),
  benchmark: z.string().optional(),
  detail: z.string().optional(),
});

export const AgentCatalogEntry = z.object({
  definition: AgentDefinition,
  available: z.boolean(),
  detail: z.string(),
  version: z.string().nullable(),
  capabilities: z.object({
    oneShot: CapabilityState,
    multiTurn: CapabilityState,
    mcp: CapabilityState,
    gui: CapabilityState,
  }),
  profiles: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      /** The latest auth test run of this profile, if any. */
      test: z.object({ ok: z.boolean(), at: z.string(), run: z.string() }).nullable(),
    }),
  ),
  /** The latest real-run evidence on this node: a valid trial, else a passed auth test. */
  evidence: Evidence.nullable(),
  usage: z.object({
    jobs: z.number().int(),
    trials: z.number().int(),
    valid: z.number().int(),
    benchmarks: z.array(z.string()),
    lastAt: z.string().nullable(),
  }),
});
export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntry>;

/** External policies (adapter-owned entrypoints) that jobs have used. */
export const ExternalMethodEntry = z.object({
  entrypoint: z.string(),
  benchmarks: z.array(z.string()),
  jobs: z.number().int(),
  lastAt: z.string(),
});
export type ExternalMethodEntry = z.infer<typeof ExternalMethodEntry>;

export const AgentCatalog = z.object({
  agents: z.array(AgentCatalogEntry),
  external: z.array(ExternalMethodEntry),
});
export type AgentCatalog = z.infer<typeof AgentCatalog>;

/**
 * Whether an Agent can take a benchmark, by the checks a submission makes: `ran` (valid trials),
 * `allowed`, `needs-auth` (allowed, but no profile), `blocked` (with why), `unknown` (no listing).
 */
export const CompatibilityCell = z.object({
  state: z.enum(["ran", "allowed", "needs-auth", "blocked", "unknown"]),
  reason: z.string().optional(),
  valid: z.number().int().optional(),
  trials: z.number().int().optional(),
  job: z.string().optional(),
});
export type CompatibilityCell = z.infer<typeof CompatibilityCell>;
export const BenchCompatibility = z.object({
  agents: z.array(z.string()),
  rows: z.array(
    z.object({ benchmark: z.string(), cells: z.record(z.string(), CompatibilityCell) }),
  ),
});
export type BenchCompatibility = z.infer<typeof BenchCompatibility>;

/** One revision of a method line (a method name), with its results per benchmark. */
export const MethodRevisionEntry = z.object({
  revision: z.string(),
  basis: MethodBasis,
  approximate: z.boolean(),
  lineage: MethodLineage.nullable(),
  firstAt: z.string(),
  results: z.array(
    z.object({
      benchmark: z.string(),
      job: z.string(),
      method: z.string(),
      at: z.string(),
      tasks: z.number().int(),
      /** Same benchmark source, execution conditions, seeds and scoring rule. */
      condition: z.string(),
      taskSet: z.string(),
      metrics: z.array(MetricSpec),
      metric: MetricSpec,
      reportRevision: z.number().int().positive().nullable(),
      summary: MethodSummary,
      /** Against the previous revision on this benchmark (its parent, else the one before). */
      versus: z
        .object({
          revision: z.string(),
          job: z.string(),
          method: z.string(),
          pairedTasks: z.number().int(),
          diff: MetricStat.nullable(),
          /** This result covers fewer tasks than the one it is compared with. */
          subset: z.boolean(),
        })
        .nullable(),
    }),
  ),
});
export type MethodRevisionEntry = z.infer<typeof MethodRevisionEntry>;
export const MethodLine = z.object({
  name: z.string(),
  agents: z.array(z.string()),
  revisions: z.array(MethodRevisionEntry),
});
export type MethodLine = z.infer<typeof MethodLine>;
export const MethodList = z.object({ methods: z.array(MethodLine) });
export type MethodList = z.infer<typeof MethodList>;
