import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RunDirs } from "../config/paths.ts";
import { type Run, type ServiceSpec, serviceOrder } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { safeJoin } from "../records/index.ts";
import type { RunContext } from "./context.ts";
import { type Control, containerName, LOG_DRAIN_TIMEOUT_MS, sleep } from "./execution.ts";

type Context = Pick<
  RunContext,
  | "dirs"
  | "gpuMode"
  | "homeLabel"
  | "mustGet"
  | "networkNames"
  | "redactor"
  | "save"
  | "serviceContainer"
  | "serviceImage"
  | "store"
  | "waitServices"
>;

export function networkNames(
  _ctx: Context,
  run: Run,
): { short: string; name: string; internal: boolean }[] {
  const declared = run.spec.networks.some((n) => n.name === "default")
    ? run.spec.networks
    : [{ name: "default", internal: !run.spec.network }, ...run.spec.networks];
  return declared.map((n) => ({
    short: n.name,
    name: `orbit-${run.id}-${n.name}`,
    internal: n.internal,
  }));
}

export async function startServices(
  ctx: Context,
  id: string,
  dirs: RunDirs,
  ctl: Control,
): Promise<void> {
  let run = ctx.mustGet(id);
  const images = new Map<string, string>();
  for (const s of run.spec.services) {
    if (ctl.cancel) return;
    images.set(s.name, await ctx.serviceImage(run, dirs, s));
  }
  const labels = { [docker.LABEL_PARENT]: id, [docker.LABEL_HOME]: ctx.homeLabel };
  for (const v of run.spec.volumes) {
    const err = await docker.createVolume(volumeName(id, v), labels);
    if (err) throw new Error(`volume ${v}: ${err}`);
  }
  for (const n of ctx.networkNames(run)) {
    const err = await docker.createNetwork(n.name, n.internal, labels);
    if (err) throw new Error(`network ${n.short}: ${err}`);
  }
  for (const s of serviceOrder(run.spec.services) ?? []) {
    if (ctl.cancel) return;
    await ctx.waitServices(id, s.dependsOn, ctl);
    const spec = ctx.serviceContainer(run, s, images.get(s.name) as string);
    let containerId: string;
    try {
      containerId = await docker.startContainer(spec);
    } catch (e) {
      throw new Error(`service ${s.name}: ${(e as Error).message}`);
    }
    run = ctx.mustGet(id);
    run.services.push({ name: s.name, containerId, failure: null });
    ctx.save(run, "service", `${s.name} started (${containerId.slice(0, 12)})`);
  }
  await ctx.waitServices(id, run.spec.dependsOn, ctl);
}

export async function waitServices(
  ctx: Context,
  id: string,
  names: string[],
  ctl: Control,
): Promise<void> {
  for (const name of names) {
    const s = ctx.mustGet(id).spec.services.find((x) => x.name === name) as ServiceSpec;
    const containerId = ctx.mustGet(id).services.find((x) => x.name === name)?.containerId;
    if (!containerId) throw new Error(`service ${name} was not started`);
    // Docker gives up on its own after start period + retries × interval; the cap is a fallback.
    const h = s.healthcheck;
    const capMs = h
      ? (h.startPeriodSec + (h.retries + 1) * (h.intervalSec + h.timeoutSec)) * 1000 + 60_000
      : 60_000;
    const deadline = Date.now() + capMs;
    for (;;) {
      if (ctl.cancel) return;
      const st = await docker.inspectContainer(containerId);
      if (!st?.running) {
        const why = st
          ? `exited with code ${st.exitCode}${st.oomKilled ? " (out of memory)" : ""}`
          : "is gone";
        throw new Error(`service ${name} ${why}`);
      }
      if (!h || st.health === "healthy") break;
      if (st.health === "unhealthy") throw new Error(`service ${name} is unhealthy`);
      if (Date.now() > deadline) throw new Error(`service ${name} did not become healthy`);
      await sleep(1000);
    }
    ctx.store.addEvent(id, "service", `${name} ${h ? "healthy" : "running"}`);
  }
}

export async function serviceImage(
  ctx: Context,
  run: Run,
  dirs: RunDirs,
  s: ServiceSpec,
): Promise<string> {
  if (s.image) {
    if (await docker.imageExists(s.image)) return s.image;
    ctx.store.addEvent(run.id, "pull", `service ${s.name}: pulling ${s.image}`);
    const code = await docker.pullImage(s.image, dirs.log);
    if (code !== 0) throw new Error(`service ${s.name}: docker pull ${s.image} failed`);
    return s.image;
  }
  const df = s.dockerfile as string;
  const context = s.context ?? dirname(df);
  const tag = docker.dockerfileTag(df, context, `${basename(context)}-${s.name}`);
  if (await docker.imageExists(tag)) {
    ctx.store.addEvent(run.id, "image", `service ${s.name}: reusing ${tag}`);
    return tag;
  }
  ctx.store.addEvent(run.id, "build", `service ${s.name}: building ${tag}`);
  appendFileSync(
    dirs.log,
    `[orbit] service ${s.name}: docker build -f ${df} -t ${tag} ${context}\n`,
  );
  const code = await docker.buildImage(df, context, tag, dirs.log);
  if (code !== 0) throw new Error(`service ${s.name}: docker build failed with exit code ${code}`);
  return tag;
}

