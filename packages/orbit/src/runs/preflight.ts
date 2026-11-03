import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type DoctorCheck,
  leaseRequest,
  type NodeResources,
  type RunSpec,
} from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";

import { allocate, infeasible } from "../resources/allocate.ts";
import { diskCheck, lowFreeGB } from "../resources/disk.ts";
import type { RunContext } from "./context.ts";
import { joinReasons, nodeLeases, type RemoteNode, remoteBlocker } from "./placement.ts";

type Context = Pick<
  RunContext,
  | "deps"
  | "localBlocker"
  | "mirrors"
  | "node"
  | "paths"
  | "remoteNodes"
  | "resources"
  | "specError"
  | "startCheck"
  | "store"
>;

export function specError(ctx: Context, spec: RunSpec): string | null {
  if (spec.project && !isAbsolute(spec.project)) return "project must be an absolute path";
  if (spec.project && !statSync(spec.project, { throwIfNoEntry: false })?.isDirectory())
    return `project not found: ${spec.project}`;
  if (spec.backend === "process") {
    if (!ctx.deps.shim) return "process runs are not available in this daemon";
    if (spec.cwd && (!isAbsolute(spec.cwd) || !existsSync(spec.cwd)))
      return `cwd not found: ${spec.cwd}`;
    if (spec.mounts.length > 0 || spec.collect.length > 0 || spec.workdir || spec.mkdirs.length)
      return "mounts, collect, mkdirs and workdir apply to docker runs only";
  }
  if (spec.agentBundle) {
    if (!spec.auth) return "agentBundle needs an auth profile";
    if (
      !isAbsolute(spec.agentBundle) ||
      !statSync(spec.agentBundle, { throwIfNoEntry: false })?.isDirectory()
    )
      return `agentBundle directory not found: ${spec.agentBundle}`;
  }
  for (const m of spec.mounts) {
    if (m.source && (!isAbsolute(m.source) || !existsSync(m.source)))
      return `mount source not found: ${m.source}`;
  }
  if (spec.dockerfile) {
    const df = isAbsolute(spec.dockerfile)
      ? spec.dockerfile
      : resolve(spec.project ?? "/", spec.dockerfile);
    if (!existsSync(df)) return `dockerfile not found: ${df}`;
    spec.dockerfile = df;
  }
  for (const s of spec.services) {
    for (const p of [s.dockerfile, s.context])
      if (p && (!isAbsolute(p) || !existsSync(p)))
        return `service ${s.name}: ${p} not found (absolute paths only)`;
  }
  // A node's own auth profile decides host networking; a worker applies its own on arrival.
  if (spec.auth && ctx.deps.auth?.get(spec.auth)?.profile.hostNetwork) spec.hostNetwork = true;
  if (spec.hostNetwork && !spec.network) return "host network conflicts with network disabled";
  return null;
}

export async function preflight(ctx: Context, spec: RunSpec, full = false): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) =>
    checks.push({ name, ok, warn, detail });
  const invalid = ctx.specError(spec);
  if (invalid) {
    add("spec", false, invalid);
    return checks;
  }
  const nodes = ctx.remoteNodes();
  if (full) {
    if (spec.project)
      add("project", true, `${spec.project} (${spec.snapshot ? "snapshot" : "read-only mount"})`);
    if (spec.backend === "docker") {
      if (spec.dockerfile) add("image", true, `built from ${spec.dockerfile}`);
      else if (spec.image) {
        const have = await docker.imageExists(spec.image);
        add(
          "image",
          true,
          have ? `${spec.image} (on this node)` : `${spec.image} not on this node; pulled at start`,
          !have,
        );
      }
    }
    for (const m of spec.mounts) {
      const name = `mount ${m.target}`;
      if (m.source) add(name, true, `${m.source} (${m.mode})`);
      else if (m.dataset) {
        const local = ctx.deps.datasets?.path(m.dataset);
        const where = [
          ...(local ? [`${ctx.node}:${local}`] : []),
          ...nodes.filter((n) => n.datasets.includes(m.dataset as string)).map((n) => n.name),
        ];
        if (local && !existsSync(local))
          add(name, false, `dataset ${m.dataset}: ${local} is registered but missing`);
        else if (where.length === 0)
          add(name, false, `dataset ${m.dataset} is not registered on any node`);
        else add(name, true, `dataset ${m.dataset} (${m.mode}) on ${where.join(", ")}`);
      }
    }
    const out = await diskCheck(
      "output",
      ctx.paths.runs,
      "move runs to a large disk with `orbit config data <dir>`",
    );
    try {
      accessSync(ctx.paths.runs, constants.W_OK);
    } catch {
      Object.assign(out, { ok: false, detail: `${ctx.paths.runs} is not writable` });
    }
    checks.push(out);
  }
  const local = await ctx.localBlocker(spec);
  const reasons: [string, string][] = local ? [[ctx.node, local]] : [];
  const candidates = nodes.filter((n) => {
    const why = remoteBlocker(spec, n);
    if (why) reasons.push([n.name, why]);
    return !why;
  });
  if (local && candidates.length === 0) add("placement", false, joinReasons(reasons));
  else if (full) checks.push(await ctx.startCheck(spec, local === null, candidates));
  return checks;
}

export async function startCheck(
  ctx: Context,
  spec: RunSpec,
  here: boolean,
  candidates: RemoteNode[],
): Promise<DoctorCheck> {
  const waits: [string, string][] = [];
  const ahead = ctx.store.queuedRuns().length;
  const queue = ahead ? `; ${ahead} run(s) already queued may go first` : "";
  if (here) {
    const a = allocate(leaseRequest(spec), await ctx.resources(true), ctx.store.activeLeases());
    if (a.ok)
      return {
        name: "placement",
        ok: true,
        warn: false,
        detail: `starts now on ${ctx.node}${a.gpuIds.length ? ` with ${a.gpuIds.length} GPU(s)` : ""}${queue}`,
      };
    waits.push([ctx.node, a.reason]);
  }
  const mirrors = candidates.length ? ctx.mirrors() : [];
  for (const n of candidates) {
    if (!n.online) {
      waits.push([n.name, "offline"]);
      continue;
    }
    const r = n.resources as NodeResources;
    const a = allocate(leaseRequest(spec), r, nodeLeases(n, mirrors));
    if (!a.ok) {
      waits.push([n.name, a.reason]);
      continue;
    }
    const low = r.disk.freeGB < lowFreeGB(r.disk.totalGB);
    return {
      name: "placement",
      ok: true,
      warn: low,
      detail: `starts now on ${n.name}${low ? ` (its data disk has ${Math.round(r.disk.freeGB)} GB free)` : ""}${queue}`,
    };
  }
  return { name: "placement", ok: true, warn: true, detail: `queues: ${joinReasons(waits)}` };
}

export async function localBlocker(ctx: Context, spec: RunSpec): Promise<string | null> {
  if (spec.resources.node && spec.resources.node !== ctx.node)
    return `pinned to ${spec.resources.node}`;
  for (const m of spec.mounts)
    if (m.dataset && !ctx.deps.datasets?.path(m.dataset))
      return `dataset ${m.dataset} not registered on this node`;
  if (spec.auth) {
    const entry = ctx.deps.auth?.get(spec.auth);
    if (!entry) return `auth profile not found: ${spec.auth}`;
    const def = ctx.deps.agents?.get(entry.profile.harness);
    if (!def) return `unknown Agent: ${entry.profile.harness}`;
    if (!(await ctx.deps.agents?.host(def))) return `${def.name} CLI not found on this node`;
  }
  return infeasible(leaseRequest(spec), await ctx.resources());
}
