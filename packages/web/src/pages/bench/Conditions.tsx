import type { BenchJob } from "../../lib/api.ts";
import { jobLabel } from "./common.tsx";
import { conditionDifferences, jobConditions } from "./conditions.ts";

export function Conditions({ jobs }: { jobs: BenchJob[] }) {
  const differences = conditionDifferences(jobs);
  return (
    <details className="card bench-conditions">
      <summary className="card-h">
        Evaluation conditions
        <span className="sub">
          {jobs.some((j) => !j.benchmarkSnapshot)
            ? "Historical settings missing"
            : "Saved at submission"}
          {differences.length ? ` · ${differences.length} differences` : ""}
        </span>
      </summary>
      <div className="card-b col" style={{ gap: 12 }}>
        {differences.length > 0 && (
          <p className="callout">
            Different conditions: {differences.join(", ")}. Interpret score changes in this context.
          </p>
        )}
        <p className="faint">
          Configuration is recorded, but external websites, model services and files at the same
          path may change. Missing historical settings are not inferred from the current
          registration.
        </p>
        {jobs.map((job) => (
          <section key={job.id}>
            {jobs.length > 1 && <h3 className="section-title">{jobLabel(job)}</h3>}
            <dl className="bench-condition-list">
              {Object.entries(jobConditions(job)).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </details>
  );
}
