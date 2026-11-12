// The `tests` review kind: a saved CTRF test report as a checklist, failures first with their
// message and trace. A file that is not a CTRF report is shown as it is, with a note.
import { useState } from "react";
import { IconBan, IconCheck, IconCircle, IconX } from "../../components/icons.tsx";
import { Empty, Loading } from "../../components/ui.tsx";
import type { ReviewFile, Run } from "../../lib/api.ts";
import { bytes, duration } from "../../lib/format.ts";
import { useRunFile } from "../../lib/run-file.ts";
import {
  parseTestsReport,
  TEST_STATUSES,
  type TestCase,
  type TestStatus,
  type TestsReport,
} from "../../lib/tests-report.ts";
import { FileBar } from "./parts.tsx";

const MAX_BYTES = 4 * 1024 * 1024;

const parse = (text: string): { report: TestsReport } | { raw: string; problem: string } => {
  try {
    return { report: parseTestsReport(text) };
  } catch (e) {
    return { raw: text, problem: (e as Error).message };
  }
};

export function TestsFile({ run, file }: { run: Run; file: ReviewFile }) {
  const source = useRunFile(run, file.path, {
    what: "the test report",
    maxBytes: MAX_BYTES,
    parse,
  });
  const problem =
    (source.missing ? "The run did not save the declared test report." : null) ??
    (source.tooLarge && source.entry
      ? `${bytes(source.entry.bytes)} exceeds the preview limit. Download the original file.`
      : null) ??
    source.error;
  const data = source.data;
  return (
    <div className="report">
      <FileBar runId={run.id} path={file.path}>
        {data && "problem" in data && <span className="chip warn">{data.problem}</span>}
      </FileBar>
      <div className="report-body">
        {problem ? (
          <Empty title="Test report unavailable">{problem}</Empty>
        ) : !data ? (
          <Loading what="Loading test report" />
        ) : "report" in data ? (
          <TestsView report={data.report} />
        ) : (
          <pre className="review-pre">{data.raw}</pre>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<TestStatus, string> = {
  failed: "Failed",
  other: "Other",
  pending: "Pending",
  skipped: "Skipped",
  passed: "Passed",
};

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === "passed") return <IconCheck size={14} strokeWidth={2.6} />;
  if (status === "failed") return <IconX size={14} strokeWidth={2.6} />;
  if (status === "skipped") return <IconBan size={13} />;
  return <IconCircle size={13} />;
}

/** A measured time; a report that records no time writes 0, which says nothing. */
const took = (ms: number | null) =>
  !ms ? "" : ms < 1 ? "<1ms" : ms < 1000 ? `${Math.round(ms)}ms` : duration(ms);

export function TestsView({ report }: { report: TestsReport }) {
  const [only, setOnly] = useState<TestStatus | null>(null);
  const total = TEST_STATUSES.reduce((a, s) => a + report.counts[s], 0);
  const present = TEST_STATUSES.filter((s) => report.counts[s] > 0);
  const shown = only ? report.tests.filter((t) => t.status === only) : report.tests;
  const firstTrace = report.tests.find((t) => t.status === "failed" && t.trace);
  const failed = report.counts.failed;
  if (total === 0) return <Empty title="The report lists no tests" />;
  return (
    <div className="tests">
      <header className="tests-summary">
        <b className={failed ? "st-failed" : report.counts.passed === total ? "st-passed" : ""}>
          {failed
            ? `${failed} of ${total} failed`
            : report.counts.passed === total
              ? `All ${total} passed`
              : `${report.counts.passed} of ${total} passed`}
        </b>
        <span className="tests-bar" aria-hidden="true">
          {present.map((s) => (
            <i key={s} className={`st-${s}`} style={{ flexGrow: report.counts[s] }} />
          ))}
        </span>
        <span className="faint">
          {[report.tool, took(report.durationMs)].filter(Boolean).join(" · ")}
        </span>
        <div className="spacer" />
        {present.length > 1 && (
          <div className="seg">
            <button
              type="button"
              className={only === null ? "on" : ""}
              onClick={() => setOnly(null)}
            >
              All {total}
            </button>
            {present.map((s) => (
              <button
                type="button"
                key={s}
                className={only === s ? "on" : ""}
                onClick={() => setOnly(s)}
              >
                {STATUS_LABEL[s]} {report.counts[s]}
              </button>
            ))}
          </div>
        )}
      </header>
      <ol className="chk-list">
        {shown.map((t, i) => (
          <TestRow key={`${t.name}/${String(i)}`} t={t} open={t === firstTrace} />
        ))}
      </ol>
      {report.omitted > 0 && (
        <p className="faint">
          {report.omitted} more tests are not listed here. Download the report for all of them.
        </p>
      )}
    </div>
  );
}

function TestRow({ t, open }: { t: TestCase; open: boolean }) {
  const file = t.file && !t.name.includes(t.file) ? t.file : null;
  return (
    <li className={`chk st-${t.status}`}>
      <span className="chk-icon" title={t.rawStatus ?? STATUS_LABEL[t.status]}>
        <StatusIcon status={t.status} />
      </span>
      <div className="chk-main">
        <div className="chk-head">
          <span className="mono">{t.name}</span>
          {file && <span className="faint mono">{file}</span>}
          {t.rawStatus && <span className="chip mono">{t.rawStatus}</span>}
          {t.retries > 0 && <span className="chip">retried {t.retries}×</span>}
          {t.tags.map((tag) => (
            <span key={tag} className="chip mono">
              {tag}
            </span>
          ))}
        </div>
        {t.message && <p className="chk-text">{t.message}</p>}
        {t.trace && (
          <details className="disclosure" open={open}>
            <summary>Trace</summary>
            <pre className="chk-trace">{t.trace}</pre>
          </details>
        )}
      </div>
      <span className="chk-side faint num">{took(t.durationMs)}</span>
    </li>
  );
}
