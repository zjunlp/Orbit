import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Run } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { safeJoin } from "../records/index.ts";
import type { RunContext } from "./context.ts";
import { DOCKER_RETRY_MS, LOG_DRAIN_TIMEOUT_MS, outcome, sleep } from "./execution.ts";
import { AGENT_INSTALL_FAILED, AGENT_SETUP_FAILED } from "./launch.ts";
import {
  checkWatching,
  collectAfter,
  copyCollected,
  keepsContainer,
  PhaseFailure,
  phaseStateDir,
  runPhased,
  runRender,
  stopMain,
} from "./phases.ts";

type Context = Pick<
  RunContext,
  | "save"
  | "paths"
  | "setAfter"
  | "stopped"
  | "collect"
  | "captureCheckpoint"
  | "containerCgroups"
  | "control"
  | "dirs"
  | "disarmTimeout"
  | "finalize"
  | "mustGet"
  | "redactor"
  | "runAfter"
  | "runHooks"
  | "skipAfter"
  | "startUsage"
  | "stopServices"
  | "stopUsage"
  | "store"
  | "waitMain"
  | "waitStopped"
>;

export async function watch(
  ctx: Context,
  id: string,
  containerId: string,
  recovered: boolean,
): Promise<void> {
  const ctl = ctx.control(id);
  const dirs = ctx.dirs(id);
  ctx.startUsage(id, async () => ({
    cgroups: await ctx.containerCgroups([
      containerId,
      ...ctx.mustGet(id).services.flatMap((s) => (s.containerId ? [s.containerId] : [])),
    ]),
    group: null,
    gpus: (ctx.mustGet(id).lease?.gpuIds.length ?? 0) > 0,
  }));
  // The container log follows the build output and Orbit's own lines; a reattach after a restart
  // re-reads the container log from its start, so it replaces only the part after that offset.
  const offsetFile = join(dirs.root, "log-offset");
  if (!recovered) writeFileSync(offsetFile, String(fileSize(dirs.log)));
  else truncateSync(dirs.log, Math.min(readOffset(offsetFile), fileSize(dirs.log)));
  const logs = docker.followLogs(containerId, dirs.log, ctx.redactor(ctx.mustGet(id)));
  ctl.logs = logs.proc;
  const drained = logs.done.then(() => true);
  let run = ctx.mustGet(id);
  const spec = run.spec;
  let exitCode = run.exitCode;
  if (exitCode === null) {
    exitCode = keepsContainer(spec)
      ? (await ctx.waitMain(id, containerId)).exitCode
      : await ctx.waitStopped(containerId);
    checkWatching(ctx);
    ctx.disarmTimeout(id);
    run = ctx.mustGet(id);
    run.exitCode = exitCode;
    ctx.save(run, "command", `main command exited with code ${exitCode}`);
  }
  ctx.disarmTimeout(id);
  const preCollected = join(phaseStateDir(ctx, id), "solve-collected");
  const checkpointFailure = Boolean(spec.checkpoint && exitCode !== 0 && ctl.cancel !== "cancel");
  await runPhased(ctx, id, [
    {
      name: "quiesce",
      // A failure checkpoint commits the writable layer here; it had no time bound before phases.
      timeoutMs:
        60_000 + (checkpointFailure ? 600_000 + (spec.checkpoint?.maxSizeGB ?? 4) * 120_000 : 0),
      resumeMs: 60_000,
      run: async () => {
        if (keepsContainer(spec)) {
          // Stop leftover Agent processes before trusted hooks can finalize the environment.
          const st = await docker.inspectContainer(containerId);
          if (!st) throw new PhaseFailure("container disappeared");
          if (st.running) {
            await stopMain(ctx, containerId);
          }
        }
        if (checkpointFailure && !ctx.mustGet(id).checkpoint) {
          const startedAt = ctx.mustGet(id).startedAt;
          const executionMin = startedAt
            ? Math.max(0, Date.now() - Date.parse(startedAt)) / 60_000
            : 0;
          await docker.stopContainer(containerId);
          await ctx.captureCheckpoint(id, containerId, executionMin);
          if (spec.after)
            ctx.skipAfter(id, "solve interrupted; checkpoint attempted before verification");
        }
        return exitCode as number;
      },
    },
    {
      name: "finalize",
      reconcile: true,
      timeoutMs:
        60_000 +
        spec.hooks.reduce((n, h) => n + h.timeoutSec * 1000 + 10_000, 0) +
        (spec.after?.timeoutMin ?? 0) * 60_000 +
        (spec.collect.length + (spec.after?.copy.length ?? 0)) * 600_000,
      skip: () => (checkpointFailure ? "checkpoint captured before verification" : undefined),
      run: async () => {
        const errors: Error[] = [];
        const attempt = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (e) {
            checkWatching(ctx);
            errors.push(e as Error);
          }
        };
        await attempt(() => ctx.runHooks(id, containerId, "main"));
        if (!spec.after) await docker.stopContainer(containerId);
        await attempt(() => ctx.runHooks(id, containerId, "services"));
        if (spec.after) {
          if (!existsSync(preCollected)) {
            await attempt(() => ctx.collect(ctx.mustGet(id), containerId));
            writeFileSync(preCollected, "done");
          }
          await attempt(() => ctx.runAfter(id, containerId, ctl));
          const after = ctx.mustGet(id).after;
          if (after && after.state !== "succeeded")
            errors.push(
              new PhaseFailure(
                after.reason ?? `after ${after.state}`,
                after.state === "timeout" ? "timeout" : "failed",
              ),
            );
        }
        if (errors.length)
          throw new PhaseFailure(
            errors.map((e) => e.message).join("; "),
            errors.some((e) => e instanceof PhaseFailure && e.state === "timeout")
              ? "timeout"
              : "failed",
          );
      },
    },
    {
      name: "render",
      reconcile: true,
      timeoutMs: (spec.after?.render?.timeoutMin ?? 1) * 60_000,
      skip: () =>
        checkpointFailure
          ? "checkpoint captured"
          : ctl.cancel === "cancel"
            ? "run cancelled"
            : !spec.after?.render
              ? "no render command"
              : undefined,
      run: (deadline) => runRender(ctx, id, containerId, deadline),
    },
    {
      name: "collect",
      timeoutMs: Math.max(
        60_000,
        (spec.collect.length +
          (spec.after?.collect.length ?? 0) +
          (spec.after?.render?.collect.length ?? 0)) *
          600_000,
      ),
      resumeMs: 600_000,
      run: async () => {
        if (!existsSync(preCollected)) await ctx.collect(ctx.mustGet(id), containerId);
        await collectAfter(ctx, id, containerId);
      },
    },
    {
      name: "stop-services",
      resumeMs: 120_000 + spec.services.length * 60_000,
      timeoutMs:
        60_000 + spec.services.reduce((n, s) => n + 60_000 + s.collect.length * 600_000, 0),
      run: async () => {
        await docker.stopContainer(containerId);
        await ctx.stopServices(id);
        const st = await docker.inspectContainer(containerId);
        if (st?.running) throw new PhaseFailure("main container did not stop");
      },
    },
  ]);
  checkWatching(ctx);
  ctx.disarmTimeout(id);
  // Evidence first: let the log follower reach EOF before the container is removed.
  const complete = await Promise.race([drained, sleep(LOG_DRAIN_TIMEOUT_MS).then(() => false)]);
  if (!complete) {
    logs.proc.kill();
    appendFileSync(dirs.log, "\n[orbit] log collection timed out; log may be truncated\n");
    ctx.store.addEvent(id, "log", "log collection timed out; log may be truncated");
  }
  // The after phase wrote its output to a file; it follows the container log, not inside it.
  const afterLog = join(dirs.orbit, "phases", "after.log");
  if (ctx.mustGet(id).spec.after && existsSync(afterLog)) {
    appendFileSync(dirs.log, "\n[orbit] after phase output:\n");
    appendFileSync(dirs.log, ctx.redactor(ctx.mustGet(id)).apply(readFileSync(afterLog, "utf8")));
  }
  const st = await docker.inspectContainer(containerId).catch(() => null);
  run = ctx.mustGet(id);
  // Docker flags any OOM kill in the container; only a failed exit means the run itself died of it.
  const oom = Boolean(st?.oomKilled) && exitCode !== 0;
  await ctx.stopUsage(run, oom);
  let reason = exitCode === 0 ? null : `exit code ${exitCode}`;
  if (oom) reason = `out of memory (limit ${run.spec.resources.memGB} GB)`;
  const setupFailed = join(dirs.agent, AGENT_SETUP_FAILED);
  if (existsSync(setupFailed))
    reason = `${AGENT_INSTALL_FAILED} (exit ${readFileSync(setupFailed, "utf8").trim()}); see orbit/agent/setup.log`;
  checkWatching(ctx);
  await ctx.finalize(run, ...outcome(run, ctl, exitCode, reason));
}

