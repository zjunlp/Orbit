// One bench trial (task × method × seed) on one page: its outcome and issues, the solve → verify
// timeline with measured use, then tabs. The adapter's `review` decides the content tabs (one per
// declared file, rendered by kind; Grader from its items; Details for its facts and any fields this
// UI does not know). Without a review (older trials and adapters) the page guesses: the solve's
// Markdown report and the verifier's JSON. The Agent session and all outputs are always there.
import { fmtMetric, type MetricDef, metricValue, resolveMetrics } from "@zjunlp/orbit/metrics";
import { Fragment, useEffect, useMemo, useState } from "react";
import { IconAlert, IconFile, IconFlask } from "../components/icons.tsx";
import { joinPath, Markdown } from "../components/Markdown.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading, StateBadge, toast, useNow } from "../components/ui.tsx";
import {
  api,
  type BenchJob,
  fileUrl,
  type Outcome,
  type Review,
  type ReviewFile,
  type ReviewItem,
  type Run,
  type Scoring,
  type Trial,
} from "../lib/api.ts";
import {
  bytes,
  dateTime,
  duration,
  fmtScore,
  isActive,
  jobPath,
  runDuration,
  runPath,
  trialPath,
} from "../lib/format.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { reportCandidates } from "../lib/report.ts";
import { extraFields, resolveKind, showValue } from "../lib/review.ts";
import { navigate, setQuery, useLocation } from "../lib/router.ts";
import { upsertRun, useRun } from "../lib/runs-store.ts";
import { useAsync } from "../lib/use.ts";
import { ArtifactsTab, Csv } from "./run/Artifacts.tsx";
import { SessionTab } from "./run/Session.tsx";
import { ConversationFile } from "./trial/Conversation.tsx";
import { EpisodeFile } from "./trial/Episode.tsx";
import { TrajectoryFile } from "./trial/Trajectory.tsx";

interface TabDef {
  key: string;
  label: string;
}

/** A run from the live store, else fetched once. */
function useRunOnce(id: string | null): Run | undefined {
  const live = useRun(id ?? "");
  const [fetched, setFetched] = useState<Run>();
  useEffect(() => {
    if (!id || live) return;
    api.run(id).then(
      (r) => {
        setFetched(r);
        upsertRun(r);
      },
      () => undefined,
    );
  }, [id, live]);
  return id ? (live ?? fetched) : undefined;
}

/** The trial's value of every metric of its job (the primary first), e.g. `Resolved 100% · Reward 100%`. */
function TrialMetrics({ o, metrics }: { o: Outcome | null; metrics: MetricDef[] }) {
  const all = resolveMetrics(metrics);
  if (!o || all.length < 2) return null;
  const ordered = [...all.filter((m) => m.primary), ...all.filter((m) => !m.primary)];
  return (
    <div className="trial-metrics">
      {ordered.map((m) => (
        <span key={m.name} className={m.primary ? "primary" : ""} title={m.description}>
          <span className="faint">{m.label}</span> <b>{fmtMetric(metricValue(o, m.name), m)}</b>
        </span>
      ))}
    </div>
  );
}

