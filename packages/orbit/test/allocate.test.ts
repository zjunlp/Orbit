import { describe, expect, it } from "vitest";
import type { Lease, NodeResources } from "../src/contracts/index.ts";
import { ResourceRequest } from "../src/contracts/index.ts";
import {
  allocate,
  allocateRoles,
  CPU_RAMP_MS,
  cpuOutside,
  infeasible,
} from "../src/resources/allocate.ts";
import { CpuMeter, parseProcStat } from "../src/resources/probe.ts";

const gpu = (index: number, over: Partial<NodeResources["gpus"][number]> = {}) => ({
  index,
  uuid: `GPU-${index}`,
  name: "RTX 3090",
  memTotalMiB: 24576,
  memUsedMiB: 10,
  utilPct: 0,
  externalMemMiB: 10,
  available: true,
  processes: [],
  ...over,
});

const node: NodeResources = {
  node: "n",
  probedAt: "",
  gpus: [
    gpu(0),
    gpu(1, { memUsedMiB: 5000, externalMemMiB: 5000, available: false }),
    gpu(2),
    gpu(3, { memUsedMiB: 500 }),
  ],
  gpuError: null,
  cpu: { count: 16, load1: 0, busy: 0 },
  memory: { totalGB: 100, availableGB: 80 },
  disk: { path: "/", totalGB: 1, freeGB: 1 },
};

const lease = (gpuIds: string[], cpus = 4, memGB = 16): Lease => ({
  id: "l",
  runId: "r",
  node: "n",
  roles: [],
  gpuIds,
  cpus,
  memGB,
  state: "active",
  createdAt: "",
  releasedAt: null,
});

const req = (r: Partial<ResourceRequest>) => ResourceRequest.parse(r);

describe("allocate", () => {
  it("skips externally busy and leased GPUs, preferring the least used", () => {
    expect(allocate(req({ gpus: 2 }), node, [])).toEqual({ ok: true, gpuIds: ["GPU-0", "GPU-2"] });
    expect(allocate(req({ gpus: 1 }), node, [lease(["GPU-0"])])).toEqual({
      ok: true,
      gpuIds: ["GPU-2"],
    });
  });

  it("queues with a reason when GPUs are short", () => {
    const a = allocate(req({ gpus: 3 }), node, [lease(["GPU-0"])]);
    expect(a).toEqual({ ok: false, reason: "waiting for GPUs (2/3 free, 1 busy outside Orbit)" });
  });

  it("honours pinned GPUs by index or uuid", () => {
    expect(allocate(req({ gpus: 1, gpuIds: ["3"] }), node, [])).toEqual({
      ok: true,
      gpuIds: ["GPU-3"],
    });
    expect(allocate(req({ gpus: 1, gpuIds: ["GPU-1"] }), node, []).ok).toBe(false);
  });

  it("accounts CPU and memory leases", () => {
    expect(allocate(req({ cpus: 10 }), node, [lease([], 8)]).ok).toBe(false);
    expect(allocate(req({ memGB: 50 }), node, [lease([], 1, 50)]).ok).toBe(false);
    expect(allocate(req({ memGB: 85 }), node, []).ok).toBe(false); // above MemAvailable
  });

  it("rejects requests the node can never satisfy", () => {
    expect(infeasible(req({ gpus: 5 }), node)).toMatch(/has 4 matching/);
    expect(infeasible(req({ gpus: 1, gpuMemGB: 40 }), node)).toMatch(/has 0 matching/);
    expect(infeasible(req({ cpus: 32 }), node)).toMatch(/CPUs/);
    expect(infeasible(req({ gpus: 4 }), node)).toBeNull();
  });
});

