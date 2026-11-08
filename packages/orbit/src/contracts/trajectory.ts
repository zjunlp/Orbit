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
    mediaPhase: z.literal("solve").optional(),
    frameBeforeAction: z.boolean().optional(),
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
          .object({
            start: Time,
            end: Time,
            label: z.string().max(100).optional(),
            inferSeconds: Time.optional(),
          })
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

const Who = z.string().min(1).max(40);
const Text = z.string().max(200_000);

/** One event of a conversation: a message, or a tool call with what it returned. */
export const ConversationEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), actor: Who, text: Text }),
  z.object({
    type: z.literal("tool_call"),
    /** Joins a call with its result; unique in the conversation. */
    id: z.string().min(1).max(200),
    actor: Who,
    name: z.string().min(1).max(200),
    arguments: z.unknown(),
    /** The call as the subject wrote it, when it was text. */
    source: z.string().max(65_536).optional(),
    result: z.unknown().optional(),
    /** `error`: the tool returned an error; `rejected`: the scaffold refused the call. */
    status: z.enum(["ok", "error", "rejected"]),
    error: z.string().max(20_000).optional(),
  }),
]);
export type ConversationEvent = z.infer<typeof ConversationEvent>;

const Check = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["passed", "failed", "unchecked"]),
  detail: z.string().max(20_000).optional(),
  /** Whether the check counts toward the score (false: diagnostic only). */
  scored: z.boolean().optional(),
});

/**
 * A tool-calling or simulated-user conversation (C3 / C4, design §9.15), written by the verifier
 * from its independent replay. Turns follow the benchmark's own user turns; states are the public
 * environment state the checker compares, when the benchmark has per-turn states.
 */
export const ConversationTrajectory = z.object({
  version: z.literal(1),
  kind: z.literal("conversation"),
  goal: z.string().max(100_000).optional(),
  participants: z
    .array(
      z.object({
        id: Who,
        role: z.enum(["agent", "user", "system", "environment"]),
        label: z.string().max(80),
      }),
    )
    .min(1)
    .max(8),
  turns: z
    .array(
      z.object({
        /** The benchmark's own turn index. */
        index: z.number().int().nonnegative(),
        note: z.string().max(2000).optional(),
        events: z.array(ConversationEvent).max(5000),
        /** `unchecked`: the checker stopped before this turn (it reports the first failure). */
        check: Check.omit({ name: true }).optional(),
        state: z
          .object({ before: z.unknown(), after: z.unknown(), expected: z.unknown().optional() })
          .optional(),
        /** The reference solution's calls of this turn, for diagnosis (not a grading rule). */
        reference: z.array(z.string().max(65_536)).max(1000).optional(),
      }),
    )
    .max(1000),
  verdict: z.object({
    passed: z.boolean().nullable(),
    /** The checker's own failure type, e.g. `multi_turn:instance_state_mismatch`. */
    type: z.string().max(200).optional(),
    message: z.string().max(20_000).optional(),
    /** What the failure type means, in the benchmark's terms. */
    explanation: z.string().max(4000).optional(),
    /** The turn where the checker first detected a failure; absent when it does not say. */
    failedTurn: z.number().int().nonnegative().nullable().optional(),
    checks: z.array(Check).max(500).default([]),
    details: z.unknown().optional(),
    scorer: z.string().max(200).optional(),
  }),
  /** Final state changes the checker compares (path → initial / expected / actual). */
  finalState: z
    .array(
      z.object({
        path: z.string().max(2000),
        initial: z.unknown().optional(),
        expected: z.unknown().optional(),
        actual: z.unknown().optional(),
      }),
    )
    .max(5000)
    .optional(),
  completeness: z.enum(["complete", "environment-only", "truncated"]).optional(),
  producer: z.enum(["agent", "sidecar", "verifier", "monitor"]).optional(),
  trust: z.enum(["trusted", "self-reported"]).optional(),
});
export type ConversationTrajectory = z.infer<typeof ConversationTrajectory>;
