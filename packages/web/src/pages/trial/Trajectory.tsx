import type { GuiTrace, SessionMessage } from "@zjunlp/orbit/contracts";
import { useMemo, useState } from "react";
import { copy, Empty, Link, Loading } from "../../components/ui.tsx";
import { api, fileUrl, type ReviewFile, type Run } from "../../lib/api.ts";
import { bytes, runPath } from "../../lib/format.ts";
import { actionOverlay, stepMessages } from "../../lib/gui-action.ts";
import { overlayOpen, useHotkeys } from "../../lib/hotkeys.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { parseTrajectory, trajectoryFrame, trajectoryStep } from "../../lib/trajectory.ts";
import { useAsync } from "../../lib/use.ts";
import "./trajectory.css";

const MAX_BYTES = 2 * 1024 * 1024;

export function TrajectoryFile({
  run,
  file,
  fallback,
  note,
}: {
  run: Run;
  file: ReviewFile;
  fallback?: string;
  note?: string | null;
}) {
  const a = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const session = useAsync(() => api.session(run.id), [run.id, run.state]);
  const entry = a.data?.files.find((item) => item.path === file.path);
  const source = useAsync(async () => {
    if (!entry || entry.bytes > MAX_BYTES) return null;
    const response = await fetch(fileUrl(run.id, file.path));
    if (!response.ok) throw new Error(`Could not read the trajectory (${response.status}).`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error("The trajectory is too large to preview.");
    return parseTrajectory(text);
  }, [run.id, file.path, entry?.bytes, entry?.mtime]);
  const files = useMemo(() => new Set(a.data?.files.map((f) => f.path) ?? []), [a.data]);
  const problem =
    a.error ??
    (a.data && !entry
      ? a.data.truncated
        ? "The output listing is truncated; the trajectory was not listed."
        : "The run did not save the declared trajectory file."
      : null) ??
    (entry && entry.bytes > MAX_BYTES
      ? `${bytes(entry.bytes)} exceeds the preview limit. Download the original file.`
      : null) ??
    source.error;
  return (
    <div className="gui-review">
      <div className="toolbar">
        <span className="faint">Saved trajectory</span>
        <span className="mono ellipsis">{file.path}</span>
        {note && <span className="chip warn">{note}</span>}
        <div className="spacer" />
        {fallback && (
          <Link className="btn sm" href={fallback}>
            Markdown view
          </Link>
        )}
        <a className="btn sm" href={fileUrl(run.id, file.path, true)}>
          Download trace
        </a>
        <Link className="btn sm" href={`${runPath(run.id)}?tab=logs`}>
          Execution logs
        </Link>
      </div>
      {problem ? (
        <Empty title="Trajectory unavailable">
          {problem} Other saved outputs and scores remain available.
          {fallback && (
            <p>
              <Link href={fallback}>Open the Markdown view →</Link>
            </p>
          )}
        </Empty>
      ) : !source.data ? (
        <Loading what="Loading saved trajectory" />
      ) : (
        <TrajectoryViewer
          key={`${run.id}/${file.path}`}
          trajectory={source.data}
          runId={run.id}
          files={files}
          listingTruncated={a.data?.truncated ?? false}
          messages={session.data?.agent?.messages ?? []}
        />
      )}
    </div>
  );
}

export function TrajectoryViewer({
  trajectory,
  runId,
  files,
  listingTruncated,
  messages = [],
}: {
  trajectory: GuiTrace;
  runId: string;
  files: Set<string>;
  listingTruncated: boolean;
  messages?: SessionMessage[];
}) {
  const loc = useLocation();
  const index = trajectoryStep(loc.query.get("step"), trajectory.steps.length);
  const before = loc.query.get("frame") === "before";
  const { action, observation } = trajectoryFrame(trajectory, index, before);
  const last = trajectory.steps.length - 1;
  const aligned = stepMessages(trajectory, index, messages);
  const [original, setOriginal] = useState(false);
  const select = (step: number) => setQuery({ step: String(Math.max(0, Math.min(last, step))) });
  useHotkeys({
    ArrowLeft: () => {
      if (!overlayOpen()) select(index - 1);
    },
    ArrowRight: () => {
      if (!overlayOpen()) select(index + 1);
    },
  });
  const firstError = trajectory.steps.findIndex((step) => Boolean(step.actionError));
  const start = Math.max(0, Math.min(index - 10, trajectory.steps.length - 21));
  const visible = trajectory.steps.slice(start, start + 21);
  const screenshot = files.has(observation.screenshot)
    ? fileUrl(runId, observation.screenshot)
    : null;
  const copyLink = () => {
    const url = new URL(location.href);
    url.searchParams.set("step", String(index));
    url.searchParams.set("frame", before ? "before" : "after");
    void copy(url.href, "Step link copied");
  };
  return (
    <div className="gui-trajectory">
      <div className="gui-goal">
        <span className="faint">Task goal</span>
        <p>{trajectory.goal || "No task goal recorded."}</p>
      </div>
      <div className="gui-trajectory-grid">
        <nav className="gui-step-list" aria-label="Trajectory steps">
          <div className="gui-step-heading">
            <b>Steps</b>
            <span className="faint">
              {last} {last === 1 ? "action" : "actions"}
            </span>
          </div>
          {firstError >= 0 && (
            <button type="button" className="btn sm" onClick={() => select(firstError)}>
              First action error
            </button>
          )}
          {start > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => select(start - 1)}>
              Earlier steps
            </button>
          )}
          {visible.map((step) => (
            <button
              key={step.step}
              type="button"
              className={`btn gui-step${step.step === index ? " on" : ""}`}
              aria-current={step.step === index ? "step" : undefined}
              onClick={() => select(step.step)}
            >
              <span>{step.step === 0 ? "Initial observation" : `Step ${step.step}`}</span>
              <small>
                {step.actionError
                  ? "Action error"
                  : step.truncated
                    ? "Truncated"
                    : step.terminated
                      ? "Task ended"
                      : (step.action ?? "Environment initialized")}
              </small>
            </button>
          ))}
          {start + visible.length < trajectory.steps.length && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => select(start + visible.length)}
            >
              Later steps
            </button>
          )}
        </nav>
        <section className="gui-observation" aria-label="Selected observation">
          <div className="gui-screen-toolbar">
            <b>
              {index === 0
                ? "Initial observation"
                : `Step ${index} · ${before ? "before action" : "after action"}`}
            </b>
            <fieldset className="seg" aria-label="Observation time">
              <button
                type="button"
                disabled={index === 0}
                className={before ? "on" : ""}
                aria-pressed={before}
                onClick={() => setQuery({ frame: "before" })}
              >
                Before
              </button>
              <button
                type="button"
                disabled={index === 0}
                className={!before ? "on" : ""}
                aria-pressed={!before}
                onClick={() => setQuery({ frame: "after" })}
              >
                After
              </button>
            </fieldset>
          </div>
          <div className={`gui-screen${original ? " original" : ""}`}>
            {screenshot ? (
              <SavedScreenshot
                key={screenshot}
                src={screenshot}
                label={`Observation ${observation.step} for ${trajectory.goal}`}
                action={action.action}
                error={action.actionError}
              />
            ) : (
              <Empty title="Screenshot unavailable">
                {listingTruncated
                  ? "The output listing is truncated; this screenshot was not listed."
                  : "This screenshot is missing from the saved outputs."}
                <p className="mono">{observation.screenshot}</p>
              </Empty>
            )}
          </div>
          <div className="gui-screen-footer">
            <span className="faint">Observation {observation.step} · saved frame</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn sm"
                disabled={!screenshot}
                aria-pressed={original}
                onClick={() => setOriginal(!original)}
              >
                {original ? "Fit image" : "100% zoom"}
              </button>
              {screenshot && (
                <a className="btn sm" href={screenshot} target="_blank" rel="noreferrer">
                  Open original
                </a>
              )}
            </div>
          </div>
        </section>
        <aside className="gui-step-detail" aria-label="Selected action and feedback">
          <div>
            <span className="faint">{index === 0 ? "Initial state" : `Step ${index} action`}</span>
            <pre>{action.action ?? "No action"}</pre>
          </div>
          <div>
            <span className="faint">Action error</span>
            <p className={action.actionError ? "gui-action-error" : ""}>
              {action.actionError || (index ? "None recorded" : "—")}
            </p>
          </div>
          <div>
            <span className="faint">Step reward</span>
            <p className="num">{action.reward ?? "Not recorded"}</p>
          </div>
          <div>
            <span className="faint">Environment status</span>
            <p>
              {action.truncated
                ? "Truncated"
                : action.terminated
                  ? "Task ended"
                  : index === 0
                    ? "Initialized"
                    : "Continuing"}
            </p>
          </div>
          {index === last && trajectory.stopReason && (
            <div>
              <span className="faint">Episode stop reason</span>
              <p>{trajectory.stopReason}</p>
            </div>
          )}
          <section aria-label="Agent at this step">
            <span className="faint">Agent at this step</span>
            {aligned.length ? (
              aligned.map((message) => (
                <details
                  key={`${message.kind}-${message.at}-${message.text}`}
                  open={message.kind === "thinking"}
                >
                  <summary>
                    {message.kind.replace("_", " ")}
                    {message.name ? ` · ${message.name}` : ""}
                  </summary>
                  <pre>{message.text}</pre>
                </details>
              ))
            ) : (
              <p className="faint">
                No session messages linked to this action. The full Agent session remains available.
              </p>
            )}
          </section>
          {observation.observation && (
            <details>
              <summary>Observation text</summary>
              <pre>{observation.observation}</pre>
            </details>
          )}
        </aside>
      </div>
      <div className="gui-step-controls">
        <button
          type="button"
          className="btn sm"
          disabled={index === 0}
          onClick={() => select(index - 1)}
        >
          ← Previous
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={index}
          disabled={last === 0}
          aria-label="Select trajectory step"
          onChange={(e) => select(Number(e.target.value))}
        />
        <span aria-live="polite" className="num">
          {index === 0 ? "Initial" : `Step ${index}`} / {last}
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={index === last}
          onClick={() => select(index + 1)}
        >
          Next →
        </button>
        <button type="button" className="btn sm" onClick={copyLink}>
          Copy step link
        </button>
      </div>
      <p className="faint gui-trace-note">
        Saved observations only. Viewing a step does not rerun actions or restore the environment.
      </p>
    </div>
  );
}