export function TrialPage({ jobId, trialId }: { jobId: string; trialId: string }) {
  const d = useAsync(() => api.benchJob(jobId), [jobId], { poll: true, pollMs: 5000 });
  const trial = d.data?.trials.find((t) => t.id === trialId);
  const job = d.data?.job;
  const solve = useRunOnce(trial?.solveRunId ?? null);
  const verify = useRunOnce(trial?.verifyRunId ?? null);
  const loc = useLocation();
  const review = trial?.outcome
    ? trial.outcome.review
    : (trial?.history.at(-1)?.outcome.review ?? null);
  const tabs: TabDef[] = useMemo(() => {
    if (!review) return LEGACY_TABS;
    const out: TabDef[] = review.files
      .map((f, i) => ({
        key: `f${i}`,
        label: f.label,
        trajectory: f.kind === "trajectory" || f.kind === "conversation",
      }))
      .sort((a, b) => Number(b.trajectory) - Number(a.trajectory));
    if (review.items.length) out.push({ key: "grader", label: "Grader" });
    if (Object.keys(review.details).length || extraFields(review, REVIEW_FIELDS).length)
      out.push({ key: "details", label: "Details" });
    return [...out, ...ALWAYS_TABS];
  }, [review]);
  const tab = tabs.some((t) => t.key === loc.query.get("tab"))
    ? (loc.query.get("tab") as string)
    : (tabs[0]?.key as string);
  const now = useNow(
    1000,
    Boolean((solve && isActive(solve.state)) || (verify && isActive(verify.state))),
  );
  const crumbs = [
    { label: "Bench", href: "/bench" },
    { label: job?.spec.name ?? jobId, href: jobPath(jobId) },
    { label: trial ? `${trial.task} · ${trial.method}` : trialId },
  ];

  if (d.error && !d.data)
    return (
      <>
        <TopBar crumbs={crumbs} />
        <Empty title="Bench job not found">{d.error}</Empty>
      </>
    );
  if (!d.data) return <Loading />;
  if (!trial || !job)
    return (
      <>
        <TopBar crumbs={crumbs} />
        <Empty title="Trial not found">{trialId}</Empty>
      </>
    );
  const deriveLegacy = async () => {
    try {
      const lines = await api.methods();
      const revision = lines
        .flatMap((line) => line.revisions)
        .find((r) => r.results.some((x) => x.job === job.id && x.method === trial.method));
      if (!revision) throw new Error("No method revision is available for this trial.");
      navigate(deriveHref(job.id, revision.revision, trial.id, trial.method));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const o = trial.outcome;
  const method = job.spec.methods.find((m) => m.name === trial.method);
  const evidence = job.capabilities?.rescore === "evidence";
  const gui =
    review?.files.some((f) => f.kind === "trajectory" || f.kind === "conversation") ?? false;
  const nav = neighbours(d.data.trials, trial);
  const rescoreLabel = evidence ? "Recheck evidence" : "Rescore";
  const rescore = async () => {
    if (
      !confirm(
        evidence
          ? "Check the saved evidence again? This does not rerun the Agent or restore the browser. The previous result remains in the history."
          : "Score this trial again? A new verify run is started from the saved solve output; the Agent is not rerun and the current score is kept in the history.",
      )
    )
      return;
    try {
      const r = await api.benchRescore(jobId, { trials: [trial.id] });
      toast(
        r.trials.length
          ? evidence
            ? "Rechecking evidence"
            : "Rescoring"
          : (r.skipped[0]?.reason ?? "Not rescored"),
      );
      d.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <TopBar crumbs={crumbs} className="topbar-wrap">
        <Link className="btn sm" href={`/bench/new?from=${encodeURIComponent(job.id)}`}>
          Copy configuration
        </Link>
        {job.revisions[trial.method] &&
          !["empty", "oracle"].includes(
            job.spec.methods.find((m) => m.name === trial.method)?.agent ?? "",
          ) && (
            <Link
              className="btn sm"
              href={deriveHref(
                job.id,
                job.revisions[trial.method]?.revision ?? "",
                trial.id,
                trial.method,
              )}
              title="Start a new evaluation whose method descends from this one, informed by this trial"
            >
              Derive next method
            </Link>
          )}
        {!job.revisions[trial.method] && method && !["empty", "oracle"].includes(method.agent) && (
          <button
            type="button"
            className="btn sm"
            onClick={() => void deriveLegacy()}
            title="Derive from the approximate revision reconstructed for this older evaluation"
          >
            Derive next method
          </button>
        )}
        {job.state !== "running" &&
          trial.state === "done" &&
          job.capabilities?.rescore !== "none" && (
            <button
              type="button"
              className="btn sm"
              onClick={rescore}
              title={
                evidence
                  ? "Check saved evidence without rerunning the environment"
                  : "Verify and score again from the saved solve output"
              }
            >
              {rescoreLabel}
            </button>
          )}
        <Link className="btn sm" href={jobPath(jobId)}>
          <IconFlask size={13} /> Job
        </Link>
        <span className="trial-nav" title="Other trials of this job">
          <TrialLink jobId={jobId} t={nav.prev} label="‹ Prev" keyHint="[" />
          <TrialLink jobId={jobId} t={nav.next} label="Next ›" keyHint="]" />
          <TrialLink jobId={jobId} t={nav.nextFailure} label="Next failure" keyHint="}" />
        </span>
      </TopBar>
      <div className="run-head trial-head">
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <TrialResult t={trial} binary={job.capabilities?.scoreKind === "binary"} />
          <h1 className="ellipsis">
            {trial.task} <span className="faint">·</span> {trial.method}
            {job.spec.seeds > 1 && <span className="faint"> #{trial.seed}</span>}
          </h1>
          <div className="spacer" />
          {o && o.score !== null && (
            <span className="trial-score num">
              {fmtScore(o.score)}
              <span className="faint"> / {fmtScore(o.maxScore)}</span>
            </span>
          )}
        </div>
        <TrialMetrics o={o} metrics={job.metrics} />
        <div className="meta">
          <span className="chip mono">{job.spec.benchmark}</span>
          {method && (
            <span className="chip mono">
              {method.agent}
              {method.entrypoint ? ` · ${method.entrypoint}` : ""}
              {method.model ? ` · ${method.model}` : ""}
              {method.effort ? ` · ${method.effort}` : ""}
            </span>
          )}
          {o && <span className="chip mono">execution {o.execution}</span>}
          {o && (
            <span className={`chip ${evalClass(o.evaluation)}`}>evaluation {o.evaluation}</span>
          )}
          {o && (
            <span className={`chip${o.cleanup !== "done" ? " warn" : ""}`}>
              cleanup {o.cleanup}
            </span>
          )}
          <span className="chip">
            {trial.state !== "done" && trial.history.length
              ? evidence
                ? "rechecking evidence"
                : "rescoring"
              : trial.state}
          </span>
          <span className="faint">created {dateTime(trial.createdAt)}</span>
        </div>
        {(o?.issues ?? trial.issues).length > 0 && (
          <div className={`trial-issues${o?.evaluation === "valid" ? " neutral" : ""}`}>
            <IconAlert size={13} />
            <span>{(o?.issues ?? trial.issues).join(" · ")}</span>
          </div>
        )}
        <details open={!gui}>
          <summary>Execution details</summary>
          <div className="trial-timeline">
            <PhaseCard label="Solve" run={solve} id={trial.solveRunId} now={now} />
            <span className="faint">→</span>
            <PhaseCard label="Verify" run={verify} id={trial.verifyRunId} now={now} />
          </div>
        </details>
        {trial.history.length > 0 && <ScoringHistory history={trial.history} />}
      </div>
      <nav className="tabs">
        {tabs.map((t, i) => (
          <a
            key={t.key}
            href={`?tab=${t.key}`}
            className={tab === t.key ? "on" : ""}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              setQuery({ tab: i === 0 ? null : t.key }, { replace: false, hash: "" });
            }}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <div className="page" style={{ display: "flex", flexDirection: "column" }}>
        <TabBody tab={tab} trial={trial} job={job} review={review} solve={solve} verify={verify} />
      </div>
    </>
  );
}

const ALWAYS_TABS: TabDef[] = [
  { key: "config", label: "Configuration" },
  { key: "session", label: "Agent session" },
  { key: "outputs", label: "Outputs" },
];
const LEGACY_TABS: TabDef[] = [
  { key: "report", label: "Report" },
  { key: "judge", label: "Grader" },
  ...ALWAYS_TABS,
];
const REVIEW_FIELDS = ["files", "items", "details"] as const;

function TabBody(props: {
  tab: string;
  trial: Trial;
  job: BenchJob;
  review: Review | null;
  solve: Run | undefined;
  verify: Run | undefined;
}) {
  const { tab, trial, job, review, solve, verify } = props;
  const notStarted = (phase: string) => (
    <Empty title={`No ${phase} run`}>
      {trial.state === "done" ? `This trial has no ${phase} run.` : `Waiting for the ${phase} run.`}
    </Empty>
  );
  const file = /^f(\d+)$/.exec(tab);
  if (file && review) {
    const f = review.files[Number(file[1])];
    if (!f) return <Empty title="No such file" />;
    const run = f.phase === "solve" ? solve : verify;
    const resolved = resolveKind(f);
    if (resolved.kind === "trajectory" && run) {
      const fallback = review.files.findIndex(
        (item) => item.phase === f.phase && resolveKind(item).kind === "markdown",
      );
      return (
        <TrajectoryFile
          key={`${run.id}/${f.path}`}
          run={run}
          file={f}
          note={resolved.note}
          fallback={fallback >= 0 ? `?tab=f${fallback}` : undefined}
        />
      );
    }
    if (resolved.kind === "episode" && run) return <EpisodeFile run={run} file={f} />;
    if (resolved.kind === "conversation" && run)
      return <ConversationFile key={`${run.id}/${f.path}`} run={run} file={f} />;
    return run ? <ReviewFileView key={tab} run={run} f={f} /> : notStarted(f.phase);
  }
  if (tab === "grader" && review) return <GraderItems items={review.items} />;
  if (tab === "details" && review) return <DetailsView review={review} />;
  if (tab === "config") return <TrialConfiguration job={job} trial={trial} />;
  if (tab === "report") return solve ? <ReportView run={solve} /> : notStarted("solve");
  if (tab === "judge") return verify ? <GraderView run={verify} /> : notStarted("verify");
  if (tab === "session") return solve ? <SessionTab run={solve} /> : notStarted("solve");
  if (tab === "outputs") return <OutputsView solve={solve} verify={verify} />;
  return <Empty title="Unknown tab" />;
}

const evalClass = (e: string | undefined) =>
  e === "invalid" ? "bad" : e === "unknown" ? "warn" : "";

function TrialResult({ t, binary }: { t: Trial; binary: boolean }) {
  const o = t.outcome;
  const binaryResult = binary && o?.evaluation === "valid" && o.score !== null && o.maxScore > 0;
  const success = binaryResult && o.score === o.maxScore;
  return (
    <span
      className={`chip ${binaryResult ? (success ? "good" : "warn") : evalClass(o?.evaluation)}`}
    >
      {binaryResult
        ? success
          ? "Task completed"
          : "Task not completed"
        : o?.evaluation === "invalid"
          ? "Evaluation invalid"
          : o?.evaluation === "unknown"
            ? "Result unknown"
            : o?.evaluation === "valid"
              ? "Scored"
              : "Awaiting result"}
    </span>
  );
}

function TrialConfiguration({ job, trial }: { job: BenchJob; trial: Trial }) {
  const method = job.spec.methods.find((m) => m.name === trial.method);
  const saved = job.benchmarkSnapshot;
  const rows: [string, unknown][] = [
    ["Benchmark", job.spec.benchmark],
    ["Task", trial.task],
    ["Seed", trial.seed],
    ["Method", method?.name],
    ["Agent", method?.agent],
    ["Model", method?.model],
    ["Entrypoint", method?.entrypoint],
    ["Method settings", method?.config],
    ["Reasoning effort", method?.effort],
    ["Solve timeout (minutes)", job.spec.timeoutMin ?? job.resources?.[trial.task]?.timeoutMin],
    ["Solve resources", job.resources?.[trial.task]],
    ["Job options", job.spec.options],
    ["Source", job.source],
    ["Environment conditions", job.capabilities?.conditions],
    ["Adapter", saved?.adapter],
    ["Environment settings", saved?.config],
  ];
  return (
    <div className="page-pad trial-config">
      <section className="card">
        <div className="card-h">Saved configuration</div>
        <div className="card-b">
          {!saved && (
            <p className="faint">
              This older job has no saved environment configuration. Current registration settings
              are not used to fill the gap.
            </p>
          )}
          <dl className="kv">
            {rows
              .filter(([, v]) => v !== undefined)
              .map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
                  </dd>
                </Fragment>
              ))}
          </dl>
        </div>
      </section>
    </div>
  );
}

/** Earlier scorings of the same solve run, newest first; each links to its verify run. */
function ScoringHistory({ history }: { history: Scoring[] }) {
  return (
    <div className="scorings">
      <span className="faint">Earlier scorings</span>
      {[...history].reverse().map((h, i) => (
        <span key={h.verifyRunId ?? String(i)} className="row" style={{ gap: 6 }}>
          <span className={`chip ${evalClass(h.outcome.evaluation)}`}>{h.outcome.evaluation}</span>
          <span className="num">
            {fmtScore(h.outcome.score)}
            <span className="faint"> / {fmtScore(h.outcome.maxScore)}</span>
          </span>
          {h.verifyRunId ? (
            <Link className="chip link mono" href={runPath(h.verifyRunId)}>
              verify
            </Link>
          ) : (
            <span className="faint">no verify run</span>
          )}
          {h.endedAt && <span className="faint">{dateTime(h.endedAt)}</span>}
          {h.outcome.issues.length > 0 && (
            <span className="faint ellipsis" title={h.outcome.issues.join(" · ")}>
              {h.outcome.issues.join(" · ")}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function PhaseCard(props: { label: string; run: Run | undefined; id: string | null; now: number }) {
  const { run } = props;
  if (!props.id)
    return (
      <div className="card phase">
        <b>{props.label}</b> <span className="faint">not started</span>
      </div>
    );
  if (!run)
    return (
      <div className="card phase">
        <b>{props.label}</b> <span className="faint mono">{props.id}</span>
      </div>
    );
  const u = run.usage;
  return (
    <Link className="card phase" href={runPath(run.id)}>
      <div className="row" style={{ gap: 8 }}>
        <b>{props.label}</b>
        <StateBadge state={run.state} />
        <span className="spacer" />
        <span className="num muted">{duration(runDuration(run, props.now))}</span>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        {run.spec.resources.gpus ? `${run.spec.resources.gpus} GPU · ` : ""}
        {run.spec.resources.cpus} CPU · {run.spec.resources.memGB} GB
        {u && (
          <>
            {" "}
            · peak {u.peakMemGB} GB RAM
            {u.peakGpuMemGB !== null ? ` · ${u.peakGpuMemGB} GB GPU` : ""}
            {u.oomKilled ? " · out of memory" : ""}
          </>
        )}
        {run.reason ? ` · ${run.reason}` : ""}
      </div>
    </Link>
  );
}

// ---- report ----

function useText(runId: string, path: string | undefined) {
  return useAsync(
    () =>
      path
        ? fetch(fileUrl(runId, path)).then(async (r) => {
            if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
            return r.text();
          })
        : Promise.resolve(null),
    [runId, path],
  );
}

function ReportView({ run }: { run: Run }) {
  const a = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const candidates = useMemo(() => reportCandidates(a.data), [a.data]);
  const loc = useLocation();
  const chosen = loc.query.get("file") ?? candidates[0];
  const text = useText(run.id, chosen);
  const files = useMemo(() => new Set((a.data?.files ?? []).map((f) => f.path)), [a.data]);

  if (!a.data) return <Loading what="Loading outputs" />;
  if (!candidates.length)
    return (
      <Empty title="No report" icon={<IconFile size={30} />}>
        The solve run left no Markdown file in its outputs.{" "}
        <Link href={`${runPath(run.id)}?tab=artifacts`}>All outputs →</Link>
      </Empty>
    );
  const dir = chosen?.includes("/") ? chosen.slice(0, chosen.lastIndexOf("/")) : "";
  const resolve = (rel: string) => {
    const p = joinPath(dir, rel.split("#")[0] ?? "");
    return p && files.has(p) ? fileUrl(run.id, p) : null;
  };
  return (
    <div className="report">
      <div className="toolbar">
        <select
          className="input"
          value={chosen}
          onChange={(e) => setQuery({ file: e.target.value }, { hash: "" })}
          aria-label="Markdown file"
        >
          {candidates.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <Link className="btn sm" href={`${runPath(run.id)}?tab=artifacts`}>
          All outputs
        </Link>
      </div>
      <div className="report-body">
        {text.error ? (
          <Empty title="Could not load the report">{text.error}</Empty>
        ) : text.data == null ? (
          <Loading />
        ) : (
          <Markdown text={text.data} resolve={resolve} />
        )}
      </div>
    </div>
  );
}

// ---- grader ----

interface GraderItem {
  index?: number | string;
  type?: string;
  content?: string;
  weight?: number | string;
  score?: number | string;
  reasoning?: string;
}

/** A grader result with per-item scores (e.g. ResearchClawBench `_score.json`), when present. */
function itemsOf(v: unknown): { items: GraderItem[]; total: unknown } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { items?: unknown; total_score?: unknown; score?: unknown };
  if (!Array.isArray(o.items) || !o.items.every((x) => x && typeof x === "object")) return null;
  return { items: o.items as GraderItem[], total: o.total_score ?? o.score };
}

function GraderView({ run }: { run: Run }) {
  const a = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const jsons = useMemo(
    () =>
      (a.data?.files ?? [])
        .map((f) => f.path)
        .filter((p) => /\.json$/i.test(p) && !/(^|\/)(code|outputs|report)\//.test(p))
        .sort(
          (x, y) => Number(!/score/i.test(x)) - Number(!/score/i.test(y)) || x.length - y.length,
        )
        .slice(0, 6),
    [a.data],
  );
  if (!a.data) return <Loading what="Loading grader output" />;
  if (!jsons.length)
    return (
      <Empty title="No grader output">
        The verify run wrote no JSON result.{" "}
        <Link href={`${runPath(run.id)}?tab=logs`}>Logs →</Link>
      </Empty>
    );
  return (
    <div className="page-pad col" style={{ gap: 16 }}>
      {jsons.map((p) => (
        <GraderFile key={p} run={run} path={p} />
      ))}
    </div>
  );
}

function GraderFile({ run, path }: { run: Run; path: string }) {
  const t = useText(run.id, path);
  const parsed = useMemo(() => {
    try {
      return t.data ? (JSON.parse(t.data) as unknown) : null;
    } catch {
      return null;
    }
  }, [t.data]);
  const scored = itemsOf(parsed);
  return (
    <section className="card">
      <div className="card-h">
        <span className="mono">{path}</span>
        {scored && scored.total !== undefined && (
          <span className="sub">total {String(scored.total)}</span>
        )}
      </div>
      {t.data == null ? (
        <div className="card-b">{t.error ?? <Loading />}</div>
      ) : scored ? (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Criterion</th>
              <th className="r" style={{ width: 70 }}>
                Weight
              </th>
              <th className="r" style={{ width: 70 }}>
                Score
              </th>
              <th>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {scored.items.map((it, i) => (
              <tr key={String(i)} style={{ verticalAlign: "top" }}>
                <td className="faint num">{String(it.index ?? i)}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 380 }}>
                  {it.type && <span className="chip mono">{it.type}</span>} {it.content}
                </td>
                <td className="r num muted">{it.weight ?? "—"}</td>
                <td className="r num">
                  <b>{it.score ?? "—"}</b>
                </td>
                <td className="muted" style={{ whiteSpace: "normal" }}>
                  <Reasoning text={it.reasoning ?? ""} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="card-b mono" style={{ maxHeight: 420, overflow: "auto", margin: 0 }}>
          {parsed ? JSON.stringify(parsed, null, 2) : t.data}
        </pre>
      )}
    </section>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 320) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, 320)}… `}
      <button type="button" className="btn ghost sm" onClick={() => setOpen(!open)}>
        {open ? "less" : "more"}
      </button>
    </>
  );
}

// ---- declared review ----

const MAX_PREVIEW = 2 * 1024 * 1024;

/** One declared file, rendered by its kind with Orbit's styles. */
function ReviewFileView({ run, f }: { run: Run; f: ReviewFile }) {
  const a = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const { kind, note } = resolveKind(f);
  const entry = a.data?.files.find((x) => x.path === f.path);
  const text = useText(
    run.id,
    kind !== "image" && entry && entry.bytes <= MAX_PREVIEW ? f.path : undefined,
  );
  const files = useMemo(() => new Set((a.data?.files ?? []).map((x) => x.path)), [a.data]);
  const extras = extraFields(f, ["label", "phase", "path", "kind", "fallback"]);
  const head = (
    <div className="toolbar">
      <span className="mono ellipsis">{f.path}</span>
      <span className="chip mono">{kind}</span>
      {entry && <span className="faint">{bytes(entry.bytes)}</span>}
      {note && <span className="chip warn">{note}</span>}
      {extras.map(([k, v]) => (
        <span key={k} className="chip mono" title={showValue(v)}>
          {k}: {showValue(v).slice(0, 40)}
        </span>
      ))}
      <div className="spacer" />
      <a className="btn sm" href={fileUrl(run.id, f.path, true)}>
        Download
      </a>
    </div>
  );
  let body: React.ReactNode;
  if (!a.data) body = <Loading />;
  else if (!entry)
    body = (
      <Empty title="File not found">
        The {f.phase} run has no <code>{f.path}</code>.{" "}
        <Link href={`${runPath(run.id)}?tab=artifacts`}>Outputs →</Link>
      </Empty>
    );
  else if (kind === "image")
    body = <img className="review-img" src={fileUrl(run.id, f.path)} alt={f.label} />;
  else if (entry.bytes > MAX_PREVIEW)
    body = <Empty title="Too large to preview">{bytes(entry.bytes)} — use Download.</Empty>;
  else if (text.error) body = <Empty title="Could not load the file">{text.error}</Empty>;
  else if (text.data == null) body = <Loading />;
  else if (kind === "markdown") {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const resolve = (rel: string) => {
      const p = joinPath(dir, rel.split("#")[0] ?? "");
      return p && files.has(p) ? fileUrl(run.id, p) : null;
    };
    body = <Markdown text={text.data} resolve={resolve} />;
  } else if (kind === "json") {
    let shown = text.data;
    try {
      shown = JSON.stringify(JSON.parse(text.data), null, 2);
    } catch {}
    body = <pre className="review-pre">{shown}</pre>;
  } else if (kind === "table")
    body = <Csv text={text.data} sep={/\.tsv$/i.test(f.path) ? "\t" : ","} />;
  else body = <pre className="review-pre">{text.data}</pre>;
  return (
    <div className="report">
      {head}
      <div className="report-body">{body}</div>
    </div>
  );
}

const ITEM_FIELDS = ["criterion", "score", "maxScore", "weight", "type", "reasoning"] as const;

function GraderItems({ items }: { items: ReviewItem[] }) {
  const total = items.reduce((a, it) => a + (it.weight ?? 0), 0);
  return (
    <div className="page-pad">
      <section className="card">
        <div className="card-h">
          Graded items <span className="sub">{items.length}</span>
          {total > 0 && <span className="sub">total weight {fmtScore(total)}</span>}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Criterion</th>
              <th className="r" style={{ width: 70 }}>
                Weight
              </th>
              <th className="r" style={{ width: 90 }}>
                Score
              </th>
              <th>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const extras = extraFields(it, ITEM_FIELDS);
              return (
                <tr key={String(i)} style={{ verticalAlign: "top" }}>
                  <td className="faint num">{i + 1}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 420 }}>
                    {it.type && <span className="chip mono">{it.type}</span>} {it.criterion}
                    {extras.length > 0 && (
                      <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
                        {extras.map(([k, v]) => `${k}: ${showValue(v)}`).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="r num muted">
                    {it.weight === undefined ? "—" : fmtScore(it.weight)}
                  </td>
                  <td className="r num">
                    <b>{it.score == null ? "—" : fmtScore(it.score)}</b>
                    {it.maxScore !== undefined && (
                      <span className="faint"> / {fmtScore(it.maxScore)}</span>
                    )}
                  </td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>
                    <Reasoning text={it.reasoning ?? ""} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** The adapter's facts, plus any review fields this UI does not know, as key / value rows. */
function DetailsView({ review }: { review: Review }) {
  const rows: [string, unknown][] = [
    ...Object.entries(review.details),
    ...extraFields(review, REVIEW_FIELDS),
  ];
  return (
    <div className="page-pad">
      <section className="card">
        <div className="card-h">Details</div>
        <div className="card-b">
          <dl className="kv">
            {rows.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd className="mono" style={{ whiteSpace: "pre-wrap" }}>
                  {showValue(v)}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}

/** Every output of both runs, through the run page's file browser. */
function OutputsView({ solve, verify }: { solve: Run | undefined; verify: Run | undefined }) {
  const loc = useLocation();
  const phase = loc.query.get("phase") === "verify" ? "verify" : "solve";
  const run = phase === "verify" ? verify : solve;
  const a = useAsync(
    () => (run ? api.artifacts(run.id) : Promise.resolve(undefined)),
    [run?.id, run?.state],
  );
  return (
    <div className="report">
      <div className="toolbar">
        <div className="seg">
          {(["solve", "verify"] as const).map((p) => (
            <button
              type="button"
              key={p}
              className={phase === p ? "on" : ""}
              onClick={() => setQuery({ phase: p === "solve" ? null : p }, { hash: "" })}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      {run ? <ArtifactsTab run={run} artifacts={a.data} /> : <Empty title={`No ${phase} run`} />}
    </div>
  );
}

/** Whether a finished trial did not succeed: invalid, unknown, or below full marks. */
export const failedTrial = (t: Trial) =>
  t.state === "done" &&
  (t.outcome?.evaluation !== "valid" ||
    t.outcome.score === null ||
    t.outcome.score < t.outcome.maxScore);

/** The previous and next trial of the job (by task, method, seed) and the next failed one. */
export function neighbours(trials: Trial[], t: Trial) {
  const order = [...trials].sort(
    (a, b) => a.task.localeCompare(b.task) || a.method.localeCompare(b.method) || a.seed - b.seed,
  );
  const i = order.findIndex((x) => x.id === t.id);
  const after = [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0))];
  return {
    prev: i > 0 ? order[i - 1] : undefined,
    next: i >= 0 && i < order.length - 1 ? order[i + 1] : undefined,
    nextFailure: after.find(failedTrial),
  };
}

function TrialLink({
  jobId,
  t,
  label,
  keyHint,
}: {
  jobId: string;
  t: Trial | undefined;
  label: string;
  keyHint: string;
}) {
  useHotkeys(
    t
      ? {
          [keyHint]: () => navigate(trialPath(jobId, t.id)),
        }
      : {},
  );
  if (!t)
    return (
      <button type="button" className="btn sm" disabled>
        {label}
      </button>
    );
  return (
    <Link
      className="btn sm"
      href={trialPath(jobId, t.id)}
      title={`${t.task} · ${t.method} #${t.seed} (${keyHint})`}
    >
      {label}
    </Link>
  );
}

/** New evaluation prefilled from the job, with this revision as parent and this trial as cause. */
export const deriveHref = (job: string, revision: string, trial: string, method: string) =>
  `/bench/new?from=${encodeURIComponent(job)}&parent=${encodeURIComponent(revision)}&informedBy=${encodeURIComponent(trial)}&method=${encodeURIComponent(method)}`;
