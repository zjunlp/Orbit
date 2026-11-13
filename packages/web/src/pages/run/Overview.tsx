import { useEffect, useState } from "react";
import { Sparkline } from "../../components/Chart.tsx";
import {
  IconAlert,
  IconBroom,
  IconCheck,
  IconCircle,
  IconClock,
  IconEdit,
  IconFile,
  IconInfo,
  IconLoader,
  IconX,
} from "../../components/icons.tsx";
import { CopyButton, Link, StateIcon, stateColor, toast } from "../../components/ui.tsx";
import { api, type Metrics, type Run, type RunEvent } from "../../lib/api.ts";
import {
  bytes,
  dateTime,
  duration,
  formatTokens,
  isActive,
  num,
  queuedFor,
  runDuration,
  STATE_LABEL,
  shellQuote,
} from "../../lib/format.ts";
import { toLines } from "../../lib/log.ts";
import { upsertRun } from "../../lib/runs-store.ts";
import { useAsync } from "../../lib/use.ts";

export function Overview({
  run,
  metrics,
  now,
  onTab,
}: {
  run: Run;
  metrics: Metrics | undefined;
  now: number;
  onTab: (t: string) => void;
}) {
  const active = isActive(run.state);
  const events = useAsync(() => api.events(run.id), [run.id, run.state, run.cleanup], {
    poll: active,
    pollMs: 4000,
  });
  return (
    <div className="page-pad">
      <Outcome run={run} />
      <Checkpoint run={run} />
      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="col" style={{ gap: 14 }}>
          <Lifecycle run={run} events={events.data ?? []} now={now} />
          <Spec run={run} />
          <section className="card">
            <div className="card-h">Token usage</div>
            <div className="card-b">
              <p>{formatTokens(run.tokens)}</p>
              <p className="faint">
                Session-reported totals. Input includes cache reads and writes; output includes
                reasoning.
              </p>
            </div>
          </section>
          {run.code && <Code run={run} />}
        </div>
        <div className="col" style={{ gap: 14 }}>
          <Note run={run} />
          <MetricsSummary metrics={metrics} onTab={onTab} />
          <LogPeek run={run} onTab={onTab} />
        </div>
      </div>
    </div>
  );
}

