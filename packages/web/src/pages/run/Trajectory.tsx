import { useVirtualizer } from "@tanstack/react-virtual";
import type { AtifStep, AtifTrajectory } from "@zjunlp/orbit/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api, type Run } from "../../lib/api.ts";
import { atifText, stepInterval, trajectoryMediaUrl, trajectoryTree } from "../../lib/atif.ts";
import { isActive, runPath } from "../../lib/format.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import { SubmitterSession } from "./Session.tsx";
import { TrajectoryEnvironment } from "./TrajectoryEnvironment.tsx";
import "./trajectory.css";

export function TrajectoryTab({
  run,
  prefix = "",
  compact = false,
  trialContext,
}: {
  run: Run;
  prefix?: string;
  compact?: boolean;
  trialContext?: { job: string; trial: string };
}) {
  const source = useAsync(() => api.trajectory(run.id), [run.id, run.state], {
    poll: isActive(run.state),
    pollMs: 5000,
  });
  const [submitter, setSubmitter] = useState(false);
  return (
    <div className="atif-tab">
      {!compact && (
        <div className="toolbar">
          <b>Trajectory</b>
          <span className="faint">Recorded Agent steps and environment evidence</span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => setSubmitter(!submitter)}>
            {submitter ? "Agent trajectory" : "Submitter session"}
          </button>
          <button type="button" className="btn sm" onClick={source.reload}>
            Refresh
          </button>
        </div>
      )}
      {submitter ? (
        <SubmitterSession run={run} />
      ) : source.error ? (
        <>
          <Empty title="Trajectory unavailable">
            <p>{source.error}</p>
            <button type="button" className="btn" onClick={source.reload}>
              Retry
            </button>
          </Empty>
          {!compact && <TrajectoryEnvironment run={run} step={null} trialContext={trialContext} />}
        </>
      ) : source.data === undefined ? (
        <Loading what="Loading trajectory" />
      ) : source.data === null ? (
        <>
          <Empty title="No Agent trajectory">
            {isActive(run.state)
              ? "No readable steps yet. This view refreshes while the Run is active."
              : "No convertible Agent evidence was recorded. Environment evidence may still be available below."}
          </Empty>
          {!compact && <TrajectoryEnvironment run={run} step={null} trialContext={trialContext} />}
        </>
      ) : (
        <AtifViewer
          key={run.id}
          run={run}
          root={source.data}
          prefix={prefix}
          compact={compact}
          trialContext={trialContext}
        />
      )}
    </div>
  );
}

