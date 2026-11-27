import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import type { BenchCatalog, SupportedBenchmark } from "../contracts/index.ts";
import {
  TAXONOMY_FIELDS,
  TAXONOMY_VALUES,
  type TaxonomyField,
  type TaxonomyFilters,
  taxonomyMatches,
} from "../contracts/taxonomy.ts";
import type { Print } from "./auth.ts";
import { compactTable as table } from "./format.ts";

export function parseCatalogFilters(specs: string[]): TaxonomyFilters {
  const result: Partial<Record<TaxonomyField, string[]>> = {};
  for (const spec of specs) {
    const parts = spec.split("=");
    const key = parts[0] as TaxonomyField;
    const value = parts[1];
    if (parts.length !== 2 || !key || !value?.trim())
      throw new Error(`--filter requires field=value: ${spec}`);
    if (!Object.hasOwn(TAXONOMY_VALUES, key))
      throw new Error(
        `unknown taxonomy field ${key}; use ${Object.keys(TAXONOMY_VALUES).join(", ")}`,
      );
    if (
      !(TAXONOMY_VALUES[key] as readonly string[]).includes(value) &&
      !["unlabeled", "__none__"].includes(value)
    )
      throw new Error(
        `unknown ${key} value ${value}; use ${TAXONOMY_VALUES[key].join(", ")}, unlabeled, __none__`,
      );
    result[key] ??= [];
    result[key].push(value);
  }
  return result;
}

function searchText(entry: SupportedBenchmark): string {
  const labels = entry.taxonomyGroups.flatMap((group) => [
    group.label,
    ...Object.entries(group.taxonomy).flatMap(([field, values]) => [
      field,
      ...(values ?? []).flatMap((value) => [
        value,
        TAXONOMY_FIELDS[field as TaxonomyField].values.find((v) => v.value === value)?.label ?? "",
      ]),
    ]),
  ]);
  return [
    entry.id,
    entry.name,
    entry.description,
    ...entry.suites,
    ...labels,
    ...entry.integrations.flatMap((i) => [i.name, i.scope]),
    entry.verification.detail,
  ]
    .join(" ")
    .toLowerCase();
}

export function selectCatalog(
  catalog: BenchCatalog,
  options: { family?: string; search?: string; filter?: string[]; registered?: boolean },
): BenchCatalog {
  const filters = parseCatalogFilters(options.filter ?? []);
  const words = options.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const supported = catalog.supported.filter(
    (entry) =>
      (!options.family || entry.id.toLowerCase() === options.family.toLowerCase()) &&
      (!options.registered || entry.registrationNames.length > 0) &&
      entry.taxonomyGroups.some((group) => taxonomyMatches(group.taxonomy, filters)) &&
      words.every((word) => searchText(entry).includes(word)),
  );
  const names = new Set(supported.flatMap((entry) => entry.registrationNames));
  return { supported, entries: catalog.entries.filter((entry) => names.has(entry.benchmark.name)) };
}

export function formatCatalog(catalog: BenchCatalog, detail: boolean): string {
  if (!catalog.supported.length) return "no matching benchmark families";
  if (!detail)
    return [
      table([
        ["FAMILY", "NAME", "ROUTES", "REGISTERED"],
        ...catalog.supported.map((entry) => [
          entry.id,
          entry.name,
          entry.integrations.map((i) => i.name).join(", "),
          entry.registrationNames.join(", ") || "-",
        ]),
      ]),
      "",
      "Registration does not establish resource readiness or calibration.",
      "Details: orbit bench catalog <family>; local registrations: orbit bench ls",
    ].join("\n");
  return catalog.supported
    .map((entry) =>
      [
        `${entry.name} (${entry.id})`,
        entry.description,
        `Suites: ${entry.suites.join(", ") || "not specified"}`,
        ...entry.taxonomyGroups.map(
          (group) =>
            `Profile ${group.label}: ${Object.entries(group.taxonomy)
              .map(
                ([key, values]) =>
                  `${key}=${values === null ? "unknown" : values.join(",") || "none"}`,
              )
              .join("; ")}`,
        ),
        ...entry.integrations.flatMap((route) => [
          `Route ${route.name}: ${route.scope}`,
          `  ${route.url}`,
        ]),
        `Verification: ${entry.verification.detail}`,
        `  ${entry.verification.url}`,
        `Local registrations: ${entry.registrationNames.join(", ") || "none"}`,
        ...catalog.entries
          .filter((local) => entry.registrationNames.includes(local.benchmark.name))
          .map(
            (local) =>
              `${local.benchmark.name}: listing ${local.listing ? `${local.listing.coverage.supported}/${local.listing.coverage.total} supported tasks` : "not available"}; ${local.calibrations.length} recorded calibration(s)${local.listingError ? `; listing error: ${local.listingError}` : ""}`,
          ),
        "Registration does not establish resource readiness or full-suite validation.",
        `Resources and setup: orbit bench resources ${entry.id}`,
        `Prepare after reviewing required inputs: orbit bench prepare ${entry.id}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function registerBenchCatalog(
  bench: Command,
  client: () => Promise<OrbitClient>,
  print: Print,
): void {
  bench
    .command("catalog [family]")
    .description("discover supported benchmark families, separately from local registrations")
    .option("--search <text>", "match all words across descriptions, routes and taxonomy labels")
    .option(
      "--filter <field=value>",
      "taxonomy filter (repeatable; same field OR, different fields AND)",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--registered", "only families with an associated local registration")
    .option("--json", "print filtered { supported, entries }")
    .action(
      async (
        family: string | undefined,
        options: { search?: string; filter: string[]; registered?: boolean; json?: boolean },
      ) => {
        parseCatalogFilters(options.filter);
        const result = selectCatalog(await (await client()).benchCatalog(), { ...options, family });
        print(options.json, result, () => formatCatalog(result, !!family));
      },
    );
}
