import { z } from "zod";

export const TASK_FILE_MAX_BYTES = 8 * 1024 * 1024;
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskSetDigest = z.string().regex(/^[a-f0-9]{12}$/);
export const TaskPartition = z.enum(["evolve", "gate", "final"]);
export type TaskPartition = z.infer<typeof TaskPartition>;
const Proportion = z.number().min(0).max(1);
export const SplitProportions = z
  .strictObject({ evolve: Proportion, gate: Proportion, final: Proportion })
  .refine(
    (p) => Math.abs(p.evolve + p.gate + p.final - 1) < 1e-10,
    "split proportions must sum to 1",
  );
export const BenchSplitRequest = z
  .strictObject({
    evolve: Proportion,
    gate: Proportion,
    final: Proportion,
    seed: z.number().int().nonnegative(),
    stratify: z.literal("suite").optional(),
    out: z.string().min(1).max(4096),
  })
  .refine(
    (p) => SplitProportions.safeParse(pickProportions(p)).success,
    "split proportions must sum to 1",
  );
function pickProportions(p: { evolve: number; gate: number; final: number }) {
  return { evolve: p.evolve, gate: p.gate, final: p.final };
}
export type BenchSplitRequest = z.infer<typeof BenchSplitRequest>;

export const TaskBenchmark = z.strictObject({
  registration: z.string(),
  identity: z.strictObject({
    id: z.string(),
    version: z.string().nullable(),
    variant: z.string().nullable(),
  }),
  source: z.strictObject({ commit: z.string(), dirty: z.boolean() }).nullable(),
  settingsSha256: Sha256,
});
export type TaskBenchmark = z.infer<typeof TaskBenchmark>;
const SplitFile = z.strictObject({
  path: z.string(),
  sha256: Sha256,
  taskSet: TaskSetDigest,
  count: z.number().int().nonnegative(),
});
export const BenchSplitManifest = z
  .strictObject({
    version: z.literal(1),
    algorithm: z.literal("sha256-stratified-v1"),
    benchmark: TaskBenchmark,
    seed: z.number().int().nonnegative(),
    proportions: SplitProportions,
    stratify: z.literal("suite").nullable(),
    population: z.strictObject({
      count: z.number().int().positive(),
      taskSet: TaskSetDigest,
      listingSha256: Sha256,
    }),
    unsupported: z.number().int().nonnegative(),
    files: z.strictObject({
      evolve: SplitFile.extend({ path: z.literal("evolve.txt") }),
      gate: SplitFile.extend({ path: z.literal("gate.txt") }),
      final: SplitFile.extend({ path: z.literal("final.txt") }),
    }),
  })
  .superRefine((m, ctx) => {
    if (m.files.evolve.count + m.files.gate.count + m.files.final.count !== m.population.count)
      ctx.addIssue({ code: "custom", message: "split file counts must cover the population" });
  });
export type BenchSplitManifest = z.infer<typeof BenchSplitManifest>;
export const BenchSplitResult = z.strictObject({ out: z.string(), manifest: BenchSplitManifest });
export type BenchSplitResult = z.infer<typeof BenchSplitResult>;

export const TaskFileRecord = z.strictObject({
  sha256: Sha256,
  frozen: z.strictObject({ partition: TaskPartition, manifest: BenchSplitManifest }).optional(),
});
export type TaskFileRecord = z.infer<typeof TaskFileRecord>;
export const TaskFileInput = TaskFileRecord.extend({
  content: z.string().max(TASK_FILE_MAX_BYTES),
});
export type TaskFileInput = z.infer<typeof TaskFileInput>;
const TaskId = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (id) =>
      id === id.trim() &&
      !Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "task IDs must fit on one line without surrounding whitespace",
  );
export const TaskFileTasks = z
  .array(TaskId)
  .min(1)
  .max(100_000)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate task IDs");
export function parseTaskFile(content: string): string[] {
  return TaskFileTasks.parse(
    content
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}
