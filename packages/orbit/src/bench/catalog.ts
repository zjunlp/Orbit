// The catalog page (design §9.15): one entry per registered benchmark, from its cached task
// listing, its calibration jobs and the real methods its jobs ran. Pure; the service caches the
// listings and reads the store.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AdapterTasksResponse,
  type BenchCapabilities,
  type BenchIdentity,
  type BenchJob,
  type Benchmark,
  type BenchTask,
  type BenchTaxonomy,
  benchCoverage,
  type CalibrationReport,
  type CatalogEntry,
  type CatalogMethod,
  isAgentMethod,
  type Method,
  type MethodSummary,
  splitDomains,
  TAXONOMY_VALUES,
  type TaxonomyField,
} from "../contracts/index.ts";
import { methodBasis, revisionOf, stableDigest } from "./revision.ts";
import { contentDigest } from "./samples.ts";

export interface Listing {
  at: string | null;
  data: AdapterTasksResponse | null;
  error: string | null;
  refreshing: boolean;
}

/** What makes two methods of different jobs the same method. */
export function methodKey(m: Method): string {
  if (m.agent === "policy")
    return `policy · ${m.policyRef ?? "?"}@${m.policySnapshot?.version ?? "?"} · ${contentDigest(m.policySnapshot ?? {}).slice(7, 23)}`;
  if (m.agent === "external") return `external · ${m.entrypoint ?? "?"}`;
  return [m.agent, m.model ?? "default model", m.effort].filter(Boolean).join(" · ");
}

export function catalogListing(at: string, data: AdapterTasksResponse): CatalogEntry["listing"] {
  const tagged = data.tasks.filter((t) => t.tags.oracle !== undefined);
  return {
    at,
    capabilities: data.capabilities ?? null,
    metrics: data.metrics ?? [],
    official: data.official ?? null,
    coverage: benchCoverage(data.tasks),
    oracleTasks: tagged.length
      ? tagged.filter((t) => t.supported && t.tags.oracle === "full").length
      : null,
  };
}

/**
 * What benchmark a registration is: its own labels, else its adapter's declaration, else its
 * adapter and data path (design §9.16).
 */
export function benchIdentity(
  b: Benchmark,
  caps: BenchCapabilities | null,
): { identity: BenchIdentity; source: "label" | "adapter" | "derived" } {
  if (b.labels?.identity) return { identity: b.labels.identity, source: "label" };
  if (caps?.identity) return { identity: caps.identity, source: "adapter" };
  let path = resolve(b.path);
  try {
    path = realpathSync(path);
  } catch {}
  return {
    identity: { id: `derived-${stableDigest([b.adapter, path])}`, name: b.name },
    source: "derived",
  };
}

/** Domains and tags: the registration's labels replace the adapter's declaration. */
export function benchDomains(b: Benchmark, caps: BenchCapabilities | null) {
  return splitDomains(b.labels?.domains ?? caps?.domains ?? []);
}

const LEGACY_DOMAINS: Record<string, NonNullable<BenchTaxonomy["domains"]>[number]> = {
  software: "software",
  "machine-learning": "machine-learning",
  science: "science",
  embodied: "robotics",
  games: "games",
};

function legacyTaxonomy(domains: string[] | undefined, explicit = false): BenchTaxonomy {
  if (!domains) return {};
  const values = domains.flatMap((d) => {
    const value = Object.hasOwn(LEGACY_DOMAINS, d) ? LEGACY_DOMAINS[d] : undefined;
    return value ? [value] : [];
  });
  return values.length || (explicit && !domains.length) ? { domains: values } : {};
}

/** Specific fields replace defaults; null and [] deliberately prevent inheritance. */
export function resolveTaxonomy(...layers: (BenchTaxonomy | undefined)[]): BenchTaxonomy {
  const values = Object.assign(
    {},
    ...layers.map((layer) =>
      Object.fromEntries(Object.entries(layer ?? {}).filter(([, value]) => value !== undefined)),
    ),
  );
  return Object.fromEntries(
    (Object.keys(TAXONOMY_VALUES) as TaxonomyField[])
      .filter((key) => values[key] !== undefined)
      .map((key) => [key, values[key] === null ? null : [...new Set<string>(values[key])].sort()]),
  ) as BenchTaxonomy;
}

