// The benchmark catalog (design §9.15): every registered benchmark grouped by integration category,
// with four separate facts per row — what it can run, whether its integration was calibrated,
// which real methods ran and how it compares with the original. A row expands into its evidence.
import { benchCategory } from "@zjunlp/orbit/categories";
import { fmtCi, fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { Fragment, useState } from "react";
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconChevron,
  IconChevronDown,
  IconLoader,
  IconX,
} from "../../components/icons.tsx";
import { Empty, Link, Loading, toast } from "../../components/ui.tsx";
import {
  api,
  type CalibrationCheck,
  type CalibrationReport,
  type CatalogEntry,
} from "../../lib/api.ts";
import {
  BENCH_CATEGORIES,
  BENCH_DOMAINS,
  CATEGORY_LABELS,
  DOMAIN_LABELS,
} from "../../lib/category.ts";
import { ago, dateTime, jobPath, trialPath } from "../../lib/format.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import "./catalog.css";
import "../hub.css";

type CalState = "passed" | "failed" | "running" | "none";

/** The state of a benchmark's latest calibration. */
export function calState(e: CatalogEntry): CalState {
  const r = e.calibrations[0];
  if (!r) return "none";
  if (r.phase !== "done") return "running";
  return r.calibrated ? "passed" : "failed";
}

const FIDELITY: Record<CatalogEntry["fidelity"], { label: string; title: string }> = {
  experimental: {
    label: "Experimental",
    title: "No passed calibration yet; scores are not yet trusted",
  },
  calibrated: {
    label: "Calibrated (sample)",
    title:
      "The latest calibration passed: validity, expected empty/oracle scores, repeats, cleanup",
  },
  "sample-aligned": {
    label: "Sample-aligned",
    title: "The adapter declares agreement with the native runner on sampled tasks",
  },
  "agent-compared": {
    label: "Agent-compared",
    title: "The adapter declares a real Agent / policy scored as officially reported",
  },
};

const identity = (e: CatalogEntry) =>
  e.capabilities?.conditions.Identity ?? e.capabilities?.conditions.Benchmark;

/** The group a row belongs to: its declared category, or why it has none yet. */
const groupOf = (e: CatalogEntry) =>
  benchCategory(e.capabilities ?? undefined) ??
  (e.listing ? "none" : e.listingError ? "failed" : "listing");
const GROUPS = [...BENCH_CATEGORIES, "none", "listing", "failed"] as const;
const GROUP_LABEL = (g: (typeof GROUPS)[number]) =>
  g === "none"
    ? "Category not declared"
    : g === "listing"
      ? "Listing tasks…"
      : g === "failed"
        ? "Task listing failed"
        : CATEGORY_LABELS[g];

/** Registrations with the same identity are one benchmark (design §9.16). */
export const benchmarkKey = (e: CatalogEntry) => e.identity.id;
/** Distinct benchmarks among entries. */
export const distinct = (entries: CatalogEntry[]) => new Set(entries.map(benchmarkKey)).size;

type Evidence =
  | "calibrated"
  | "failed"
  | "uncalibrated"
  | "running"
  | "real"
  | "no-real"
  | "parity";
const EVIDENCE: { key: Evidence; label: string; test: (e: CatalogEntry) => boolean }[] = [
  { key: "calibrated", label: "Passed sample calibration", test: (e) => calState(e) === "passed" },
  { key: "failed", label: "Calibration failed", test: (e) => calState(e) === "failed" },
  { key: "uncalibrated", label: "Not calibrated", test: (e) => calState(e) === "none" },
  { key: "running", label: "Calibration running", test: (e) => calState(e) === "running" },
  { key: "real", label: "Real methods ran", test: (e) => e.methods.length > 0 },
  { key: "no-real", label: "No real methods yet", test: (e) => e.methods.length === 0 },
  { key: "parity", label: "Parity evidence", test: (e) => Boolean(e.capabilities?.parity) },
];
const DOMAIN_KEYS = [...BENCH_DOMAINS, "unlabeled"] as const;
const domainLabel = (d: string) =>
  d === "unlabeled" ? "Unlabeled" : (DOMAIN_LABELS[d as keyof typeof DOMAIN_LABELS] ?? d);
