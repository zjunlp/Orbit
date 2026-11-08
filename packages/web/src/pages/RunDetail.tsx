import { useEffect, useState } from "react";
import {
  IconBot,
  IconBox,
  IconChip,
  IconClock,
  IconCopy,
  IconFolder,
  IconGit,
  IconLayers,
} from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import {
  ConfirmDialog,
  CopyButton,
  copy,
  Empty,
  Kbd,
  Link,
  Loading,
  Params,
  StateBadge,
  toast,
  useNow,
} from "../components/ui.tsx";
import { api, HttpError, type Run } from "../lib/api.ts";
import {
  bytes,
  cliCommand,
  duration,
  harnessLabel,
  isActive,
  jobPath,
  runDuration,
  runTitle,
  trialPath,
} from "../lib/format.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { navigate, setQuery, useLocation } from "../lib/router.ts";
import { upsertRun, useRun } from "../lib/runs-store.ts";
import { useAsync } from "../lib/use.ts";
import { ArtifactsTab } from "./run/Artifacts.tsx";
import { DiffTab } from "./run/Diff.tsx";
import { EventsTab } from "./run/Events.tsx";
import { LogsTab } from "./run/Logs.tsx";
import { MetricsTab } from "./run/Metrics.tsx";
import { Overview } from "./run/Overview.tsx";
import { SessionTab } from "./run/Session.tsx";

const TABS = ["overview", "logs", "metrics", "artifacts", "code", "session", "events"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  logs: "Logs",
  metrics: "Metrics",
  artifacts: "Artifacts",
  code: "Code",
  session: "Session",
  events: "Events",
};

export function RunDetail({ id }: { id: string }) {
  const live = useRun(id);
  const [fetched, setFetched] = useState<Run | null>(null);
  const [failure, setFailure] = useState<{ notFound: boolean; message: string } | null>(null);
  const run = live ?? fetched;

  useEffect(() => {
    if (live) return;
    api.run(id).then(
      (r) => {
        setFetched(r);
        upsertRun(r);
      },
      (e: Error) =>
        setFailure({ notFound: e instanceof HttpError && e.status === 404, message: e.message }),
    );
  }, [id, live]);

  if (!run)
    return (
      <>
        <TopBar crumbs={[{ label: "Runs", href: "/runs" }, { label: id }]} />
        {failure ? (
          <Empty title={failure.notFound ? "Run not found" : "Could not load run"}>
            {failure.notFound ? id : failure.message}
          </Empty>
        ) : (
          <Loading what="Loading run" />
        )}
      </>
    );
  return <RunView run={run} />;
}

