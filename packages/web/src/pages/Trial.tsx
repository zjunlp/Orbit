// One bench trial (task × method × seed) on one page: its outcome and issues, the solve → verify
// timeline with measured use, then tabs. The adapter's `review` decides the content tabs (one per
// declared file, rendered by kind through `FILE_VIEWS`; Grader from its items; Details for its facts
// and any fields this UI does not know). Without a review (older trials and adapters) the page
// guesses: the solve's Markdown report and the verifier's JSON (trial/Legacy.tsx). The Agent
// session and all outputs are always there.
import { fmtMetric, type MetricDef, metricValue, resolveMetrics } from "@zjunlp/orbit/metrics";
import { planRank, sampleLabel, sampleOrder } from "@zjunlp/orbit/naming";
import { Fragment, useEffect, useMemo, useState } from "react";
import { IconAlert, IconFlask } from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading, StateBadge, toast, useNow } from "../components/ui.tsx";
import {
  api,
  type BenchJob,
  type Outcome,
  type Review,
  type Run,
  type Scoring,
  type Trial,
} from "../lib/api.ts";
import {
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
import { extraFields, REVIEW_FIELDS, resolveKind } from "../lib/review.ts";
import { navigate, setQuery, useLocation } from "../lib/router.ts";
import { upsertRun, useRun } from "../lib/runs-store.ts";
import { useAsync } from "../lib/use.ts";
import { ArtifactsTab } from "./run/Artifacts.tsx";
import { SessionTab } from "./run/Session.tsx";
import { GraderView, ReportView } from "./trial/Legacy.tsx";
import { DetailsView, FILE_VIEWS, GraderItems, isInteractive } from "./trial/Review.tsx";

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
      .map((f, i) => ({ key: `f${i}`, label: f.label, interactive: isInteractive(f) }))
      .sort((a, b) => Number(b.interactive) - Number(a.interactive));
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
    { label: "Evaluations", href: "/bench" },
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
      if (!revision) throw new Error("No configuration version is available for this trial.");
      navigate(deriveHref(job.id, revision.revision, trial.id, trial.method));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const o = trial.outcome;
  const method = job.spec.methods.find((m) => m.name === trial.method);
  const evidence = job.capabilities?.rescore === "evidence";
  const gui = review?.files.some(isInteractive) ?? false;
  const nav = neighbours(d.data.trials, trial, job.spec.samplePlan);
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
              title="Copy this configuration to adjust its model, reasoning effort or optional files in a new evaluation"
            >
              Adjust configuration
            </Link>
          )}
        {!job.revisions[trial.method] && method && !["empty", "oracle"].includes(method.agent) && (
          <button
            type="button"
            className="btn sm"
            onClick={() => void deriveLegacy()}
            title="Adjust the configuration reconstructed from this older evaluation"
          >
            Adjust configuration
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
            {(trial.sampleRef || (job.spec.seeds ?? 1) > 1) && (
              <span className="faint"> #{sampleLabel(trial)}</span>
            )}
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
        <details className="disclosure" open={!gui}>
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
    if (!run) return notStarted(f.phase);
    const View = FILE_VIEWS[resolveKind(f).kind];
    return (
      <View key={`${tab}/${run.id}/${f.path}`} run={run} file={f} review={review} solve={solve} />
    );
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
    [trial.sampleRef ? "Sample" : "Seed", trial.sampleRef ?? trial.seed],
    ...(trial.batch
      ? ([
          ["Shared solve batch", trial.batch.plan.id],
          ["Episode position", `${trial.batch.index + 1} / ${trial.batch.plan.members.length}`],
          [
            "Model random stream",
            trial.batch.plan.randomness === "service"
              ? "Continues in fixed batch order; retries require the same full prefix"
              : "Stateless",
          ],
          [
            "Shared resources and cancellation",
            "Solve duration and resource use cover the whole batch. Cancelling the solve stops all unfinished episodes; completed evidence is still verified.",
          ],
        ] satisfies [string, unknown][])
      : []),
    [
      "Initial state",
      job.spec.samplePlan?.items.find((s) => s.sampleId === trial.sampleRef)?.initialStateId,
    ],
    ["Sample conditions", job.spec.samplePlan?.items.find((s) => s.sampleId === trial.sampleRef)],
    ["Policy", method?.policyRef],
    [
      "Earlier solve attempts",
      trial.priorAttempts?.map((attempt) => ({
        run: attempt.solveRunId,
        batch: attempt.batch?.plan.id,
        outcome: attempt.outcome,
      })),
    ],
    ["Policy type", method?.policySnapshot?.kind],
    ["Policy connector", method?.policySnapshot?.connector],
    ["Policy I/O adapter", method?.policySnapshot?.ioAdapter],
    ["Execution horizon", method?.policySnapshot?.replanSteps],
    ["Backbone digest", method?.policySnapshot?.backboneDigest],
    ["Checkpoint digest", method?.policySnapshot?.checkpointDigest],
    ["Normalization digest", method?.policySnapshot?.normalizationDigest],
    ["Normalization key", method?.policySnapshot?.normalizationKey],
    ["Configuration", method?.name],
    ["Agent", method?.agent],
    ["Model", method?.model],
    ["Entrypoint", method?.entrypoint],
    ["Configuration settings", method?.config],
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
export function neighbours(trials: Trial[], t: Trial, plan?: { items: { sampleId: string }[] }) {
  const rank = planRank(plan);
  const order = [...trials].sort(
    (a, b) =>
      a.task.localeCompare(b.task) || a.method.localeCompare(b.method) || sampleOrder(a, b, rank),
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
      title={`${t.task} · ${t.method} #${sampleLabel(t)} (${keyHint})`}
    >
      {label}
    </Link>
  );
}

/** New evaluation prefilled from the job, with this revision as parent and this trial as cause. */
export const deriveHref = (job: string, revision: string, trial: string, method: string) =>
  `/bench/new?from=${encodeURIComponent(job)}&parent=${encodeURIComponent(revision)}&informedBy=${encodeURIComponent(trial)}&method=${encodeURIComponent(method)}`;
