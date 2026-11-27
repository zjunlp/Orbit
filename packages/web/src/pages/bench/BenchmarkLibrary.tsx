import type { BenchTaxonomy, SupportedBenchmark } from "@zjunlp/orbit/contracts";
import {
  TAXONOMY_FIELDS,
  TAXONOMY_GROUPS,
  type TaxonomyField,
  taxonomyMatches,
} from "@zjunlp/orbit/taxonomy";
import { Fragment, useMemo } from "react";
import {
  IconBox,
  IconBrain,
  IconChevron,
  IconChevronDown,
  IconDashboard,
  IconFilter,
  IconFlask,
  IconLayers,
  IconLoader,
  IconRuns,
  IconSearch,
  IconTerminal,
  IconX,
} from "../../components/icons.tsx";
import { Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import {
  matchesTaxonomy,
  readTaxonomyFilters,
  taxonomyFields,
  taxonomyLabel,
  toggleTaxonomyValue,
} from "../../lib/taxonomy.ts";
import { useAsync } from "../../lib/use.ts";
import { BenchmarkComparison } from "./BenchmarkComparison.tsx";
import { CoverageMatrix, TaxonomyTags } from "./Catalog.tsx";
import {
  COMPARISON_LIMIT,
  comparisonProfileKey,
  readComparison,
  toggleComparison,
} from "./comparison-model.ts";
import { TaxonomyFacets } from "./TaxonomyFacets.tsx";

/** Display labels are a union; filtering always uses the original protocol groups. */
export function libraryEntry(benchmark: SupportedBenchmark) {
  const taxonomy: BenchTaxonomy = Object.fromEntries(
    taxonomyFields.flatMap((field) => {
      const values = benchmark.taxonomyGroups.map((group) => group.taxonomy[field]);
      const known = values.filter((value) => Array.isArray(value));
      return known.length ? [[field, [...new Set(known.flat())]]] : [];
    }),
  );
  return { ...benchmark, identity: { id: benchmark.id, name: benchmark.name }, taxonomy };
}

export function BenchmarkLibrary() {
  const { query } = useLocation();
  const catalog = useAsync(() => api.benchCatalog(), [], { poll: true, pollMs: 10000 });
  const entries = useMemo(() => (catalog.data?.supported ?? []).map(libraryEntry), [catalog.data]);
  const filterKey = new URLSearchParams(
    taxonomyFields.map((field) => [field, query.get(field) ?? ""]),
  ).toString();
  const filters = useMemo(() => readTaxonomyFilters(new URLSearchParams(filterKey)), [filterKey]);
  const active = taxonomyFields.flatMap((field) =>
    (filters[field] ?? []).map((value) => ({ field, value })),
  );
  const q = (query.get("q") ?? "").trim().toLowerCase();
  const localValue = query.get("local");
  const local = localValue === "registered" || localValue === "unregistered" ? localValue : "all";
  const view = query.get("view") ?? "grid";
  const index = useMemo(
    () =>
      entries.map((entry) => ({
        entry,
        text: [
          entry.id,
          entry.name,
          ...entry.taxonomyGroups.map((group) => group.label),
          entry.description,
          ...entry.suites,
          ...entry.integrations.map((route) => route.name),
          ...taxonomyFields.flatMap((field) =>
            (entry.taxonomy[field] ?? []).map((value) => taxonomyLabel(field, value)),
          ),
        ]
          .join(" ")
          .toLowerCase(),
      })),
    [entries],
  );
  const base = useMemo(
    () =>
      index
        .filter(
          ({ entry, text }) =>
            text.includes(q) &&
            (local === "all" ||
              (local === "registered"
                ? entry.registrationNames.length > 0
                : entry.registrationNames.length === 0)),
        )
        .map(({ entry }) => entry),
    [index, q, local],
  );
  const shown = useMemo(
    () =>
      base
        .filter((entry) => matchesTaxonomy(entry, filters))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [base, filters],
  );
  const compareValue = query.get("compare");
  const comparison = useMemo(() => readComparison(compareValue, entries), [compareValue, entries]);
  const selectedIds = comparison.entries.map((entry) => entry.id);
  const visibleIds = new Set(shown.map((entry) => entry.id));
  const hiddenCount = selectedIds.filter((id) => !visibleIds.has(id)).length;
  const selectComparison = (id: string) => {
    const next = toggleComparison(selectedIds, id);
    setQuery({
      compare: next.join(",") || null,
      ...(selectedIds.includes(id) ? { [comparisonProfileKey(id)]: null } : {}),
    });
  };
  const clearComparison = () =>
    setQuery({
      compare: null,
      ...Object.fromEntries(
        [...query.keys()]
          .filter((key) => key.startsWith("compareProfile."))
          .map((key) => [key, null]),
      ),
    });
  const toggle = (field: TaxonomyField, value: string) =>
    setQuery({ [field]: toggleTaxonomyValue(filters, field, value).join(",") || null });
  const clear = () =>
    setQuery({
      ...Object.fromEntries(taxonomyFields.map((field) => [field, null])),
      q: null,
      local: null,
    });
  if (!catalog.data)
    return catalog.error ? (
      <div className="callout" role="alert">
        {catalog.error}
        <button type="button" className="btn sm" onClick={catalog.reload}>
          Try again
        </button>
      </div>
    ) : (
      <Loading what="Loading supported benchmarks" />
    );

  return (
    <div className="benchmark-library">
      <header className="library-heading">
        <div>
          <div className="library-eyebrow">
            <span /> BENCHMARK LIBRARY
          </div>
          <h1>
            Benchmarks<span className="library-title-dot">.</span>
          </h1>
          <p>Explore the benchmarks integrated with Orbit, by what they evaluate.</p>
        </div>
        <section className="library-totals" aria-label="Library totals">
          <div>
            <strong>{entries.length}</strong>
            <span>Benchmark families</span>
          </div>
          <div>
            <strong>
              {new Set(entries.flatMap((entry) => entry.taxonomy.domains ?? [])).size}
            </strong>
            <span>Domains covered</span>
          </div>
        </section>
      </header>
      {catalog.error && (
        <div className="callout" role="alert">
          Showing the last loaded library. {catalog.error}
        </div>
      )}
      <div className="library-controls">
        <label className="library-search">
          <IconSearch size={18} />
          <input
            type="search"
            aria-label="Search benchmarks"
            placeholder="Search benchmarks, suites, or capabilities…"
            value={query.get("q") ?? ""}
            onChange={(event) => setQuery({ q: event.target.value || null })}
          />
        </label>
        <button
          type="button"
          className="btn library-refresh"
          onClick={catalog.reload}
          title="Reload the benchmark library"
        >
          <IconLoader size={15} />
          <span>Refresh</span>
        </button>
      </div>
      <div className="library-display-options">
        <select
          className="library-select"
          aria-label="Filter by local setup"
          value={local}
          onChange={(event) =>
            setQuery({ local: event.target.value === "all" ? null : event.target.value })
          }
        >
          <option value="all">All local setup states</option>
          <option value="registered">Has local setup</option>
          <option value="unregistered">No local setup</option>
        </select>
      </div>
      <TaxonomyFacets entries={base} filters={filters} toggle={toggle} />
      {(active.length > 0 || q || local !== "all") && (
        <section className="library-active-filters" aria-label="Active filters">
          <IconFilter size={14} />
          {active.map(({ field, value }) => (
            <button
              type="button"
              className="filter-token"
              key={`${field}:${value}`}
              onClick={() => toggle(field, value)}
              aria-label={`Remove ${TAXONOMY_FIELDS[field].label}: ${taxonomyLabel(field, value)}`}
            >
              <span>{TAXONOMY_FIELDS[field].label}:</span> {taxonomyLabel(field, value)}
              <IconX size={11} />
            </button>
          ))}
          {q && (
            <button type="button" className="filter-token" onClick={() => setQuery({ q: null })}>
              Search: {query.get("q")}
              <IconX size={11} />
            </button>
          )}
          {local !== "all" && (
            <button
              type="button"
              className="filter-token"
              onClick={() => setQuery({ local: null })}
            >
              {local === "registered" ? "Has local setup" : "No local setup"}
              <IconX size={11} />
            </button>
          )}
          <button type="button" className="filter-clear" onClick={clear}>
            Clear all
          </button>
        </section>
      )}
      {(selectedIds.length > 0 ||
        view === "compare" ||
        comparison.unknown.length > 0 ||
        comparison.overflow > 0) && (
        <section className="comparison-selection" aria-label="Selected benchmark families">
          <div className="comparison-selection-summary" aria-live="polite">
            <b>
              {selectedIds.length} of {COMPARISON_LIMIT} families selected
            </b>
            <p>
              {hiddenCount} selected {hiddenCount === 1 ? "family is" : "families are"} hidden by
              current filters. Selection is kept when filters change.
            </p>
            {selectedIds.length === COMPARISON_LIMIT && (
              <p>Selection limit reached. Remove a family to add another.</p>
            )}
            {comparison.unknown.length > 0 && (
              <p>
                {comparison.unknown.length} unavailable{" "}
                {comparison.unknown.length === 1 ? "family ID was" : "family IDs were"} ignored from
                this URL.
              </p>
            )}
            {comparison.overflow > 0 && (
              <p>
                Only the first {COMPARISON_LIMIT} available families from this URL are selected.
              </p>
            )}
          </div>
          {view === "compare" ? (
            <button type="button" className="btn sm" onClick={() => setQuery({ view: null })}>
              Back to cards
            </button>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              disabled={selectedIds.length < 2}
              onClick={() => setQuery({ view: "compare" })}
            >
              Compare selected
            </button>
          )}
          <button type="button" className="btn sm" onClick={clearComparison}>
            Clear selection
          </button>
          {selectedIds.length > 0 && (
            <div className="comparison-selection-items">
              {comparison.entries.map((entry) => (
                <button
                  type="button"
                  className="filter-token"
                  key={entry.id}
                  aria-label={`Remove ${entry.name} from comparison`}
                  onClick={() => selectComparison(entry.id)}
                >
                  {entry.name}
                  {!visibleIds.has(entry.id) && <span> · hidden</span>}
                  <IconX size={11} />
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="library-results-bar">
        <div>
          <b>{view === "compare" ? selectedIds.length : shown.length}</b> benchmark families{" "}
          <span className="library-results-dot">·</span>
          <span>{view === "compare" ? "Selected for comparison" : "One card per benchmark"}</span>
        </div>
        <div className="library-display-options">
          <section className="library-view-toggle" aria-label="Catalog layout">
            {[
              { key: "grid", label: "Cards", Icon: IconDashboard },
              { key: "list", label: "List", Icon: IconRuns },
              { key: "matrix", label: "Coverage matrix", Icon: IconLayers },
            ].map(({ key, label, Icon }) => (
              <button
                type="button"
                key={key}
                aria-label={label}
                title={label}
                aria-pressed={view === key}
                onClick={() => setQuery({ view: key === "grid" ? null : key })}
              >
                <Icon size={15} />
              </button>
            ))}
          </section>
        </div>
      </div>
      {!entries.length ? (
        <div className="library-empty">
          <IconLayers size={30} />
          <h2>The integration library is not available</h2>
          <p>Rebuild Orbit and restart its daemon to load the benchmark library.</p>
        </div>
      ) : view === "compare" ? (
        <BenchmarkComparison entries={comparison.entries} filters={filters} />
      ) : !shown.length ? (
        <div className="library-empty">
          <IconSearch size={30} />
          <h2>No benchmarks match these filters</h2>
          <p>Try fewer conditions or a different search.</p>
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        </div>
      ) : view === "matrix" ? (
        <CoverageMatrix entries={shown} filters={filters} />
      ) : (
        <div className={`library-cards${view === "list" ? " as-list" : ""}`}>
          {shown.map((entry) => (
            <SupportedCard
              key={entry.id}
              entry={entry}
              open={query.get("open") === entry.id}
              filters={filters}
              comparison={{
                selected: selectedIds.includes(entry.id),
                disabled: selectedIds.length >= COMPARISON_LIMIT && !selectedIds.includes(entry.id),
                toggle: () => selectComparison(entry.id),
              }}
              toggle={() =>
                setQuery({ open: query.get("open") === entry.id ? null : entry.id, profile: null })
              }
            />
          ))}
        </div>
      )}
      <section className="callout">
        <b>Bring your own benchmark</b>
        <p>
          Connect Harbor tasks, a manifest, the Python SDK, or a native adapter through Orbit’s
          existing evaluation workflow.
        </p>
        <Link className="btn sm" href="/benchmarks?mode=add">
          Add your benchmark
        </Link>{" "}
        <a
          href="https://github.com/zjunlp/Orbit/blob/main/docs/guides/benchmark-onboarding.md"
          target="_blank"
          rel="noreferrer"
        >
          Benchmark onboarding guide ↗
        </a>
      </section>
      <p className="library-footnote">
        Integration coverage is included with Orbit. Local installation, model compatibility, and
        evaluation results are separate; check each benchmark’s supported scope.
      </p>
    </div>
  );
}

export function SupportedCard({
  entry,
  open,
  toggle,
  filters = {},
  comparison,
}: {
  entry: ReturnType<typeof libraryEntry>;
  open: boolean;
  toggle: () => void;
  comparison?: { selected: boolean; disabled: boolean; toggle: () => void };
  filters?: import("../../lib/taxonomy.ts").TaxonomyFilters;
}) {
  const matching = entry.taxonomyGroups.filter((group) => taxonomyMatches(group.taxonomy, filters));
  const hasFilters = Object.values(filters).some((values) => values?.length);
  const domains = entry.taxonomy.domains ?? [];
  const Icon = domains.includes("robotics")
    ? IconBox
    : domains.includes("science")
      ? IconFlask
      : domains.includes("software")
        ? IconTerminal
        : domains.includes("machine-learning")
          ? IconBrain
          : IconLayers;
  return (
    <article className={`benchmark-card supported-benchmark${open ? " is-open" : ""}`}>
      <div className="benchmark-card-main">
        <div className="benchmark-card-header">
          <span className={`benchmark-emblem emblem-${domains[0] ?? "default"}`}>
            <Icon size={22} />
          </span>
          <div className="benchmark-card-name">
            <button type="button" onClick={toggle} aria-expanded={open}>
              <h2>{entry.name}</h2>
            </button>
            <div>{entry.integrations.map((route) => route.name).join(" · ")}</div>
          </div>
          <button
            type="button"
            className="btn ghost icon benchmark-expand"
            aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? <IconChevronDown size={17} /> : <IconChevron size={17} />}
          </button>
        </div>
        <p className="benchmark-description">{entry.description}</p>
        <div className="benchmark-content-facets">
          {(["domains", "taskTypes", "targets"] as const).map((field) => (
            <div className="benchmark-facet-line" key={field}>
              <span className="benchmark-facet-label">
                {field === "targets" ? "Evaluates" : TAXONOMY_FIELDS[field].label}
              </span>
              <TaxonomyTags e={entry} field={field} />
            </div>
          ))}
        </div>
        <div className="benchmark-conditions-strip">
          <IconDashboard size={13} />
          <TaxonomyTags e={entry} field="interfaces" limit={2} />
          <span className="condition-separator" />
          <IconBox size={13} />
          <TaxonomyTags e={entry} field="platforms" limit={2} />
        </div>
        <p className="muted">
          {entry.registrationNames.length
            ? `${entry.registrationNames.length} local setup${entry.registrationNames.length === 1 ? "" : "s"} registered`
            : "No local setup registered"}
        </p>
        {hasFilters && (
          <p className="muted">
            Matching protocol{matching.length === 1 ? "" : "s"}:{" "}
            {matching.map((group) => group.label).join(" · ")}. All selected fields match within
            each protocol.
          </p>
        )}
        <div className="benchmark-card-footer">
          {comparison && (
            <button
              type="button"
              className="btn sm"
              aria-label={`Compare ${entry.name}`}
              aria-pressed={comparison.selected}
              disabled={comparison.disabled}
              onClick={comparison.toggle}
              title={
                comparison.disabled
                  ? "Select up to four families. Remove a selected family first."
                  : undefined
              }
            >
              {comparison.selected ? "Selected for comparison" : "Compare"}
            </button>
          )}
          {entry.registrationNames.length === 1 ? (
            <>
              <Link
                className="btn sm"
                href={`/benchmarks?mode=local&setup=${encodeURIComponent(entry.registrationNames[0] ?? "")}&open=${encodeURIComponent(entry.registrationNames[0] ?? "")}`}
              >
                View setup
              </Link>
              <Link
                className="btn sm"
                href={`/bench/new?benchmark=${encodeURIComponent(entry.registrationNames[0] ?? "")}`}
              >
                Evaluate
              </Link>
            </>
          ) : (
            entry.registrationNames.length > 1 && (
              <button type="button" className="btn sm" onClick={toggle}>
                {open ? "Hide local setup choices" : "Choose local setup"}
              </button>
            )
          )}
          <Link
            className="btn sm"
            href={`/benchmarks?mode=resources&family=${encodeURIComponent(entry.id)}`}
          >
            Prepare resources
          </Link>
          <span className="integration-verification" title={entry.verification.detail}>
            <IconLayers size={12} /> {entry.integrations.length}{" "}
            {entry.integrations.length === 1 ? "integration" : "integrations"}
          </span>
          <button type="button" className="supported-details-button" onClick={toggle}>
            {open ? "Close details" : "View supported scope"}
            <IconChevron size={13} />
          </button>
        </div>
      </div>
      {open && <SupportedDetail entry={entry} filters={filters} />}
    </article>
  );
}

function SupportedDetail({
  entry,
  filters,
}: {
  entry: ReturnType<typeof libraryEntry>;
  filters: import("../../lib/taxonomy.ts").TaxonomyFilters;
}) {
  const { query } = useLocation();
  const requested = query.get("open") === entry.id ? query.get("profile") : null;
  const selected = requested == null ? -1 : Number(requested);
  const profile =
    Number.isInteger(selected) && selected >= 0 && selected < entry.taxonomyGroups.length
      ? selected
      : Math.max(
          0,
          entry.taxonomyGroups.findIndex((group) => taxonomyMatches(group.taxonomy, filters)),
        );
  const current = entry.taxonomyGroups[profile] ?? entry.taxonomyGroups[0];
  return (
    <div className="benchmark-expanded supported-detail">
      <div className="supported-scope-grid">
        <section>
          <h3>Supported scope</h3>
          <p>{entry.suites.join(" · ")}</p>
          {entry.integrations.map((route) => (
            <div className="supported-route" key={route.name}>
              <a href={route.url} target="_blank" rel="noreferrer">
                {route.name} <span aria-hidden="true">↗</span>
              </a>
              <p>{route.scope}</p>
            </div>
          ))}
        </section>
        <section>
          <h3>What was checked</h3>
          <p>{entry.verification.detail}</p>
          <a href={entry.verification.url} target="_blank" rel="noreferrer">
            Validation notes <span aria-hidden="true">↗</span>
          </a>
          {entry.id === "embodied-first-exam" ? (
            <p className="supported-model-note">
              This benchmark evaluates coding agents. Its tasks are distinct from direct VLA policy
              evaluation.
            </p>
          ) : (
            entry.taxonomy.interfaces?.includes("physical-control") && (
              <p className="supported-model-note">
                VLA models are evaluated policies. Compatibility depends on the model version,
                checkpoint, and suite; see the validation notes for checked combinations.
              </p>
            )
          )}
        </section>
      </div>
      <div className="classification-detail">
        {entry.taxonomyGroups.length > 1 && (
          <label className="classification-profile">
            Protocol profile{" "}
            <select
              className="input"
              value={profile}
              onChange={(event) => setQuery({ profile: event.target.value })}
            >
              {entry.taxonomyGroups.map((group, index) => (
                <option key={group.label} value={index}>
                  {group.label}
                </option>
              ))}
            </select>
            <span>These labels describe the selected protocol together.</span>
          </label>
        )}
        <div className="classification-grid">
          {TAXONOMY_GROUPS.map((group, index) => (
            <section key={group.id}>
              <h3>
                <span>0{index + 1}</span>
                {group.label}
              </h3>
              <dl>
                {group.fields.map((field) => (
                  <Fragment key={field}>
                    <dt>{TAXONOMY_FIELDS[field].label}</dt>
                    <dd>
                      <TaxonomyTags e={{ taxonomy: current?.taxonomy }} field={field} limit={20} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
      <details className="supported-local-setups" open={entry.registrationNames.length > 1}>
        <summary>
          Local setups{entry.registrationNames.length ? ` (${entry.registrationNames.length})` : ""}
        </summary>
        <p>
          Choose a local setup to evaluate tasks or inspect its recorded evidence. Setups do not add
          benchmark families to this library. Registration alone does not establish readiness or
          calibration.
        </p>
        {entry.registrationNames.length ? (
          <ul>
            {entry.registrationNames.map((name) => (
              <li key={name}>
                <span>{name}</span>
                <Link
                  className="btn sm"
                  href={`/benchmarks?mode=local&setup=${encodeURIComponent(name)}&open=${encodeURIComponent(name)}`}
                >
                  View setup
                </Link>
                <Link className="btn sm" href={`/bench/new?benchmark=${encodeURIComponent(name)}`}>
                  Evaluate
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No local setup could be matched automatically. Check{" "}
            <Link href="/benchmarks?mode=local">Local setups</Link> or follow an integration guide
            above.
          </p>
        )}
      </details>
    </div>
  );
}
