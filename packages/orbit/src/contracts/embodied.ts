import { z } from "zod";
import { ProfileName } from "./common.ts";
import { ServiceSpec } from "./runs.ts";

export const ContentDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const SemanticProfile = z.strictObject({
  id: z.string().min(1),
  observations: z.record(
    z.string(),
    z.strictObject({
      semantic: z.string().min(1),
      dtype: z.string().min(1),
      shape: z.array(z.number().int().nonnegative()),
      camera: z.string().optional(),
      layout: z.string().optional(),
      frame: z.string().optional(),
      unit: z.string().optional(),
      format: z.string().optional(),
      order: z.array(z.string()).optional(),
    }),
  ),
  action: z.strictObject({
    semantic: z.string().min(1),
    shape: z.array(z.number().int().positive()),
    controller: z.string().min(1),
    frame: z.string().min(1),
    unit: z.string().min(1),
    rotation: z.string().min(1),
    gripper: z.string().min(1),
    order: z.array(z.string().min(1)).optional(),
  }),
});
export type SemanticProfile = z.infer<typeof SemanticProfile>;
export const ResolvedBinding = z.object({
  version: z.literal(1),
  benchmarkProfile: SemanticProfile,
  policyProfile: SemanticProfile,
  observationMap: z.record(z.string(), z.string()),
  digest: ContentDigest,
});
export type ResolvedBinding = z.infer<typeof ResolvedBinding>;
export const EmbodiedCapabilities = z.object({
  profile: z.string().min(1),
  semanticProfile: SemanticProfile,
  observationMap: z.record(z.string(), z.string()),
  /** Fixed sequential solve batches; model RNG remains scoped to the leased service. */
  batch: z.object({ maxEpisodes: z.number().int().min(2).max(256) }).optional(),
});

export const SolveBatch = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  attemptId: z.string().regex(/^[a-zA-Z0-9-]+$/),
  method: z.string().min(1),
  randomness: z.enum(["service", "stateless"]),
  members: z
    .array(
      z.strictObject({
        trialId: z.string().min(1),
        sampleRef: ContentDigest,
        episodeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
      }),
    )
    .min(1)
    .max(256),
  digest: ContentDigest,
});
export type SolveBatch = z.infer<typeof SolveBatch>;
export const BatchEpisode = z
  .object({ plan: SolveBatch, index: z.number().int().nonnegative() })
  .refine(
    (value) => value.index < value.plan.members.length,
    "batch episode index is out of range",
  );
export type BatchEpisode = z.infer<typeof BatchEpisode>;