export function ActionMarker({
  action,
  width,
  height,
}: {
  action: string | null;
  width: number;
  height: number;
}) {
  const overlay = actionOverlay(action);
  if (!overlay.point || width <= 0 || height <= 0) return null;
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x <= width && y <= height;
  if (!inside(overlay.point) || (overlay.end && !inside(overlay.end))) return null;
  return (
    <svg
      className="gui-action-overlay"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={overlay.end ? "Drag path" : "Action position"}
    >
      <title>{overlay.end ? "Drag path" : "Action position"}</title>
      {overlay.end && (
        <line x1={overlay.point[0]} y1={overlay.point[1]} x2={overlay.end[0]} y2={overlay.end[1]} />
      )}
      <circle cx={overlay.point[0]} cy={overlay.point[1]} r={7} />
      {overlay.end && <circle cx={overlay.end[0]} cy={overlay.end[1]} r={4} />}
    </svg>
  );
}

function SavedScreenshot({
  src,
  label,
  action,
  error,
}: {
  src: string;
  label: string;
  action: string | null;
  error?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState([0, 0]);
  const overlay = actionOverlay(action);
  return failed ? (
    <Empty title="Could not load the screenshot">
      The recorded action is still available. Check the original outputs.
    </Empty>
  ) : (
    <div className="gui-image-wrap">
      <div className="gui-image-position">
        <img
          loading="lazy"
          decoding="async"
          src={src}
          alt={label}
          onError={() => setFailed(true)}
          onLoad={(event) =>
            setSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])
          }
        />
        <ActionMarker action={action} width={size[0] ?? 0} height={size[1] ?? 0} />
      </div>
      {(overlay.text || error) && (
        <div className="gui-image-caption">
          {overlay.text && (
            <div>
              Input: <code>{overlay.text}</code>
            </div>
          )}
          {error && <div className="gui-action-error">Action error: {error}</div>}
        </div>
      )}
    </div>
  );
}