describe("CPU use outside Orbit", () => {
  const at = "2026-10-02T12:00:00.000Z";
  const busy = (n: number): NodeResources => ({
    ...node,
    probedAt: at,
    cpu: { count: 80, load1: n, busy: n },
  });
  const leaseAt = (cpus: number, ageMs: number): Lease => ({
    ...lease([], cpus, 1),
    createdAt: new Date(Date.parse(at) - ageMs).toISOString(),
  });

  it("queues behind processes Orbit did not start", () => {
    expect(allocate(req({ cpus: 16 }), busy(48), []).ok).toBe(true);
    expect(allocate(req({ cpus: 40 }), busy(48), [])).toEqual({
      ok: false,
      reason: "waiting for CPUs (36/40 free, ~44 busy outside Orbit)",
    });
    // Background noise (≤ 5% of the cores) does not block a whole-node request.
    expect(allocate(req({ cpus: 80 }), busy(3), []).ok).toBe(true);
  });

  it("does not count settled leases twice, but does count starting runs", () => {
    // 32 CPUs leased long ago and busy: the other 16 busy CPUs are outside Orbit.
    expect(cpuOutside(busy(48), [leaseAt(32, CPU_RAMP_MS)])).toBe(12);
    // A run leased in this pass is not in the measurement yet: it adds its lease on top.
    const fresh = [leaseAt(32, 0)];
    expect(cpuOutside(busy(48), fresh)).toBe(44);
    expect(allocate(req({ cpus: 8 }), busy(48), fresh)).toMatchObject({ ok: false });
    expect(allocate(req({ cpus: 4 }), busy(48), fresh).ok).toBe(true);
  });

  it("measures /proc/stat: rises at once, falls slowly", () => {
    expect(parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n")).toEqual({
      busy: 150,
      total: 1000,
    });
    expect(parseProcStat("garbage")).toBeNull();
    const m = new CpuMeter();
    expect(m.sample({ busy: 0, total: 0 }, 8, 5, 0)).toBe(5); // first sample: load average
    expect(m.sample({ busy: 100, total: 200 }, 8, 5, 2000)).toBe(4); // half busy on 8 cores
    expect(m.sample({ busy: 100, total: 200 }, 8, 5, 2500)).toBe(4); // < 1 s apart: unchanged
    expect(m.sample({ busy: 300, total: 400 }, 8, 5, 4000)).toBe(8); // all busy: immediately
    const after = m.sample({ busy: 300, total: 600 }, 8, 5, 6000); // idle for 2 s
    expect(after).toBeGreaterThan(7);
    expect(after).toBeLessThan(8);
  });
});

describe("role allocation", () => {
  const req = (role: string, gpus: number, extra: object = {}) => ({
    role,
    gpus,
    cpus: 2,
    memGB: 4,
    ...extra,
  });

  it("gives each role its own cards, never the same one twice", () => {
    const a = allocateRoles([req("main", 0), req("sim", 1), req("policy", 1)], node, []);
    expect(a.ok && a.roles).toEqual([
      { role: "main", gpuIds: [], cpus: 2, memGB: 4 },
      // GPU-1 is busy outside Orbit in this fixture, so the roles take the free cards.
      { role: "sim", gpuIds: ["GPU-0"], cpus: 2, memGB: 4 },
      { role: "policy", gpuIds: ["GPU-2"], cpus: 2, memGB: 4 },
    ]);
    expect(a.ok && a.gpuIds).toEqual(["GPU-0", "GPU-2"]);
  });

  it("waits instead of starting half of a heterogeneous requirement", () => {
    const small = node.gpus.slice(0, 1).map((g) => ({ ...g }));
    const half = { ...node, gpus: small };
    const a = allocateRoles([req("sim", 1), req("policy", 1)], half, []);
    expect(a).toMatchObject({ ok: false });
    // The whole requirement is checked first: two roles, one free card.
    expect(!a.ok && a.reason).toMatch(/waiting for GPUs \(1\/2 free\)/);
  });

  it("counts the cards another lease already holds", () => {
    // Three cards: GPU-0 held by another lease, GPU-1 busy outside Orbit.
    const busy = { ...node, gpus: node.gpus.slice(0, 3) };
    const held = { ...lease(["GPU-0"]) } as Lease;
    const a = allocateRoles([req("main", 1)], busy, [held]);
    expect(a.ok && a.roles[0]?.gpuIds).toEqual(["GPU-2"]);
  });
});
