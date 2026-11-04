import { z } from "zod";
import type { GuiTrajectory } from "./bench.ts";

const ArtifactPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/^[a-z][a-z\d+.-]*:/i.test(path) &&
      !path.includes("\\") &&
      !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "media paths must stay inside the run output",
  );
const Time = z.number().nonnegative();
const Vector = z.array(z.number()).max(256);

export const GuiStepContext = z.object({
  actionId: z.string().min(1).max(128).optional(),
  at: z.iso.datetime({ offset: true }).optional(),
});
export type GuiStepContext = z.infer<typeof GuiStepContext>;
export type GuiTrace = Omit<GuiTrajectory, "steps"> & {
  steps: (GuiTrajectory["steps"][number] & GuiStepContext)[];
};

/** Saved media and numeric samples, never executable actions or a live environment connection. */
export const EpisodeTrajectory = z
  .object({
    version: z.literal(1),
    kind: z.literal("episode"),
    goal: z.string().max(100_000),
    actionNames: z.array(z.string().max(100)).max(256),
    proprioNames: z.array(z.string().max(100)).max(256),
    cameras: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            frames: z
              .array(z.object({ time: Time, path: ArtifactPath }))
              .min(1)
              .max(100_000)
              .optional(),
            video: z
              .object({
                path: ArtifactPath,
                offsetSec: Time.optional(),
                timeMap: z
                  .array(z.object({ time: Time, videoTime: Time }))
                  .min(1)
                  .max(100_000)
                  .optional(),
              })
              .optional(),
            source: z.enum(["live", "render"]).optional(),
          })
          .refine(
            (camera) => (camera.frames !== undefined) !== (camera.video !== undefined),
            "a camera needs either frames or a video",
          ),
      )
      .max(16),
    samples: z
      .array(
        z.object({
          time: Time,
          action: Vector,
          proprio: Vector,
          reward: z.number().nullable(),
          terminated: z.boolean(),
          truncated: z.boolean(),
          sessionMessageIndexes: z.array(z.number().int().nonnegative()).max(200).optional(),
          late: z.boolean().optional(),
          stall: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(100_000),
    chunks: z
      .array(
        z
          .object({ start: Time, end: Time, label: z.string().max(100).optional() })
          .refine((chunk) => chunk.end >= chunk.start, "chunk end precedes start"),
      )
      .max(100_000),
    completeness: z.enum(["complete", "environment-only", "truncated"]).optional(),
    producer: z.enum(["agent", "sidecar", "verifier", "monitor"]).optional(),
    trust: z.enum(["trusted", "self-reported"]).optional(),
  })
  .superRefine((trace, ctx) => {
    const ordered = (times: number[]) =>
      times.every((time, i) => i === 0 || time > (times[i - 1] ?? -1));
    if (!ordered(trace.samples.map((sample) => sample.time)))
      ctx.addIssue({ code: "custom", message: "sample times must strictly increase" });
    for (const camera of trace.cameras)
      if (camera.frames && !ordered(camera.frames.map((frame) => frame.time)))
        ctx.addIssue({ code: "custom", message: "camera frame times must strictly increase" });
    for (const camera of trace.cameras) {
      const map = camera.video?.timeMap;
      if (
        map &&
        (!ordered(map.map((frame) => frame.time)) || !ordered(map.map((frame) => frame.videoTime)))
      )
        ctx.addIssue({ code: "custom", message: "video mapping times must strictly increase" });
    }
    for (const sample of trace.samples)
      if (
        sample.action.length !== trace.actionNames.length ||
        sample.proprio.length !== trace.proprioNames.length
      )
        ctx.addIssue({ code: "custom", message: "sample vectors must match their channel names" });
  });
export type EpisodeTrajectory = z.infer<typeof EpisodeTrajectory>;
