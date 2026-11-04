import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { AfterPhase, AfterStatus, RunPhase, RunSpec } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { nowIso } from "../lib/ids.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { safeJoin } from "../records/index.ts";
import type { RunContext } from "./context.ts";
import { type Control, sleep } from "./execution.ts";

type Context = Pick<
  RunContext,
  "dirs" | "mustGet" | "paths" | "save" | "setAfter" | "skipAfter" | "store" | "stopped" | "control"
>;

export class PhaseFailure extends Error {
  state: "failed" | "timeout" | "skipped";
  exitCode?: number;
  constructor(
    message: string,
    state: "failed" | "timeout" | "skipped" = "failed",
    exitCode?: number,
  ) {
    super(message);
    this.state = state;
    this.exitCode = exitCode;
  }
}

export class WatchStopped extends Error {}
export function checkWatching(ctx: Pick<RunContext, "stopped">): void {
  if (ctx.stopped) throw new WatchStopped("daemon stopped; phase remains resumable");
}

export interface PhaseStep {
  name: RunPhase["name"];
  timeoutMs: number;
  skip?: () => string | undefined;
  reconcile?: boolean;
  /**
   * A phase found `running` after a daemon restart whose deadline already passed gets this fresh
   * budget instead of failing: evidence collection and service stops must not be lost because the
   * daemon was down. Default (with `reconcile`): 30 s to read what already happened.
   */
  resumeMs?: number;
  run: (deadline: number) => Promise<number> | Promise<void>;
}

/** Persist each transition in the existing Run document. Terminal phases are never replayed. */
export async function runPhased(
  ctx: Pick<Context, "mustGet" | "save" | "stopped">,
  id: string,
  steps: PhaseStep[],
): Promise<void> {
  let run = ctx.mustGet(id);
  for (const step of steps)
    if (!run.phases.some((p) => p.name === step.name))
      run.phases.push({
        name: step.name,
        state: "pending",
        startedAt: null,
        endedAt: null,
        attempts: 0,
      });
  ctx.save(run);
  for (const step of steps) {
    checkWatching(ctx);
    run = ctx.mustGet(id);
    const phase = run.phases.find((p) => p.name === step.name) as RunPhase;
    if (!["pending", "running"].includes(phase.state)) continue;
    const resuming = phase.state === "running";
    const skip = step.skip?.();
    if (skip && phase.state === "pending") {
      Object.assign(phase, { state: "skipped", reason: skip, endedAt: nowIso() });
      ctx.save(run, "phase", `${step.name}: skipped (${skip})`);
      continue;
    }
    if (phase.state === "pending") {
      Object.assign(phase, {
        state: "running",
        startedAt: nowIso(),
        deadlineAt: new Date(Date.now() + step.timeoutMs).toISOString(),
        attempts: phase.attempts + 1,
      });
      ctx.save(run, "phase", `${step.name}: running`);
    }
    const deadline = phase.deadlineAt ? Date.parse(phase.deadlineAt) : Date.now() + step.timeoutMs;
    const reconcile =
      resuming && (step.reconcile || step.resumeMs !== undefined) && Date.now() >= deadline;
    let result: Partial<RunPhase>;
    try {
      if (Date.now() >= deadline && !reconcile)
        throw new PhaseFailure("phase deadline exceeded", "timeout");
      const exitCode = await docker.withDeadline(
        reconcile ? Date.now() + (step.resumeMs ?? 30_000) : deadline,
        async () => (await step.run(deadline)) ?? undefined,
      );
      checkWatching(ctx);
      result =
        Date.now() > deadline && !reconcile
          ? { state: "timeout", reason: "phase deadline exceeded" }
          : { state: "done", ...(exitCode === undefined ? {} : { exitCode }) };
    } catch (error) {
      checkWatching(ctx);
      if (error instanceof WatchStopped) throw error;
      result =
        error instanceof PhaseFailure
          ? {
              state: error.state,
              reason: error.message,
              ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            }
          : {
              state: Date.now() >= deadline ? "timeout" : "failed",
              reason: (error as Error).message,
            };
    }
    run = ctx.mustGet(id);
    Object.assign(run.phases.find((p) => p.name === step.name) as RunPhase, result, {
      endedAt: nowIso(),
    });
    ctx.save(
      run,
      "phase",
      `${step.name}: ${result.state}${result.reason ? ` (${result.reason})` : ""}`,
    );
  }
}

