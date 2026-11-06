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
  benchCoverage,
  type CalibrationReport,
  type CatalogEntry,
  type CatalogMethod,
  isAgentMethod,
  type Method,
  type MethodSummary,
  splitDomains,
} from "../contracts/index.ts";

import { methodBasis, revisionOf, stableDigest } from "./revision.ts";

export interface Listing {
  at: string | null;
  data: AdapterTasksResponse | null;
  error: string | null;
  refreshing: boolean;
}

/** What makes two methods of different jobs the same method. */
export function methodKey(m: Method): string {
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
  const lastDone = calibrations.find((c) => c.phase === "done");
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
    listingError: listing.error,
    refreshing: listing.refreshing,
    calibrations: calibrations.slice(0, 5),
    jobs: jobs.length,
    methods: [...methods.values()],
    fidelity: parity ?? (lastDone?.calibrated ? "calibrated" : "experimental"),
  };
}
