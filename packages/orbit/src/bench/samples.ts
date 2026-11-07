import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ResolvedBinding, SamplePlan, type SemanticProfile } from "../contracts/index.ts";

export function resolveBinding(
  benchmark: SemanticProfile,
  policy: SemanticProfile,
  observationMap: Record<string, string>,
): ResolvedBinding {
  if (
    !isDeepStrictEqual(Object.keys(observationMap).sort(), Object.keys(policy.observations).sort())
  )
    throw new Error("explicit mappings must cover exactly the policy observation fields");
  for (const [target, source] of Object.entries(observationMap)) {
    const expected = policy.observations[target];
    if (!expected || !isDeepStrictEqual(expected, benchmark.observations[source]))
      throw new Error(`incompatible observation semantics: ${target} <- ${source}`);
    if (expected.semantic.toLowerCase() === "raw")
      throw new Error(`incomplete semantic declaration for ${target}`);
    if (expected.semantic === "rgb" && (!expected.camera || !expected.layout))
      throw new Error(`missing camera identity or layout for ${target}`);
    if (expected.semantic.includes("position") && !expected.unit)
      throw new Error(`missing physical unit for ${target}`);
    if (/position|orientation/.test(expected.semantic) && !expected.frame)
      throw new Error(`missing coordinate frame for ${target}`);
  }
  if (!isDeepStrictEqual(benchmark.action, policy.action))
    throw new Error("action semantics differ");
  const content = {
    version: 1 as const,
    benchmarkProfile: benchmark,
    policyProfile: policy,
    observationMap,
  };
  return ResolvedBinding.parse({ ...content, digest: contentDigest(content) });
}

export function contentDigest(value: unknown): string {
  function ordered(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(ordered);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, ordered(x)]),
      );
    return v;
  }
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex")}`;
}

export function checkSamplePlan(input: SamplePlan): SamplePlan {
  const plan = SamplePlan.parse(input);
  const seen = new Set<string>();
  for (const item of plan.items) {
    const { sampleId, ...content } = item;
    if (sampleId !== contentDigest(content)) throw new Error("sampleId does not match its content");
    if (seen.has(sampleId)) throw new Error(`duplicate planned sample: ${sampleId}`);
    seen.add(sampleId);
  }
  if (plan.digest !== contentDigest(plan.items)) throw new Error("sample plan digest mismatch");
  return plan;
}