export async function waitMain(
  ctx: Context,
  id: string,
  containerId: string,
): Promise<{ exitCode: number; running: boolean }> {
  const file = join(ctx.dirs(id).orbit, "phases", "main.exit");
  for (let i = 0; ; i++) {
    checkWatching(ctx);
    const code = readCode(file);
    if (code !== null) return { exitCode: code, running: true };
    if (i % 5 === 0) {
      const st = await docker.inspectContainer(containerId).catch(() => undefined);
      if (st === null) return { exitCode: -1, running: false };
      if (st && !st.running) return { exitCode: readCode(file) ?? st.exitCode, running: false };
    }
    await sleep(250);
  }
}

export async function stopMain(_ctx: unknown, containerId: string): Promise<void> {
  const code = await docker.execWait(
    containerId,
    [
      "sh",
      "-c",
      `p=$(cat /orbit/phases/main.pid 2>/dev/null) || exit 125
kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || exit 0
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 -"$p" 2>/dev/null || kill -0 "$p" 2>/dev/null || exit 0
  sleep 1
done
kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
    ],
    15_000,
  );
  if (code === 125) await docker.stopContainer(containerId);
}

/** The claim and watchdog live in the container, surviving both daemon and Docker-client exits. */
export const DURABLE_COMMAND = `d=$1; seconds=$2; shift 2
if ! mkdir -m 0777 "$d" 2>/dev/null; then test -d "$d" && exit 0; exit 125; fi
exec > "$d/log" 2>&1
if command -v setsid >/dev/null 2>&1; then setsid "$@" & else "$@" & fi
pid=$!
echo "$pid" > "$d/pid"
(
  sleep "$seconds"
  test -f "$d/exit" && exit 0
  touch "$d/timeout"
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  sleep 1
  kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
) &
watchdog=$!
wait "$pid"
code=$?
if test -f "$d/timeout"; then wait "$watchdog"; else kill "$watchdog" 2>/dev/null || true; fi
kill -KILL -"$pid" 2>/dev/null || true
echo "$code" > "$d/exit.tmp"
mv "$d/exit.tmp" "$d/exit"
`;

/**
 * Daemon-only phase state: receipts and markers that decide whether a phase already ran. It lives
 * beside the run's `/orbit` mount, never inside it, so a process in the container cannot forge them.
 */
export function phaseStateDir(ctx: Pick<Context, "dirs">, id: string): string {
  const dir = join(ctx.dirs(id).root, "phase-state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function durableCommand(
  ctx: Context,
  id: string,
  containerId: string,
  key: string,
  command: string[],
  timeoutMs: number,
  options: {
    env?: Record<string, string>;
    envFile?: string;
    deadline?: number;
    cancel?: () => boolean;
  } = {},
): Promise<number> {
  checkWatching(ctx);
  const receipt = join(phaseStateDir(ctx, id), `${key}.result.json`);
  const result = (code: number, timedOut: boolean) => {
    if (timedOut) throw new PhaseFailure(`${key} deadline exceeded`, "timeout", code);
    return code;
  };
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, "utf8")) as { code: number; timedOut: boolean };
    if (Number.isInteger(saved.code) && typeof saved.timedOut === "boolean")
      return result(saved.code, saved.timedOut);
    throw new PhaseFailure("invalid saved command result");
  }
  const service = ctx.mustGet(id).services.find((s) => s.containerId === containerId);
  const mounted =
    service && existsSync(join(ctx.dirs(id).orbit, "phases", "services", service.name));
  const parent = mounted ? `/tmp/orbit-${id}-phases` : "/tmp";
  const dir = mounted ? `${parent}/${key}` : `/tmp/orbit-${id}-${key}`;
  const q = docker.shellJoin([dir]);
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs);
  const seconds = Math.max(0.001, (deadline - Date.now()) / 1000);
  // An atomic claim makes even a lost exec acknowledgement safe to retry.
  const st = await docker.inspectContainer(containerId);
  if (!st?.running) throw new PhaseFailure("container disappeared or stopped");
  const query = () =>
    docker.execRead(containerId, [
      "sh",
      "-c",
      `d=${q}; if test -f "$d/exit"; then cat "$d/exit"; test ! -f "$d/timeout" || echo timeout; elif test -d "$d"; then echo pending; else echo absent; fi`,
    ]);
  const initial = await query();
  if (initial.code !== 0) throw new PhaseFailure("container status is unavailable");
  if (initial.stdout.trim() === "absent") {
    if (options.cancel?.()) throw new PhaseFailure("run cancelled", "skipped");
    if (Date.now() >= deadline) throw new PhaseFailure(`${key} deadline exceeded`, "timeout");
    const writable = await docker.execWait(containerId, [
      "sh",
      "-c",
      `test -w ${docker.shellJoin([parent])}`,
    ]);
    if (writable !== 0) throw new PhaseFailure("durable command status directory is not writable");
    const err = await docker.execDetached(
      containerId,
      ["sh", "-c", DURABLE_COMMAND, "sh", dir, String(seconds), ...command],
      options.env ?? {},
      options.envFile,
    );
    if (err) throw new PhaseFailure(`cannot start ${key}: ${err}`);
  }
  let expired = false;
  let cancelled = false;
  for (;;) {
    checkWatching(ctx);
    const status = await query();
    checkWatching(ctx);
    if (status.code !== 0) throw new PhaseFailure("container disappeared or status is unavailable");
    const code = /^-?\d+/.exec(status.stdout);
    if (code) {
      const dest = join(ctx.dirs(id).orbit, "phases", `${key}.log`);
      await docker.copyFromContainer(containerId, `${dir}/log`, dest);
      checkWatching(ctx);
      writePrivateJson(receipt, {
        code: Number(code[0]),
        timedOut: status.stdout.includes("timeout"),
      });
      if (cancelled) throw new PhaseFailure("run cancelled", "skipped");
      if (expired || status.stdout.includes("timeout"))
        throw new PhaseFailure(`${key} deadline exceeded`, "timeout", Number(code[0]));
      return Number(code[0]);
    }
    cancelled = Boolean(options.cancel?.());
    expired = Date.now() >= deadline;
    if (cancelled || expired) {
      await docker.withDeadline(Date.now() + 6000, () =>
        docker.execWait(
          containerId,
          [
            "sh",
            "-c",
            `d=${q}; p=$(cat "$d/pid" 2>/dev/null) || exit 0; kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
          ],
          5000,
        ),
      );
      await docker.withDeadline(Date.now() + 10_000, () =>
        docker.copyFromContainer(
          containerId,
          `${dir}/log`,
          join(ctx.dirs(id).orbit, "phases", `${key}.log`),
        ),
      );
      throw new PhaseFailure(
        cancelled ? "run cancelled" : `${key} deadline exceeded`,
        cancelled ? "skipped" : "timeout",
      );
    }
    await sleep(250);
  }
}

