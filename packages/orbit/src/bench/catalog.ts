// The catalog page (design §9.15): one entry per registered benchmark, from its cached task
// listing, its calibration jobs and the real methods its jobs ran. Pure; the service caches the
// listings and reads the store.
import {
  type AdapterTasksResponse,
  type BenchJob,
  type Benchmark,
  benchCoverage,
  type CalibrationReport,
  type CatalogEntry,
  type CatalogMethod,
  isAgentMethod,
  type Method,
  type MethodSummary,
} from "../contracts/index.ts";
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
      const key = methodKey(m);
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
  return {
    benchmark,
    listing: view,
    capabilities: view?.capabilities ?? jobs.find((j) => j.capabilities)?.capabilities ?? null,
    listingError: listing.error,
    refreshing: listing.refreshing,
    calibrations: calibrations.slice(0, 5),
    jobs: jobs.length,
    methods: [...methods.values()],
    fidelity: parity ?? (lastDone?.calibrated ? "calibrated" : "experimental"),
  };
}