function Checkpoint({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  const checkpoint = run.checkpoint;
  if (!checkpoint) return null;
  const ready = checkpoint.state === "ready" && run.cleanup === "done";
  return (
    <div className="callout" style={{ marginTop: 12 }}>
      <div className="grow">
        {checkpoint.state === "ready" ? (
          <>
            Checkpoint saved
            {checkpoint.sizeBytes === null ? "" : ` (${bytes(checkpoint.sizeBytes)})`}. Files and
            session can be restored; running processes are restarted.
            {checkpoint.session
              ? " Continue in a new standalone run; benchmark results stay unchanged."
              : ` Inspect with orbit resume ${run.id} --command '<command>'.`}
          </>
        ) : (
          <>Checkpoint failed: {checkpoint.reason}</>
        )}
      </div>
      {ready && checkpoint.session && (
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const next = await api.resume(run.id);
              window.location.assign(`/runs/${next.id}`);
            } catch (e) {
              toast((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Restoring…" : "Continue session"}
        </button>
      )}
    </div>
  );
}

function Outcome({ run }: { run: Run }) {
  const s = run.state;
  if (s === "succeeded")
    return (
      <div className="callout" style={{ "--c": stateColor(s) } as React.CSSProperties}>
        <IconCheck size={16} />
        <div className="grow">
          Finished with exit code 0{run.endedAt ? ` at ${dateTime(run.endedAt)}` : ""}.
          {run.cleanup === "done"
            ? " Container removed and resources released."
            : ` Cleanup ${run.cleanup}.`}
        </div>
      </div>
    );
  if (s === "queued" || s === "starting" || s === "running")
    return (
      <div className="callout" style={{ "--c": stateColor(s) } as React.CSSProperties}>
        {s === "queued" ? <IconClock size={16} /> : <IconLoader size={16} className="spin" />}
        <div className="grow">
          {s === "queued" ? (
            <>
              <b>Queued</b> — {run.reason ?? "waiting for resources"}. It starts automatically when
              resources free up. <Link href="/resources">See resources →</Link>
            </>
          ) : s === "starting" ? (
            <>
              <b>Starting</b> — {run.reason ?? "preparing image and container"}.
            </>
          ) : (
            <>
              <b>Running</b> on {run.node}
              {run.remote ? " (worker node)" : run.origin ? ` for ${run.origin}` : ""}
              {run.lease?.gpuIds.length ? ` with ${run.lease.gpuIds.length} GPU(s)` : ""}.{" "}
              <Link href="?tab=logs">Follow logs →</Link>
            </>
          )}
        </div>
      </div>
    );
  return (
    <div className="callout" style={{ "--c": stateColor(s) } as React.CSSProperties}>
      <IconAlert size={16} />
      <div className="grow">
        <b>{STATE_LABEL[s]}</b>
        {run.reason ? (
          <> — {run.reason}</>
        ) : run.exitCode !== null ? (
          <> — exit code {run.exitCode}</>
        ) : null}
        <div className="muted" style={{ marginTop: 2 }}>
          Logs, metrics and outputs collected before cleanup are kept.{" "}
          <Link href="?tab=logs&err=1">Jump to the first error →</Link>
        </div>
      </div>
    </div>
  );
}

const STEP_ICON: Record<string, React.ReactNode> = {
  cleanup: <IconBroom size={13} />,
  note: <IconEdit size={13} />,
};

function Lifecycle({ run, events, now }: { run: Run; events: RunEvent[]; now: number }) {
  const created = Date.parse(run.createdAt);
  const q = queuedFor(run, now);
  const d = runDuration(run, now) ?? 0;
  const total = Math.max(q + d, 1);
  return (
    <section className="card">
      <div className="card-h">
        Lifecycle{" "}
        <span className="sub">
          queued {duration(q)} · ran {duration(runDuration(run, now))}
        </span>
      </div>
      <div className="card-b col" style={{ gap: 12 }}>
        <div className="timeline" title="Queue time (striped) then run time">
          <div className="q" style={{ width: `${(q / total) * 100}%` }}>
            {q / total > 0.15 ? `queued ${duration(q)}` : ""}
          </div>
          {run.startedAt && (
            <div style={{ "--c": stateColor(run.state), flex: 1 } as React.CSSProperties}>
              {d / total > 0.15 ? `${STATE_LABEL[run.state]} ${duration(d)}` : ""}
            </div>
          )}
        </div>
        <ol className="steps">
          {events
            .filter((e) => e.kind !== "note")
            .map((e) => {
              const icon =
                STEP_ICON[e.kind] ??
                ([
                  "succeeded",
                  "failed",
                  "cancelled",
                  "lost",
                  "running",
                  "starting",
                  "queued",
                ].includes(e.kind) ? (
                  <StateIcon state={e.kind as Run["state"]} size={13} />
                ) : (
                  <IconCircle size={9} />
                ));
              return (
                <li key={e.seq}>
                  <span className="ic">{icon}</span>
                  <span>
                    <b style={{ fontWeight: 500 }}>{e.kind}</b>{" "}
                    <span className="muted">{e.message}</span>
                  </span>
                  <span className="faint mono num" title={dateTime(e.at)}>
                    +{duration(Date.parse(e.at) - created)}
                  </span>
                </li>
              );
            })}
          {run.cleanup === "pending" && !isActive(run.state) && (
            <li>
              <span className="ic">
                <IconLoader size={13} className="spin" />
              </span>
              <span className="muted">cleaning up container and lease…</span>
              <span />
            </li>
          )}
        </ol>
        <div className="row" style={{ gap: 14, fontSize: 12 }}>
          <Check
            ok={run.cleanup === "done"}
            bad={run.cleanup === "failed"}
            label="container removed"
          />
          <Check
            ok={run.lease?.state === "released" || !run.lease}
            bad={run.cleanup === "failed"}
            label="lease released"
          />
          <Check ok={!isActive(run.state) && run.cleanup !== "pending"} label="logs collected" />
        </div>
      </div>
    </section>
  );
}

function Check({ ok, bad, label }: { ok: boolean; bad?: boolean; label: string }) {
  return (
    <span
      className="row"
      style={{
        gap: 5,
        color: bad ? "var(--st-failed)" : ok ? "var(--st-succeeded)" : "var(--text-3)",
      }}
    >
      {bad ? <IconX size={13} /> : ok ? <IconCheck size={13} /> : <IconCircle size={11} />}
      <span className={ok ? "muted" : "faint"}>{label}</span>
    </span>
  );
}

function Spec({ run }: { run: Run }) {
  const s = run.spec;
  const cmd = shellQuote(s.command);
  const workdir = run.code
    ? `/workspace${run.code.subdir ? `/${run.code.subdir}` : ""}`
    : "/workspace";
  return (
    <section className="card">
      <div className="card-h">Spec</div>
      <div className="card-b col" style={{ gap: 12 }}>
        <div className="cmd">
          <span className="faint">$ </span>
          {cmd}
          <span className="copy">
            <CopyButton text={cmd} label="" title="Copy command" />
          </span>
        </div>
        <dl className="kv">
          <dt>Image</dt>
          <dd className="mono">
            {run.image ?? s.image ?? "—"}
            {s.dockerfile && <span className="faint"> (built from {s.dockerfile})</span>}
          </dd>
          <dt>Workdir</dt>
          <dd className="mono">{s.snapshot && s.project ? workdir : "image default"}</dd>
          <dt>Resources</dt>
          <dd>
            {s.resources.gpus} GPU{s.resources.gpuMemGB ? ` (≥${s.resources.gpuMemGB} GB)` : ""} ·{" "}
            {s.resources.cpus} CPU · {s.resources.memGB} GB RAM
            {run.lease?.gpuIds.length ? (
              <div className="mono faint" style={{ fontSize: 11 }}>
                {run.lease.gpuIds.join(", ")}
              </div>
            ) : null}
          </dd>
          {run.usage && (
            <>
              <dt>Measured</dt>
              <dd>
                {run.usage.peakMemGB} GB RAM peak · CPU {run.usage.peakCpus} peak /{" "}
                {run.usage.meanCpus} mean
                {run.usage.peakGpuMemGB !== null && ` · ${run.usage.peakGpuMemGB} GB GPU peak`}
                {run.usage.oomKilled ? (
                  <span className="chip bad"> out of memory</span>
                ) : run.usage.oomKills ? (
                  <span className="chip warn"> {run.usage.oomKills} killed for memory</span>
                ) : null}
              </dd>
            </>
          )}
          <dt>Network</dt>
          <dd>{!s.network ? "disabled" : s.hostNetwork ? "host network" : "enabled"}</dd>
          {s.auth && (
            <>
              <dt>Agent auth</dt>
              <dd className="mono">{s.auth}</dd>
            </>
          )}
          <dt>User</dt>
          <dd>{s.root ? "root" : "host user"}</dd>
          {s.timeoutMin && (
            <>
              <dt>Timeout</dt>
              <dd>{s.timeoutMin} min</dd>
            </>
          )}
          {s.mounts.length > 0 && (
            <>
              <dt>Mounts</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {s.mounts.map((m) => (
                  <div key={m.target}>
                    {m.source ?? `dataset:${m.dataset}`} → {m.target}{" "}
                    <span className="faint">{m.mode}</span>
                  </div>
                ))}
              </dd>
            </>
          )}
          {Object.keys(s.env).length > 0 && (
            <>
              <dt>Env</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {Object.entries(s.env).map(([k, v]) => (
                  <div key={k}>
                    {k}=<span className="muted">{v}</span>
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{dateTime(run.createdAt)}</dd>
          {s.parentId && (
            <>
              <dt>Parent</dt>
              <dd>
                <Link href={`/runs/${encodeURIComponent(s.parentId)}`} className="mono">
                  {s.parentId}
                </Link>
              </dd>
            </>
          )}
        </dl>
      </div>
    </section>
  );
}

function Code({ run }: { run: Run }) {
  const c = run.code;
  if (!c) return null;
  return (
    <section className="card">
      <div className="card-h">
        Code snapshot{" "}
        <span className="sub">
          {c.fileCount} files · {(c.bytes / 1024 / 1024).toFixed(1)} MB copied
        </span>
      </div>
      <div className="card-b">
        <dl className="kv">
          <dt>Repository</dt>
          <dd className="mono">
            {c.repo}
            {c.subdir && <span className="faint"> / {c.subdir}</span>}
          </dd>
          <dt>Commit</dt>
          <dd className="mono">
            {c.branch ?? "detached"} @ {c.commit ?? "no commits"}{" "}
            {c.commit && <CopyButton text={c.commit} />}
          </dd>
          <dt>Working tree</dt>
          <dd>
            {c.dirty ? (
              <>
                <span style={{ color: "var(--st-cancelled)" }}>
                  {c.changedFiles.length} uncommitted change(s)
                </span>
                <div className="col" style={{ gap: 2, marginTop: 4 }}>
                  {c.changedFiles.slice(0, 12).map((f) => (
                    <Link
                      key={f}
                      className="row mono"
                      style={{ gap: 5, fontSize: 12 }}
                      href={`?tab=code#${encodeURIComponent(f)}`}
                    >
                      <IconFile size={12} /> {f}
                    </Link>
                  ))}
                  {c.changedFiles.length > 12 && (
                    <span className="faint">… {c.changedFiles.length - 12} more</span>
                  )}
                </div>
              </>
            ) : (
              <span className="muted">clean — exactly the commit above</span>
            )}
          </dd>
        </dl>
      </div>
    </section>
  );
}

function Note({ run }: { run: Run }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(run.note);
  useEffect(() => {
    if (!editing) setText(run.note);
  }, [run.note, editing]);
  const save = async () => {
    try {
      upsertRun(await api.note(run.id, text));
      setEditing(false);
    } catch (e) {
      toast(`Could not save the note: ${(e as Error).message}`);
    }
  };
  return (
    <section className="card">
      <div className="card-h">
        Notes <span className="sub">conclusions, hypotheses, what to try next</span>
        <div className="spacer" />
        {!editing && (
          <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>
            <IconEdit size={12} /> Edit
          </button>
        )}
      </div>
      <div className="card-b">
        {editing ? (
          <div className="col">
            <textarea
              className="input"
              rows={6}
              value={text}
              // biome-ignore lint/a11y/noAutofocus: user just clicked Edit
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <div className="row">
              <button type="button" className="btn primary sm" onClick={() => void save()}>
                Save
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <span className="faint" style={{ fontSize: 12 }}>
                ⌘/Ctrl+Enter to save · agents write here with{" "}
                <span className="mono">orbit note</span>
              </span>
            </div>
          </div>
        ) : run.note ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{run.note}</div>
        ) : (
          <div className="faint">
            No notes yet. Agents can record findings with{" "}
            <span className="mono">orbit note {run.id.slice(0, 15)}… "…"</span>
          </div>
        )}
      </div>
    </section>
  );
}

function MetricsSummary({
  metrics,
  onTab,
}: {
  metrics: Metrics | undefined;
  onTab: (t: string) => void;
}) {
  if (!metrics?.series.length)
    return (
      <section className="card">
        <div className="card-h">Metrics</div>
        <div className="card-b faint">
          <IconInfo size={13} style={{ verticalAlign: -2 }} /> No metrics. Append JSON lines like{" "}
          <span className="mono">{'{"step": 10, "loss": 0.3}'}</span> to{" "}
          <span className="mono">$ORBIT_METRICS</span>.
        </div>
      </section>
    );
  const series = metrics.series.slice(0, 10);
  return (
    <section className="card">
      <div className="card-h">
        Metrics <span className="sub">last value</span>
        <div className="spacer" />
        <button type="button" className="btn ghost sm" onClick={() => onTab("metrics")}>
          Charts →
        </button>
      </div>
      <table className="table compact">
        <tbody>
          {series.map((s) => (
            <tr key={s.key} className="click" onClick={() => onTab("metrics")}>
              <td className="mono">{s.key}</td>
              <td className="r num mono">{num(metrics.summary[s.key])}</td>
              <td style={{ width: 130 }}>
                <Sparkline points={s.points} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {metrics.series.length > 10 && (
        <div className="card-b faint">+{metrics.series.length - 10} more keys</div>
      )}
    </section>
  );
}

function LogPeek({ run, onTab }: { run: Run; onTab: (t: string) => void }) {
  const active = isActive(run.state);
  const tail = useAsync(() => api.logs(run.id, -16 * 1024, 16 * 1024), [run.id, run.state], {
    poll: active,
    pollMs: 2000,
  });
  const lines = toLines(tail.data?.text ?? "").slice(-25);
  return (
    <section className="card">
      <div className="card-h">
        Log tail
        <div className="spacer" />
        <button type="button" className="btn ghost sm" onClick={() => onTab("logs")}>
          Full logs →
        </button>
      </div>
      <div className="card-b">
        {lines.length ? (
          <div className="logpeek">
            {lines.map((l) => (
              <div
                key={l.n}
                style={{
                  color:
                    l.kind === "err"
                      ? "var(--st-failed)"
                      : l.kind === "sys"
                        ? "var(--st-starting)"
                        : undefined,
                }}
              >
                {l.plain || " "}
              </div>
            ))}
          </div>
        ) : (
          <div className="faint">{run.state === "queued" ? "Not started yet." : "No output."}</div>
        )}
      </div>
    </section>
  );
}