export async function runHooks(
  ctx: Context,
  id: string,
  containerId: string,
  which: "main" | "services",
) {
  const run = ctx.mustGet(id);
  const errors: PhaseFailure[] = [];
  for (const [i, h] of run.spec.hooks.entries()) {
    if (Boolean(h.service) !== (which === "services")) continue;
    const target = h.service
      ? run.services.find((s) => s.name === h.service)?.containerId
      : containerId;
    const where = h.service ?? "main";
    try {
      if (!target) throw new PhaseFailure("service not running");
      const deadline = run.phases.find((p) => p.name === "finalize")?.deadlineAt;
      const code = await durableCommand(
        ctx,
        id,
        target,
        `hook-${i}`,
        ["sh", "-c", h.command],
        h.timeoutSec * 1000,
        { deadline: deadline ? Date.parse(deadline) : undefined },
      );
      if (code !== 0) throw new PhaseFailure(`exit code ${code}`, "failed", code);
      checkWatching(ctx);
      ctx.store.addEvent(id, "hook", `hook ${i + 1} (${where}): done`);
    } catch (e) {
      checkWatching(ctx);
      const error = e instanceof PhaseFailure ? e : new PhaseFailure((e as Error).message);
      errors.push(error);
      checkWatching(ctx);
      ctx.store.addEvent(id, "hook", `hook ${i + 1} (${where}): ${error.message}`);
    }
  }
  if (errors.length)
    throw new PhaseFailure(
      errors.map((e) => e.message).join("; "),
      errors.some((e) => e.state === "timeout") ? "timeout" : "failed",
    );
}

