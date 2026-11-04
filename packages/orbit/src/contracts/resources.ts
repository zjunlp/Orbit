import { z } from "zod";

/** A process holding GPU memory; null fields could not be read (shown as unknown). */
export const GpuProcess = z.object({
  pid: z.number().int(),
  memMiB: z.number(),
  user: z.string().nullable(),
  /** Process name and its script or module, without arguments (they may hold secrets). */
  command: z.string().nullable(),
  startedAt: z.string().nullable(),
  /** Docker container name when the process runs in one. */
  container: z.string().nullable(),
  /** The Orbit run of that container. */
  runId: z.string().nullable(),
});
export type GpuProcess = z.infer<typeof GpuProcess>;

export const Gpu = z.object({
  index: z.number().int(),
  uuid: z.string(),
  name: z.string(),
  memTotalMiB: z.number(),
  memUsedMiB: z.number(),
  utilPct: z.number().nullable(),
  /** Memory used on the GPU by any process; the allocator treats leased GPUs separately. */
  externalMemMiB: z.number(),
  available: z.boolean(),
  /** Compute processes on this GPU, largest first (empty when the driver does not list them). */
  processes: z.array(GpuProcess).default([]),
});
export type Gpu = z.infer<typeof Gpu>;

export const NodeResources = z.object({
  node: z.string(),
  probedAt: z.string(),
  gpus: z.array(Gpu),
  gpuError: z.string().nullable(),
  cpu: z.object({
    count: z.number().int(),
    load1: z.number(),
    /** CPUs in use by all processes (Orbit's and others'), measured from /proc/stat and smoothed. */
    busy: z.number(),
  }),
  memory: z.object({
    totalGB: z.number(),
    availableGB: z.number(),
  }),
  disk: z.object({
    path: z.string(),
    totalGB: z.number(),
    freeGB: z.number(),
  }),
});
export type NodeResources = z.infer<typeof NodeResources>;

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  /** Works, but worth changing (e.g. data on the system disk). */
  warn: z.boolean().default(false),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  ok: z.boolean(),
  checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const ResourceRequest = z.object({
  gpus: z.number().int().min(0).default(0),
  /** Minimum total memory per GPU. */
  gpuMemGB: z.number().positive().optional(),
  /** Pin specific GPUs by UUID or index. */
  gpuIds: z.array(z.string()).optional(),
  cpus: z.number().positive().default(4),
  memGB: z.number().positive().default(16),
  /** Pin the run to this node; default: any node that can run it. */
  node: z.string().optional(),
});
export type ResourceRequest = z.infer<typeof ResourceRequest>;

/**
 * Which part of a run holds a resource: the run's own container, or one of its services (`sim`,
 * `policy`, …). Absent on leases recorded before allocations were per role.
 */
export const LeaseRole = z
  .string()
  .regex(/^[a-z0-9_-]{1,41}$/, "a role is a service name or `main`");
export type LeaseRole = z.infer<typeof LeaseRole>;

/** GPUs assigned to one role. A run without roles keeps a single `main` assignment. */
export const RoleAllocation = z.object({
  role: LeaseRole,
  gpuIds: z.array(z.string()),
  cpus: z.number(),
  memGB: z.number(),
});
export type RoleAllocation = z.infer<typeof RoleAllocation>;

export const Lease = z.object({
  id: z.string(),
  runId: z.string(),
  node: z.string(),
  gpuIds: z.array(z.string()),
  /** Per role; the union of `gpuIds` equals `roles[].gpuIds` on new leases. */
  roles: z.array(RoleAllocation).default([]),
  cpus: z.number(),
  memGB: z.number(),
  state: z.enum(["active", "released"]),
  createdAt: z.string(),
  releasedAt: z.string().nullable(),
});
export type Lease = z.infer<typeof Lease>;
