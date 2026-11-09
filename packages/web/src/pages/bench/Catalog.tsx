import { benchCategory } from "@zjunlp/orbit/categories";
import { fmtCi, fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { TAXONOMY_FIELDS, TAXONOMY_GROUPS, type TaxonomyField } from "@zjunlp/orbit/taxonomy";
import { Fragment, useState } from "react";
import {
  IconAlert,
  IconBan,
  IconBox,
  IconBrain,
  IconCheck,
  IconChevron,
  IconChevronDown,
  IconDashboard,
  IconEdit,
  IconFilter,
  IconFlask,
  IconLayers,
  IconLoader,
  IconRuns,
  IconSearch,
  IconTerminal,
  IconX,
} from "../../components/icons.tsx";
import { Link, Loading, toast } from "../../components/ui.tsx";
import {
  api,
  type CalibrationCheck,
  type CalibrationReport,
  type CatalogEntry,
} from "../../lib/api.ts";
import { CATEGORY_LABELS, DOMAIN_LABELS } from "../../lib/category.ts";
import { ago, dateTime, jobPath, trialPath } from "../../lib/format.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import {
  fieldValues,
  matchesLegacyDomain,
  matchesTaxonomy,
  readTaxonomyFilters,
  type TaxonomyFilters,
  taxonomyFields,
  taxonomyGroups,
  taxonomyLabel,
  toggleTaxonomyValue,
} from "../../lib/taxonomy.ts";
import { useAsync } from "../../lib/use.ts";
import { TaxonomyEditor } from "./TaxonomyEditor.tsx";
import "./catalog.css";
import "./taxonomy.css";
import "../hub.css";

type CalState = "passed" | "failed" | "running" | "none";
export function calState(e: CatalogEntry): CalState {
  const r = e.calibrations[0];
  if (!r) return "none";
  if (r.phase !== "done") return "running";
  return r.calibrated ? "passed" : "failed";
}

const FIDELITY: Record<CatalogEntry["fidelity"], { label: string; title: string }> = {
  experimental: { label: "Experimental", title: "No passed calibration recorded" },
  calibrated: { label: "Sample calibrated", title: "The latest sample calibration passed" },
  "sample-aligned": {
    label: "Sample aligned",
    title: "Adapter-declared agreement with the native runner on sampled tasks",
  },
  "agent-compared": {
    label: "Agent compared",
    title: "Adapter-declared comparison with officially reported results",
  },
};

const identity = (e: CatalogEntry) =>
  e.capabilities?.conditions.Identity ?? e.capabilities?.conditions.Benchmark;
export const benchmarkKey = (e: CatalogEntry) => e.identity.id;
export const distinct = (entries: CatalogEntry[]) => new Set(entries.map(benchmarkKey)).size;
const legacyCategory = (e: CatalogEntry) =>
  benchCategory(e.capabilities ?? undefined) ??
  (e.listing ? "none" : e.listingError ? "failed" : "listing");

const EVIDENCE = [
  {
    key: "calibrated",
    label: "Sample calibrated",
    test: (e: CatalogEntry) => calState(e) === "passed",
  },
  {
    key: "failed",
    label: "Calibration failed",
    test: (e: CatalogEntry) => calState(e) === "failed",
  },
  {
    key: "uncalibrated",
    label: "Not calibrated",
    test: (e: CatalogEntry) => calState(e) === "none",
  },
  {
    key: "running",
    label: "Calibration running",
    test: (e: CatalogEntry) => calState(e) === "running",
  },
  { key: "real", label: "Real methods ran", test: (e: CatalogEntry) => e.methods.length > 0 },
  {
    key: "no-real",
    label: "No real methods yet",
    test: (e: CatalogEntry) => e.methods.length === 0,
  },
  {
    key: "parity",
    label: "Parity evidence",
    test: (e: CatalogEntry) => Boolean(e.capabilities?.parity),
  },
];
const DIMENSION_ICONS = [IconLayers, IconTerminal, IconBrain, IconDashboard, IconBox, IconCheck];