export function setAfter(ctx: Context, id: string, status: AfterStatus, message: string): void {
  const run = ctx.mustGet(id);
  run.after = status;
  ctx.save(run, "after", message);
}

export function skipAfter(ctx: Context, id: string, why: string): void {
  ctx.setAfter(
    id,
    { state: "skipped", exitCode: null, reason: why, startedAt: null, endedAt: nowIso() },
    `after phase skipped: ${why}`,
  );
}

export async function runAfter(
  ctx: Context,
  id: string,
  containerId: string,
  _ctl: Control,
): Promise<void> {
  const run = ctx.mustGet(id);
  const a = run.spec.after as AfterPhase;
  if (run.after && run.after.state !== "running") return;
  const durableMarker = join(phaseStateDir(ctx, id), "after-durable");
  const legacy = run.after?.state === "running" && !existsSync(durableMarker);
  let startedAt = run.after?.startedAt ?? null;
  let status: AfterStatus;
  const envFile = join(ctx.paths.tmp, `${id}.after.env`);
  try {
    const phaseDeadline = run.phases.find((p) => p.name === "finalize")?.deadlineAt;
    if (!startedAt && phaseDeadline && Date.now() >= Date.parse(phaseDeadline))
      throw new PhaseFailure("after deadline exceeded before start", "timeout");
    if (!startedAt) {
      for (const c of a.copy) {
        const error = await docker.copyToContainer(containerId, c.source, c.target);
        if (error) throw new Error(`copy to ${c.target}: ${error}`);
      }
      if (a.network !== undefined && a.network !== run.spec.network) {
        const nets = await docker.containerNetworks(containerId);
        if (!nets) throw new Error("cannot inspect container networks");
        if (a.network) {
          if (!(await docker.connectNetwork("bridge", containerId)))
            throw new Error("cannot connect network");
        } else
          for (const n of nets)
            if (!(await docker.disconnectNetwork(n, containerId)))
              throw new Error(`cannot disconnect ${n}`);
      }
      writeFileSync(durableMarker, "1");
      startedAt = nowIso();
      ctx.setAfter(
        id,
        { state: "running", exitCode: null, reason: null, startedAt, endedAt: null },
        "after phase started",
      );
    }
    const secrets: Record<string, string> = {};
    for (const k of a.passEnv) if (process.env[k] !== undefined) secrets[k] = process.env[k];
    if (Object.keys(secrets).length)
      writeFileSync(envFile, docker.envFileText(secrets), { mode: 0o600 });
    const deadline = Math.min(
      Date.parse(startedAt) + a.timeoutMin * 60_000,
      phaseDeadline ? Date.parse(phaseDeadline) : Infinity,
    );
    // Older Runs used after.exit without a per-command claim. Wait for that original command.
    // Only a run started by an older Orbit (no durable marker) may use it: the file is in the
    // container-writable /orbit mount, so a current run never trusts it.
    const oldExit = join(ctx.dirs(id).orbit, "phases", "after.exit");
    let code = legacy ? readCode(oldExit) : null;
    if (code === null && legacy) {
      while (code === null && Date.now() < deadline) {
        checkWatching(ctx);
        if (!(await docker.inspectContainer(containerId))?.running)
          throw new Error("container disappeared");
        await sleep(250);
        code = readCode(oldExit);
      }
      if (code === null) {
        await docker.withDeadline(Date.now() + 40_000, () => docker.stopContainer(containerId));
        throw new PhaseFailure("after deadline exceeded", "timeout");
      }
    }
    code ??= await durableCommand(ctx, id, containerId, "after", a.command, a.timeoutMin * 60_000, {
      env: a.env,
      ...(Object.keys(secrets).length ? { envFile } : {}),
      deadline,
    });
    status = {
      state: code === 0 ? "succeeded" : "failed",
      exitCode: code,
      reason: code === 0 ? null : `exit code ${code}`,
      startedAt,
      endedAt: nowIso(),
    };
  } catch (e) {
    checkWatching(ctx);
    status = {
      state: e instanceof PhaseFailure && e.state === "timeout" ? "timeout" : "error",
      exitCode: null,
      reason: (e as Error).message,
      startedAt,
      endedAt: nowIso(),
    };
  } finally {
    rmSync(envFile, { force: true });
  }
  checkWatching(ctx);
  ctx.setAfter(
    id,
    status,
    `after phase ${status.state}${status.reason ? `: ${status.reason}` : ""}`,
  );
}

