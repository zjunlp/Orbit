// Views of what an adapter declared in `review`: one component per file kind, the graded items and
// the details. A kind is added in three places: `REVIEW_KINDS` (contracts), `KNOWN_KINDS`
// (lib/review.ts) and `FILE_VIEWS` below, which the type checker keeps complete.
import { Fragment, useMemo, useState } from "react";
import { joinPath, Markdown } from "../../components/Markdown.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { fileUrl, type Review, type ReviewFile, type ReviewItem, type Run } from "../../lib/api.ts";
import { bytes, fmtScore, runPath } from "../../lib/format.ts";
import { extraFields, type Kind, REVIEW_FIELDS, resolveKind, showValue } from "../../lib/review.ts";
import { useRunFile } from "../../lib/run-file.ts";
import { Csv } from "../run/Artifacts.tsx";
import { ConversationFile } from "./Conversation.tsx";
import { EpisodeFile, VideoPreview } from "./Episode.tsx";
import { TrajectoryFile } from "./Trajectory.tsx";

export interface FileViewProps {
  /** The run of the file's phase. */
  run: Run;
  file: ReviewFile;
  review: Review;
  solve: Run | undefined;
}

const preview = ({ run, file }: FileViewProps) => <ReviewFileView run={run} f={file} />;

/** How each review kind is shown. */
export const FILE_VIEWS: Record<Kind, (p: FileViewProps) => React.ReactNode> = {
  markdown: preview,
  image: preview,
  video: preview,
  text: preview,
  json: preview,
  table: preview,
  trajectory: ({ run, file, review }) => {
    const fallback = review.files.findIndex(
      (item) => item.phase === file.phase && resolveKind(item).kind === "markdown",
    );
    return (
      <TrajectoryFile
        run={run}
        file={file}
        note={resolveKind(file).note}
        fallback={fallback >= 0 ? `?tab=f${fallback}` : undefined}
      />
    );
  },
  episode: ({ run, file, solve }) => <EpisodeFile run={run} file={file} solve={solve} />,
  conversation: ({ run, file }) => <ConversationFile run={run} file={file} />,
};

/** Kinds read step by step; their tabs come first and execution details start folded. */
export const isInteractive = (f: ReviewFile) => {
  const kind = resolveKind(f).kind;
  return kind === "trajectory" || kind === "conversation";
};

const MAX_PREVIEW = 2 * 1024 * 1024;

/** One declared file of a plain kind, rendered with Orbit's styles. */
function ReviewFileView({ run, f }: { run: Run; f: ReviewFile }) {
  const { kind, note } = resolveKind(f);
  const text = useRunFile(run, f.path, {
    what: "the file",
    maxBytes: MAX_PREVIEW,
    parse: (t) => t,
    skip: kind === "image" || kind === "video",
  });
  const a = text.listing;
  const entry = text.entry;
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
  if (a.error) body = <Empty title="Could not list the outputs">{a.error}</Empty>;
  else if (!a.data) body = <Loading />;
  else if (!entry)
    body = (
      <Empty title="File not found">
        The {f.phase} run has no <code>{f.path}</code>.{" "}
        <Link href={`${runPath(run.id)}?tab=artifacts`}>Outputs →</Link>
      </Empty>
    );
  else if (kind === "image")
    body = <img className="review-img" src={fileUrl(run.id, f.path)} alt={f.label} />;
  else if (kind === "video")
    body = <VideoPreview key={`${run.id}/${f.path}`} runId={run.id} path={f.path} name={f.label} />;
  else if (text.tooLarge)
    body = <Empty title="Too large to preview">{bytes(entry.bytes)} — use Download.</Empty>;
  else if (text.error) body = <Empty title="Could not load the file">{text.error}</Empty>;
  else if (text.data === undefined) body = <Loading />;
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

export function Reasoning({ text }: { text: string }) {
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

const ITEM_FIELDS = ["criterion", "score", "maxScore", "weight", "type", "reasoning"] as const;

export function GraderItems({ items }: { items: ReviewItem[] }) {
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
export function DetailsView({ review }: { review: Review }) {
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
