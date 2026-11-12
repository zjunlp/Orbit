// Tabs of trials without a declared `review` (older trials and adapters): the solve run's Markdown
// report and the verifier's JSON results, found by name.
import { useMemo } from "react";
import { IconFile } from "../../components/icons.tsx";
import { joinPath, Markdown } from "../../components/Markdown.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api, fileUrl, type Run } from "../../lib/api.ts";
import { runPath } from "../../lib/format.ts";
import { reportCandidates } from "../../lib/report.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { readRunFile } from "../../lib/run-file.ts";
import { useAsync } from "../../lib/use.ts";
import { Reasoning } from "./parts.tsx";

function useText(runId: string, path: string | undefined) {
  return useAsync(
    () => (path ? readRunFile(runId, path, "the file") : Promise.resolve(null)),
    [runId, path],
  );
}

export function ReportView({ run }: { run: Run }) {
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

export function GraderView({ run }: { run: Run }) {
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
