import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RunDirs } from "../config/paths.ts";
import type { Run } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { nowIso } from "../lib/ids.ts";
import type { RunContext } from "./context.ts";
import { type Control, outcome, PROC_POLL_MS, STOP_GRACE_MS, sleep } from "./execution.ts";
import {
  dockerConfigDir,
  groupAlive,
  killGroup,
  procAlive,
  processEnv,
  procStart,
  readExitFile,
  spawnProcess,
  writeShim,
} from "./process.ts";
import type { ShimConfig } from "./shim.ts";

type Context = Pick<
  RunContext,
  | "active"
  | "armTimeout"
  | "containerCgroups"
  | "control"
  | "deps"
  | "dirs"
  | "disarmTimeout"
  | "envFile"
  | "finalize"
  | "gpuMode"
  | "homeLabel"
  | "mustGet"
  | "passEnv"
  | "prepareAuth"
  | "redactor"
  | "save"
  | "startUsage"
  | "stopProcess"
  | "stopUsage"
  | "store"
  | "watchProcess"
>;

export async function launchProcess(
  ctx: Context,
  run: Run,
  dirs: RunDirs,
  ctl: Control,
): Promise<void> {
  const id = run.id;
  const envFile = ctx.envFile(id);
  try {
    const binDir = join(dirs.root, "bin");
    const home = join(dirs.root, "home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const gpuIds = run.lease?.gpuIds ?? [];
    const cfg: ShimConfig = {
      realDocker: which("docker") ?? "docker",
      dockerConfig: dockerConfigDir(),
      runId: id,
      homeLabel: ctx.homeLabel,
      gpuIds,
      gpuMode: ctx.gpuMode,
      hostNetwork: run.spec.hostNetwork,
      auth: null,
    };
    if (run.spec.auth) {
      const h = await ctx.prepareAuth(run, dirs);
      if (Object.keys(h.secretEnv).length > 0)
        writeFileSync(envFile, docker.envFileText(h.secretEnv), { mode: 0o600 });
      cfg.auth = {
        mounts: h.mounts,
        agentDir: dirs.agent,
        env: h.env,
        envFile: Object.keys(h.secretEnv).length > 0 ? envFile : null,
        pathDirs: h.cli?.pathDirs ?? [],
      };
    }
    writeShim(binDir, join(dirs.root, "shim.json"), ctx.deps.shim as string[], cfg);
    const cwd =
      run.spec.cwd ??
      (run.code ? join(dirs.workspace, run.code.subdir) : (run.spec.project ?? dirs.root));
    const env = processEnv({
      binDir,
      home,
      exitFile: join(dirs.root, "exit-code"),
      extra: {
        ...run.spec.env,
        ...ctx.passEnv(run),
        ORBIT_RUN_ID: id,
        ORBIT_OUTPUT: dirs.output,
        ORBIT_METRICS: dirs.metrics,
        PYTHONUNBUFFERED: "1",
        CUDA_VISIBLE_DEVICES: gpuIds.join(","),
      },
    });
    if (ctl.cancel)
      return void (await ctx.finalize(
        ctx.mustGet(id),
        "cancelled",
        null,
        "cancelled before start",
      ));
    appendFileSync(dirs.log, `[orbit] process in ${cwd}\n`);
    const child = spawnProcess({ command: run.spec.command, cwd, env, log: dirs.log });
    const exited = new Promise<number | null>((done) => {
      child.once("error", (e) => {
        appendFileSync(dirs.log, `[orbit] ${e.message}\n`);
        done(127);
      });
      child.once("exit", (code, signal) =>
        done(code ?? (signal ? 128 + signalNumber(signal) : null)),
      );
    });
    const pid = child.pid;
    const start = pid ? procStart(pid) : null;
    const fresh = ctx.mustGet(id);
    fresh.proc = pid && start ? { pid, start } : null;
    fresh.state = "running";
    fresh.startedAt = nowIso();
    ctx.save(fresh, "started", pid ? `process ${pid}` : "process failed to start");
    if (ctl.cancel) void ctx.stopProcess(fresh);
    ctx.armTimeout(fresh);
    await ctx.watchProcess(id, exited);
  } catch (e) {
    const msg = (e as Error).message;
    appendFileSync(dirs.log, `\n[orbit] ${ctx.redactor(run).apply(msg)}\n`);
    await ctx.finalize(ctx.mustGet(id), "failed", null, msg);
  } finally {
    ctx.active.delete(id);
  }
}

export async function watchProcess(
  ctx: Context,
  id: string,
  exited: Promise<number | null> | null,
): Promise<void> {
  const ctl = ctx.control(id);
  ctx.startUsage(id, async () => {
    const r = ctx.mustGet(id);
    const children = (await docker.containersWithLabel(docker.LABEL_PARENT, id)) ?? [];
    return {
      cgroups: await ctx.containerCgroups(children),
      group: r.proc ? { pgid: r.proc.pid, since: Number(r.proc.start) } : null,
      gpus: (r.lease?.gpuIds.length ?? 0) > 0,
    };
  });
  let code: number | null = null;
  if (exited) code = await exited;
  else {
    for (;;) {
      const r = ctx.mustGet(id);
      if (!r.proc || !procAlive(r.proc)) break;
      await sleep(PROC_POLL_MS);
    }
  }
  ctx.disarmTimeout(id);
  const run = ctx.mustGet(id);
  await ctx.stopUsage(run, false);
  code = readExitFile(join(ctx.dirs(id).root, "exit-code")) ?? code;
  const reason = code === 0 ? null : code === null ? "exit status unknown" : `exit code ${code}`;
  await ctx.finalize(run, ...outcome(run, ctl, code, reason));
}

export async function stopProcess(_ctx: Context, run: Run): Promise<void> {
  const proc = run.proc;
  if (proc && procAlive(proc)) {
    killGroup(proc.pid, "SIGTERM");
    setTimeout(() => {
      if (groupAlive(proc)) killGroup(proc.pid, "SIGKILL");
    }, STOP_GRACE_MS).unref();
  }
  const children = await docker.containersWithLabel(docker.LABEL_PARENT, run.id);
  await Promise.all((children ?? []).map((c) => docker.stopContainer(c)));
}

export async function cleanupProcess(ctx: Context, run: Run): Promise<boolean> {
  const proc = run.proc;
  if (proc && groupAlive(proc)) {
    killGroup(proc.pid, "SIGKILL");
    for (let i = 0; i < 20 && groupAlive(proc); i++) await sleep(250);
  }
  rmSync(ctx.envFile(run.id), { force: true });
  const children = await docker.containersWithLabel(docker.LABEL_PARENT, run.id);
  if (children === null) return false;
  const removed = await Promise.all(children.map((c) => docker.removeContainer(c)));
  const ok = removed.every(Boolean) && !(proc && groupAlive(proc));
  if (ok && children.length > 0)
    ctx.store.addEvent(run.id, "cleanup", `removed ${children.length} child container(s)`);
  return ok;
}

export async function recoverProcess(ctx: Context, run: Run): Promise<void> {
  if (!run.proc) {
    await ctx.finalize(run, "lost", null, "process never started before daemon restart");
    return;
  }
  const alive = procAlive(run.proc);
  ctx.save(
    run,
    "recovered",
    alive ? "reattached to process after daemon restart" : "collected after daemon restart",
  );
  ctx.control(run.id);
  if (alive) ctx.armTimeout(run);
  void ctx
    .watchProcess(run.id, null)
    .catch((e) => console.error(`orbit: run ${run.id}:`, (e as Error).message))
    .finally(() => ctx.active.delete(run.id));
}

export async function redactLog(ctx: Context, run: Run): Promise<void> {
  const r = ctx.redactor(run);
  if (r.empty) return;
  const log = ctx.dirs(run.id).log;
  const tmp = `${log}.redact`;
  try {
    await pipeline(createReadStream(log), r.stream(), createWriteStream(tmp));
    renameSync(tmp, log);
  } catch {
    rmSync(tmp, { force: true });
  }
}

export function which(cmd: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d && existsSync(join(d, cmd))) return join(d, cmd);
  }
  return null;
}

export function signalNumber(signal: NodeJS.Signals): number {
  return (
    ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal] ?? 15
  );
}
