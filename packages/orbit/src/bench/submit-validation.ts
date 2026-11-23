// Pure submission checks. They take the parsed spec and the adapter's task listing and either
// return the normalized selection or throw a UserError; they touch no service state.
import { z } from "zod";
import {
  type BenchCapabilities,
  BenchInitialStates,
  type BenchJobSpec,
  type BenchTask,
  type SampleIdentity,
  SeedPartitionKey,
} from "../contracts/index.ts";
import { UserError } from "../runs/service.ts";
import { checkSamplePlan } from "./samples.ts";

const LegacySeedCounts = z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative());

export function initialStates(task: BenchTask): BenchTask["initialStates"] {
  if (task.initialStates) return task.initialStates;
  // Older native adapters reported these numbers in free-form task tags.
  const { initialStateCounts, initialStateCount } = task.tags;
  const total =
    initialStateCount !== undefined && /^\d+$/.test(initialStateCount)
      ? BenchInitialStates.safeParse({ count: Number(initialStateCount) })
      : undefined;
  if (initialStateCounts !== undefined) {
    try {
      const result = LegacySeedCounts.safeParse(JSON.parse(initialStateCounts));
      if (result.success) {
        const entries = Object.entries(result.data);
        const valid = entries.filter(([key]) => SeedPartitionKey.safeParse(key).success);
        if (valid.length || !entries.length || !total?.success)
          return { countsBySeed: Object.fromEntries(valid) };
      }
    } catch {
      // Treat free text as a tag.
    }
  }
  return total?.success ? total.data : undefined;
}

/** The selected tasks: explicit, else the sample plan's, else every supported task. */
export function resolveTaskSelection(spec: BenchJobSpec, tasks: BenchTask[]): { tasks: string[] } {
  if (spec.tasks.length === 0)
    spec.tasks = spec.samplePlan
      ? [...new Set(spec.samplePlan.items.map((sample) => sample.taskId))]
      : tasks.filter((t) => t.supported).map((t) => t.id);
  return { tasks: spec.tasks };
}

/** Every selected task exists and is supported by the benchmark. */
export function checkTasksExist(
  spec: BenchJobSpec,
  tasks: BenchTask[],
  benchmarkName: string,
): void {
  for (const id of spec.tasks) {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new UserError(`task not found in ${benchmarkName}: ${id}`);
    if (!t.supported) throw new UserError(`task ${id} is not supported: ${t.reason}`);
  }
  if (spec.tasks.length === 0) throw new UserError(`${benchmarkName} has no supported tasks`);
}

/** A frozen sample plan must agree with the benchmark's profile, tasks and declared initial states. */
export function checkPlanAgainstBenchmark(
  spec: BenchJobSpec,
  tasks: BenchTask[],
  capabilities: BenchCapabilities | undefined,
): void {
  if (!spec.samplePlan) {
    if (spec.methods.some((m) => m.agent === "policy"))
      throw new UserError(
        "policy methods require a frozen samplePlan; legacy seeds cannot identify their samples",
      );
    return;
  }
  try {
    checkSamplePlan(spec.samplePlan);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  if (spec.methods.some((m) => m.agent !== "policy"))
    throw new UserError("planned C6 jobs currently require independent policy methods");
  const selected = new Set(spec.tasks);
  const byId = new Map(
    tasks.map((task) => [task.id, { tags: task.tags, states: initialStates(task) }]),
  );
  const planned = new Set<string>();
  for (const sample of spec.samplePlan.items) {
    const { taskId, initialStateId, environmentSeed } = sample;
    if (sample.benchmarkProfile !== capabilities?.embodied?.profile)
      throw new UserError("sample evaluation profile does not match the benchmark");
    if (!selected.has(taskId)) throw new UserError(`sample task is not selected: ${taskId}`);
    if (initialStateId.length > 1 && initialStateId.startsWith("0"))
      throw new UserError(
        `initial-state index ${initialStateId} for ${taskId} must use digits without leading zeros`,
      );
    planned.add(taskId);
    const { tags, states } = byId.get(taskId) ?? {};
    if (tags?.initialStateDigest && tags.initialStateDigest !== sample.initialStateDigest)
      throw new UserError(`initial-state asset differs from the benchmark: ${taskId}`);

    let count: number | undefined;
    if (states && "countsBySeed" in states) {
      count = states.countsBySeed[String(environmentSeed)];
      if (count === undefined)
        throw new UserError(
          `environment seed ${environmentSeed} has no declared initial states for ${taskId}`,
        );
    } else count = states?.count;
    if (count !== undefined && Number(initialStateId) >= count)
      throw new UserError(
        `initial-state index ${initialStateId} is outside the declared range for ${taskId} (${count} states)`,
      );
  }
  if (spec.tasks.some((task) => !planned.has(task)))
    throw new UserError("every selected task needs at least one planned sample");
}

/** The (method, sample) slots a job expands into, in plan order. */
export function trialSlots(spec: BenchJobSpec): {
  method: BenchJobSpec["methods"][number];
  sample: { task: string } & SampleIdentity;
}[] {
  if (spec.samplePlan)
    return spec.samplePlan.items.flatMap((sample) =>
      spec.methods.map((method) => ({
        method,
        sample: { task: sample.taskId, sampleRef: sample.sampleId } as {
          task: string;
        } & SampleIdentity,
      })),
    );
  return spec.tasks.flatMap((task) =>
    spec.methods.flatMap((method) =>
      Array.from({ length: spec.seeds ?? 1 }, (_, index) => ({
        method,
        sample: { task, seed: index + 1 } as { task: string } & SampleIdentity,
      })),
    ),
  );
}
