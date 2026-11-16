import type { EnvironmentByKind, ReviewFile, Run } from "@zjunlp/orbit/contracts";
import { useMemo, useState } from "react";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { linkedRecords } from "../../lib/atif.ts";
import { trialPath } from "../../lib/format.ts";
import { fileHref, resolveKind } from "../../lib/review.ts";
import { useRunFile } from "../../lib/run-file.ts";
import { useAsync } from "../../lib/use.ts";
import { ConversationViewer } from "../trial/Conversation.tsx";
import { EpisodeViewer } from "../trial/Episode.tsx";
import { TrajectoryViewer } from "../trial/Trajectory.tsx";

export function TrajectoryEnvironment({
  run,
  step,
  subagent = false,
  trialContext,
}: {
  run: Run;
  step: number | null;
  subagent?: boolean;
  trialContext?: { job: string; trial: string };
}) {
  const jobId = trialContext?.job ?? run.spec.tags.job;
  const trialId = trialContext?.trial ?? run.spec.tags.trial;
  const source = useAsync(
    () => (jobId && trialId ? api.benchJob(jobId) : Promise.resolve(null)),
    [jobId, trialId, run.state],
    { poll: !!jobId && !!trialId, pollMs: 15000 },
  );
  const trial = source.data?.trials.find((t) => t.id === trialId);
  const review = trial?.outcome?.review ?? trial?.history.at(-1)?.outcome.review;
  const files = (review?.files ?? []).flatMap((file, i) =>
    ["trajectory", "episode", "conversation"].includes(resolveKind(file).kind) ? [{ file, i }] : [],
  );
  const [selected, setSelected] = useState(0);
  const chosen = files[selected] ?? files[0];
  const evidenceId = chosen?.file.phase === "verify" ? trial?.verifyRunId : trial?.solveRunId;
  const evidence = useAsync(
    () => (evidenceId ? api.run(evidenceId) : Promise.resolve(null)),
    [evidenceId],
  );
  const sameSolve = trial?.solveRunId === run.id;
  return (
    <section className="atif-env">
      <h3>Environment evidence</h3>
      {source.error ? (
        <p className="atif-warning">{source.error}</p>
      ) : source.data === undefined ? (
        <Loading />
      ) : !chosen ? (
        <p className="faint">No environment replay was declared for this Run.</p>
      ) : (
        <>
          <select
            className="input"
            aria-label="Environment recording"
            value={Math.max(0, files.indexOf(chosen))}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {files.map((f, i) => (
              <option key={`${f.file.phase}/${f.file.path}`} value={i}>
                {f.file.label} · {f.file.phase}
              </option>
            ))}
          </select>
          <Link
            href={`${trialPath(jobId ?? "", trialId ?? "")}${fileHref(review?.files ?? [], chosen.i)}`}
          >
            Open full environment replay →
          </Link>
          {subagent ? (
            <p>
              Environment links refer to root Agent steps. Select the root trajectory to
              synchronize.
            </p>
          ) : !sameSolve ? (
            <p>
              The trial now refers to a different solve attempt. Its current environment is not
              paired with this historical trajectory.
            </p>
          ) : evidence.error ? (
            <p>{evidence.error}</p>
          ) : !evidence.data || evidence.data.id !== evidenceId ? (
            <Loading />
          ) : (
            <AlignedEnvironment
              key={`${evidenceId}/${chosen.file.path}`}
              run={evidence.data}
              solve={run}
              file={chosen.file}
              step={step}
            />
          )}
        </>
      )}
    </section>
  );
}

function AlignedEnvironment({
  run,
  solve,
  file,
  step,
}: {
  run: Run;
  solve: Run;
  file: ReviewFile;
  step: number | null;
}) {
  const kind =
    resolveKind(file).kind === "trajectory"
      ? "gui"
      : file.kind === "episode"
        ? "episode"
        : "conversation";
  const source = useRunFile<EnvironmentByKind[typeof kind]>(run, file.path, {
    what: "environment evidence",
    maxBytes: (kind === "conversation" ? 16 : 2) * 1024 * 1024,
    parse: JSON.parse,
    load: () => api.environment(run.id, file.path, kind, solve.id),
    loadKey: solve.id,
  });
  const trace = source.data;
  const separate =
    kind === "episode" && trace && "mediaPhase" in trace && trace.mediaPhase === "solve";
  const media = useAsync(
    () => (separate ? api.artifacts(solve.id) : Promise.resolve(null)),
    [separate, solve.id],
  );
  const listing = separate ? media.data : source.listing.data;
  const paths = useMemo(() => new Set(listing?.files.map((f) => f.path) ?? []), [listing]);
  const rows = trace
    ? "steps" in trace
      ? trace.steps
      : "samples" in trace
        ? trace.samples
        : trace.turns
    : [];
  const matches = step === null ? rows.map((_, i) => i) : linkedRecords(rows, step);
  const [chosen, setChosen] = useState(0);
  const index = matches.includes(chosen) ? chosen : matches[0];
  if (source.error || source.missing || source.tooLarge)
    return (
      <Empty title="Environment unavailable">
        {source.error ??
          (source.tooLarge
            ? "Recording exceeds the preview limit."
            : "Recording missing from outputs.")}
      </Empty>
    );
  if (!trace || (separate && !media.data && !media.error)) return <Loading />;
  if (index === undefined)
    return (
      <p className="faint">
        No environment record is linked to step {step}. Open the full replay to inspect unaligned
        evidence.
      </p>
    );
  const control = {
    index,
    select: (next: number) => {
      if (matches.includes(next)) setChosen(next);
    },
  };
  return (
    <div className="atif-env-preview">
      <p className="faint">
        {step === null
          ? "Environment-only evidence"
          : `${matches.length} record(s) linked to step ${step}`}
      </p>
      {matches.length > 1 && (
        <select
          className="input"
          aria-label="Linked environment record"
          value={index}
          onChange={(e) => setChosen(Number(e.target.value))}
        >
          {matches.map((i) => (
            <option key={i} value={i}>
              Record {i + 1}
            </option>
          ))}
        </select>
      )}
      {media.error && <p className="atif-warning">Media unavailable: {media.error}</p>}
      {"steps" in trace ? (
        <TrajectoryViewer
          trajectory={trace}
          runId={run.id}
          files={paths}
          listingTruncated={listing?.truncated ?? false}
          control={control}
        />
      ) : "samples" in trace ? (
        <EpisodeViewer
          trace={trace}
          runId={run.id}
          mediaRunId={separate ? solve.id : run.id}
          files={paths}
          control={control}
        />
      ) : (
        <ConversationViewer c={trace} control={control} />
      )}
    </div>
  );
}