function RunView({ run }: { run: Run }) {
  const loc = useLocation();
  const [deleting, setDeleting] = useState(false);
  const tab = (
    TABS.includes(loc.query.get("tab") as Tab) ? loc.query.get("tab") : "overview"
  ) as Tab;
  const active = isActive(run.state);
  const now = useNow(1000, active);
  // Fetched once per state change for the tab counts; polled only on the tabs that show them.
  const metrics = useAsync(() => api.metrics(run.id), [run.id, run.state], {
    poll: active && (tab === "overview" || tab === "metrics"),
    pollMs: 3000,
  });
  const artifacts = useAsync(() => api.artifacts(run.id), [run.id, run.state], {
    poll: active && tab === "artifacts",
    pollMs: 5000,
  });
  const go = (t: Tab) =>
    setQuery({ tab: t === "overview" ? null : t, err: null }, { replace: false, hash: "" });

  useHotkeys(Object.fromEntries(TABS.map((t, i) => [String(i + 1), () => go(t)])));

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the title inputs matter
  useEffect(() => {
    document.title = `${runTitle(run)} · ${run.state} · Orbit`;
    return () => {
      document.title = "Orbit";
    };
  }, [run.state, run.id]);

  const counts: Partial<Record<Tab, number | string>> = {
    metrics: metrics.data?.series.length || undefined,
    artifacts: artifacts.data?.files.length || undefined,
    code: run.code?.changedFiles.length || undefined,
  };
  const c = run.code;
  const agent = run.spec.agent;
  // Solve and verify runs of a bench trial carry its job, trial and phase as tags.
  const t = run.spec.tags;
  const bench =
    t.job && t.trial && t.phase
      ? {
          job: t.job,
          trial: t.trial,
          phase: t.phase,
          title:
            [run.spec.params.task, run.spec.params.method].filter(Boolean).join(" · ") || t.trial,
        }
      : null;
  const res = run.spec.resources;
  const gpuIds = run.lease?.gpuIds ?? [];

  return (
    <>
      <TopBar
        crumbs={
          bench
            ? [
                { label: "Bench", href: "/bench" },
                { label: bench.job, href: jobPath(bench.job) },
                { label: bench.title, href: trialPath(bench.job, bench.trial) },
                { label: bench.phase },
              ]
            : [
                { label: "Runs", href: "/runs" },
                ...(run.spec.group
                  ? [{ label: run.spec.group, href: `/?q=${encodeURIComponent(run.spec.group)}` }]
                  : []),
                { label: <span className="mono">{run.id}</span> },
              ]
        }
      >
        {bench && (
          <Link className="btn sm" href={trialPath(bench.job, bench.trial)}>
            ← Trial
          </Link>
        )}
        <button
          type="button"
          className="btn sm"
          onClick={() => void copy(cliCommand(run), "Copied orbit run command")}
          title="Copy an `orbit run` command that reproduces this spec"
        >
          <IconCopy size={13} /> Copy as CLI
        </button>
        {run.spec.group && (
          <Link
            className="btn sm"
            href={`/compare?group=${encodeURIComponent(run.spec.group)}&base=${encodeURIComponent(run.id)}`}
          >
            <IconLayers size={13} /> Compare group
          </Link>
        )}
        {active && (
          <button
            type="button"
            className="btn danger sm"
            onClick={async () => {
              const scope = run.spec.tags.batch_size
                ? ` This stops all unfinished episodes in its ${run.spec.tags.batch_size}-episode batch. Completed evidence will still be verified.`
                : "";
              if (!confirm(`Cancel run ${run.id}?${scope}`)) return;
              try {
                upsertRun(await api.cancel(run.id));
              } catch (e) {
                toast(`Cancel failed: ${(e as Error).message}`);
              }
            }}
          >
            Cancel run
          </button>
        )}
        {!active && run.cleanup === "done" && !run.spec.tags.bench && (
          <button type="button" className="btn danger sm" onClick={() => setDeleting(true)}>
            Delete run
          </button>
        )}
      </TopBar>
      {deleting && (
        <ConfirmDialog
          title={`Delete run ${run.id}`}
          expected={run.id}
          action="Delete this run"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const r = await api.deleteRuns([run.id]);
            toast(r.leftovers.length ? "Run deleted; some files were left on disk" : "Run deleted");
            navigate("/runs");
          }}
        >
          <p>
            This deletes <b>{runTitle(run)}</b>: its record, logs, metrics, outputs, code snapshot
            and Agent session.
          </p>
        </ConfirmDialog>
      )}
      <div className="run-head">
        <div className="row" style={{ gap: 12 }}>
          <StateBadge state={run.state} large />
          <h1 className="ellipsis">{runTitle(run)}</h1>
          <CopyButton text={run.id} title="Copy run id" />
          <div className="spacer" />
          <span className="row muted num" style={{ gap: 6 }} title="Run time (queue time excluded)">
            <IconClock size={14} />
            {duration(runDuration(run, now))}
          </span>
        </div>
        <div className="meta">
          {run.exitCode !== null && (
            <span className={`chip mono ${run.exitCode === 0 ? "good" : "bad"}`}>
              exit {run.exitCode}
            </span>
          )}
          {run.cleanup !== "done" && !active && (
            <span
              className={`chip ${run.cleanup === "failed" ? "bad" : ""}`}
              title="Container removal and lease release"
            >
              cleanup {run.cleanup}
            </span>
          )}
          <span className="chip" title={gpuIds.join("\n")}>
            <IconChip size={12} />
            {res.gpus ? <b>{res.gpus}× GPU</b> : "no GPU"} · {res.cpus} CPU · {res.memGB} GB
          </span>
          <span
            className="chip mono"
            title={[run.image ?? run.spec.image ?? run.spec.dockerfile, run.imageId]
              .filter(Boolean)
              .join("\n")}
          >
            <IconBox size={12} />
            {(run.image ?? run.spec.image ?? run.spec.dockerfile ?? "").replace(
              /^orbit-local\//,
              "",
            )}
          </span>
          {c && (
            <span
              className="chip link mono"
              onClick={() => go("code")}
              title={`${c.repo}\n${c.commit}`}
            >
              <IconGit size={12} />
              {c.branch ?? "detached"}@{c.commit?.slice(0, 7) ?? "none"}
              {c.dirty && (
                <b style={{ color: "var(--st-cancelled)" }}>+{c.changedFiles.length} uncommitted</b>
              )}
            </span>
          )}
          {agent && (
            <span className="chip link" onClick={() => go("session")} title={agent.sessionId}>
              <IconBot size={12} />
              {harnessLabel(agent.harness)}
              {agent.sessionId && <span className="mono faint">{agent.sessionId.slice(0, 8)}</span>}
            </span>
          )}
          {run.folder && (
            <Link className="chip link mono" href={`/?folder=${encodeURIComponent(run.folder)}`}>
              <IconFolder size={12} />
              {run.folder}
            </Link>
          )}
          {run.sizeBytes !== null && (
            <span className="chip mono" title="Run directory on disk">
              {bytes(run.sizeBytes)}
            </span>
          )}
          <Params params={run.spec.params} />
          {Object.entries(run.spec.tags).map(([k, v]) => (
            <span key={k} className="chip mono">
              {k}:{v}
            </span>
          ))}
        </div>
      </div>
      <nav className="tabs">
        {TABS.map((t, i) => (
          <a
            key={t}
            href={`?tab=${t}`}
            className={tab === t ? "on" : ""}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              go(t);
            }}
          >
            {TAB_LABEL[t]}
            {counts[t] !== undefined && <span className="count">{counts[t]}</span>}
            {t === "logs" && active && (
              <span
                className="dot pulse"
                style={{ "--c": "var(--st-running)" } as React.CSSProperties}
              />
            )}
            <span className="kbd">
              <Kbd>{i + 1}</Kbd>
            </span>
          </a>
        ))}
      </nav>
      <div className="page" style={{ display: "flex", flexDirection: "column" }}>
        {tab === "overview" && (
          <Overview run={run} metrics={metrics.data} now={now} onTab={(t) => go(t as Tab)} />
        )}
        {tab === "logs" && <LogsTab run={run} />}
        {tab === "metrics" && (
          <MetricsTab metrics={metrics.data} error={metrics.error} active={active} />
        )}
        {tab === "artifacts" && <ArtifactsTab run={run} artifacts={artifacts.data} />}
        {tab === "code" && <DiffTab run={run} />}
        {tab === "session" && <SessionTab run={run} />}
        {tab === "events" && <EventsTab run={run} />}
      </div>
    </>
  );
}

export function goRun(id: string, tab?: string) {
  navigate(`/runs/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`);
}
