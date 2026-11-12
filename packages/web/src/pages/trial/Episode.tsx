import type { EpisodeTrajectory, SessionMessage } from "@zjunlp/orbit/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, PALETTE } from "../../components/Chart.tsx";
import { Empty, Loading } from "../../components/ui.tsx";
import { api, fileUrl, type ReviewFile, type Run } from "../../lib/api.ts";
import {
  channelNames,
  chunkTiming,
  episodeVideoTime,
  MAX_CHUNK_BUTTONS,
  parseEpisode,
  sampleAt,
} from "../../lib/episode.ts";
import { episodeVideo, MAX_VIDEO_BYTES } from "../../lib/episode-video.ts";
import { useRunFile } from "../../lib/run-file.ts";
import { useAsync } from "../../lib/use.ts";
import { FileBar } from "./parts.tsx";
import "./episode.css";

const MAX_BYTES = 2 * 1024 * 1024;
const seconds = (value: number) => Number(value.toFixed(4)).toString();
/** A recorded number at reading precision: four significant digits, no float noise. */
const shown = (value: number | null | undefined) =>
  value == null ? "—" : Number(value.toPrecision(4)).toString();

export function EpisodeFile({ run, file, solve }: { run: Run; file: ReviewFile; solve?: Run }) {
  const session = useAsync(() => api.session(run.id), [run.id, run.state]);
  const source = useRunFile(run, file.path, {
    what: "the episode index",
    maxBytes: MAX_BYTES,
    parse: parseEpisode,
  });
  const artifacts = source.listing;
  const mediaRun = source.data?.mediaPhase === "solve" ? solve : run;
  const separateMedia = !!mediaRun && mediaRun.id !== run.id;
  const media = useAsync(
    () => (separateMedia ? api.artifacts(mediaRun.id) : Promise.resolve(undefined)),
    [separateMedia, mediaRun?.id, mediaRun?.state],
  );
  const mediaEntries = separateMedia ? media.data : artifacts.data;
  const files = useMemo(
    () => new Set(mediaEntries?.files.map((item) => item.path) ?? []),
    [mediaEntries],
  );
  const error =
    source.error ??
    (source.tooLarge ? "Episode index exceeds the 2 MiB preview limit." : null) ??
    (source.missing ? "Episode index is missing from the saved outputs." : null);
  return (
    <div className="episode-review">
      <FileBar runId={run.id} path={file.path} />
      {error ? (
        <Empty title="Episode unavailable">{error}</Empty>
      ) : !source.data || (separateMedia && !media.data && !media.error) ? (
        <Loading />
      ) : (
        <>
          {source.data.cameras.length > 0 && (!mediaRun || (separateMedia && media.error)) && (
            <Empty title="Episode media unavailable">
              {media.error ?? "This trial has no saved Solve run."}
            </Empty>
          )}
          <EpisodeViewer
            key={`${run.id}/${file.path}`}
            trace={source.data}
            runId={run.id}
            mediaRunId={mediaRun?.id ?? null}
            files={files}
            messages={session.data?.agent?.messages ?? []}
          />
        </>
      )}
    </div>
  );
}

function Camera({
  camera,
  time,
  runId,
  files,
  videoLimit,
}: {
  camera: EpisodeTrajectory["cameras"][number];
  time: number;
  runId: string;
  files: Set<string>;
  videoLimit: number;
}) {
  const frame = camera.frames?.findLast((item) => item.time <= time);
  const path = camera.video
    ? time >= (camera.video.offsetSec ?? 0)
      ? camera.video.path
      : undefined
    : frame?.path;
  const seek = camera.video ? episodeVideoTime(camera.video, time) : 0;
  return (
    <figure className="episode-camera">
      <figcaption>
        {camera.name} <span className="faint">{camera.source ?? "source not recorded"}</span>
      </figcaption>
      {!path || !files.has(path) ? (
        <Empty title="Camera media unavailable">No saved frame at this time.</Empty>
      ) : camera.video ? (
        <VideoPreview
          key={path}
          runId={runId}
          path={path}
          seek={seek}
          name={camera.name}
          limit={videoLimit}
        />
      ) : (
        <img src={fileUrl(runId, path)} alt={`${camera.name} at ${frame?.time}s`} loading="lazy" />
      )}
    </figure>
  );
}

