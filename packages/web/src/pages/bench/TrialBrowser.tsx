import { type MetricDef, metricValue } from "@zjunlp/orbit/metrics";
import { sampleLabel } from "@zjunlp/orbit/naming";
import { MetricSwitch, ScoreCell } from "../../components/BenchMetrics.tsx";
import { Link } from "../../components/ui.tsx";
import type { BenchJob, MethodSummary, Trial } from "../../lib/api.ts";
import { trialPath } from "../../lib/format.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { matchesTrial, unfinishedTask } from "./conditions.ts";
import { JobMatrix } from "./JobMatrix.tsx";
import { RunLinks } from "./TrialCell.tsx";

export function TrialBrowser(props: {
  job: BenchJob;
  trials: Trial[];
  summary: MethodSummary[];
  metric: MetricDef;
  metrics: MetricDef[];
  setMetric: (name: string) => void;
}) {
  const { job, trials, metric } = props;
  const { query } = useLocation();
  const view = query.get("view") ?? "list";
  const filter = query.get("result") ?? "all";
  const method = query.get("method") ?? "";
  const seed = query.get("seed") ?? "";
  const task = query.get("task") ?? "";
  const search = query.get("q") ?? "";
  const shown = trials.filter(
    (t) =>
      (!method || t.method === method) &&
      (!seed || (t.sampleRef ?? String(t.seed)) === seed) &&
      (!task || t.task === task) &&
      t.task.toLowerCase().includes(search.toLowerCase()) &&
      matchesTrial(t, job, filter),
  );
  const selectedTasks = [...new Set(shown.map((t) => t.task))];
  const newQuery = new URLSearchParams({ from: job.id });
  for (const taskId of selectedTasks) newQuery.append("task", taskId);
  const incomplete = trials.filter((t) => unfinishedTask(t, job)).length;
  const issues = trials.filter((t) => matchesTrial(t, job, "issues")).length;
  return (
    <section className="col" style={{ gap: 12 }}>
      <div className="bench-filters">
        <h3 className="section-title">Tasks</h3>
        <span className="faint">
          {shown.length}/{trials.length} trials
        </span>
        <div className="spacer" />
        <div className="seg">
          {["list", "matrix"].map((v) => (
            <button
              type="button"
              key={v}
              className={view === v ? "on" : ""}
              aria-pressed={view === v}
              onClick={() => setQuery({ view: v })}
            >
              {v === "list" ? "List" : "Matrix"}
            </button>
          ))}
        </div>
        {selectedTasks.length > 0 && !job.spec.samplePlan && (
          <Link
            className="btn sm"
            href={`/bench/new?${newQuery}`}
            title="Creates a new evaluation for these tasks, with all original methods and repetitions"
          >
            New evaluation from these tasks
          </Link>
        )}
      </div>
      <div className="bench-filters">
        <input
          className="input"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setQuery({ q: e.target.value, task: null })}
        />
        <label>
          Result
          <select
            className="input"
            value={filter}
            onChange={(e) => setQuery({ result: e.target.value })}
          >
            <option value="all">All results</option>
            {job.capabilities?.scoreKind === "binary" && (
              <option value="unfinished">Task not completed ({incomplete})</option>
            )}
            <option value="issues">Evaluation issues ({issues})</option>
            <option value="active">In progress</option>
          </select>
        </label>
        <label>
          Method
          <select
            className="input"
            value={method}
            onChange={(e) => setQuery({ method: e.target.value })}
          >
            <option value="">All methods</option>
            {job.spec.methods.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {job.spec.samplePlan && (
          <label>
            Initial state
            <select
              className="input"
              value={seed}
              onChange={(e) => setQuery({ seed: e.target.value })}
            >
              <option value="">All samples</option>
              {job.spec.samplePlan.items.map((sample) => (
                <option key={sample.sampleId} value={sample.sampleId}>
                  {sample.taskId} · init {sample.initialStateId} · repeat {sample.repetition}
                </option>
              ))}
            </select>
          </label>
        )}
        {(job.spec.seeds ?? 1) > 1 && (
          <label>
            Seed
            <select
              className="input"
              value={seed}
              onChange={(e) => setQuery({ seed: e.target.value })}
            >
              <option value="">All seeds</option>
              {Array.from({ length: job.spec.seeds ?? 1 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {task && (
          <button className="btn sm" type="button" onClick={() => setQuery({ task: null })}>
            Clear task: {task}
          </button>
        )}
        <MetricSwitch metrics={props.metrics} value={metric} onChange={props.setMetric} />
      </div>
      {shown.length === 0 ? (
        <div className="card card-b faint">No trials match these filters.</div>
      ) : view === "matrix" ? (
        <>
          <JobMatrix {...props} trials={shown} />
          <p className="faint">
            Filters apply to trial cells; the mean row includes the entire evaluation.
          </p>
        </>
      ) : (
        <div className="card bench-trial-table">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Method / seed</th>
                <th>{metric.label}</th>
                <th>Task result</th>
                <th>Phase</th>
                <th>Validity</th>
                <th>Cleanup</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td className="task-cell">
                    <Link href={trialPath(job.id, t.id)}>{t.task}</Link>
                    {t.outcome?.issues.length ? (
                      <div className="faint">{t.outcome.issues.join("; ")}</div>
                    ) : null}
                  </td>
                  <td>
                    {t.method}
                    <span className="faint"> · {sampleLabel(t)}</span>
                  </td>
                  <td>
                    <ScoreCell
                      metric={metric}
                      value={t.outcome ? metricValue(t.outcome, metric.name) : null}
                      evaluation={t.outcome?.evaluation ?? "pending"}
                      href={trialPath(job.id, t.id)}
                    />
                  </td>
                  <td>
                    {unfinishedTask(t, job) ? (
                      <span className="chip warn">Not completed</span>
                    ) : job.capabilities?.scoreKind === "binary" &&
                      t.outcome?.evaluation === "valid" &&
                      t.outcome.score === t.outcome.maxScore ? (
                      <span className="chip good">Success</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {t.state}
                    {t.history.length > 0 && t.state !== "done" ? (
                      <div className="faint">Rechecking saved output</div>
                    ) : null}
                  </td>
                  <td>{t.outcome?.evaluation ?? "Pending"}</td>
                  <td>{t.outcome?.cleanup ?? "—"}</td>
                  <td>
                    <RunLinks t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
