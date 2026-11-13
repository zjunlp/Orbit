import { rmSync } from "node:fs";
import { isTerminal, type Run, type RunState } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { finishHarness } from "../harness/index.ts";
import { nowIso } from "../lib/ids.ts";
import { dirBytes } from "../records/index.ts";
import type { RunContext } from "./context.ts";
import { containerName, usesRunNetworks } from "./execution.ts";

type Context = Pick<
  RunContext,
  | "active"
  | "cleanup"
  | "cleanupProcess"
  | "cleanupServices"
  | "deps"
  | "dirs"
  | "disarmTimeout"
  | "finishAuth"
  | "measure"
  | "mustGet"
  | "redactLog"
  | "redactor"
  | "save"
  | "stopped"
  | "store"
  | "tick"
  | "trajectory"
>;

export async function removeDir(ctx: Context, run: Run): Promise<boolean> {
  const root = ctx.dirs(run.id).root;
  const rm = () => {
    try {
      rmSync(root, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  if (rm()) return true;
  const image = run.image ?? run.spec.image;
  if (image && (await docker.imageExists(image).catch(() => false)))
    await docker.emptyDirAsRoot(root, image);
  return rm();
}

export async function finalize(
  ctx: Context,
  run: Run,
  state: RunState,
  exitCode: number | null,
  reason: string | null,
): Promise<Run> {
  ctx.disarmTimeout(run.id);
  // Already ended (e.g. a later step of the same watcher threw): only retry its cleanup.
  const now = ctx.mustGet(run.id);
  if (isTerminal(now.state)) {
    if (now.cleanup !== "done") await ctx.cleanup(now);
    return ctx.mustGet(run.id);
  }
  run.state = state;
  run.exitCode = exitCode;
  run.reason = reason === null ? null : ctx.redactor(run).apply(reason);
  run.endedAt = nowIso();
  if (run.spec.auth) ctx.finishAuth(run);
  if (run.spec.backend === "process") await ctx.redactLog(run);
  ctx.save(run, state, run.reason ?? (exitCode !== null ? `exit code ${exitCode}` : state));
  await ctx.cleanup(run);
  void ctx.tick();
  return ctx.mustGet(run.id);
}

export function finishAuth(ctx: Context, run: Run): void {
  const name = run.spec.auth as string;
  const entry = ctx.deps.auth?.get(name) ?? null;
  const def = entry ? (ctx.deps.agents?.get(entry.profile.harness) ?? null) : null;
  const { refreshed } = finishHarness(entry, ctx.dirs(run.id).agent, def);
  if (refreshed) {
    ctx.deps.auth?.updateSecret(name, refreshed);
    ctx.store.addEvent(run.id, "auth", `refreshed login saved to profile ${name}`);
  }
}

export async function cleanup(ctx: Context, run: Run): Promise<void> {
  // By name as well: `docker run` can create the container and still fail before returning its id.
  const removed =
    run.spec.backend === "process"
      ? await ctx.cleanupProcess(run)
      : (await docker.removeContainer(run.containerId ?? containerName(run.id))) &&
        (!usesRunNetworks(run.spec) || (await ctx.cleanupServices(run)));
  const fresh = ctx.mustGet(run.id);
  if (!removed) {
    if (fresh.cleanup !== "failed") {
      fresh.cleanup = "failed";
      ctx.save(
        fresh,
        "cleanup",
        run.spec.backend === "process"
          ? "process or child containers still present; lease kept until they are gone"
          : "container removal failed; lease kept until it succeeds",
      );
    }
    return;
  }
  await ctx.trajectory(run.id, true).catch(() => null);
  // Re-read after trajectory persistence so cleanup cannot overwrite its summary.
  fresh.trajectory = ctx.mustGet(run.id).trajectory;
  fresh.tokens = ctx.mustGet(run.id).tokens;
  fresh.cleanup = "done";
  const lease = fresh.lease;
  ctx.store.tx(() => {
    if (lease && lease.state === "active") {
      lease.state = "released";
      lease.releasedAt = nowIso();
      ctx.store.putLease(lease);
    }
    const what =
      run.spec.backend === "process" ? "process and child containers gone" : "container removed";
    ctx.save(fresh, "cleanup", lease ? `${what}, lease released` : "done");
  });
  void ctx.measure(fresh.id);
}

export async function measure(ctx: Context, id: string): Promise<void> {
  const bytes = await dirBytes(ctx.dirs(id).root);
  if (ctx.stopped) return;
  const run = ctx.store.getRun(id);
  if (bytes === null || !run || run.sizeBytes === bytes) return;
  run.sizeBytes = bytes;
  ctx.save(run);
}

export async function measureMissing(ctx: Context): Promise<void> {
  for (const r of ctx.store.unmeasuredRuns()) {
    if (ctx.stopped) return;
    await ctx.measure(r.id);
  }
}

export async function retryCleanup(ctx: Context): Promise<void> {
  for (const run of ctx.store.pendingCleanup()) {
    if (run.remote) continue;
    if (!ctx.active.has(run.id)) await ctx.cleanup(run);
  }
}