export function VideoPreview({
  runId,
  path,
  seek,
  name,
  limit = MAX_VIDEO_BYTES,
}: {
  runId: string;
  path: string;
  seek?: number;
  name: string;
  limit?: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setUrl(undefined);
    setError(undefined);
    let local: string | undefined;
    void episodeVideo(fileUrl(runId, path), path, controller.signal, limit).then(
      (blob) => {
        if (controller.signal.aborted) return;
        local = URL.createObjectURL(blob);
        setUrl(local);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Video unavailable.");
      },
    );
    return () => {
      controller.abort();
      if (local) URL.revokeObjectURL(local);
    };
  }, [runId, path, limit]);
  useEffect(() => {
    if (seek !== undefined && video.current && video.current.readyState >= 1)
      video.current.currentTime = seek;
  }, [seek]);
  if (error)
    return (
      <Empty title="Video preview unavailable">
        {error}
        <p>
          <a href={fileUrl(runId, path, true)}>Download video</a>
        </p>
      </Empty>
    );
  if (!url) return <Loading what="Loading saved video" />;
  return (
    <video
      ref={video}
      className={seek === undefined ? "review-video" : undefined}
      src={url}
      controls={seek === undefined}
      preload={seek === undefined ? "metadata" : "auto"}
      muted={seek !== undefined}
      playsInline
      aria-label={name}
      onError={() => setError("This browser could not decode the saved video.")}
      onLoadedMetadata={() => {
        if (seek !== undefined && video.current) video.current.currentTime = seek;
      }}
    />
  );
}