export async function waitStopped(ctx: Context, containerId: string): Promise<number> {
  let exitCode = await docker.waitContainer(containerId);
  // `docker wait` also fails when docker itself is unavailable: only a stopped container counts.
  while (exitCode === -1) {
    checkWatching(ctx);
    const st = await docker.inspectContainer(containerId).catch(() => undefined);
    if (st === null) break;
    if (st && !st.running) {
      exitCode = st.exitCode;
      break;
    }
    await sleep(DOCKER_RETRY_MS);
    exitCode = await docker.waitContainer(containerId);
  }
  return exitCode;
}

export async function collect(ctx: Context, run: Run, containerId: string): Promise<void> {
  if (run.spec.collect.length === 0) return;
  const base = join(ctx.dirs(run.id).output, "collected");
  const missing: string[] = [];
  for (const p of run.spec.collect) {
    const dest = safeJoin(base, `.${p}`);
    const err = dest
      ? await copyCollected(containerId, p, dest)
      : "path leaves the output directory";
    if (err) missing.push(`${p} (${err})`);
  }
  const n = run.spec.collect.length - missing.length;
  ctx.store.addEvent(
    run.id,
    "collect",
    `${n}/${run.spec.collect.length} collected${missing.length ? `; missing ${missing.join("; ")}` : ""}`,
  );
  if (missing.length) throw new PhaseFailure(missing.join("; "));
}

export const fileSize = (f: string) => (existsSync(f) ? statSync(f).size : 0);

export function readOffset(f: string): number {
  try {
    const n = Number.parseInt(readFileSync(f, "utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
