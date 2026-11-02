import type { GuiTrajectory } from "@zjunlp/orbit/contracts";

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function safeTrajectoryPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !/^[a-z][a-z\d+.-]*:/i.test(path) &&
    !path.includes("\\") &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Artifacts are untrusted input; validate before selecting an observation or requesting an image. */
export function parseTrajectory(text: string): GuiTrajectory {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The trajectory is incomplete or is not valid JSON.");
  }
  if (!record(value) || value.version !== 1)
    throw new Error("This trajectory format is not supported. Expected version 1.");
  if (typeof value.goal !== "string" || value.goal.length > 100_000)
    throw new Error("The trajectory has no valid task goal.");
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 10_001)
    throw new Error(
      "The trajectory must contain an initial observation and at most 10,000 actions.",
    );
  if (value.stopReason !== undefined && typeof value.stopReason !== "string")
    throw new Error("The trajectory has an invalid stop reason.");
  for (const [index, row] of value.steps.entries()) {
    if (!record(row) || row.step !== index)
      throw new Error(`The trajectory is missing or has an invalid step ${index}.`);
    if (!safeTrajectoryPath(row.screenshot))
      throw new Error(`Step ${index} has an unsafe or missing screenshot path.`);
    if (
      index === 0
        ? row.action !== null
        : typeof row.action !== "string" || row.action.trim().length === 0
    )
      throw new Error(`Step ${index} has an invalid action.`);
    if (row.reward !== null && (typeof row.reward !== "number" || !Number.isFinite(row.reward)))
      throw new Error(`Step ${index} has an invalid reward.`);
    for (const key of ["actionError", "observation"])
      if (row[key] !== undefined && typeof row[key] !== "string")
        throw new Error(`Step ${index} has invalid ${key}.`);
    for (const key of ["terminated", "truncated"])
      if (row[key] !== undefined && typeof row[key] !== "boolean")
        throw new Error(`Step ${index} has invalid ${key}.`);
  }
  return value as GuiTrajectory;
}

export function trajectoryStep(raw: string | null, count: number): number {
  const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? Math.min(n, Math.max(0, count - 1)) : 0;
}

export function trajectoryFrame(trajectory: GuiTrajectory, step: number, before: boolean) {
  const index = Math.max(0, Math.min(step, trajectory.steps.length - 1));
  const action = trajectory.steps[index];
  const observation = trajectory.steps[before && index > 0 ? index - 1 : index];
  if (!action || !observation) throw new Error("The selected step is unavailable.");
  return { action, observation };
}
