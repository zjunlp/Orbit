import {
  BENCH_CATEGORIES,
  BENCH_DOMAINS,
  benchCategory,
  CATEGORY_LABELS,
  DOMAIN_LABELS,
} from "@zjunlp/orbit/categories";
import type { BenchCapabilities } from "@zjunlp/orbit/contracts";

export { BENCH_CATEGORIES, BENCH_DOMAINS, CATEGORY_LABELS, DOMAIN_LABELS };

/** "C6 Embodied policy · sim, sync" for a job's declared capabilities, or null. */
export function categoryLabel(c: Partial<BenchCapabilities> | undefined | null): string | null {
  const cat = benchCategory(c ?? undefined);
  if (!cat) return null;
  const extra = [...(c?.profiles ?? []), ...(c?.domains ?? [])];
  return `${CATEGORY_LABELS[cat]}${extra.length ? ` · ${extra.join(", ")}` : ""}`;
}