/** Preserve conjunctions at task scope, while compressing identical descriptors for the catalog. */
export function catalogTaxonomy(
  benchmark: Benchmark,
  capabilities: BenchCapabilities | null,
  tasks: BenchTask[] | null,
): Pick<CatalogEntry, "taxonomy" | "taxonomyGroups"> {
  const defaults = resolveTaxonomy(
    legacyTaxonomy(capabilities?.domains),
    capabilities?.taxonomy,
    legacyTaxonomy(benchmark.labels?.domains, true),
    benchmark.labels?.taxonomy,
  );
  if (tasks === null)
    return { taxonomy: defaults, taxonomyGroups: [{ taxonomy: defaults, taskCount: null }] };
  const groups = new Map<string, { taxonomy: BenchTaxonomy; taskCount: number }>();
  for (const task of tasks) {
    const taxonomy = resolveTaxonomy(
      defaults,
      legacyTaxonomy(task.tags.domain ? [task.tags.domain] : undefined),
      task.taxonomy,
    );
    const key = JSON.stringify(taxonomy);
    const group = groups.get(key);
    if (group) group.taskCount++;
    else groups.set(key, { taxonomy, taskCount: 1 });
  }
  const taxonomyGroups = [...groups.values()];
  const union: Record<string, string[] | null> = {};
  for (const field of Object.keys(TAXONOMY_VALUES) as TaxonomyField[]) {
    const values = taxonomyGroups.map((g) => g.taxonomy[field]);
    const known = values.filter((v): v is NonNullable<typeof v> => Array.isArray(v));
    if (known.length) union[field] = [...new Set(known.flat())].sort();
    else if (values.some((v) => v === null)) union[field] = null;
  }
  return { taxonomy: union as BenchTaxonomy, taxonomyGroups };
}

/**
 * One catalog entry. `jobs` are this benchmark's jobs, newest first, each with its summary;
 * `calibrations` the reports of its calibration jobs, newest first.
 */
export function catalogEntry(
  benchmark: Benchmark,
  listing: Listing,
  jobs: (BenchJob & { summary: MethodSummary[] })[],
  calibrations: CalibrationReport[],
): CatalogEntry {
  const methods = new Map<string, CatalogMethod>();
  for (const j of jobs) {
    if (j.spec.calibration) continue;
    for (const m of j.spec.methods) {
      if (!isAgentMethod(m)) continue;
      const revision =
        j.revisions[m.name] ??
        revisionOf(methodBasis(m, { authKind: null, cliVersion: null, bundleDigest: null }), true);
      const key = `${methodKey(m)} · ${revision.revision}${revision.approximate ? " (approximate)" : ""}`;
      const known = methods.get(key);
      if (known) {
        known.jobs++;
        continue;
      }
      const summary = j.summary.find((s) => s.method === m.name);
      if (!summary) continue;
      methods.set(key, {
        key,
        agent: m.agent,
        model: m.model ?? null,
        jobs: 1,
        latest: { job: j.id, method: m.name, createdAt: j.createdAt, state: j.state, summary },
      });
    }
  }
  const view = listing.data && listing.at ? catalogListing(listing.at, listing.data) : null;
  const parity = view?.capabilities?.parity?.level;
  const benchmarkChecks = calibrations.filter((c) => c.mode !== "policy");
  const policyChecks = calibrations.filter((c) => c.mode === "policy");
  const lastDone = benchmarkChecks.find((c) => c.phase === "done");
  const capabilities = view?.capabilities ?? jobs.find((j) => j.capabilities)?.capabilities ?? null;
  const { identity, source } = benchIdentity(benchmark, capabilities);
  const { domains, tags } = benchDomains(benchmark, capabilities);
  return {
    benchmark,
    listing: view,
    capabilities,
    identity,
    identitySource: source,
    domains,
    tags,
    ...catalogTaxonomy(benchmark, capabilities, listing.data?.tasks ?? null),
    listingError: listing.error,
    refreshing: listing.refreshing,
    calibrations: benchmarkChecks.slice(0, 5),
    ...(policyChecks.length ? { policyChecks: policyChecks.slice(0, 5) } : {}),
    jobs: jobs.length,
    methods: [...methods.values()],
    fidelity: parity ?? (lastDone?.calibrated ? "calibrated" : "experimental"),
  };
}