const inDomain = (e: CatalogEntry, d: string) =>
  d === "unlabeled" ? e.domains.length === 0 : e.domains.includes(d);

/**
 * The Benchmarks page body: facets (category, domain, evidence) with counts, a grouped table and a
 * category × domain coverage matrix. Counts are distinct benchmarks, not registrations.
 */
export function BenchCatalogView() {
  const loc = useLocation();
  const busy = (d?: CatalogEntry[]) =>
    (d ?? []).some((e) => e.refreshing || calState(e) === "running");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const catalog = useAsync(() => api.benchCatalog().then((r) => r.entries), [], {
    poll: true,
    pollMs: 4000,
  });
  const refreshListings = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await api.benchCatalog((catalog.data ?? []).map((e) => e.benchmark.name));
      catalog.reload();
    } catch (error) {
      setRefreshError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const q = (loc.query.get("q") ?? "").toLowerCase();
  const category = loc.query.get("category") ?? "all";
  const domain = loc.query.get("domain") ?? "all";
  const ev = (loc.query.get("ev") ?? "all") as Evidence | "all";
  const view = loc.query.get("view") === "matrix" ? "matrix" : "table";
  const open = loc.query.get("open");
  const entries = catalog.data ?? [];
  const searched = entries.filter((e) =>
    `${e.benchmark.name} ${e.identity.name} ${e.identity.id} ${identity(e) ?? ""} ${e.benchmark.adapter} ${e.domains.join(" ")} ${e.tags.join(" ")}`
      .toLowerCase()
      .includes(q),
  );
  const pass = (e: CatalogEntry, skip?: "category" | "domain" | "ev") =>
    (skip === "category" || category === "all" || groupOf(e) === category) &&
    (skip === "domain" || domain === "all" || inDomain(e, domain)) &&
    (skip === "ev" || ev === "all" || (EVIDENCE.find((x) => x.key === ev)?.test(e) ?? true));
  const shown = searched.filter((e) => pass(e));
  const groups = GROUPS.map((c) => ({ c, rows: shown.filter((e) => groupOf(e) === c) })).filter(
    (g) => g.rows.length,
  );

  if (catalog.error && !catalog.data)
    return (
      <div className="callout" role="alert">
        {catalog.error}
      </div>
    );
  if (!catalog.data) return <Loading what="Loading the catalog" />;
  if (!entries.length)
    return (
      <Empty title="No benchmarks registered">
        <p>Prepare a benchmark and register its adapter on the daemon host:</p>
        <code>orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py</code>
      </Empty>
    );
  const categories = new Set(
    entries.map((e) => benchCategory(e.capabilities ?? undefined)).filter(Boolean),
  );
  const domains = new Set(entries.flatMap((e) => e.domains));
  const facet = (
    title: string,
    param: "category" | "domain" | "ev",
    current: string,
    items: { key: string; label: string; test: (e: CatalogEntry) => boolean }[],
  ) => (
    <div className="facet">
      <div className="facet-h">{title}</div>
      {items.map((it) => {
        const n = distinct(searched.filter((e) => pass(e, param) && it.test(e)));
        if (!n && current !== it.key) return null;
        return (
          <button
            key={it.key}
            type="button"
            className={`facet-item${current === it.key ? " on" : ""}`}
            aria-pressed={current === it.key}
            onClick={() => setQuery({ [param]: current === it.key ? null : it.key })}
          >
            <span className="ellipsis">{it.label}</span>
            <span className="num faint">{n}</span>
          </button>
        );
      })}
    </div>
  );
  const active = [
    category !== "all" && { k: "category", label: GROUP_LABEL(category as never) },
    domain !== "all" && { k: "domain", label: domainLabel(domain) },
    ev !== "all" && { k: "ev", label: EVIDENCE.find((x) => x.key === ev)?.label ?? ev },
  ].filter(Boolean) as { k: string; label: string }[];
  return (
    <div className="col" style={{ gap: 14 }}>
      {(catalog.error || refreshError) && (
        <div className="callout" role="alert">
          Connection problem; showing the last loaded catalog. {catalog.error ?? refreshError}
        </div>
      )}
      <div className="hub-stats">
        <div className="hub-stat">
          <b className="num">{distinct(entries)}</b>
          <span>benchmarks</span>
          <small className="faint">{entries.length} registrations</small>
        </div>
        <div className="hub-stat">
          <b className="num">
            {categories.size}
            <span className="faint">/7</span>
          </b>
          <span>categories</span>
          <small className="faint">how the subject interacts</small>
        </div>
        <div className="hub-stat">
          <b className="num">{domains.size}</b>
          <span>domains</span>
          <small className="faint">
            {distinct(entries.filter((e) => !e.domains.length))} benchmarks unlabeled
          </small>
        </div>
        <div className="hub-stat good">
          <b className="num">{distinct(entries.filter((e) => calState(e) === "passed"))}</b>
          <span>sample-calibrated</span>
          <small className="faint">integration judged correctly</small>
        </div>
        <div className="hub-stat">
          <b className="num">{distinct(entries.filter((e) => e.methods.length))}</b>
          <span>with real methods</span>
          <small className="faint">a model or policy ran</small>
        </div>
      </div>
      <div className="bench-home-toolbar">
        <input
          className="input"
          type="search"
          aria-label="Search benchmarks"
          placeholder="Search benchmarks, sources, domains or adapters"
          value={loc.query.get("q") ?? ""}
          onChange={(e) => setQuery({ q: e.target.value || null })}
        />
        <span className="seg" title="View">
          <button
            type="button"
            className={`btn sm${view === "table" ? " on" : " ghost"}`}
            aria-pressed={view === "table"}
            onClick={() => setQuery({ view: null })}
          >
            Table
          </button>
          <button
            type="button"
            className={`btn sm${view === "matrix" ? " on" : " ghost"}`}
            aria-pressed={view === "matrix"}
            onClick={() => setQuery({ view: "matrix" })}
          >
            Coverage matrix
          </button>
        </span>
        <button
          type="button"
          className="btn"
          title="List every benchmark's tasks again"
          disabled={refreshing}
          onClick={() => void refreshListings()}
        >
          {refreshing || busy(entries) ? <IconLoader size={13} className="spin" /> : null} Refresh
          listings
        </button>
      </div>
      <div className="hub-layout">
        <aside className="facets" aria-label="Filters">
          {facet(
            "Category",
            "category",
            category,
            GROUPS.map((c) => ({ key: c, label: GROUP_LABEL(c), test: (e) => groupOf(e) === c })),
          )}
          {facet(
            "Domain",
            "domain",
            domain,
            DOMAIN_KEYS.map((d) => ({
              key: d,
              label: domainLabel(d),
              test: (e) => inDomain(e, d),
            })),
          )}
          {facet(
            "Evidence",
            "ev",
            ev,
            EVIDENCE.map((x) => ({ key: x.key, label: x.label, test: x.test })),
          )}
        </aside>
        <div className="col" style={{ gap: 10, minWidth: 0 }}>
          {active.length > 0 && (
            <div className="active-filters">
              {active.map((f) => (
                <button
                  key={f.k}
                  type="button"
                  className="chip link"
                  onClick={() => setQuery({ [f.k]: null })}
                  aria-label={`Remove filter ${f.label}`}
                >
                  {f.label} <IconX size={11} />
                </button>
              ))}
              <span className="faint">
                {distinct(shown)} of {distinct(entries)} benchmarks
              </span>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setQuery({ q: null, category: null, domain: null, ev: null })}
              >
                Clear all
              </button>
            </div>
          )}
          {view === "matrix" ? (
            <CoverageMatrix
              entries={searched.filter((e) => pass(e, "category") && pass(e, "domain"))}
            />
          ) : !shown.length ? (
            <Empty title="No matching benchmarks">Change the search or filters.</Empty>
          ) : (
            <section className="card matrix-wrap">
              <table className="table catalog-table">
                <colgroup>
                  <col style={{ width: 34 }} />
                  <col style={{ minWidth: 220 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 172 }} />
                  <col style={{ width: 168 }} />
                  <col style={{ width: 124 }} />
                  <col style={{ width: 96 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th />
                    <th>Benchmark · domains</th>
                    <th>Tasks</th>
                    <th>Calibration</th>
                    <th>Real methods</th>
                    <th>Fidelity</th>
                    <th />
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.c}>
                    <tr className="catalog-group-row">
                      <td colSpan={7}>
                        {GROUP_LABEL(g.c)}
                        <span className="count">
                          {distinct(g.rows)} benchmark{distinct(g.rows) === 1 ? "" : "s"}
                          {g.rows.length > distinct(g.rows) && ` · ${g.rows.length} registrations`}
                        </span>
                      </td>
                    </tr>
                    {[...new Set(g.rows.map(benchmarkKey))].map((key) => {
                      const regs = g.rows.filter((e) => benchmarkKey(e) === key);
                      const first = regs[0] as CatalogEntry;
                      return (
                        <Fragment key={key}>
                          {regs.length > 1 && (
                            <tr className="catalog-identity-row">
                              <td />
                              <td colSpan={6}>
                                <b>{first.identity.name}</b>
                                {first.identity.version && (
                                  <span className="faint mono"> {first.identity.version}</span>
                                )}
                                <span className="faint"> · {regs.length} registrations</span>
                                <DomainChips e={first} />
                              </td>
                            </tr>
                          )}
                          {regs.map((e) => (
                            <Fragment key={e.benchmark.name}>
                              <Row
                                e={e}
                                nested={regs.length > 1}
                                open={open === e.benchmark.name}
                                toggle={() =>
                                  setQuery({
                                    open: open === e.benchmark.name ? null : e.benchmark.name,
                                    ptab: null,
                                  })
                                }
                                reload={catalog.reload}
                              />
                              {open === e.benchmark.name && (
                                <tr className="catalog-detail-row">
                                  <td colSpan={7}>
                                    <Detail e={e} />
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DomainChips({ e }: { e: CatalogEntry }) {
  if (!e.domains.length && !e.tags.length)
    return <span className="domain-chip none">unlabeled</span>;
  return (
    <span className="domain-chips">
      {e.domains.map((d) => (
        <span key={d} className={`domain-chip d-${d}`}>
          {domainLabel(d)}
        </span>
      ))}
      {e.tags.slice(0, 4).map((t) => (
        <span key={t} className="domain-chip tag">
          {t}
        </span>
      ))}
      {e.tags.length > 4 && <span className="faint">+{e.tags.length - 4}</span>}
    </span>
  );
}

/** Category × domain: distinct benchmarks (and how many passed calibration); click to filter. */
export function CoverageMatrix({ entries }: { entries: CatalogEntry[] }) {
  const cats = BENCH_CATEGORIES.filter((c) => entries.some((e) => groupOf(e) === c));
  const others = GROUPS.filter((g) => !BENCH_CATEGORIES.includes(g as never)).filter((g) =>
    entries.some((e) => groupOf(e) === g),
  );
  const rows = [...cats, ...others];
  const cols = DOMAIN_KEYS.filter((d) => entries.some((e) => inDomain(e, d)));
  if (!rows.length)
    return <Empty title="No matching benchmarks">Change the search or filters.</Empty>;
  return (
    <section className="card">
      <div className="matrix-wrap">
        <table className="table coverage-matrix">
          <thead>
            <tr>
              <th>Category \\ domain</th>
              {cols.map((d) => (
                <th key={d} className="c">
                  {domainLabel(d)}
                </th>
              ))}
              <th className="c">All</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const inRow = entries.filter((e) => groupOf(e) === c);
              return (
                <tr key={c}>
                  <th scope="row">{GROUP_LABEL(c)}</th>
                  {cols.map((d) => {
                    const cell = inRow.filter((e) => inDomain(e, d));
                    const n = distinct(cell);
                    const cal = distinct(cell.filter((e) => calState(e) === "passed"));
                    return (
                      <td key={d} className="c">
                        {n ? (
                          <button
                            type="button"
                            className="matrix-cell"
                            style={{ "--a": Math.min(1, 0.18 + n * 0.16) } as React.CSSProperties}
                            title={`${n} benchmark(s), ${cal} passed sample calibration`}
                            onClick={() => setQuery({ category: c, domain: d, view: null })}
                          >
                            <b>{n}</b>
                            {cal > 0 && <small> · {cal}✓</small>}
                          </button>
                        ) : (
                          <span className="faint">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="c num">{distinct(inRow)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-b faint" style={{ fontSize: 12 }}>
        Cells count distinct benchmarks (✓: passed sample calibration). A benchmark with several
        domains appears in each; the matrix shows coverage, not scores.
      </div>
    </section>
  );
}

function Row({
  e,
  open,
  toggle,
  reload,
  nested = false,
}: {
  e: CatalogEntry;
  open: boolean;
  toggle: () => void;
  reload: () => void;
  /** One of several registrations of the same benchmark (shown under its identity row). */
  nested?: boolean;
}) {
  const [calibrating, setCalibrating] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const cov = e.listing?.coverage;
  const metric = primaryMetric(resolveMetrics(e.listing?.metrics ?? []));
  const profiles = e.capabilities?.profiles ?? [];
  return (
    <tr className={`click${open ? " sel" : ""}`} onClick={toggle}>
      <td className="catalog-toggle">
        <button
          type="button"
          className="btn ghost sm icon"
          aria-label={open ? `Collapse ${e.benchmark.name}` : `Expand ${e.benchmark.name}`}
          aria-expanded={open}
          onClick={(ev) => {
            ev.stopPropagation();
            toggle();
          }}
        >
          {open ? <IconChevronDown size={15} /> : <IconChevron size={15} />}
        </button>
      </td>
      <td className={nested ? "nested" : ""}>
        <b>{nested ? e.benchmark.name : e.identity.name}</b>
        {!nested && e.identity.name !== e.benchmark.name && (
          <span className="faint mono"> {e.benchmark.name}</span>
        )}
        {!nested && <DomainChips e={e} />}
        {identity(e) && (
          <div className="catalog-sub clamp2" title={identity(e)}>
            {identity(e)}
          </div>
        )}
        {profiles.length > 0 && (
          <div className="faint mono catalog-sub">{profiles.join(" · ")}</div>
        )}
      </td>
      <td>
        {cov ? (
          <>
            <span className="num">
              {cov.supported}
              <span className="faint"> / {cov.total}</span>
            </span>
            {cov.supported < cov.total && (
              <div className="faint catalog-sub">{cov.total - cov.supported} unsupported</div>
            )}
            <div className="catalog-bar" aria-hidden>
              <span style={{ width: `${(100 * cov.supported) / Math.max(cov.total, 1)}%` }} />
            </div>
          </>
        ) : e.listingError ? (
          <span className="bad-text" title={e.listingError}>
            <IconAlert size={12} /> listing failed
          </span>
        ) : (
          <span className="faint">
            <IconLoader size={12} className="spin" /> listing…
          </span>
        )}
      </td>
      <td>
        <CalibrationCell e={e} />
      </td>
      <td>
        {e.methods.length === 0 ? (
          <span className="faint">No real evaluations yet</span>
        ) : (
          <div className="catalog-methods">
            {e.methods.slice(0, 2).map((m) => {
              const s = m.latest.summary;
              return (
                <Link
                  key={m.key}
                  className="catalog-method link"
                  href={jobPath(m.latest.job)}
                  title={`${m.key} · ${m.jobs} job(s) · latest ${dateTime(m.latest.createdAt)}`}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <span className="ellipsis">{m.model ?? m.agent}</span>
                  <span className="num">
                    <b>{fmtMetric(s.metrics[metric.name]?.mean, metric)}</b>{" "}
                    <span className="faint">
                      {s.valid}/{s.trials} valid
                    </span>
                  </span>
                </Link>
              );
            })}
            {e.methods.length > 2 && <span className="faint">+{e.methods.length - 2}</span>}
          </div>
        )}
      </td>
      <td>
        <span className={`chip fid-${e.fidelity}`} title={FIDELITY[e.fidelity].title}>
          {FIDELITY[e.fidelity].label}
        </span>
      </td>
      <td className="r row-actions" onClick={(ev) => ev.stopPropagation()}>
        <button
          type="button"
          className="btn sm"
          disabled={!e.listing || calState(e) === "running"}
          title={
            !e.listing
              ? "Waiting for the task listing"
              : calState(e) === "running"
                ? "A calibration is running"
                : "Run the calibration methods on sampled tasks"
          }
          onClick={() => setCalibrating(true)}
        >
          Calibrate
        </button>
        <Link
          className="btn sm"
          href={`/bench/new?benchmark=${encodeURIComponent(e.benchmark.name)}`}
        >
          Evaluate
        </Link>
        <button
          type="button"
          className="btn sm ghost"
          title="Set what benchmark this is and its domains"
          onClick={() => setLabeling(true)}
        >
          Labels
        </button>
        {labeling && (
          <LabelsDialog
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
      </td>
    </tr>
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
  const tabs = ["calibration", "coverage", "methods", "conditions"] as const;
  const tab = (tabs as readonly string[]).includes(loc.query.get("ptab") ?? "")
    ? (loc.query.get("ptab") as (typeof tabs)[number])
    : "calibration";
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
              setQuery({ ptab: t === "calibration" ? null : t });
            }}
          >
            {t[0]?.toUpperCase()}
            {t.slice(1)}
          </a>
        ))}
      </nav>
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
function LabelsDialog({
  e,
  onClose,
  onSaved,
}: {
  e: CatalogEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const own = e.benchmark.labels;
  const [id, setId] = useState(own?.identity?.id ?? e.identity.id);
  const [name, setName] = useState(own?.identity?.name ?? e.identity.name);
  const [version, setVersion] = useState(own?.identity?.version ?? e.identity.version ?? "");
  const [domains, setDomains] = useState<string[]>(own?.domains ?? [...e.domains, ...e.tags]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (d: string) =>
    setDomains((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]));
  const save = async (clear = false) => {
    setBusy(true);
    setError(null);
    try {
      await api.benchLabel(
        e.benchmark.name,
        clear
          ? {}
          : {
              identity: {
                id: id.trim(),
                name: name.trim() || id.trim(),
                ...(version.trim() ? { version: version.trim() } : {}),
              },
              domains,
            },
      );
      toast(clear ? "Labels removed" : "Labels saved");
      onSaved();
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
        aria-labelledby="labels-title"
        onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") onClose();
        }}
      >
        <div className="dialog-h" id="labels-title">
          Labels of {e.benchmark.name}
        </div>
        <div className="dialog-b" style={{ textAlign: "left" }}>
          <p className="muted">
            Registrations with the same id count as one benchmark. Labels do not change how it runs.
            Now:{" "}
            {e.identitySource === "derived"
              ? "derived from the registration name"
              : `from the ${e.identitySource}`}
            .
          </p>
          <div className="form-grid">
            <label htmlFor="lab-id">Id</label>
            <input
              id="lab-id"
              className="input mono"
              value={id}
              onChange={(x) => setId(x.target.value)}
            />
            <label htmlFor="lab-name">Name</label>
            <input
              id="lab-name"
              className="input"
              value={name}
              onChange={(x) => setName(x.target.value)}
            />
            <label htmlFor="lab-version">Version</label>
            <input
              id="lab-version"
              className="input"
              value={version}
              placeholder="optional"
              onChange={(x) => setVersion(x.target.value)}
            />
          </div>
          <div className="conv-field-l">Domains</div>
          <div className="domain-picker">
            {BENCH_DOMAINS.map((d) => (
              <label key={d} className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={domains.includes(d)} onChange={() => toggle(d)} />
                {DOMAIN_LABELS[d]}
              </label>
            ))}
          </div>
          {domains.some((d) => !(BENCH_DOMAINS as readonly string[]).includes(d)) && (
            <p className="faint">
              Kept as tags:{" "}
              {domains.filter((d) => !(BENCH_DOMAINS as readonly string[]).includes(d)).join(", ")}
            </p>
          )}
          {error && <div className="errbox">{error}</div>}
        </div>
        <div className="dialog-f">
          {own && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Remove labels
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !id.trim()}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
