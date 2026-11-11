import type { BenchTaxonomy, SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { TAXONOMY_FIELDS, TAXONOMY_GROUPS, type TaxonomyField } from "@zjunlp/orbit/taxonomy";
import { Fragment, useState } from "react";
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
import { CoverageMatrix, TaxonomyTags } from "./Catalog.tsx";
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
  const entries = (catalog.data?.supported ?? []).map(libraryEntry);
  const filters = readTaxonomyFilters(query);
  const active = taxonomyFields.flatMap((field) =>
    (filters[field] ?? []).map((value) => ({ field, value })),
  );
  const q = (query.get("q") ?? "").trim().toLowerCase();
  const view = query.get("view") ?? "grid";
  const base = entries.filter((entry) =>
    [
      entry.name,
      entry.description,
      ...entry.suites,
      ...entry.integrations.map((route) => route.name),
      ...taxonomyFields.flatMap((field) =>
        (entry.taxonomy[field] ?? []).map((value) => taxonomyLabel(field, value)),
      ),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
  const shown = base
    .filter((entry) => matchesTaxonomy(entry, filters))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (field: TaxonomyField, value: string) =>
    setQuery({ [field]: toggleTaxonomyValue(filters, field, value).join(",") || null });
  const clear = () =>
    setQuery({
      ...Object.fromEntries(taxonomyFields.map((field) => [field, null])),
      q: null,
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
      <TaxonomyFacets entries={base} filters={filters} toggle={toggle} />
      {(active.length > 0 || q) && (
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
          <button type="button" className="filter-clear" onClick={clear}>
            Clear all
          </button>
        </section>
      )}
      <div className="library-results-bar">
        <div>
          <b>{shown.length}</b> benchmark families <span className="library-results-dot">·</span>
          <span>One card per benchmark</span>
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
              toggle={() => setQuery({ open: query.get("open") === entry.id ? null : entry.id })}
            />
          ))}
        </div>
      )}
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
}: {
  entry: ReturnType<typeof libraryEntry>;
  open: boolean;
  toggle: () => void;
}) {
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
        <div className="benchmark-card-footer">
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
      {open && <SupportedDetail entry={entry} />}
    </article>
  );
}

function SupportedDetail({ entry }: { entry: ReturnType<typeof libraryEntry> }) {
  const [profile, setProfile] = useState(0);
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
              onChange={(event) => setProfile(Number(event.target.value))}
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
      <details className="supported-local-setups">
        <summary>
          Local setups{entry.registrationNames.length ? ` (${entry.registrationNames.length})` : ""}
        </summary>
        <p>
          Choose a local setup to evaluate tasks or inspect its recorded evidence. Setups do not add
          benchmark families to this library.
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
