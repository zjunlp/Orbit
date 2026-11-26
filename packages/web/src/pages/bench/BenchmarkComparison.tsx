import type { SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { TAXONOMY_FIELDS, TAXONOMY_GROUPS } from "@zjunlp/orbit/taxonomy";
import { Fragment } from "react";
import { Link } from "../../components/ui.tsx";
import { setQuery, useLocation } from "../../lib/router.ts";
import type { TaxonomyFilters } from "../../lib/taxonomy.ts";
import { TaxonomyTags } from "./Catalog.tsx";
import { comparisonProfile, comparisonProfileKey } from "./comparison-model.ts";
import "./comparison.css";

export function BenchmarkComparison({
  entries,
  filters,
}: {
  entries: SupportedBenchmark[];
  filters: TaxonomyFilters;
}) {
  const { query } = useLocation();
  const profiles = entries.map((entry) =>
    comparisonProfile(entry, query.get(comparisonProfileKey(entry.id)), filters),
  );
  if (entries.length < 2)
    return (
      <section className="library-empty" aria-label="Benchmark comparison">
        <h2>Select at least two benchmark families</h2>
        <p>
          Choose up to four families from the cards to compare their protocols and supported scope.
        </p>
        <button type="button" className="btn" onClick={() => setQuery({ view: null })}>
          Browse benchmark cards
        </button>
      </section>
    );
  return (
    <section className="benchmark-comparison" aria-label="Benchmark comparison">
      <h2>Compare benchmark families</h2>
      <p className="muted">
        Review task protocols, integration scope and verification facts. Classification describes
        one selected protocol per family; different profiles are kept separate. Filters affect the
        cards and initial profile choice; selected families remain here even when hidden by filters.
      </p>
      <p className="comparison-scroll-hint">
        Scroll the table sideways to review all selected families.
      </p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll this overflow region. */}
      <section className="comparison-scroll" aria-label="Benchmark comparison table" tabIndex={0}>
        <table style={{ minWidth: 170 + entries.length * 270 }}>
          <caption>Benchmark selection comparison: scope and facts</caption>
          <thead>
            <tr>
              <th scope="col">Benchmark family</th>
              {entries.map((entry) => (
                <th scope="col" key={entry.id}>
                  {entry.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Description</th>
              {entries.map((entry) => (
                <td key={entry.id}>{entry.description}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Protocol profile</th>
              {entries.map((entry, index) => (
                <td key={entry.id}>
                  {entry.taxonomyGroups.length > 1 ? (
                    <select
                      className="input"
                      aria-label={`Protocol profile for ${entry.name}`}
                      value={profiles[index]}
                      onChange={(event) =>
                        setQuery({ [comparisonProfileKey(entry.id)]: event.target.value })
                      }
                    >
                      {entry.taxonomyGroups.map((group, profile) => (
                        <option key={group.label} value={profile}>
                          {group.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (entry.taxonomyGroups[0]?.label ?? "No protocol profiles published")
                  )}
                </td>
              ))}
            </tr>
            {TAXONOMY_GROUPS.map((group) => (
              <tr key={group.id}>
                <th scope="row">{group.label}</th>
                {entries.map((entry, index) => (
                  <td key={entry.id}>
                    <dl className="comparison-taxonomy">
                      {group.fields.map((field) => (
                        <Fragment key={field}>
                          <dt>{TAXONOMY_FIELDS[field].label}</dt>
                          <dd>
                            <TaxonomyTags
                              e={{ taxonomy: entry.taxonomyGroups[profiles[index] ?? 0]?.taxonomy }}
                              field={field}
                              limit={20}
                            />
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Suites and recipes</th>
              {entries.map((entry) => (
                <td key={entry.id}>
                  {entry.suites.length ? entry.suites.join(" · ") : "Not specified"}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Integrations and scope</th>
              {entries.map((entry) => (
                <td key={entry.id}>
                  {entry.integrations.map((route) => (
                    <div className="comparison-item" key={route.name}>
                      <a href={route.url} target="_blank" rel="noreferrer">
                        {route.name} ↗
                      </a>
                      <p>{route.scope}</p>
                    </div>
                  ))}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Verification facts</th>
              {entries.map((entry) => (
                <td key={entry.id}>
                  <p>{entry.verification.detail}</p>
                  <a href={entry.verification.url} target="_blank" rel="noreferrer">
                    Validation notes ↗
                  </a>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Local setups</th>
              {entries.map((entry) => (
                <td key={entry.id}>
                  <p>
                    {entry.registrationNames.length
                      ? `${entry.registrationNames.length} local setup${entry.registrationNames.length === 1 ? "" : "s"} registered`
                      : "No local setup registered"}
                  </p>
                  {entry.registrationNames.length > 0 && (
                    <details>
                      <summary>Choose a local setup</summary>
                      {entry.registrationNames.map((name) => (
                        <div className="comparison-item" key={name}>
                          <p>{name}</p>
                          <div className="comparison-setup-links">
                            <Link
                              href={`/benchmarks?mode=local&setup=${encodeURIComponent(name)}&open=${encodeURIComponent(name)}`}
                            >
                              View setup
                            </Link>
                            <Link href={`/bench/new?benchmark=${encodeURIComponent(name)}`}>
                              Evaluate
                            </Link>
                          </div>
                        </div>
                      ))}
                    </details>
                  )}
                  <p className="muted">
                    Registration alone does not establish readiness or calibration.
                  </p>
                  <Link
                    className="btn sm"
                    href={`/benchmarks?mode=resources&family=${encodeURIComponent(entry.id)}`}
                  >
                    Prepare resources
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>
    </section>
  );
}