export function EpisodeViewer({
  trace,
  runId,
  mediaRunId = runId,
  files,
  messages = [],
}: {
  trace: EpisodeTrajectory;
  runId: string;
  mediaRunId?: string | null;
  files: Set<string>;
  messages?: SessionMessage[];
}) {
  const videoLimit = Math.floor(
    MAX_VIDEO_BYTES / Math.max(1, trace.cameras.filter((camera) => camera.video).length),
  );
  const [index, setIndex] = useState(0);
  const channels = useMemo(() => channelNames(trace), [trace]);
  const [channel, setChannel] = useState(channels.paired[0] ?? "");
  const timing = useMemo(() => chunkTiming(trace.chunks), [trace]);
  const linked = useMemo(
    () => trace.samples.some((row) => row.sessionMessageIndexes?.length),
    [trace],
  );
  const sample = trace.samples[index] ?? trace.samples[0];
  const [playing, setPlaying] = useState(false);
  const last = trace.samples.length - 1;
  useEffect(() => {
    if (!playing || index >= last) return;
    const delay = Math.max(
      16,
      ((trace.samples[index + 1]?.time ?? 0) - (sample?.time ?? 0)) * 1000,
    );
    const timer = setTimeout(() => setIndex((current) => Math.min(last, current + 1)), delay);
    return () => clearTimeout(timer);
  }, [playing, index, last, trace, sample]);
  useEffect(() => {
    if (index === last) setPlaying(false);
  }, [index, last]);
  const series = useMemo(
    () => [
      ...trace.proprioNames.map((name, channel) => ({
        name,
        label: `State · ${name}`,
        color: PALETTE[channel % PALETTE.length] ?? "#58a6ff",
        points: trace.samples.map(
          (row) => [row.time, row.proprio[channel] ?? 0] as [number, number],
        ),
      })),
      ...trace.actionNames.map((name, channel) => ({
        name,
        label: `Action · ${name}`,
        color: PALETTE[(channel + trace.proprioNames.length) % PALETTE.length] ?? "#f778ba",
        points: trace.samples.map(
          (row) => [row.time, row.action[channel] ?? 0] as [number, number],
        ),
      })),
    ],
    [trace],
  );
  const shownSeries = channel ? series.filter((item) => item.name === channel) : series;
  if (!sample) return <Empty title="No episode samples" />;
  const chunks = trace.chunks.filter(
    (chunk) => chunk.start <= sample.time && chunk.end >= sample.time,
  );
  return (
    <div className="episode-viewer">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <b>{trace.goal || "Saved episode"}</b>
        {trace.producer && <span className="chip">{trace.producer}</span>}
        {trace.trust && <span className="chip">{trace.trust}</span>}
        {trace.completeness && (
          <span className="chip">
            {trace.completeness === "complete"
              ? "Session complete"
              : trace.completeness === "environment-only"
                ? "Environment only"
                : "Partial record"}
          </span>
        )}
      </div>
      {trace.frameBeforeAction && (
        <p className="faint">
          Playback time follows the video frame rate. Each step shows the frame before the action
          and the robot state and reward after the action.
        </p>
      )}
      <div className="episode-controls">
        <button
          type="button"
          className="btn sm"
          disabled={last === 0}
          onClick={() => {
            if (index === last) setIndex(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          aria-label="Episode time"
          min={0}
          max={last}
          value={index}
          onChange={(event) => {
            setPlaying(false);
            setIndex(Number(event.target.value));
          }}
        />
        <span className="mono">
          {sample.time.toFixed(3)} s · {index + 1} / {trace.samples.length}
        </span>
      </div>
      <div className="episode-flags" aria-live="polite">
        {sample.reward != null && <span className="chip">Reward {shown(sample.reward)}</span>}
        <span className="chip">
          {sample.truncated ? "Truncated" : sample.terminated ? "Terminated" : "Continuing"}
        </span>
        {sample.late && <span className="chip warn">Late action</span>}
        {sample.stall && <span className="chip warn">Stall</span>}
        {chunks.map((chunk) => (
          <span key={`${chunk.start}-${chunk.end}-${chunk.label}`} className="chip">
            Chunk {chunk.label ?? `${seconds(chunk.start)}–${seconds(chunk.end)}s`}
          </span>
        ))}
      </div>
      <div className="episode-cameras">
        {mediaRunId &&
          trace.cameras.map((camera) => (
            <Camera
              key={camera.name}
              camera={camera}
              time={sample.time}
              runId={mediaRunId}
              files={files}
              videoLimit={videoLimit}
            />
          ))}
      </div>
      <section aria-label="Action chunk boundaries" className="episode-chunks">
        <b>Action chunks</b>
        {trace.chunks.length > MAX_CHUNK_BUTTONS ? (
          // One policy call per step or two: hundreds of buttons say less than their summary.
          <>
            <span>
              {trace.chunks.length} {trace.completeness === "truncated" ? "shown chunks" : "chunks"}
            </span>
            {timing && (
              <>
                <span className="faint">
                  {trace.completeness === "truncated" ? "shown inference" : "inference"} median{" "}
                  {seconds(timing.median)}s · max {seconds(timing.max)}s
                </span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setPlaying(false);
                    setIndex(sampleAt(trace, timing.slowest.start));
                  }}
                >
                  Slowest · {seconds(timing.slowest.start)}s
                </button>
              </>
            )}
          </>
        ) : trace.chunks.length ? (
          trace.chunks.map((chunk) => (
            <button
              type="button"
              key={`${chunk.start}-${chunk.end}-${chunk.label}`}
              className="btn sm"
              onClick={() => {
                setPlaying(false);
                setIndex(sampleAt(trace, chunk.start));
              }}
            >
              {chunk.label ? `Chunk ${chunk.label}` : "Chunk"} · {seconds(chunk.start)}–
              {seconds(chunk.end)}s
              {chunk.inferSeconds !== undefined && ` · inference ${seconds(chunk.inferSeconds)}s`}
            </button>
          ))
        ) : (
          <span className="faint">No chunk boundaries recorded</span>
        )}
      </section>
      <section aria-label="Action and joint curves">
        <h3>Actions and body state</h3>
        {channels.all.length > 1 && (
          <label>
            Channel{" "}
            <select
              className="input"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              {channels.all.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value="">All channels</option>
            </select>
          </label>
        )}
        {shownSeries.length ? (
          <Chart
            series={shownSeries}
            smoothing={0}
            syncKey={`episode-${runId}`}
            onHover={(_values, at) => {
              if (at !== null && !playing) setIndex(sampleAt(trace, at));
            }}
          />
        ) : (
          <p className="faint">No numeric channels recorded.</p>
        )}
        <div className="episode-values">
          {shownSeries.map((item) => (
            <span key={item.label} style={{ color: item.color }}>
              {item.label}: {shown(item.points[index]?.[1])}
            </span>
          ))}
        </div>
      </section>
      {linked && (
        <section aria-label="Agent at this time" className="episode-session">
          <h3>Agent at this time</h3>
          {sample.sessionMessageIndexes?.some((index) => messages[index]) ? (
            sample.sessionMessageIndexes.map((index) => {
              const message = messages[index];
              return message ? (
                <details key={index} open={message.kind === "thinking"}>
                  <summary>
                    {message.kind.replace("_", " ")}
                    {message.name ? ` · ${message.name}` : ""}
                  </summary>
                  <pre>{message.text}</pre>
                </details>
              ) : null;
            })
          ) : (
            <p className="faint">
              No session messages linked at this time. The full Agent session remains available.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
