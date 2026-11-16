import type { Run, RunSpec, RunState } from "../contracts/index.ts";

export const containerName = (runId: string) => `orbit-${runId}`;

/** Per-run networks: for services, or for an after phase that has network when the run has none. */
export const usesRunNetworks = (s: RunSpec) =>
  s.services.length > 0 || (s.after?.network === true && !s.network);

export interface Control {
  timeout?: NodeJS.Timeout;
  setupTimeout?: NodeJS.Timeout;
  cancel?: "cancel" | "timeout";
  /** A failure found by Orbit while the container runs (it is stopped, then collected). */
  fail?: string;
  logs?: { kill(): unknown };
}

/** Final state and reason from the exit code and what Orbit requested. */
export function outcome(
  run: Run,
  ctl: Control,
  code: number | null,
  reason: string | null,
): [RunState, number | null, string | null] {
  if (ctl.fail) return ["failed", code, ctl.fail];
  if (ctl.cancel === "cancel") return ["cancelled", code, "cancelled"];
  if (ctl.cancel === "timeout") return ["failed", code, `timeout after ${run.spec.timeoutMin} min`];
  return [code === 0 ? "succeeded" : "failed", code, reason];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const LOG_DRAIN_TIMEOUT_MS = 15_000;

export const STOP_GRACE_MS = 10_000;

export const PROC_POLL_MS = 2000;

export const REFUSAL_TTL_MS = 10 * 60_000;

export const DOCKER_RETRY_MS = 5000;

/** Directory names too generic to name an image after (the task directory is used instead). */
export const GENERIC_DIRS = new Set([
  "environment",
  "tests",
  "docker",
  "env",
  "verifier",
  "solution",
]);