export function BenchCatalogView() {
  const loc = useLocation();
  const [activeDimension, setActiveDimension] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const catalog = useAsync(() => api.benchCatalog().then((r) => r.entries), [], {
    poll: true,
    pollMs: 4000,
  });
  const entries = catalog.data ?? [];
  const filters = readTaxonomyFilters(loc.query);
  const active = taxonomyFields.flatMap((field) =>
    (filters[field] ?? []).map((value) => ({ field, value })),
  );
  const q = (loc.query.get("q") ?? "").trim().toLowerCase();
  const ev = loc.query.get("ev") ?? "all";
  const category = loc.query.get("category") ?? "all";
  const legacyDomain = loc.query.get("domain") ?? "all";
  const view = loc.query.get("view") ?? "grid";
  const order = loc.query.get("sort") ?? "name";
  const open = loc.query.get("open");
  const searched = entries.filter((e) => {
    const labels = taxonomyFields.flatMap((field) =>
      (e.taxonomy?.[field] ?? []).map((v) => taxonomyLabel(field, v)),
    );
    return `${e.benchmark.name} ${e.identity.name} ${e.identity.id} ${identity(e) ?? ""} ${e.benchmark.adapter} ${e.tags.join(" ")} ${labels.join(" ")}`
      .toLowerCase()
      .includes(q);
  });
  const base = searched.filter(
    (e) =>
      (category === "all" || legacyCategory(e) === category) &&
      matchesLegacyDomain(e, legacyDomain) &&
      (ev === "all" || (EVIDENCE.find((f) => f.key === ev)?.test(e) ?? false)),
  );
  const shown = base
    .filter((e) => matchesTaxonomy(e, filters))
    .sort(
      (a, b) =>
        (order === "tasks"
          ? (b.listing?.coverage.total ?? -1) - (a.listing?.coverage.total ?? -1)
          : order === "recent"
            ? b.benchmark.updatedAt.localeCompare(a.benchmark.updatedAt)
            : 0) ||
        a.identity.name.localeCompare(b.identity.name) ||
        a.benchmark.name.localeCompare(b.benchmark.name),
    );
  const families = [...new Set(shown.map(benchmarkKey))];
  const dimension = TAXONOMY_GROUPS.find((g) => g.id === activeDimension);
  const toggle = (field: TaxonomyField, value: string) =>
    setQuery({
      [field]: toggleTaxonomyValue(filters, field, value).join(",") || null,
      ...(field === "domains" ? { domain: null } : {}),
    });
  const clear = () =>
    setQuery({
      ...Object.fromEntries(taxonomyFields.map((f) => [f, null])),
      q: null,
      domain: null,
      category: null,
      ev: null,
    });
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await api.benchCatalog(entries.map((e) => e.benchmark.name));
      catalog.reload();
    } catch (error) {
      setRefreshError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (catalog.error && !catalog.data)
    return (
      <div className="callout" role="alert">
        {catalog.error}
        <button type="button" className="btn sm" onClick={catalog.reload}>
          Try again
        </button>
      </div>
    );
  if (!catalog.data) return <Loading what="Loading the benchmark library" />;

  return (
    <div className="benchmark-library">
      <header className="library-heading">
        <div>
          <div className="library-eyebrow">
            <span /> EVALUATION LIBRARY
          </div>
          <h1>
            Benchmarks<span className="library-title-dot">.</span>
          </h1>
          <p>Find the right tasks. Understand what they measure.</p>
        </div>
        <section className="library-totals" aria-label="Library totals">
          <div>
            <strong>{distinct(entries)}</strong>
            <span>Benchmarks</span>
          </div>
          <div>
            <strong>{entries.length}</strong>
            <span>Registrations</span>
          </div>
          <div>
            <strong>{entries.filter((e) => calState(e) === "passed").length}</strong>
            <span>Sample calibrated</span>
          </div>
        </section>
      </header>
      {(catalog.error || refreshError) && (
        <div className="callout" role="alert">
          Showing the last loaded catalog. {catalog.error ?? refreshError}
        </div>
      )}
      <div className="library-controls">
        <label className="library-search">
          <IconSearch size={18} />
          <input
            type="search"
            aria-label="Search benchmarks"
            placeholder="Search benchmarks, task types, or capabilities…"
            value={loc.query.get("q") ?? ""}
            onChange={(e) => setQuery({ q: e.target.value || null })}
          />
        </label>
        <button
          type="button"
          className="btn library-refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
          title="Refresh benchmark task listings"
        >
          <IconLoader
            size={15}
            className={refreshing || entries.some((e) => e.refreshing) ? "spin" : ""}
          />
          <span>Refresh</span>
        </button>
      </div>
      <section className="dimension-bar" aria-label="Six classification dimensions">
        {TAXONOMY_GROUPS.map((group, i) => {
          const n = group.fields.reduce((sum, f) => sum + (filters[f]?.length ?? 0), 0);
          const Icon = DIMENSION_ICONS[i] ?? IconLayers;
          return (
            <button
              type="button"
              key={group.id}
              className={`dimension-button${activeDimension === group.id ? " expanded" : ""}${n ? " selected" : ""}`}
              aria-expanded={activeDimension === group.id}
              aria-controls="dimension-options"
              onClick={() => setActiveDimension(activeDimension === group.id ? null : group.id)}
            >
              <span className="dimension-number">
                0{i + 1}
                <Icon size={15} />
              </span>
              <span className="dimension-name">
                {group.label}
                <IconChevronDown size={13} />
              </span>
              <span className="dimension-summary">{n ? `${n} selected` : group.question}</span>
            </button>
          );
        })}
      </section>
      {dimension && (
        <section
          id="dimension-options"
          className="dimension-panel"
          aria-label={`${dimension.label} filters`}
        >
          <div className="dimension-panel-head">
            <div>
              <b>{dimension.label}</b>
              <p>Choose any values within a field. Different fields must match the same tasks.</p>
            </div>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Close filters"
              onClick={() => setActiveDimension(null)}
            >
              <IconX size={16} />
            </button>
          </div>
          <div className={`dimension-fields fields-${dimension.fields.length}`}>
            {dimension.fields.map((field) => (
              <fieldset key={field}>
                <legend>{TAXONOMY_FIELDS[field].label}</legend>
                <div className="dimension-options">
                  {[
                    ...TAXONOMY_FIELDS[field].values.map((v) => v.value),
                    "unlabeled",
                    "__none__",
                  ].map((value) => {
                    const count = distinct(
                      base.filter((e) => matchesTaxonomy(e, { ...filters, [field]: [value] })),
                    );
                    const selected = filters[field]?.includes(value) ?? false;
                    if (!count && !selected) return null;
                    return (
                      <button
                        type="button"
                        key={value}
                        className={`dimension-option${selected ? " on" : ""}`}
                        aria-pressed={selected}
                        onClick={() => toggle(field, value)}
                      >
                        <span className="filter-check">{selected && <IconCheck size={11} />}</span>
                        <span>{taxonomyLabel(field, value)}</span>
                        <small>{count}</small>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </section>
      )}
      {(active.length > 0 || category !== "all" || legacyDomain !== "all" || q || ev !== "all") && (
        <section className="library-active-filters" aria-label="Active filters">
          <IconFilter size={14} />
          {active.map(({ field, value }) => (
            <button
              key={`${field}:${value}`}
              type="button"
              className="filter-token"
              onClick={() => toggle(field, value)}
              aria-label={`Remove ${TAXONOMY_FIELDS[field].label}: ${taxonomyLabel(field, value)}`}
            >
              <span>{TAXONOMY_FIELDS[field].label}:</span> {taxonomyLabel(field, value)}
              <IconX size={11} />
            </button>
          ))}
          {category !== "all" && (
            <button
              type="button"
              className="filter-token"
              onClick={() => setQuery({ category: null })}
            >
              Legacy: {CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category}
              <IconX size={11} />
            </button>
          )}
          {legacyDomain !== "all" && (
            <button
              type="button"
              className="filter-token"
              onClick={() => setQuery({ domain: null })}
            >
              Legacy domain:{" "}
              {DOMAIN_LABELS[legacyDomain as keyof typeof DOMAIN_LABELS] ?? legacyDomain}
              <IconX size={11} />
            </button>
          )}
          {q && (
            <button type="button" className="filter-token" onClick={() => setQuery({ q: null })}>
              Search: {loc.query.get("q")}
              <IconX size={11} />
            </button>
          )}
          {ev !== "all" && (
            <button type="button" className="filter-token" onClick={() => setQuery({ ev: null })}>
              {EVIDENCE.find((e) => e.key === ev)?.label ?? ev}
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
          <b>{distinct(shown)}</b> benchmark{distinct(shown) === 1 ? "" : "s"}
          <span className="library-results-dot">·</span>
          <span>
            {shown.length} registration{shown.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="library-display-options">
          <select
            className="library-select"
            aria-label="Filter by registration evidence"
            value={ev}
            onChange={(e) => setQuery({ ev: e.target.value === "all" ? null : e.target.value })}
          >
            <option value="all">All evidence</option>
            {EVIDENCE.map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
              </option>
            ))}
          </select>
          <select
            className="library-select"
            aria-label="Sort benchmarks"
            value={order}
            onChange={(e) => setQuery({ sort: e.target.value === "name" ? null : e.target.value })}
          >
            <option value="name">Name A–Z</option>
            <option value="tasks">Most tasks</option>
            <option value="recent">Recently updated</option>
          </select>
          <section className="library-view-toggle" aria-label="Catalog layout">
            {[
              { key: "grid", label: "Cards", Icon: IconDashboard },
              { key: "list", label: "List", Icon: IconRuns },
              { key: "matrix", label: "Coverage matrix", Icon: IconLayers },
            ].map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={view === key || (key === "list" && view === "table")}
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
          <h2>Your benchmark library starts here</h2>
          <p>Register a benchmark to explore its tasks, classification, and evaluation evidence.</p>
          <code>orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py</code>
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
        <div className={`library-cards${view === "list" || view === "table" ? " as-list" : ""}`}>
          {families.flatMap((key) => {
            const regs = shown.filter((e) => benchmarkKey(e) === key);
            return regs.map((e) => (
              <BenchmarkCard
                key={e.benchmark.name}
                e={e}
                registrations={regs.length}
                open={open === e.benchmark.name}
                filtered={active.length > 0}
                toggle={() =>
                  setQuery({
                    open: open === e.benchmark.name ? null : e.benchmark.name,
                    ptab: null,
                  })
                }
                reload={catalog.reload}
              />
            ));
          })}
        </div>
      )}
      {entries.length > 0 && (
        <p className="library-footnote">
          Classification describes tasks. Calibration and run evidence apply to the recorded
          registration and samples.
        </p>
      )}
    </div>
  );
}

function TaxonomyTags({
  e,
  field,
  limit = 3,
}: {
  e: CatalogEntry;
  field: TaxonomyField;
  limit?: number;
}) {
  const values = e.taxonomy?.[field];
  if (values == null) return <span className="taxonomy-unknown">Not annotated</span>;
  if (!values.length) return <span className="taxonomy-unknown">None</span>;
  return (
    <span className="taxonomy-tags">
      {values.slice(0, limit).map((value) => (
        <span className={`taxonomy-tag tag-${field}`} key={value}>
          {taxonomyLabel(field, value)}
        </span>
      ))}
      {values.length > limit && (
        <span
          className="taxonomy-more"
          title={values
            .slice(limit)
            .map((v) => taxonomyLabel(field, v))
            .join(", ")}
        >
          +{values.length - limit}
        </span>
      )}
    </span>
  );
}

export function CoverageMatrix({
  entries,
  filters = {},
}: {
  entries: CatalogEntry[];
  filters?: TaxonomyFilters;
}) {
  const available = (field: TaxonomyField) => [
    ...new Set(
      entries.flatMap((e) =>
        taxonomyGroups(e)
          .filter((g) => matchesTaxonomy({ ...e, taxonomyGroups: [g] }, filters))
          .flatMap((g) => fieldValues(g.taxonomy, field)),
      ),
    ),
  ];
  const domains = available("domains");
  const tasks = available("taskTypes");
  return (
    <section className="card library-matrix">
      <div className="matrix-wrap">
        <table className="table coverage-matrix">
          <thead>
            <tr>
              <th>Domain / task type</th>
              {tasks.map((task) => (
                <th key={task} className="c">
                  {taxonomyLabel("taskTypes", task)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain}>
                <th scope="row">{taxonomyLabel("domains", domain)}</th>
                {tasks.map((task) => {
                  const matches = entries.filter((e) =>
                    taxonomyGroups(e).some((g) => {
                      const scoped = { ...e, taxonomyGroups: [g] };
                      return (
                        matchesTaxonomy(scoped, filters) &&
                        matchesTaxonomy(scoped, { domains: [domain], taskTypes: [task] })
                      );
                    }),
                  );
                  const n = distinct(matches);
                  return (
                    <td className="c" key={task}>
                      {n ? (
                        <button
                          type="button"
                          className="matrix-cell"
                          title={`${n} benchmark(s) with matching tasks`}
                          onClick={() =>
                            setQuery({ domains: domain, domain: null, taskTypes: task, view: null })
                          }
                        >
                          <b>{n}</b>
                        </button>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-b faint">
        Distinct benchmarks with matching task profiles. Multiple labels can place a benchmark in
        several cells.
      </div>
    </section>
  );
}

function BenchmarkCard({
  e,
  registrations,
  open,
  filtered,
  toggle,
  reload,
}: {
  e: CatalogEntry;
  registrations: number;
  open: boolean;
  filtered: boolean;
  toggle: () => void;
  reload: () => void;
}) {
  const [calibrating, setCalibrating] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const cov = e.listing?.coverage;
  const state = calState(e);
  const domains = e.taxonomy?.domains ?? [];
  const Icon = domains.includes("science")
    ? IconFlask
    : domains.includes("software")
      ? IconTerminal
      : domains.includes("robotics")
        ? IconBox
        : domains.includes("machine-learning")
          ? IconBrain
          : IconLayers;
  const format =
    e.benchmark.adapter === "harbor"
      ? "Harbor format"
      : e.benchmark.adapter === "manifest"
        ? "Manifest"
        : "Native adapter";
  return (
    <article className={`benchmark-card${open ? " is-open" : ""}`}>
      <div className="benchmark-card-main">
        <div className="benchmark-card-header">
          <span className={`benchmark-emblem emblem-${domains[0] ?? "default"}`}>
            <Icon size={22} />
          </span>
          <div className="benchmark-card-name">
            <button type="button" onClick={toggle} aria-expanded={open}>
              <h2>{e.identity.name}</h2>
            </button>
            <div>
              {e.identity.variant || e.identity.version || e.benchmark.name}
              {e.identity.variant && e.identity.version ? ` · ${e.identity.version}` : ""}
              {registrations > 1 && <span> · {registrations} registrations</span>}
            </div>
          </div>
          <button
            type="button"
            className="btn ghost icon benchmark-expand"
            aria-label={`${open ? "Collapse" : "Expand"} ${e.benchmark.name}`}
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? <IconChevronDown size={17} /> : <IconChevron size={17} />}
          </button>
        </div>
        {identity(e) && <p className="benchmark-description">{identity(e)}</p>}
        <div className="benchmark-content-facets">
          {(["domains", "taskTypes", "targets"] as const).map((field) => (
            <div className="benchmark-facet-line" key={field}>
              <span className="benchmark-facet-label">
                {field === "targets" ? "Evaluates" : TAXONOMY_FIELDS[field].label}
              </span>
              <TaxonomyTags e={e} field={field} />
            </div>
          ))}
        </div>
        <div className="benchmark-conditions-strip">
          <IconDashboard size={13} />
          <TaxonomyTags e={e} field="interfaces" limit={2} />
          <span className="condition-separator" />
          <IconBox size={13} />
          <TaxonomyTags e={e} field="platforms" limit={2} />
        </div>
        <div className="benchmark-card-footer">
          <div className="benchmark-task-count">
            {cov ? (
              <>
                <b>{cov.total.toLocaleString()}</b> tasks{" "}
                <span>{cov.supported.toLocaleString()} supported</span>
              </>
            ) : e.listingError ? (
              <span className="bad-text">
                <IconAlert size={12} /> Listing failed
              </span>
            ) : (
              <span>
                <IconLoader size={12} className="spin" /> Loading tasks
              </span>
            )}
          </div>
          <Link
            className="benchmark-evaluate"
            href={`/bench/new?benchmark=${encodeURIComponent(e.benchmark.name)}`}
          >
            Evaluate <IconChevron size={13} />
          </Link>
        </div>
      </div>
      <div className="benchmark-evidence-strip">
        <span className={`evidence-status evidence-${state}`}>
          <i />
          {state === "passed"
            ? "Sample calibrated"
            : state === "running"
              ? "Calibration running"
              : state === "failed"
                ? "Calibration failed"
                : "Not calibrated"}
        </span>
        <span>
          {e.jobs} evaluation{e.jobs === 1 ? "" : "s"}
        </span>
        <span className="benchmark-format">{format}</span>
      </div>
      {open && (
        <div className="benchmark-expanded">
          <div className="benchmark-detail-actions">
            <span className="mono">{e.benchmark.name}</span>
            <span className="spacer" />
            <button type="button" className="btn sm" onClick={() => setLabeling(true)}>
              <IconEdit size={13} />
              Edit classification
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!e.listing || state === "running"}
              onClick={() => setCalibrating(true)}
            >
              Calibrate
            </button>
          </div>
          {filtered && (
            <p className="benchmark-scope-note">
              The filters match task profiles. Evidence below describes the registration’s recorded
              samples.
            </p>
          )}
          <Detail e={e} />
        </div>
      )}
      {labeling && (
        <TaxonomyEditor
          e={e}
          onClose={() => setLabeling(false)}
          onSaved={() => {
            setLabeling(false);
            reload();
          }}
        />
      )}
      {calibrating && (
        <CalibrateDialog
          e={e}
          onClose={() => setCalibrating(false)}
          onStarted={() => {
            setCalibrating(false);
            reload();
          }}
        />
      )}
    </article>
  );
}

function ClassificationDetail({ e }: { e: CatalogEntry }) {
  const groups = taxonomyGroups(e);
  const [profile, setProfile] = useState("all");
  const selected = groups[Number(profile)];
  const current = profile !== "all" && selected ? { ...e, taxonomy: selected.taxonomy } : e;
  return (
    <div className="classification-detail">
      {groups.length > 1 && (
        <label className="classification-profile">
          Task profile{" "}
          <select
            className="input"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="all">All profiles · combined labels</option>
            {groups.map((g, i) => (
              <option key={JSON.stringify(g.taxonomy)} value={i}>
                Profile {i + 1} · {g.taskCount ?? "unknown"} tasks
              </option>
            ))}
          </select>
          <span>Choose a profile to see labels that occur together.</span>
        </label>
      )}
      <div className="classification-grid">
        {TAXONOMY_GROUPS.map((group, i) => (
          <section key={group.id}>
            <h3>
              <span>0{i + 1}</span>
              {group.label}
            </h3>
            <dl>
              {group.fields.map((field) => (
                <Fragment key={field}>
                  <dt>{TAXONOMY_FIELDS[field].label}</dt>
                  <dd>
                    <TaxonomyTags e={current} field={field} limit={20} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="classification-integration">
        <span>Integration</span>
        <b>
          {e.benchmark.adapter === "harbor"
            ? "Harbor task format"
            : e.benchmark.adapter === "manifest"
              ? "Manifest adapter"
              : "Native adapter"}
        </b>
        {e.capabilities?.category && (
          <span>{CATEGORY_LABELS[e.capabilities.category]} · legacy integration category</span>
        )}
      </div>
      {e.tags.length > 0 && <p className="faint">Source tags: {e.tags.join(" · ")}</p>}
    </div>
  );
}

const CHECK_ICON = {
  passed: <IconCheck size={13} />,
  failed: <IconX size={13} />,
  not_run: <IconBan size={13} />,
};

export function CalibrationCell({ e }: { e: CatalogEntry }) {
  const r = e.calibrations[0];
  const s = calState(e);
  if (!r) {
    const policy = e.policyChecks?.[0];
    return (
      <div className="col">
        <span className="faint">not calibrated</span>
        {policy && (
          <Link href={jobPath(policy.job)}>
            {policy.phase !== "done"
              ? "Policy check running"
              : policy.calibrated
                ? "Policy integration passed"
                : "Policy check not passed"}
          </Link>
        )}
      </div>
    );
  }
  const failed = r.checks.filter((c) => c.result === "failed");
  const skipped = r.checks.filter((c) => c.result === "not_run").length;
  return (
    <div className="col" style={{ gap: 3 }}>
      <span className={`cal-state cal-${s}`}>
        {s === "passed" ? (
          <IconCheck size={13} />
        ) : s === "failed" ? (
          <IconX size={13} />
        ) : (
          <IconLoader size={13} className="spin" />
        )}
        {s === "passed"
          ? "Passed"
          : s === "failed"
            ? `${failed.length} check${failed.length === 1 ? "" : "s"} failed`
            : r.phase === "rescoring"
              ? "Rescoring"
              : "Running"}
        {s !== "running" && skipped > 0 && (
          <span className="faint"> · {skipped} not applicable</span>
        )}
      </span>
      <span className="faint catalog-sub">
        sample of {r.tasks.length}
        {e.listing ? `/${e.listing.coverage.supported}` : ""} task{r.tasks.length === 1 ? "" : "s"}{" "}
        × {r.seeds} seed{r.seeds === 1 ? "" : "s"} · {ago(r.endedAt ?? r.createdAt)}
      </span>
      {e.calibrations.length > 1 && (
        <span className="cal-history" title="Latest calibrations, newest first">
          {e.calibrations.map((c) => (
            <span
              key={c.job}
              className={`cal-${c.phase !== "done" ? "running" : c.calibrated ? "passed" : "failed"}`}
              title={`${c.job} · ${dateTime(c.createdAt)}`}
            />
          ))}
        </span>
      )}
    </div>
  );
}

function Detail({ e }: { e: CatalogEntry }) {
  const loc = useLocation();
  const tabs = ["classification", "calibration", "coverage", "methods", "conditions"] as const;
  const tab = (tabs as readonly string[]).includes(loc.query.get("ptab") ?? "")
    ? (loc.query.get("ptab") as (typeof tabs)[number])
    : "classification";
  return (
    <div className="catalog-detail">
      <nav className="tabs sub">
        {tabs.map((t) => (
          <a
            key={t}
            href={`?ptab=${t}`}
            className={tab === t ? "on" : ""}
            onClick={(ev) => {
              ev.preventDefault();
              setQuery({ ptab: t === "classification" ? null : t });
            }}
          >
            {t[0]?.toUpperCase()}
            {t.slice(1)}
          </a>
        ))}
      </nav>
      {tab === "classification" && <ClassificationDetail e={e} />}
      {tab === "calibration" && <CalibrationDetail e={e} />}
      {tab === "coverage" && <CoverageDetail e={e} />}
      {tab === "methods" && <MethodsDetail e={e} />}
      {tab === "conditions" && <ConditionsDetail e={e} />}
    </div>
  );
}

export function CalibrationDetail({ e }: { e: CatalogEntry }) {
  const r = e.calibrations[0];
  return (
    <div className="col" style={{ gap: 16 }}>
      {r ? (
        <CalibrationResult r={r} />
      ) : (
        <div className="catalog-empty">
          <p>
            No calibration recorded. Calibration runs the do-nothing and reference methods on
            sampled tasks and checks validity, expected scores, repeats, cleanup and a rescore from
            saved evidence.
          </p>
          <p className="faint">
            Use <b>Calibrate</b> on this row, or{" "}
            <code>orbit bench calibrate {e.benchmark.name}</code>.
          </p>
          {e.capabilities?.methods.includes("policy") && (
            <p>
              Check a real policy with frozen episodes using{" "}
              <code>
                orbit bench calibrate {e.benchmark.name} --policy POLICY --sample-plan samples.json
                --budget 20
              </code>
              .
            </p>
          )}
        </div>
      )}
      {(e.policyChecks?.length ?? 0) > 0 && (
        <section className="col" style={{ gap: 10 }}>
          <b>Policy integration checks</b>
          <p className="faint">
            Sampled model-path checks. Benchmark semantic calibration and full-suite statistical
            equivalence remain separate.
          </p>
          {e.policyChecks?.map((policy) => (
            <CalibrationResult key={policy.job} r={policy} />
          ))}
        </section>
      )}
    </div>
  );
}

function CalibrationResult({ r }: { r: CalibrationReport }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="catalog-facts">
        <span>
          Job{" "}
          <Link href={jobPath(r.job)} className="mono">
            {r.job}
          </Link>
        </span>
        <span>methods {r.methods.join(", ")}</span>
        {r.mode === "policy" ? (
          <span>
            Policy {r.policyRef} · {r.samples} frozen episodes · {r.budget?.minutes} minute total
            budget
            {r.budget?.expiredAt ? " · budget exhausted" : ""}
            {r.phase !== "done" && r.budget?.executionEndedAt
              ? " · execution finished; waiting for resource cleanup"
              : ""}
          </span>
        ) : (
          <span>
            {r.tasks.length} task{r.tasks.length === 1 ? "" : "s"} × {r.seeds} seed
            {r.seeds === 1 ? "" : "s"}
          </span>
        )}
        {r.source && (
          <span className="mono" title="Benchmark checkout at submission">
            {r.source.commit.slice(0, 10)}
            {r.source.dirty ? " (dirty)" : ""}
          </span>
        )}
        <span>{dateTime(r.endedAt ?? r.createdAt)}</span>
      </div>
      <table className="table cal-checks">
        <thead>
          <tr>
            <th style={{ width: 90 }}>Result</th>
            <th>Check</th>
            <th>Detail</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {r.checks.map((c) => (
            <CheckRow key={c.name} c={c} r={r} />
          ))}
        </tbody>
      </table>
      <div className="faint catalog-sub">Tasks: {r.tasks.join(", ")}</div>
    </div>
  );
}

function CheckRow({ c, r }: { c: CalibrationCheck; r: CalibrationReport }) {
  return (
    <tr className={`check-${c.result}`}>
      <td>
        <span className={`cal-state cal-${c.result === "not_run" ? "none" : c.result}`}>
          {CHECK_ICON[c.result]}
          {c.result === "not_run" ? "n/a" : c.result}
        </span>
      </td>
      <td>{c.name}</td>
      <td className={c.result === "failed" ? "" : "muted"}>{c.detail}</td>
      <td>
        {c.trials.length === 0 && c.result === "passed" && (
          <Link className="chip link" href={jobPath(r.job)}>
            {r.tasks.length * r.methods.length * r.seeds} trials
          </Link>
        )}
        {c.trials.slice(0, 4).map((t) => (
          <Link key={t} className="chip link mono" href={trialPath(r.job, t)}>
            {t.split(".").pop()}
          </Link>
        ))}
        {c.trials.length > 4 && <span className="faint"> +{c.trials.length - 4}</span>}
      </td>
    </tr>
  );
}

function CoverageDetail({ e }: { e: CatalogEntry }) {
  const l = e.listing;
  if (!l) return <div className="catalog-empty">{e.listingError ?? "Listing tasks…"}</div>;
  return (
    <div className="catalog-columns">
      <div>
        <div className="catalog-h">
          By suite <span className="faint">· listed {ago(l.at)}</span>
        </div>
        <table className="table">
          <tbody>
            {l.coverage.suites.slice(0, 40).map((s) => (
              <tr key={s.suite}>
                <td className="mono">{s.suite}</td>
                <td className="r num">
                  {s.supported}
                  <span className="faint"> / {s.total}</span>
                </td>
                <td style={{ width: 120 }}>
                  <div className="catalog-bar">
                    <span style={{ width: `${(100 * s.supported) / Math.max(s.total, 1)}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {l.coverage.suites.length > 40 && (
          <div className="faint">+{l.coverage.suites.length - 40} more suites</div>
        )}
        {l.oracleTasks !== null && (
          <p className="faint">{l.oracleTasks} supported task(s) have a full reference solution.</p>
        )}
      </div>
      <div>
        <div className="catalog-h">Why the others cannot run</div>
        {l.coverage.reasons.length === 0 ? (
          <p className="muted">Every listed task is supported.</p>
        ) : (
          <ul className="catalog-reasons">
            {l.coverage.reasons.map((r) => (
              <li key={r.reason}>
                <b className="num">{r.tasks}</b> <span>{r.reason}</span>
                <div className="faint mono catalog-sub">{r.suites.slice(0, 8).join(", ")}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="faint">
          Supported means Orbit can run the task under its conditions here, not that it was
          calibrated or that this machine has the hardware it names.
        </p>
      </div>
    </div>
  );
}

function MethodsDetail({ e }: { e: CatalogEntry }) {
  const metric = primaryMetric(resolveMetrics(e.listing?.metrics ?? []));
  const admitted = e.listing?.capabilities?.methods ?? [];
  return (
    <div className="col" style={{ gap: 10 }}>
      {e.methods.length === 0 ? (
        <p className="muted">
          No real method has run yet — only calibration methods. Calibration shows that the
          integration judges correctly; it says nothing about how a model scores.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Method (agent · model · effort)</th>
              <th>Latest job</th>
              <th className="r">{metric.label} ± 95% CI</th>
              <th className="r">Valid / trials</th>
              <th className="r">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {e.methods.map((m) => {
              const s = m.latest.summary;
              return (
                <tr key={m.key}>
                  <td className="mono">{m.key}</td>
                  <td>
                    <Link href={jobPath(m.latest.job)} className="mono">
                      {m.latest.job}
                    </Link>{" "}
                    <span className="faint">
                      {m.latest.method} · {ago(m.latest.createdAt)}
                    </span>
                  </td>
                  <td className="r num">
                    {fmtMetric(s.metrics[metric.name]?.mean, metric)}{" "}
                    <span className="faint">{fmtCi(s.metrics[metric.name], metric)}</span>
                  </td>
                  <td className="r num">
                    {s.valid}/{s.trials}
                    {s.invalid > 0 && <span className="bad-text"> · {s.invalid} invalid</span>}
                  </td>
                  <td className="r num">{m.jobs}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {e.capabilities?.conditions["Agent scaffold"] && (
        <p className="catalog-note">
          <b>How CLI Agents take this benchmark:</b> {e.capabilities.conditions["Agent scaffold"]}
        </p>
      )}
      {admitted.length > 0 && (
        <p className="faint">
          The adapter admits: {admitted.join(", ")}
          {admitted.includes("cli") ? " (cli: any registered Agent)" : ""}.
        </p>
      )}
      <p className="faint">
        Scores are Orbit's valid-only means over tasks. The benchmark's own aggregation is on each
        job's page; agreement with officially published results is shown under Fidelity only when
        the adapter declares evidence for it.
      </p>
    </div>
  );
}

function ConditionsDetail({ e }: { e: CatalogEntry }) {
  const caps = e.listing?.capabilities;
  return (
    <div className="col" style={{ gap: 10 }}>
      <dl className="kv">
        <dt>Adapter</dt>
        <dd className="mono">{e.benchmark.adapter}</dd>
        <dt>Checkout</dt>
        <dd className="mono">{e.benchmark.path}</dd>
        <dt>Resources</dt>
        <dd className="mono">{e.benchmark.resources ?? "Adapter defaults"}</dd>
        <dt>Registered</dt>
        <dd>{dateTime(e.benchmark.createdAt)}</dd>
        {caps?.parity && (
          <>
            <dt>Parity evidence</dt>
            <dd>
              {FIDELITY[caps.parity.level].label}: {caps.parity.evidence}
              {caps.parity.checkedAt ? ` (${caps.parity.checkedAt})` : ""}
            </dd>
          </>
        )}
        {e.listing?.official && (
          <>
            <dt>Official aggregation</dt>
            <dd>
              {e.listing.official.name} · errors {e.listing.official.errors} · per{" "}
              {e.listing.official.unit}
            </dd>
          </>
        )}
        {Object.entries(caps?.conditions ?? {}).map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function CalibrateDialog({
  e,
  onClose,
  onStarted,
}: {
  e: CatalogEntry;
  onClose: () => void;
  onStarted: () => void;
}) {
  const caps = e.listing?.capabilities;
  const policyMode = Boolean(
    caps?.methods.includes("policy") &&
      !caps.methods.includes("empty") &&
      !caps.methods.includes("oracle"),
  );
  const canOracle =
    caps?.calibration?.oracle !== "none" && (!caps || caps.methods.includes("oracle"));
  const canRescore = caps?.rescore !== "none";
  const [sample, setSample] = useState(3);
  const [seeds, setSeeds] = useState(2);
  const [suite, setSuite] = useState("");
  const [oracle, setOracle] = useState(canOracle);
  const [rescore, setRescore] = useState(canRescore);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policyRef, setPolicyRef] = useState("");
  const [plan, setPlan] = useState("");
  const [budget, setBudget] = useState(20);
  const suites = e.listing?.coverage.suites.filter((s) => s.supported > 0) ?? [];
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api.benchCalibrate(
        policyMode
          ? {
              benchmark: e.benchmark.name,
              policyRef,
              samplePlan: JSON.parse(plan),
              budgetMin: budget,
              rescore,
            }
          : {
              benchmark: e.benchmark.name,
              sample,
              seeds,
              oracle,
              rescore,
              ...(suite ? { suite } : {}),
            },
      );
      toast(`Calibration started: ${job.id}`);
      onStarted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calibrate-title"
        onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") onClose();
        }}
      >
        <div className="dialog-h" id="calibrate-title">
          Calibrate {e.benchmark.name}
        </div>
        <div className="dialog-b" style={{ textAlign: "left" }}>
          {policyMode ? (
            <>
              <p className="muted">
                Checks a registered real model on 2–5 frozen episodes, with independent evidence
                verification. Native task success is separate from integration validity.
              </p>
              <div className="form-grid">
                <label htmlFor="cal-policy">Registered policy</label>
                <input
                  id="cal-policy"
                  className="input"
                  value={policyRef}
                  onChange={(ev) => setPolicyRef(ev.target.value)}
                />
                <label htmlFor="cal-plan">Frozen sample plan</label>
                <input
                  id="cal-plan"
                  className="input"
                  type="file"
                  accept=".json,application/json"
                  onChange={(ev) => {
                    const file = ev.target.files?.[0];
                    if (file)
                      void file
                        .text()
                        .then(setPlan)
                        .catch((err) => setError(String(err)));
                  }}
                />
                <label htmlFor="cal-budget">Total budget (minutes)</label>
                <input
                  id="cal-budget"
                  className="input"
                  type="number"
                  min={0.1}
                  max={30}
                  step={0.1}
                  value={budget}
                  onChange={(ev) => setBudget(Number(ev.target.value))}
                />
              </div>
              <p className="faint">
                The budget includes queueing, model startup, verification and rescore. Unfinished
                work is stopped at the deadline; cleanup is still confirmed.
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                Runs the do-nothing method{canOracle ? " and the reference solution" : ""} on
                sampled tasks. No model is called.
              </p>
              <div className="form-grid">
                <label htmlFor="cal-sample">Tasks</label>
                <input
                  id="cal-sample"
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={sample}
                  onChange={(ev) => setSample(Math.max(1, Number(ev.target.value) || 1))}
                />
                <label htmlFor="cal-seeds">Seeds</label>
                <input
                  id="cal-seeds"
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={seeds}
                  onChange={(ev) => setSeeds(Math.max(1, Number(ev.target.value) || 1))}
                />
                <label htmlFor="cal-suite">Suite</label>
                <select
                  id="cal-suite"
                  className="input"
                  value={suite}
                  onChange={(ev) => setSuite(ev.target.value)}
                >
                  <option value="">All suites (round robin)</option>
                  {suites.map((s) => (
                    <option key={s.suite} value={s.suite}>
                      {s.suite} ({s.supported})
                    </option>
                  ))}
                </select>
              </div>
              <label className="row">
                <input
                  type="checkbox"
                  checked={oracle}
                  disabled={!canOracle}
                  onChange={(ev) => setOracle(ev.target.checked)}
                />
                Reference solution (oracle)
                {!canOracle && <span className="faint"> — not available</span>}
              </label>
            </>
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={rescore}
              disabled={!canRescore}
              onChange={(ev) => setRescore(ev.target.checked)}
            />
            Rescore from saved evidence afterwards
          </label>
          {!policyMode && (
            <p className="faint">
              {sample * seeds * (oracle ? 2 : 1)} trial(s) · each starts its environment once.
            </p>
          )}
          {error && <div className="errbox">{error}</div>}
        </div>
        <div className="dialog-f">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || (policyMode && (!policyRef || !plan))}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Start calibration"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Identity and domains of a registration; they only change how the catalog groups and counts it. */
