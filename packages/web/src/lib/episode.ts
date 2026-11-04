import type { EpisodeTrajectory } from "@zjunlp/orbit/contracts";
import { safeTrajectoryPath } from "./trajectory.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const time = (value: unknown): value is number => number(value) && value >= 0;
const names = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 256 &&
  value.every((item) => typeof item === "string" && item.length <= 100);
const vector = (value: unknown, count: number) =>
  Array.isArray(value) && value.length === count && value.every(number);
const choice = (value: unknown, options: string[]) =>
  value === undefined || (typeof value === "string" && options.includes(value));

/** Mirrors the contract without importing runtime code into Web. */
export function parseEpisode(text: string): EpisodeTrajectory {
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    value.version !== 1 ||
    value.kind !== "episode" ||
    typeof value.goal !== "string" ||
    value.goal.length > 100_000 ||
    !names(value.actionNames) ||
    !names(value.proprioNames) ||
    !Array.isArray(value.samples) ||
    !value.samples.length ||
    value.samples.length > 100_000 ||
    !Array.isArray(value.cameras) ||
    value.cameras.length > 16 ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 100_000 ||
    !choice(value.producer, ["agent", "sidecar", "verifier", "monitor"]) ||
    !choice(value.trust, ["trusted", "self-reported"])
  )
    throw new Error("Unsupported or incomplete episode index.");
  let previous = -1;
  for (const sample of value.samples) {
    if (
      !object(sample) ||
      !time(sample.time) ||
      sample.time <= previous ||
      !vector(sample.action, value.actionNames.length) ||
      !vector(sample.proprio, value.proprioNames.length) ||
      (sample.reward !== null && !number(sample.reward)) ||
      typeof sample.terminated !== "boolean" ||
      typeof sample.truncated !== "boolean" ||
      [sample.late, sample.stall].some((flag) => flag !== undefined && typeof flag !== "boolean")
    )
      throw new Error("Invalid episode sample, vector or timestamp.");
    previous = sample.time;
  }
  for (const camera of value.cameras) {
    if (
      !object(camera) ||
      typeof camera.name !== "string" ||
      !camera.name ||
      camera.name.length > 100 ||
      !choice(camera.source, ["live", "render"]) ||
      (camera.frames !== undefined) === (camera.video !== undefined)
    )
      throw new Error("Invalid episode camera.");
    if (
      camera.video !== undefined &&
      (!object(camera.video) ||
        !safeTrajectoryPath(camera.video.path) ||
        (camera.video.offsetSec !== undefined && !time(camera.video.offsetSec)))
    )
      throw new Error("Unsafe episode video path or offset.");
    if (camera.frames !== undefined) {
      if (!Array.isArray(camera.frames) || !camera.frames.length || camera.frames.length > 100_000)
        throw new Error("Invalid camera frames.");
      let frameTime = -1;
      for (const frame of camera.frames) {
        if (
          !object(frame) ||
          !time(frame.time) ||
          frame.time <= frameTime ||
          !safeTrajectoryPath(frame.path)
        )
          throw new Error("Unsafe camera frame path or timestamp.");
        frameTime = frame.time;
      }
    }
  }
  for (const chunk of value.chunks)
    if (
      !object(chunk) ||
      !time(chunk.start) ||
      !time(chunk.end) ||
      chunk.end < chunk.start ||
      (chunk.label !== undefined && (typeof chunk.label !== "string" || chunk.label.length > 100))
    )
      throw new Error("Invalid action chunk.");
  return value as EpisodeTrajectory;
}

export function sampleAt(trace: EpisodeTrajectory, at: number) {
  let low = 0;
  let high = trace.samples.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((trace.samples[middle]?.time ?? 0) <= at) low = middle;
    else high = middle - 1;
  }
  return low;
}