export async function runRender(
  ctx: Context,
  id: string,
  containerId: string,
  deadline: number,
): Promise<number> {
  const render = ctx.mustGet(id).spec.after?.render;
  if (!render) return 0;
  const code = await durableCommand(
    ctx,
    id,
    containerId,
    "render",
    render.command,
    render.timeoutMin * 60_000,
    { deadline, cancel: () => ctx.control(id).cancel === "cancel" },
  );
  if (code !== 0) throw new PhaseFailure(`render exit code ${code}`, "failed", code);
  return code;
}

export async function collectAfter(ctx: Context, id: string, containerId: string): Promise<void> {
  const a = ctx.mustGet(id).spec.after;
  if (!a) return;
  const failures: string[] = [];
  for (const [name, paths] of [
    ["after", a.collect],
    ["render", a.render?.collect ?? []],
  ] as const) {
    const missing: string[] = [];
    for (const p of paths) {
      const dest = safeJoin(join(ctx.dirs(id).output, name), `.${p}`);
      const error = dest
        ? await copyCollected(containerId, p, dest, ctx.dirs(id).output)
        : "leaves output";
      if (error) missing.push(`${p} (${error})`);
    }
    failures.push(...missing);
    if (paths.length)
      ctx.store.addEvent(
        id,
        "collect",
        `${name}: ${paths.length - missing.length}/${paths.length} collected${missing.length ? `; missing ${missing.join("; ")}` : ""}`,
      );
  }
  if (failures.length) throw new PhaseFailure(failures.join("; "));
}

/**
 * Make `dir` and every directory between `root` and it a real directory. The run's container can
 * write under its output, so a symlink or file it planted there is removed instead of followed out
 * of the output directory.
 */
export function realDirs(root: string, dir: string): void {
  const rel = relative(root, dir);
  if (rel.startsWith("..")) throw new Error(`${dir} leaves ${root}`);
  let at = root;
  for (const part of rel ? rel.split(sep) : []) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) rmSync(at, { force: true });
    if (!st?.isDirectory()) mkdirSync(at);
  }
}

/**
 * Retry-safe directory copies: Docker always sees a fresh target, then evidence is replaced. Every
 * directory from `root` (the output directory) down to `dest` is made real first.
 */
export async function copyCollected(
  containerId: string,
  path: string,
  dest: string,
  root: string,
): Promise<string | null> {
  realDirs(root, dirname(dest));
  const temporary = `${dest}.orbit-collect`;
  rmSync(temporary, { recursive: true, force: true });
  const error = await docker.copyFromContainer(containerId, path, temporary);
  if (error) {
    rmSync(temporary, { recursive: true, force: true });
    return error;
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(temporary, dest);
  return null;
}

/**
 * The container command: `mkdirs` first (best effort), and with an after phase the phase script,
 * which keeps the container once the command has exited.
 */
export function runCommand(s: RunSpec): string[] {
  let cmd = keepsContainer(s) ? ["/bin/sh", "/orbit/phases/run.sh", ...s.command] : s.command;
  if (s.mkdirs.length)
    cmd = [
      "/bin/sh",
      "-c",
      `mkdir -p ${docker.shellJoin(s.mkdirs)} 2>/dev/null; exec "$@"`,
      "sh",
      ...cmd,
    ];
  return cmd;
}

/** Runs whose container stays once the command exits: for hooks and an after phase. */
export const keepsContainer = (s: RunSpec) => Boolean(s.after) || s.hooks.length > 0;

/**
 * PID 1's child in a run with an after phase: start the command in its own session (so a timeout
 * can stop all of it), record its exit code, then keep the container for the after phase.
 */
export const PHASE_SCRIPT = `#!/bin/sh
d=/orbit/phases
if command -v setsid >/dev/null 2>&1; then setsid "$@" & else "$@" & fi
pid=$!
echo "$pid" > "$d/main.pid"
wait "$pid"
code=$?
echo "$code" > "$d/main.exit"
while :; do sleep 3600; done
`;

export function writePhaseScript(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.sh"), PHASE_SCRIPT, { mode: 0o755 });
}

/** A small integer file the phase scripts write, or null while it does not exist (yet). */
export function readCode(file: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
