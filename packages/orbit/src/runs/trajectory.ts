import { join } from "node:path";
import { type AtifTrajectory, isTerminal } from "../contracts/index.ts";
import {
  loadAgentTrajectory,
  readTrajectory,
  saveTrajectory,
  trajectorySummary,
} from "../sessions/trajectory.ts";
import type { RunContext } from "./context.ts";

type Context = Pick<RunContext, "dirs" | "mustGet" | "redactor" | "store" | "save">;

export async function runTrajectory(
  ctx: Context,
  id: string,
  rebuild: boolean,
  finalized: boolean,
): Promise<AtifTrajectory | null> {
  const run = ctx.mustGet(id);
  const dirs = ctx.dirs(id);
  const previous = await readTrajectory(join(dirs.orbit, "trajectory"));
  if (previous && run.trajectory && !rebuild) return previous;
  const result = await loadAgentTrajectory(dirs.agent);
  if (!result) {
    if (previous && rebuild)
      throw new Error("native Agent session is missing or empty; previous trajectory retained");
    return null;
  }
  const orbit = result.trajectory.extra?.orbit;
  if (orbit) {
    orbit.run = id;
    const trial = ctx.store.trialsByRun(id)[0];
    if (trial) {
      orbit.trial = trial.id;
      orbit.job = trial.jobId;
      orbit.task = trial.task;
    }
  }
  const canSave = isTerminal(run.state) && (run.cleanup === "done" || finalized);
  const trajectory = canSave
    ? await saveTrajectory(dirs.root, result, previous, (text) => ctx.redactor(run).apply(text))
    : result.trajectory;
  if (canSave) {
    const fresh = ctx.mustGet(id);
    fresh.trajectory = trajectorySummary(trajectory);
    ctx.save(fresh, "trajectory", rebuild ? "trajectory rebuilt" : "trajectory generated");
  }
  return trajectory;
}
