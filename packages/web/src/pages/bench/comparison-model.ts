import type { SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { taxonomyMatches } from "@zjunlp/orbit/taxonomy";
import type { TaxonomyFilters } from "../../lib/taxonomy.ts";

export const COMPARISON_LIMIT = 4;

export function readComparison(value: string | null, entries: SupportedBenchmark[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const known = ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  return {
    entries: known.slice(0, COMPARISON_LIMIT),
    unknown: ids.filter((id) => !byId.has(id)),
    overflow: Math.max(0, known.length - COMPARISON_LIMIT),
  };
}

export function toggleComparison(ids: string[], id: string) {
  if (ids.includes(id)) return ids.filter((selected) => selected !== id);
  return ids.length < COMPARISON_LIMIT ? [...ids, id] : ids;
}

export const comparisonProfileKey = (id: string) => `compareProfile.${id}`;

export function comparisonProfile(
  entry: SupportedBenchmark,
  requested: string | null,
  filters: TaxonomyFilters,
) {
  const index = requested != null && /^\d+$/.test(requested) ? Number(requested) : -1;
  return index >= 0 && index < entry.taxonomyGroups.length
    ? index
    : Math.max(
        0,
        entry.taxonomyGroups.findIndex((group) => taxonomyMatches(group.taxonomy, filters)),
      );
}
