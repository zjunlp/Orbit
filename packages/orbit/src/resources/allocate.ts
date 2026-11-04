import type { Lease, NodeResources, ResourceRequest, RoleAllocation } from "../contracts/index.ts";
import type { RoleRequest } from "../contracts/runs.ts";

/** Keep this fraction of host memory out of leases for the OS and the daemon. */
export const MEM_LEASABLE_FRACTION = 0.9;

/** A lease this young may not show in measured CPU use yet (container start, imports, data loading). */
export const CPU_RAMP_MS = 60_000;

/**
 * CPU use the leases do not explain, i.e. other processes on the node. Settled leases are assumed
 * busy up to their size; runs still starting count twice (lease + whatever they already use), which
 * errs towards waiting. Background noise up to 5% of the cores (at least one) is ignored.
 */
export function cpuOutside(r: NodeResources, leases: Lease[]): number {
  const now = Date.parse(r.probedAt);
  const settled = leases
    .filter((l) => now - Date.parse(l.createdAt) >= CPU_RAMP_MS)
    .reduce((n, l) => n + l.cpus, 0);
  const noise = Math.max(1, r.cpu.count * 0.05);
  return Math.max(0, r.cpu.busy - noise - settled);
}

export type Allocation = { ok: true; gpuIds: string[] } | { ok: false; reason: string };

/** Reject requests this node can never satisfy (instead of queueing forever). */
export function infeasible(req: ResourceRequest, r: NodeResources): string | null {
  if (req.gpus > 0 && r.gpuError) return `GPUs requested but unavailable: ${r.gpuError}`;
  const fitting = r.gpus.filter(
    (g) => gpuMemFits(g, req) && (!req.gpuIds?.length || matchesId(g, req.gpuIds)),
  );
  if (req.gpus > fitting.length) {
    return `needs ${req.gpus} GPU(s) but this node has ${fitting.length} matching`;
  }
  if (req.cpus > r.cpu.count) return `needs ${req.cpus} CPUs but this node has ${r.cpu.count}`;
  const maxMem = r.memory.totalGB * MEM_LEASABLE_FRACTION;
  if (req.memGB > maxMem)
    return `needs ${req.memGB} GB memory but at most ${Math.floor(maxMem)} GB is leasable`;
  return null;
}

/**
 * Cards report a little less than their nominal size (an 80 GB H100 shows 81559 MiB), so a request
 * in nominal GB matches within 3%.
 */
function gpuMemFits(g: { memTotalMiB: number }, req: ResourceRequest): boolean {
  return !req.gpuMemGB || g.memTotalMiB >= req.gpuMemGB * 1024 * 0.97;
}

function matchesId(g: { uuid: string; index: number }, ids: string[]): boolean {
  return ids.some((id) => id === g.uuid || id === String(g.index));
}

/**
 * Decide whether `req` fits now.
 * available = probed hardware − active Orbit leases − external use (busy GPUs, CPU use outside
 * leases, memory not available).
 */
export function allocate(req: ResourceRequest, r: NodeResources, leases: Lease[]): Allocation {
  const leasedCpus = leases.reduce((n, l) => n + l.cpus, 0);
  const outside = cpuOutside(r, leases);
  const freeCpus = r.cpu.count - leasedCpus - outside;
  if (req.cpus > freeCpus) {
    const free = Math.max(0, Math.floor(freeCpus));
    const why = outside >= 1 ? `, ~${Math.round(outside)} busy outside Orbit` : "";
    return { ok: false, reason: `waiting for CPUs (${free}/${req.cpus} free${why})` };
  }
  const leasedMem = leases.reduce((n, l) => n + l.memGB, 0);
  const leasable = r.memory.totalGB * MEM_LEASABLE_FRACTION - leasedMem;
  if (req.memGB > leasable || req.memGB > r.memory.availableGB) {
    const free = Math.floor(Math.min(leasable, r.memory.availableGB));
    return { ok: false, reason: `waiting for memory (${free}/${req.memGB} GB free)` };
  }
  if (req.gpus === 0) return { ok: true, gpuIds: [] };

  const leased = new Set(leases.flatMap((l) => l.gpuIds));
  const free = r.gpus
    .filter((g) => !leased.has(g.uuid) && g.available)
    .filter((g) => gpuMemFits(g, req))
    .filter((g) => !req.gpuIds?.length || matchesId(g, req.gpuIds))
    .sort((a, b) => a.memUsedMiB - b.memUsedMiB || a.index - b.index);
  if (free.length < req.gpus) {
    const external = r.gpus.filter((g) => !leased.has(g.uuid) && !g.available).length;
    const why = external > 0 ? `, ${external} busy outside Orbit` : "";
    return { ok: false, reason: `waiting for GPUs (${free.length}/${req.gpus} free${why})` };
  }
  return { ok: true, gpuIds: free.slice(0, req.gpus).map((g) => g.uuid) };
}

export type RoleAllocationResult =
  | { ok: true; gpuIds: string[]; roles: RoleAllocation[] }
  | { ok: false; reason: string };

/**
 * Allocate a run's roles (its own container, a simulator, a policy server) together (design §9.4).
 * Roles never share a card, so a heterogeneous requirement (a RTX card for the simulator, a large
 * card for the policy) is satisfied or the run waits: a half-started run would hold GPUs while
 * waiting for the rest. CPU and memory were already summed by `leaseRequest`.
 */
export function allocateRoles(
  roles: RoleRequest[],
  r: NodeResources,
  leases: Lease[],
): RoleAllocationResult {
  const total = roles.reduce((n, x) => n + x.gpus, 0);
  const whole = allocate(
    {
      gpus: total,
      cpus: roles.reduce((n, x) => n + x.cpus, 0),
      memGB: roles.reduce((n, x) => n + x.memGB, 0),
    } as ResourceRequest,
    r,
    leases,
  );
  if (!whole.ok) return whole;
  if (total === 0)
    return {
      ok: true,
      gpuIds: [],
      roles: roles.map((x) => ({ role: x.role, gpuIds: [], cpus: x.cpus, memGB: x.memGB })),
    };

  const leased = new Set(leases.flatMap((l) => l.gpuIds));
  const taken = new Set<string>();
  const out: RoleAllocation[] = [];
  for (const role of roles) {
    const free = r.gpus
      .filter((g) => !leased.has(g.uuid) && !taken.has(g.uuid) && g.available)
      .filter((g) => gpuMemFits(g, role as ResourceRequest))
      .filter(
        (g) =>
          !role.gpuIds?.length || role.gpuIds.some((id) => id === g.uuid || id === String(g.index)),
      )
      .sort((a, b) => a.memUsedMiB - b.memUsedMiB || a.index - b.index);
    if (free.length < role.gpus) {
      const named = (role as RoleRequest & { gpuFeatures?: string[] }).gpuFeatures ?? [];
      return {
        ok: false,
        reason: `waiting for GPUs (role ${role.role}: ${free.length}/${role.gpus} free${named.length ? ` for ${named.join(",")}` : ""})`,
      };
    }
    const picked = free.slice(0, role.gpus).map((g) => g.uuid);
    for (const id of picked) taken.add(id);
    out.push({ role: role.role, gpuIds: picked, cpus: role.cpus, memGB: role.memGB });
  }
  return { ok: true, gpuIds: out.flatMap((x) => x.gpuIds), roles: out };
}