export function serviceContainer(
  ctx: Context,
  run: Run,
  s: ServiceSpec,
  image: string,
): docker.ContainerSpec {
  const nets = ctx.networkNames(run);
  return {
    name: `${containerName(run.id)}-${s.name}`,
    image,
    command: s.command ?? [],
    labels: { [docker.LABEL_PARENT]: run.id, [docker.LABEL_HOME]: ctx.homeLabel },
    gpuIds: [],
    gpuMode: ctx.gpuMode,
    cpus: s.cpus ?? null,
    memGB: s.memGB ?? null,
    mounts: s.binds.map((b) => ({ source: b.source, target: b.target, mode: b.mode })),
    volumes: s.volumes.map((v) => ({
      name: volumeName(run.id, v.volume),
      target: v.target,
      mode: v.mode,
    })),
    env: s.env,
    workdir: s.workdir ?? null,
    network: s.noNetwork ? "none" : "bridge",
    ...(s.noNetwork
      ? {}
      : {
          networks: nets
            .filter((n) => s.networks.includes(n.short))
            .map((n) => ({ name: n.name, aliases: [s.name] })),
        }),
    ...(s.restart ? { restart: s.restart } : {}),
    ...(s.hostPid ? { hostPid: true } : {}),
    ...(s.hostCgroup ? { hostCgroup: true } : {}),
    user: null,
    init: s.init,
    shm: false,
    ...(s.shmGB ? { shmGB: s.shmGB } : {}),
    ...(s.healthcheck ? { healthcheck: s.healthcheck } : {}),
    readOnly: s.readOnly,
    tmpfs: s.tmpfs,
    capAdd: s.capAdd,
    capDrop: s.capDrop,
    securityOpt: s.securityOpt,
    ...(s.pidsLimit ? { pidsLimit: s.pidsLimit } : {}),
  };
}

export async function stopServices(ctx: Context, id: string): Promise<void> {
  if (ctx.mustGet(id).services.length === 0) return;
  const base = join(ctx.dirs(id).output, "services");
  const failures = new Map<string, string>();
  for (const svc of ctx.mustGet(id).services) {
    if (!svc.containerId) continue;
    const st = await docker.inspectContainer(svc.containerId).catch(() => null);
    if (!st) failures.set(svc.name, "container disappeared");
    else if (!st.running && (st.exitCode !== 0 || st.oomKilled))
      failures.set(
        svc.name,
        `exited with code ${st.exitCode}${st.oomKilled ? " (out of memory)" : ""}`,
      );
    else if (st.health === "unhealthy") failures.set(svc.name, "unhealthy");
  }
  const run = ctx.mustGet(id);
  for (const svc of run.services) svc.failure = failures.get(svc.name) ?? svc.failure;
  ctx.save(run, "service", "stopping services");
  await Promise.all(
    run.services.map((s) => (s.containerId ? docker.stopContainer(s.containerId) : null)),
  );
  for (const svc of run.services) {
    const spec = run.spec.services.find((x) => x.name === svc.name);
    if (!svc.containerId || !spec) continue;
    const dir = join(base, svc.name);
    mkdirSync(dir, { recursive: true });
    const logs = docker.followLogs(svc.containerId, join(dir, "log"), ctx.redactor(run));
    await Promise.race([logs.done, sleep(LOG_DRAIN_TIMEOUT_MS)]);
    logs.proc.kill();
    const missing: string[] = [];
    for (const p of spec.collect) {
      const dest = safeJoin(dir, `.${p}`);
      const err = dest
        ? await docker.copyFromContainer(svc.containerId, p, dest)
        : "path leaves the output directory";
      if (err) missing.push(`${p} (${err})`);
    }
    const what = `${svc.name}: ${svc.failure ? `failed during the run (${svc.failure}); ` : ""}${spec.collect.length - missing.length}/${spec.collect.length} collected`;
    ctx.store.addEvent(
      id,
      "service",
      `${what}${missing.length ? `; missing ${missing.join("; ")}` : ""}`,
    );
  }
}

export async function cleanupServices(ctx: Context, run: Run): Promise<boolean> {
  const children = await docker.containersWithLabel(docker.LABEL_PARENT, run.id);
  if (children === null) return false;
  const removed = await Promise.all(children.map((c) => docker.removeContainer(c)));
  if (!removed.every(Boolean)) return false;
  const nets = await docker.networksWithLabel(docker.LABEL_PARENT, run.id);
  if (nets === null) return false;
  const gone = await Promise.all(nets.map((n) => docker.removeNetwork(n)));
  // Volumes go last: the run's own container (removed before this) may still have used them.
  const vols = await docker.volumesWithLabel(docker.LABEL_PARENT, run.id);
  if (vols === null) return false;
  const volsGone = await Promise.all(vols.map((v) => docker.removeVolume(v)));
  if (children.length + nets.length + vols.length > 0)
    ctx.store.addEvent(
      run.id,
      "cleanup",
      `removed ${children.length} service container(s), ${nets.length} network(s) and ${vols.length} volume(s)`,
    );
  return gone.every(Boolean) && volsGone.every(Boolean);
}

/** Docker name of a run's volume. */
export const volumeName = (runId: string, volume: string) => `orbit-${runId}-${volume}`;