export function AtifViewer({
  run,
  root,
  prefix = "",
  compact = false,
  trialContext,
}: {
  run: Run;
  root: AtifTrajectory;
  prefix?: string;
  compact?: boolean;
  trialContext?: { job: string; trial: string };
}) {
  const loc = useLocation();
  const tree = useMemo(() => trajectoryTree(root), [root]);
  const path = loc.query.get(`${prefix}agent`) ?? "";
  const branch = tree.find((row) => row.path === path);
  const trace = branch?.trace;
  const raw = loc.query.get(`${prefix}step`);
  const number = raw && /^\d+$/.test(raw) ? Number(raw) : 1;
  const index = Number.isSafeInteger(number)
    ? Math.max(0, Math.min((trace?.steps.length ?? 1) - 1, number - 1))
    : 0;
  const step = trace?.steps[index];
  const [search, setSearch] = useState("");
  const rows = useMemo(
    () =>
      (trace?.steps ?? []).filter(
        (s) =>
          !search ||
          `${s.step_id} ${s.source} ${atifText(s.message)} ${(s.tool_calls ?? []).map((c) => c.function_name).join(" ")}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [trace, search],
  );
  const box = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => box.current,
    estimateSize: () => 68,
    overscan: 6,
    initialRect: { width: 220, height: 560 },
  });
  const selectedRow = rows.findIndex((s) => s.step_id === step?.step_id);
  useEffect(() => {
    if (selectedRow >= 0) virtual.scrollToIndex(selectedRow, { align: "auto" });
  }, [selectedRow, virtual]);
  const select = (id: number) => setQuery({ [`${prefix}step`]: String(id) });
  const selectBranch = (next: string) =>
    setQuery({ [`${prefix}agent`]: next || null, [`${prefix}step`]: null });
  const gap = step ? stepInterval(step, trace?.steps[index + 1]) : null;
  if (!trace || !step)
    return (
      <Empty title="Trajectory branch unavailable">
        <button type="button" className="btn" onClick={() => selectBranch("")}>
          Open root trajectory
        </button>
      </Empty>
    );
  return (
    <section
      className={`atif-view${compact ? " compact" : ""}`}
      aria-label="Agent trajectory"
      onKeyDown={(e) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))
        )
          return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          select(
            Math.min(
              trace.steps.length,
              Math.max(1, step.step_id + (e.key === "ArrowLeft" ? -1 : 1)),
            ),
          );
        }
      }}
    >
      <div className="atif-heading">
        <label>
          Agent{" "}
          <select
            className="input"
            aria-label="Trajectory branch"
            value={path}
            onChange={(e) => selectBranch(e.target.value)}
          >
            {tree.map((row) => (
              <option
                key={row.path}
                value={row.path}
              >{`${"↳ ".repeat(row.depth)}${row.trace.agent.name} · ${row.trace.trajectory_id ?? row.trace.session_id ?? "root"}`}</option>
            ))}
          </select>
        </label>
        <span className="chip">{trace.schema_version}</span>
        <span className="chip">
          {trace.extra?.orbit?.completeness ?? "Completeness not recorded"}
        </span>
        <span className="faint">
          {trace.steps.length} steps · {trace.agent.model_name ?? "Model not recorded"}
        </span>
      </div>
      {!!trace.extra?.orbit?.warnings?.length && (
        <details className="atif-warning">
          <summary>Evidence warnings ({trace.extra.orbit.warnings.length})</summary>
          <ul>
            {trace.extra.orbit.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {trace.extra?.orbit?.completeness === "truncated" && (
        <p className="atif-warning">
          Partial trajectory: some steps, results or usage could not be recovered.
        </p>
      )}
      <div className="atif-grid">
        <aside className="atif-nav">
          <input
            className="input"
            type="search"
            aria-label="Find trajectory steps"
            placeholder="Find steps or tools"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <nav ref={box} className="atif-step-list" aria-label="Trajectory steps">
            <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
              {virtual.getVirtualItems().map((v) => {
                const s = rows[v.index];
                return s ? (
                  <button
                    key={s.step_id}
                    type="button"
                    className={`atif-step${s.step_id === step.step_id ? " on" : ""}`}
                    aria-current={s.step_id === step.step_id ? "step" : undefined}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: v.size,
                      transform: `translateY(${v.start}px)`,
                    }}
                    onClick={() => select(s.step_id)}
                  >
                    <b>
                      {s.step_id} · {s.source}
                    </b>
                    <small>
                      {s.extra?.orbit?.checkpoint ? "Checkpoint · " : ""}
                      {s.extra?.context_management ? "Context compression · " : ""}
                      {atifText(s.message).slice(0, 100) ||
                        s.tool_calls?.map((c) => c.function_name).join(", ") ||
                        "Recorded step"}
                    </small>
                  </button>
                ) : null;
              })}
            </div>
            {!rows.length && <p>No matching steps.</p>}
          </nav>
        </aside>
        <article className="atif-detail">
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={index === 0}
              onClick={() => select(step.step_id - 1)}
            >
              ← Previous
            </button>
            <b>
              Step {step.step_id} · {step.source}
            </b>
            <button
              type="button"
              className="btn sm"
              disabled={index === trace.steps.length - 1}
              onClick={() => select(step.step_id + 1)}
            >
              Next →
            </button>
          </div>
          <div className="atif-facts">
            <span>{step.timestamp ?? "Time not recorded"}</span>
            <span>Input: {step.metrics?.prompt_tokens ?? "not recorded"}</span>
            <span>Output: {step.metrics?.completion_tokens ?? "not recorded"}</span>
            <span>Cached: {step.metrics?.cached_tokens ?? "not recorded"}</span>
            <span>
              Until next step: {gap === null ? "not recorded" : `${Number(gap.toFixed(3))} s`}
            </span>
          </div>
          {step.is_copied_context && <p className="chip">Copied context</p>}
          {step.extra?.context_management != null && (
            <details open>
              <summary>Context compression</summary>
              <pre>{JSON.stringify(step.extra.context_management, null, 2)}</pre>
            </details>
          )}
          {step.extra?.orbit?.checkpoint && (
            <p className="chip">
              Checkpoint · {step.extra.orbit.checkpoint.level} · {step.extra.orbit.checkpoint.id}
            </p>
          )}
          <AtifContent run={run.id} content={step.message} />
          {step.extra?.orbit?.reasoning === "opaque" ? (
            <p className="faint">Opaque reasoning was not retained.</p>
          ) : (
            step.reasoning_content && (
              <details>
                <summary>
                  Reasoning{step.extra?.orbit?.reasoning === "summary" ? " summary" : ""}
                </summary>
                <AtifContent run={run.id} content={step.reasoning_content} />
              </details>
            )
          )}
          {!!step.tool_calls?.length && (
            <section aria-label="Tool calls">
              <h3>
                {step.tool_calls.length} tool call{step.tool_calls.length === 1 ? "" : "s"} in this
                step
              </h3>
              {step.tool_calls.map((call) => (
                <details key={call.tool_call_id} className="atif-tool">
                  <summary>
                    {call.function_name} <span className="faint">{call.tool_call_id}</span>
                  </summary>
                  <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                  {step.observation?.results
                    .filter((result) => result.source_call_id === call.tool_call_id)
                    .map((result, i) => (
                      <div key={String(i)} className="atif-result">
                        <b>Result {i + 1}</b>
                        <AtifContent run={run.id} content={result.content} />
                      </div>
                    ))}
                  {!step.observation?.results.some(
                    (r) => r.source_call_id === call.tool_call_id,
                  ) && <p>Result not recorded.</p>}
                </details>
              ))}
            </section>
          )}
          {step.observation?.results
            .filter((r) => !r.source_call_id)
            .map((r, i) => (
              <AtifContent key={String(i)} run={run.id} content={r.content} />
            ))}
          {step.observation?.results
            .flatMap((r) => r.subagent_trajectory_ref ?? [])
            .map((ref, i) => {
              const child = tree.find(
                (row) =>
                  row.path.startsWith(path ? `${path}/` : "") &&
                  row.depth === (branch?.depth ?? 0) + 1 &&
                  (ref.trajectory_id
                    ? row.trace.trajectory_id === ref.trajectory_id
                    : ref.session_id != null && row.trace.session_id === ref.session_id),
              );
              return (
                <div key={String(i)} className="atif-child">
                  {child ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => selectBranch(child.path)}
                    >
                      Open sub-Agent · {child.trace.agent.name}
                    </button>
                  ) : (
                    <span>
                      Sub-Agent evidence unavailable ·{" "}
                      {ref.trajectory_id ?? ref.session_id ?? ref.trajectory_path}
                    </span>
                  )}
                </div>
              );
            })}
        </article>
        {!compact && (
          <aside className="atif-environment">
            <TrajectoryEnvironment
              key={`${run.id}/${path}`}
              run={run}
              trialContext={trialContext}
              step={path ? null : step.step_id}
              subagent={!!path}
            />
          </aside>
        )}
      </div>
      {compact && (
        <Link
          className="atif-full"
          href={`${runPath(run.id)}?tab=session&step=${step.step_id}${path ? `&agent=${encodeURIComponent(path)}` : ""}`}
        >
          Open full trajectory and environment →
        </Link>
      )}
    </section>
  );
}

export function AtifContent({
  run,
  content,
}: {
  run: string;
  content: AtifStep["message"] | null | undefined;
}) {
  if (content == null) return <p className="faint">Content not recorded.</p>;
  if (typeof content === "string")
    return <Markdown text={content} resolve={(path) => trajectoryMediaUrl(run, path)} />;
  return (
    <>
      {content.map((part, i) => {
        if (part.type === "text")
          return <AtifContent key={String(i)} run={run} content={part.text} />;
        const url = trajectoryMediaUrl(run, part.source.path);
        return !url ? (
          <p key={String(i)} className="faint">
            Media unavailable: {part.source.path}
          </p>
        ) : part.type === "image" ? (
          <img key={String(i)} src={url} alt="Recorded Agent observation" loading="lazy" />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: Original evidence has no supplied caption track; no transcript is fabricated.
          <audio key={String(i)} src={url} controls preload="none" aria-label="Recorded audio" />
        );
      })}
    </>
  );
}
