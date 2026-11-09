import type { BenchTaxonomy } from "@zjunlp/orbit/contracts";
import { TAXONOMY_FIELDS, type TaxonomyField, taxonomyMatches } from "@zjunlp/orbit/taxonomy";
import type { CatalogEntry } from "./api.ts";

export type TaxonomyFilters = Partial<Record<TaxonomyField, string[]>>;
export const taxonomyFields = Object.keys(TAXONOMY_FIELDS) as TaxonomyField[];

export function readTaxonomyFilters(query: URLSearchParams): TaxonomyFilters {
  return Object.fromEntries(
    taxonomyFields.map((field) => [
      field,
      [...new Set((query.get(field) ?? "").split(",").filter((v) => v && v !== "all"))],
    ]),
  );
}

export const taxonomyLabel = (field: TaxonomyField, value: string) =>
  value === "unlabeled"
    ? "Not annotated"
    : value === "__none__"
      ? "None"
      : (TAXONOMY_FIELDS[field].values.find((v) => v.value === value)?.label ?? value);

export const taxonomyGroups = (entry: CatalogEntry) =>
  entry.taxonomyGroups ?? [{ taxonomy: entry.taxonomy ?? {}, taskCount: null }];

export const matchesLegacyDomain = (entry: CatalogEntry, value: string) =>
  value === "all" ||
  (value === "unlabeled" ? entry.domains.length === 0 : entry.domains.includes(value));

export function matchesTaxonomy(entry: CatalogEntry, filters: TaxonomyFilters) {
  if (!Object.values(filters).some((values) => values?.length)) return true;
  return taxonomyGroups(entry).some((group) => taxonomyMatches(group.taxonomy, filters));
}

export function fieldValues(taxonomy: BenchTaxonomy, field: TaxonomyField): string[] {
  const values = taxonomy[field];
  return values == null ? ["unlabeled"] : values.length ? values : ["__none__"];
}

export function toggleTaxonomyValue(filters: TaxonomyFilters, field: TaxonomyField, value: string) {
  const current = filters[field] ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}
