import type {
  DeviceAllocation,
  DeviceRequest,
  Lease,
  NodeResources,
  ResourceRequest,
  RoleAllocation,
} from "../contracts/index.ts";
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
export function infeasible(
  req: ResourceRequest,
  r: NodeResources,
  roles: RoleRequest[] = [],
): string | null {
  if (req.gpus > 0 && r.gpuError) return `GPUs requested but unavailable: ${r.gpuError}`;
  for (const role of roles) {
    if (role.gpus === 0) continue;
    const have = r.gpus.filter(
      (g) =>
        gpuMemFits(g, role) &&
        modelMatches(g.name, role.gpuModels) &&
        (!role.gpuIds?.length || matchesId(g, role.gpuIds)),
    ).length;
    if (have < role.gpus) {
      const constraints = [
        role.gpuModels?.length ? `of ${role.gpuModels.join(" / ")}` : "",
        role.gpuMemGB ? `with at least ${role.gpuMemGB} GB` : "",
        role.gpuIds?.length ? `matching ${role.gpuIds.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `role ${role.role} needs ${role.gpus} GPU(s)${constraints ? ` ${constraints}` : ""}, but this node has ${have}`;
    }
  }
  const fitting = roles.length
    ? r.gpus
    : r.gpus.filter((g) => gpuMemFits(g, req) && (!req.gpuIds?.length || matchesId(g, req.gpuIds)));
  if (req.gpus > fitting.length) {
    return `needs ${req.gpus} GPU(s) but this node has ${fitting.length} matching`;
  }
  if (req.cpus > r.cpu.count) return `needs ${req.cpus} CPUs but this node has ${r.cpu.count}`;
  const maxMem = r.memory.totalGB * MEM_LEASABLE_FRACTION;
  if (req.memGB > maxMem)
    return `needs ${req.memGB} GB memory but at most ${Math.floor(maxMem)} GB is leasable`;
  for (const d of deviceTotals(req.devices ?? [])) {
    const have = (r.devices ?? []).find((x) => x.class === d.class);
    // A shared class (kvm, dri, tun) is present or not; any number of runs and roles use it.
    if (!have || have.count < (have.shared ? 1 : d.count))
      return `needs ${d.count} ${d.class} device(s), but this node has ${have?.count ?? 0}${have?.detail ? ` (${have.detail})` : ""}`;
  }
  return null;
}

/**
 * Cards report a little less than their nominal size (an 80 GB H100 shows 81559 MiB), so a request
 * in nominal GB matches within 3%.
 */
function gpuMemFits(g: { memTotalMiB: number }, req: Pick<ResourceRequest, "gpuMemGB">): boolean {
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
  const devices = allocateDevices(req.devices ?? [], r, leases);
  if (!devices.ok) return devices;
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

function deviceTotals(requests: DeviceRequest[]): DeviceRequest[] {
  const totals = new Map<string, number>();
  for (const d of requests) totals.set(d.class, (totals.get(d.class) ?? 0) + d.count);
  return [...totals].map(([cls, count]) => ({ class: cls, count }));
}

/** Device paths are assigned once, then carried by the lease to the container. */
function allocateDevices(
  requests: DeviceRequest[],
  r: NodeResources,
  leases: Lease[],
  reserved: DeviceAllocation[] = [],
): { ok: true; devices: DeviceAllocation[] } | { ok: false; reason: string } {
  const active = leases.filter((l) => l.state === "active");
  const held = active.flatMap((l) => l.roles.flatMap((role) => role.devices ?? []));
  const out: DeviceAllocation[] = [];
  for (const req of deviceTotals(requests)) {
    const node = (r.devices ?? []).find((d) => d.class === req.class);
    if (node?.shared) {
      // Shared device nodes are not consumed: present is enough, every run gets the same nodes.
      if (node.count < 1)
        return { ok: false, reason: `waiting for devices (${req.class}: none present)` };
      out.push({ ...req, paths: node.paths.slice(0, req.count) });
      continue;
    }
    const others = held.filter((d) => d.class === req.class);
    const sameRun = reserved.filter((d) => d.class === req.class);
    const used = [...others, ...sameRun];
    const free =
      node?.exclusive && others.length
        ? 0
        : Math.max(0, (node?.count ?? 0) - used.reduce((n, d) => n + d.count, 0));
    const owners = active
      .filter((l) => l.roles.some((role) => role.devices?.some((d) => d.class === req.class)))
      .map((l) => l.runId);
    if (free < req.count)
      return {
        ok: false,
        reason: `waiting for devices (${req.class}: ${free}/${req.count} free${owners.length ? `; held by ${owners.join(", ")}` : ""}${node?.exclusive ? "; exclusive" : ""})`,
      };
    const taken = new Set([...held, ...reserved, ...out].flatMap((d) => d.paths));
    const paths = (node?.paths ?? []).filter((p) => !taken.has(p));
    // Older count-only leases cannot safely identify a free physical device.
    const unknown = used.reduce((n, d) => n + Math.max(0, d.count - d.paths.length), 0);
    const candidates = unknown ? [] : [...new Set(paths)];
    if (node?.paths.length && candidates.length < req.count)
      return {
        ok: false,
        reason: `waiting for devices (${req.class}: ${candidates.length}/${req.count} device paths free)`,
      };
    out.push({ ...req, paths: candidates.slice(0, req.count) });
  }
  return { ok: true, devices: out };
}

const tokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a card is one of the acceptable models (none listed: any card). A model matches whole
 * words of the card name in order: `L4` is "NVIDIA L4", not "NVIDIA L40S"; `A10` is not "A100".
 */
export function modelMatches(name: string, models: string[] | undefined): boolean {
  if (!models?.length) return true;
  const card = tokens(name);
  return models.some((m) => {
    const want = tokens(m);
    return want.length > 0 && card.some((_, i) => want.every((w, j) => card[i + j] === w));
  });
}

const DECLARED_GPU_CAPABILITIES = new Set(["egl", "vulkan", "cuda"]);

function gpuFeatures(role: RoleRequest): { models: string[]; declared: string[] } {
  const features = [...new Set((role.gpuFeatures ?? []).map((x) => x.trim().toLowerCase()))];
  return {
    models: features.filter((x) => x && !DECLARED_GPU_CAPABILITIES.has(x)),
    declared: features.filter((x) => DECLARED_GPU_CAPABILITIES.has(x)),
  };
}

/** These declarations are retained, but a GPU name cannot verify graphics or CUDA support. */
export function gpuCapabilityWarnings(roles: RoleRequest[]): string[] {
  return roles.flatMap((role) => {
    const { declared } = gpuFeatures(role);
    return role.gpus > 0 && declared.length
      ? [`role ${role.role}: ${declared.join(", ")} capabilities declared, not verified`]
      : [];
  });
}

export type RoleAllocationResult =
  | { ok: true; gpuIds: string[]; roles: RoleAllocation[] }
  | { ok: false; reason: string };

/**
 * Allocate all roles together, without sharing cards. Matching may move an earlier unrestricted
 * role to another card so it cannot strand a later role requiring a specific model or GPU ID.
 */
export function allocateRoles(
  roles: RoleRequest[],
  r: NodeResources,
  leases: Lease[],
): RoleAllocationResult {
  const total = roles.reduce((n, x) => n + x.gpus, 0);
  const warnings = gpuCapabilityWarnings(roles);
  const waiting = (reason: string): RoleAllocationResult => ({
    ok: false,
    reason: `${reason}${warnings.length ? `; ${warnings.join("; ")}` : ""}`,
  });
  const whole = allocate(
    {
      gpus: total,
      cpus: roles.reduce((n, x) => n + x.cpus, 0),
      memGB: roles.reduce((n, x) => n + x.memGB, 0),
      devices: roles.flatMap((x) => x.devices ?? []),
    } as ResourceRequest,
    r,
    leases,
  );
  if (
    !whole.ok &&
    (!whole.reason.startsWith("waiting for GPUs") ||
      !roles.some((role) => gpuFeatures(role).models.length || role.gpuModels?.length))
  )
    return waiting(whole.reason);

  const leased = new Set(leases.flatMap((l) => l.gpuIds));
  const candidates = roles.map((role) => {
    const { models } = gpuFeatures(role);
    return r.gpus
      .filter((g) => !leased.has(g.uuid) && g.available)
      .filter((g) => gpuMemFits(g, role))
      .filter((g) => !role.gpuIds?.length || matchesId(g, role.gpuIds))
      .filter((g) => models.every((name) => g.name.toLowerCase().includes(name)))
      .filter((g) => modelMatches(g.name, role.gpuModels))
      .sort((a, b) => a.memUsedMiB - b.memUsedMiB || a.index - b.index)
      .map((g) => g.uuid);
  });
  const shortage = (i: number, free: number) => {
    const role = roles[i] as RoleRequest;
    const { models } = gpuFeatures(role);
    return waiting(
      `waiting for GPUs (role ${role.role}: ${models.length ? `needs ${models.join(", ")}, ` : ""}${role.gpuModels?.length ? `one of ${role.gpuModels.join(" / ")}, ` : ""}${free}/${role.gpus} matching cards free)`,
    );
  };
  for (const [i, role] of roles.entries())
    if ((candidates[i]?.length ?? 0) < role.gpus) return shortage(i, candidates[i]?.length ?? 0);
  if (!whole.ok) return waiting(whole.reason);

  const slots = roles.flatMap((role, i) => Array.from({ length: role.gpus }, () => i));
  const owner = new Map<string, number>();
  const assign = (slot: number, seen: Set<string>): boolean => {
    const available = candidates[slots[slot] as number] ?? [];
    // Try unused cards first, preserving the previous least-used-card preference.
    for (const card of available) {
      if (!seen.has(card) && !owner.has(card)) {
        owner.set(card, slot);
        return true;
      }
    }
    for (const card of available) {
      if (seen.has(card)) continue;
      seen.add(card);
      const previous = owner.get(card);
      if (previous !== undefined && assign(previous, seen)) {
        owner.set(card, slot);
        return true;
      }
    }
    return false;
  };
  for (const [slot, role] of slots.entries())
    if (!assign(slot, new Set())) {
      const available = (candidates[role] ?? []).filter((card) => !owner.has(card)).length;
      return shortage(role, available);
    }
  const out: RoleAllocation[] = [];
  for (const [i, role] of roles.entries()) {
    const devices = allocateDevices(
      role.devices ?? [],
      r,
      leases,
      out.flatMap((x) => x.devices),
    );
    if (!devices.ok) return waiting(`role ${role.role}: ${devices.reason}`);
    const picked = (candidates[i] ?? []).filter((card) => {
      const slot = owner.get(card);
      return slot !== undefined && slots[slot] === i;
    });
    out.push({
      role: role.role,
      devices: devices.devices,
      gpuIds: picked,
      cpus: role.cpus,
      memGB: role.memGB,
    });
  }
  return { ok: true, gpuIds: out.flatMap((x) => x.gpuIds), roles: out };
}

/** Below this much free space on the data disk no new run starts here (outputs, images, checkpoints). */
export const MIN_FREE_DISK_GB = 5;

/**
 * Host protection before any lease (design §9.6, point 3): a nearly full data disk, or too many runs
 * starting at once (image pulls, builds, VM unpacking), make new local runs wait.
 */
export function hostProtection(
  r: NodeResources,
  starting: number,
  maxStarting: number,
): string | null {
  if (r.disk.totalGB > 0 && r.disk.freeGB < MIN_FREE_DISK_GB)
    return `host protection: the data disk has ${r.disk.freeGB} GB free (under ${MIN_FREE_DISK_GB} GB)`;
  if (starting >= maxStarting)
    return `waiting for ${starting} starting run(s) (at most ${maxStarting} start at once; ORBIT_MAX_STARTING)`;
  return null;
}
