// Method revisions (design §9.16): what a method is made of, hashed, so results of the same content
// line up across jobs and a changed bundle, model or CLI is a new revision even under the same name.
import { createHash } from "node:crypto";
import type {
  BenchCapabilities,
  BenchJob,
  Benchmark,
  Method,
  MethodBasis,
  MethodRevision,
} from "../contracts/index.ts";
import { inspectBundle } from "../lib/bundle.ts";
import { contentDigest } from "./samples.ts";

export function benchmarkExecutionSettings(b: Benchmark) {
  return {
    adapter: b.adapter,
    path: b.path,
    config: b.config,
    env: b.env,
    passEnv: b.passEnv,
    resources: b.resources ?? null,
  };
}

export function benchmarkExecutionDigest(b: Benchmark): string {
  return contentDigest(benchmarkExecutionSettings(b));
}

export function benchmarkReviewDigest(b: Benchmark, resources: BenchJob["resources"]): string {
  return resources
    ? contentDigest({ registration: benchmarkExecutionSettings(b), resources })
    : benchmarkExecutionDigest(b);
}

/** Discovery labels never change comparability or retry compatibility. */
export function executionCapabilities(capabilities: BenchCapabilities | null | undefined) {
  if (!capabilities) return capabilities;
  const value = { ...capabilities };
  delete value.taxonomy;
  return value;
}

/** Digest the files installed into the Agent home, following bundle links like the installer. */
export function bundleDigest(dir: string): string {
  return inspectBundle(dir).digest;
}

/** Stable JSON: object keys sorted, so the same basis always hashes the same. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 12);
}

export function revisionOf(basis: MethodBasis, approximate = false): MethodRevision {
  const revision = stableDigest(basis);
  return { revision, basis, approximate };
}

/**
 * The basis of a method. `cliVersion` and `bundleDigest` are what the submitting node sees; for an
 * older job without them pass null (the revision is then marked approximate).
 */
export function methodBasis(
  m: Method,
  extra: { authKind: string | null; cliVersion: string | null; bundleDigest: string | null },
): MethodBasis {
  return {
    agent: m.agent,
    model: m.model ?? null,
    effort: m.effort ?? null,
    authKind: extra.authKind,
    cliVersion: extra.cliVersion,
    bundleDigest: extra.bundleDigest,
    entrypoint: m.entrypoint ?? null,
    config: m.config && Object.keys(m.config).length ? m.config : null,
    ...(m.agent === "policy" && m.policySnapshot
      ? { policyDigest: contentDigest(m.policySnapshot) }
      : {}),
  };
}
