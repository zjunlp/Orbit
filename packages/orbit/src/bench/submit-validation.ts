// Pure submission checks. They take the parsed spec and the adapter's task listing and either
// return the normalized selection or throw a UserError; they touch no service state.
import type {
  BenchCapabilities,
  BenchJobSpec,
  BenchTask,
  SampleIdentity,
} from "../contracts/index.ts";
import { UserError } from "../runs/service.ts";
import { checkSamplePlan } from "./samples.ts";

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

/** A frozen sample plan must agree with the benchmark's profile, tasks and initial-state assets. */
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
  for (const sample of spec.samplePlan.items) {
    if (sample.benchmarkProfile !== capabilities?.embodied?.profile)
      throw new UserError("sample evaluation profile does not match the benchmark");
    if (!spec.tasks.includes(sample.taskId))
      throw new UserError(`sample task is not selected: ${sample.taskId}`);
    const expectedAsset = tasks.find((task) => task.id === sample.taskId)?.tags.initialStateDigest;
    if (expectedAsset && expectedAsset !== sample.initialStateDigest)
      throw new UserError(`initial-state asset differs from the benchmark: ${sample.taskId}`);
  }
  if (spec.tasks.some((task) => !spec.samplePlan?.items.some((s) => s.taskId === task)))
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