/** A policy definition is independent of a benchmark registration. */
export const PolicyDefinition = z
  .strictObject({
    name: ProfileName,
    version: z.string().min(1),
    kind: z.enum(["model", "calibration"]).default("model"),
    connector: z.enum(["openpi-ws", "groot-zmq", "openvla-ws"]),
    ioAdapter: z.enum(["gr00t-flat", "libero-native", "robocasa-native"]).optional(),
    replanSteps: z.number().int().positive().optional(),
    backboneDigest: ContentDigest.optional(),
    randomness: z
      .union([
        z.object({
          backend: z.literal("jax"),
          initialKey: z.literal(0),
          scope: z.literal("service"),
        }),
        z.object({ backend: z.literal("stateless"), scope: z.literal("stateless") }),
        z.object({
          backend: z.literal("torch"),
          initialSeed: z.literal(0),
          scope: z.literal("service"),
        }),
      ])
      .default({ backend: "jax", initialKey: 0, scope: "service" }),
    profile: SemanticProfile,
    port: z.number().int().min(1).max(65535).default(8000),
    callTimeoutSec: z.number().positive().default(300),
    checkpointDigest: ContentDigest,
    normalizationDigest: ContentDigest,
    normalizationKey: z.string().min(1).optional(),
    service: ServiceSpec.refine(
      (service) => Boolean(service.healthcheck),
      "a policy needs a readiness health check",
    )
      .refine(
        (service) => Boolean(service.image && /(?:^|@)sha256:[a-f0-9]{64}$/.test(service.image)),
        "a policy needs an immutable image ID or repository digest",
      )
      .refine(
        (service) => service.binds.length === 0,
        "policy weights use a named dataset; host binds are unsupported",
      )
      .refine(
        (service) =>
          !service.gpusOf || (service.gpusOf === "main" && !service.role && !service.gpus),
        "a shared policy must explicitly use main GPUs without its own role or GPU reservation",
      ),
    weights: z.object({ dataset: ProfileName, target: z.string().startsWith("/") }).optional(),
  })
  .superRefine((definition, ctx) => {
    if (definition.ioAdapter === "robocasa-native" && definition.connector !== "openpi-ws")
      ctx.addIssue({ code: "custom", message: "The RoboCasa I/O adapter requires OpenPI" });
    if (definition.normalizationKey && definition.connector !== "openvla-ws")
      ctx.addIssue({
        code: "custom",
        message: "normalizationKey is supported by the OpenVLA connector",
      });
    if (definition.connector === "openvla-ws") {
      if (definition.replanSteps !== 8 || definition.ioAdapter !== "libero-native")
        ctx.addIssue({
          code: "custom",
          message: "OpenVLA-OFT requires the explicit eight-step native LIBERO I/O recipe",
        });
      if (definition.kind === "model" && definition.randomness.backend !== "torch")
        ctx.addIssue({
          code: "custom",
          message: "OpenVLA-OFT models require a torch random-stream declaration",
        });
    }
    if (definition.connector !== "groot-zmq") return;
    if (
      !definition.replanSteps ||
      !definition.ioAdapter ||
      (definition.ioAdapter === "gr00t-flat" && !definition.profile.action.order?.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "GR00T requires an explicit execution horizon and action ordering",
      });
    if (
      definition.kind === "model" &&
      (definition.randomness.backend !== "torch" || !definition.backboneDigest)
    )
      ctx.addIssue({
        code: "custom",
        message: "GR00T models require a torch random-stream declaration and backbone digest",
      });
  });
export type PolicyDefinition = z.infer<typeof PolicyDefinition>;
export type PolicyDefinitionInput = z.input<typeof PolicyDefinition>;
export const PolicyList = z.object({ policies: z.array(PolicyDefinition) });

export const EpisodeSample = z.strictObject({
  sampleId: ContentDigest,
  taskId: z.string().min(1),
  benchmarkProfile: z.string().min(1),
  initialStateId: z.string().regex(/^\d+$/),
  initialStateDigest: ContentDigest,
  environmentSeed: z.number().int().nonnegative(),
  policySeed: z.literal(0),
  repetition: z.number().int().nonnegative(),
});
export type EpisodeSample = z.infer<typeof EpisodeSample>;
export const SamplePlan = z.strictObject({
  version: z.literal(1),
  items: z.array(EpisodeSample).min(1).max(100_000),
  digest: ContentDigest,
});
export type SamplePlan = z.infer<typeof SamplePlan>;

/** Legacy JSON keeps its required seed; planned trials never carry an ordinal as a seed. */
export const SampleIdentity = z.union([
  z.object({ seed: z.number().int(), sampleRef: z.never().optional() }),
  z.object({ seed: z.never().optional(), sampleRef: ContentDigest }),
]);
export type SampleIdentity = z.infer<typeof SampleIdentity>;

export function sampleIdentity(value: SampleIdentity): SampleIdentity {
  return value.sampleRef === undefined ? { seed: value.seed } : { sampleRef: value.sampleRef };
}

export function sampleKey(value: SampleIdentity & { task: string }): string {
  return value.sampleRef ?? `${value.task}#${value.seed}`;
}

export function legacySeed(value: SampleIdentity): number {
  if (value.seed === undefined) throw new Error("this adapter requires legacy task × seed trials");
  return value.seed;
}
