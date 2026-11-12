// Views of what an adapter declared in `review`: one component per file kind, the grouped evidence
// and the details. A kind is added in three places: `REVIEW_KINDS` (contracts), `KNOWN_KINDS`
// (lib/review.ts) and `FILE_VIEWS` below, which the type checker keeps complete.
import { Fragment, useMemo } from "react";
import { joinPath, Markdown } from "../../components/Markdown.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { fileUrl, type Review, type ReviewFile, type Run } from "../../lib/api.ts";
import { bytes, runPath } from "../../lib/format.ts";
import {
  extraFields,
  fileHref,
  fileLabel,
  type Kind,
  REVIEW_FIELDS,
  resolveKind,
  showValue,
} from "../../lib/review.ts";
import { setQuery } from "../../lib/router.ts";
import { useRunFile } from "../../lib/run-file.ts";
import { Csv } from "../run/Artifacts.tsx";
import { ConversationFile } from "./Conversation.tsx";
import { EpisodeFile, VideoPreview } from "./Episode.tsx";
import { FileBar, Value } from "./parts.tsx";
import { TestsFile } from "./Tests.tsx";
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
        fallback={fallback >= 0 ? fileHref(review.files, fallback) : undefined}
      />
    );
  },
  episode: ({ run, file, solve }) => <EpisodeFile run={run} file={file} solve={solve} />,
  conversation: ({ run, file }) => <ConversationFile run={run} file={file} />,
  tests: ({ run, file }) => <TestsFile run={run} file={file} />,
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
      <FileBar runId={run.id} path={f.path}>
        {entry && <span className="faint">{bytes(entry.bytes)}</span>}
        {note && <span className="chip warn">{note}</span>}
        {extras.map(([k, v]) => (
          <span key={k} className="chip mono" title={showValue(v)}>
            {k}: {showValue(v).slice(0, 40)}
          </span>
        ))}
      </FileBar>
      <div className="report-body">{body}</div>
    </div>
  );
}

/** The files without a tab of their own: a list to pick from, one file shown at a time. */
export function EvidenceView(props: {
  review: Review;
  /** Indexes into `review.files`. */
  indexes: number[];
  selected: number | null;
  solve: Run | undefined;
  verify: Run | undefined;
}) {
  const { review, indexes } = props;
  const index =
    props.selected !== null && indexes.includes(props.selected) ? props.selected : indexes[0];
  const f = index === undefined ? undefined : review.files[index];
  if (!f || index === undefined) return <Empty title="No evidence files" />;
  const run = f.phase === "solve" ? props.solve : props.verify;
  const View = FILE_VIEWS[resolveKind(f).kind];
  return (
    <div className="evidence">
      <nav className="evidence-list" aria-label="Evidence files">
        {indexes.map((i) => {
          const item = review.files[i];
          if (!item) return null;
          return (
            <a
              key={i}
              href={`?tab=evidence&file=${i}`}
              className={i === index ? "on" : ""}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                setQuery({ tab: "evidence", file: String(i) }, { hash: "" });
              }}
            >
              {fileLabel(item)}
              <small>
                {item.phase} · {resolveKind(item).kind}
              </small>
            </a>
          );
        })}
      </nav>
      <div className="evidence-file">
        {run ? (
          <View
            key={`${run.id}/${f.path}`}
            run={run}
            file={f}
            review={review}
            solve={props.solve}
          />
        ) : (
          <Empty title={`No ${f.phase} run`} />
        )}
      </div>
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
    <div className="page-pad trial-config">
      <section className="card">
        <div className="card-h">Details</div>
        <div className="card-b">
          <dl className="kv">
            {rows.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>
                  <Value value={v} />
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
