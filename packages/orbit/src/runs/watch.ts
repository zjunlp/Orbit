import {
  appendFileSync,
  existsSync,
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
import { keepsContainer } from "./phases.ts";

type Context = Pick<
  RunContext,
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
  let exitCode: number;
  let collected = false;
  const spec = ctx.mustGet(id).spec;
  const checkpointFailure = async () => {
    if (!spec.checkpoint || exitCode === 0 || ctl.cancel === "cancel") return false;
    const startedAt = ctx.mustGet(id).startedAt;
    const executionMin = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) / 60_000 : 0;
    await docker.stopContainer(containerId);
    await ctx.waitStopped(containerId);
    await ctx.captureCheckpoint(id, containerId, executionMin);
    if (spec.after)
      ctx.skipAfter(id, "solve interrupted; checkpoint attempted before verification");
    return true;
  };
  if (keepsContainer(spec)) {
    const main = await ctx.waitMain(id, containerId);
    exitCode = main.exitCode;
    ctx.disarmTimeout(id);
    if (await checkpointFailure()) {
      await ctx.collect(ctx.mustGet(id), containerId);
      collected = true;
    } else if (main.running) {
      // As Harbor: hooks in the run's container first; without an after phase it is stopped
      // before the services' hooks run.
      const go = () => ctl.cancel !== "cancel";
      if (go()) await ctx.runHooks(id, containerId, "main");
      if (!spec.after) {
        await docker.stopContainer(containerId);
        await ctx.waitStopped(containerId);
      }
      if (go()) await ctx.runHooks(id, containerId, "services");
      // Artifacts are taken as the command left them, before the after phase can change them.
      await ctx.collect(ctx.mustGet(id), containerId);
      collected = true;
      if (spec.after) {
        await ctx.runAfter(id, containerId, ctl);
        await docker.stopContainer(containerId);
        await ctx.waitStopped(containerId);
      }
    } else if (spec.after) ctx.skipAfter(id, "the container stopped with the command");
  } else {
    exitCode = await ctx.waitStopped(containerId);
    ctx.disarmTimeout(id);
    await checkpointFailure();
  }
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
  let run = ctx.mustGet(id);
  if (!collected) await ctx.collect(run, containerId);
  await ctx.stopServices(id);
  run = ctx.mustGet(id);
  // Docker flags any OOM kill in the container; only a failed exit means the run itself died of it.
  const oom = Boolean(st?.oomKilled) && exitCode !== 0;
  await ctx.stopUsage(run, oom);
  let reason = exitCode === 0 ? null : `exit code ${exitCode}`;
  if (oom) reason = `out of memory (limit ${run.spec.resources.memGB} GB)`;
  const setupFailed = join(dirs.agent, AGENT_SETUP_FAILED);
  if (existsSync(setupFailed))
    reason = `${AGENT_INSTALL_FAILED} (exit ${readFileSync(setupFailed, "utf8").trim()}); see orbit/agent/setup.log`;
  await ctx.finalize(run, ...outcome(run, ctl, exitCode, reason));
}

export async function waitStopped(_ctx: Context, containerId: string): Promise<number> {
  let exitCode = await docker.waitContainer(containerId);
  // `docker wait` also fails when docker itself is unavailable: only a stopped container counts.
  while (exitCode === -1) {
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
      ? await docker.copyFromContainer(containerId, p, dest)
      : "path leaves the output directory";
    if (err) missing.push(`${p} (${err})`);
  }
  const n = run.spec.collect.length - missing.length;
  ctx.store.addEvent(
    run.id,
    "collect",
    `${n}/${run.spec.collect.length} collected${missing.length ? `; missing ${missing.join("; ")}` : ""}`,
  );
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
