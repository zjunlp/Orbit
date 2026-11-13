import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { runDirs } from "../config/paths.ts";
import type { RoleAllocation } from "../contracts/index.ts";
import {
  isTerminal,
  leaseRequest,
  type RemoteSubmit,
  type Run,
  type RunEvent,
  RunSpec,
} from "../contracts/index.ts";
import { nowIso } from "../lib/ids.ts";
import { safeJoin } from "../records/index.ts";
import { bundleDir, isBundleHash } from "../workspace/bundle.ts";
import type { RunContext } from "./context.ts";
import { UserError } from "./errors.ts";
import { REFUSAL_TTL_MS } from "./execution.ts";
import type { DispatchResult, RemoteNode } from "./placement.ts";

type Context = Pick<
  RunContext,
  | "changed"
  | "deps"
  | "dispatchRemote"
  | "localBlocker"
  | "loseRemote"
  | "mustGet"
  | "node"
  | "paths"
  | "receiveRemote"
  | "receiving"
  | "refused"
  | "remote"
  | "requeueRemote"
  | "save"
  | "store"
  | "tick"
>;

export function remoteNodes(ctx: Context): RemoteNode[] {
  return [...(ctx.remote?.nodes() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

export function refusal(ctx: Context, key: string): string | null {
  const r = ctx.refused.get(key);
  if (r && r.until > Date.now()) return r.why;
  ctx.refused.delete(key);
  return null;
}

export function mirrors(ctx: Context): Run[] {
  return ctx.store
    .listRuns({ states: ["starting", "running"], limit: 100_000 })
    .filter((r) => r.remote);
}

export function placeRemote(ctx: Context, run: Run, node: string, roles: RoleAllocation[]): Run {
  run.state = "starting";
  run.remote = true;
  run.node = node;
  run.reason = null;
  run.lease = {
    id: `lease-${run.id}`,
    runId: run.id,
    node,
    gpuIds: roles.flatMap((x) => x.gpuIds),
    roles,
    cpus: leaseRequest(run.spec).cpus,
    memGB: leaseRequest(run.spec).memGB,
    state: "active",
    createdAt: nowIso(),
    releasedAt: null,
  };
  ctx.store.tx(() => {
    ctx.store.putSync({
      runId: run.id,
      node,
      eventSeq: 0,
      confirmed: false,
      cancel: false,
      done: false,
    });
    ctx.save(
      run,
      "placed",
      `node ${node}${roles.length ? `, roles ${roles.map((x) => `${x.role}:${x.gpuIds.length}`).join(" ")}` : ""}`,
    );
  });
  void ctx.dispatchRemote(run.id);
  return run;
}

export async function dispatchRemote(ctx: Context, id: string): Promise<void> {
  const run = ctx.mustGet(id);
  const remote = ctx.remote;
  const r: DispatchResult = remote
    ? await remote
        .dispatch(run)
        .catch((e) => ({ ok: false, kind: "unknown", message: (e as Error).message }) as const)
    : { ok: false, kind: "unreachable", message: "cluster not running" };
  const sync = ctx.store.getSync(id);
  if (!sync) return;
  // The node was removed while the run was being sent: it may run there, untracked.
  if (sync.done && (r.ok || r.kind === "unknown")) {
    ctx.loseRemote(id, `node ${run.node} was removed`);
    return;
  }
  if (r.ok) {
    ctx.store.putSync({ ...sync, confirmed: true });
    ctx.store.addEvent(id, "dispatched", `accepted by ${run.node}`);
    if (sync.cancel) void remote?.cancel(run).catch(() => {});
    return;
  }
  if (r.kind === "unknown") {
    ctx.store.addEvent(id, "dispatch", `${r.message}; checking with ${run.node}`);
    return;
  }
  if (r.kind === "rejected")
    ctx.refused.set(`${id}@${run.node}`, {
      why: `refused: ${r.message}`,
      until: Date.now() + REFUSAL_TTL_MS,
    });
  ctx.requeueRemote(id, `${run.node}: ${r.message}`);
}

export function requeueRemote(ctx: Context, id: string, why: string): void {
  const run = ctx.mustGet(id);
  if (!run.remote || isTerminal(run.state)) return;
  const sync = ctx.store.getSync(id);
  ctx.store.deleteSync(id);
  const cancelled = sync?.cancel ?? false;
  run.remote = false;
  run.node = ctx.node;
  run.lease = null;
  run.state = cancelled ? "cancelled" : "queued";
  run.reason = cancelled ? "cancelled" : why;
  if (cancelled) {
    run.endedAt = nowIso();
    run.cleanup = "done";
  }
  ctx.save(run, cancelled ? "cancelled" : "requeued", why);
  void ctx.tick();
}

export function loseRemote(ctx: Context, id: string, why: string): void {
  const run = ctx.mustGet(id);
  const sync = ctx.store.getSync(id);
  if (sync) ctx.store.putSync({ ...sync, done: true });
  if (!run.remote || isTerminal(run.state)) return;
  run.state = "lost";
  run.reason = why;
  run.endedAt = nowIso();
  run.cleanup = "done";
  if (run.lease?.state === "active")
    run.lease = { ...run.lease, state: "released", releasedAt: nowIso() };
  ctx.save(run, "lost", why);
  void ctx.tick();
}

export function applyRemote(ctx: Context, id: string, remote: Run, events: RunEvent[]): Run {
  const run = ctx.mustGet(id);
  const sync = ctx.store.getSync(id);
  // Lost or requeued meanwhile (node removed, run unknown there): keep the local outcome.
  if (!run.remote || !sync || sync.done) return run;
  const queuedThere = remote.state === "queued";
  run.state = queuedThere ? "starting" : remote.state;
  run.reason = queuedThere ? `queued on ${run.node}: ${remote.reason ?? ""}` : remote.reason;
  run.exitCode = remote.exitCode;
  run.image = remote.image ?? run.image;
  run.imageId = remote.imageId ?? run.imageId;
  run.containerId = remote.containerId;
  run.startedAt = remote.startedAt;
  run.endedAt = remote.endedAt;
  run.cleanup = remote.cleanup;
  run.usage = remote.usage;
  run.trajectory = remote.trajectory;
  if (remote.lease) run.lease = remote.lease;
  else if (isTerminal(remote.state) && run.lease?.state === "active")
    run.lease = { ...run.lease, state: "released", releasedAt: remote.endedAt ?? nowIso() };
  const fresh = events.filter((e) => e.seq > (sync?.eventSeq ?? 0));
  const saved = ctx.store.tx(() => {
    ctx.store.putRun(run);
    const out = fresh.map((e) => ctx.store.addEvent(id, e.kind, e.message, e.at));
    ctx.store.putSync({
      ...sync,
      confirmed: true,
      eventSeq: fresh.at(-1)?.seq ?? sync.eventSeq,
      cancel: sync.cancel && !isTerminal(remote.state),
    });
    return out;
  });
  if (saved.length === 0) ctx.changed(run);
  for (const event of saved) ctx.changed(run, event);
  if (isTerminal(run.state)) void ctx.tick();
  return run;
}

export function submitRemote(ctx: Context, input: RemoteSubmit): Promise<Run> {
  // A retried submission while the first is still being received joins it.
  const pending = ctx.receiving.get(input.id);
  if (pending) return pending;
  const p = ctx.receiveRemote(input).finally(() => ctx.receiving.delete(input.id));
  ctx.receiving.set(input.id, p);
  return p;
}

export async function receiveRemote(ctx: Context, input: RemoteSubmit): Promise<Run> {
  const existing = ctx.store.getRun(input.id);
  if (existing) {
    if (existing.origin !== input.origin)
      throw new UserError(`run ${input.id} already exists on ${ctx.node}`);
    return existing;
  }
  const spec = RunSpec.parse(input.spec);
  if (spec.backend !== "docker") throw new UserError("only docker runs can run on another node");
  if (spec.checkpoint) throw new UserError("checkpoint runs stay on the submitting node");
  if (spec.mounts.some((m) => m.source)) throw new UserError("host path mounts are not portable");
  if (spec.project && !input.workspace)
    throw new UserError("a project run needs its code snapshot");
  const bundle = (hash: string) => {
    if (!isBundleHash(hash)) throw new UserError(`bad bundle hash: ${hash}`);
    const dir = bundleDir(ctx.paths.bundles, hash);
    if (!existsSync(dir)) throw new UserError(`bundle ${hash.slice(0, 12)} not uploaded`);
    return dir;
  };
  spec.resources.node = ctx.node;
  delete spec.agent;
  if (input.dockerfile) {
    const df = safeJoin(bundle(input.dockerfile.bundle), input.dockerfile.path);
    if (!df || !existsSync(df)) throw new UserError("dockerfile missing from its bundle");
    spec.dockerfile = df;
  }
  if (input.agentBundle) spec.agentBundle = bundle(input.agentBundle);
  if (spec.auth && ctx.deps.auth?.get(spec.auth)?.profile.hostNetwork) spec.hostNetwork = true;
  const why = await ctx.localBlocker(spec);
  if (why) throw new UserError(why);
  const workspace = input.workspace ? bundle(input.workspace) : null;

  const dirs = runDirs(ctx.paths, input.id);
  mkdirSync(dirs.output, { recursive: true });
  writeFileSync(dirs.metrics, "");
  writeFileSync(dirs.log, "");
  // Asynchronously: a large snapshot must not stall heartbeats and other requests.
  if (workspace) await cp(workspace, dirs.workspace, { recursive: true, verbatimSymlinks: true });
  const run: Run = {
    id: input.id,
    spec,
    state: "queued",
    reason: null,
    exitCode: null,
    node: ctx.node,
    image: spec.image ?? null,
    containerId: null,
    lease: null,
    code: input.code,
    proc: null,
    cleanup: "pending",
    checkpoint: null,
    remote: false,
    origin: input.origin,
    imageId: null,
    note: "",
    folder: "",
    usage: null,
    trajectory: null,
    services: [],
    after: null,
    phases: [],
    stopRequested: null,
    sizeBytes: null,
    createdAt: nowIso(),
    startedAt: null,
    endedAt: null,
  };
  ctx.save(run, "submitted", `from ${input.origin}`);
  void ctx.tick();
  return run;
}
