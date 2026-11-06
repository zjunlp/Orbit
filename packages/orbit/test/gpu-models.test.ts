import { describe, expect, it } from "vitest";
import { Lease, NodeResources, RunSpec, roleRequests } from "../src/contracts/index.ts";
import type { RoleRequest } from "../src/contracts/runs.ts";
import { allocateRoles, gpuCapabilityWarnings, infeasible } from "../src/resources/allocate.ts";

const role = (name: string, extra: Partial<RoleRequest> = {}): RoleRequest => ({
  role: name,
  gpus: 1,
  cpus: 1,
  memGB: 1,
  ...extra,
});
const node = NodeResources.parse({
  node: "fixture",
  probedAt: "2026-11-04T00:00:00Z",
  cpu: { count: 16, load1: 0, busy: 0 },
  memory: { totalGB: 128, availableGB: 120 },
  disk: { path: "/", totalGB: 100, freeGB: 90 },
  gpuError: null,
  gpus: ["NVIDIA GeForce RTX 3090", "NVIDIA H100", "NVIDIA RTX 4090"].map((name, index) => ({
    index,
    uuid: `GPU-${index}`,
    name,
    memTotalMiB: index === 1 ? 81920 : 24576,
    memUsedMiB: 0,
    utilPct: 0,
    externalMemMiB: 0,
    available: true,
  })),
});

const admission = (roles: RoleRequest[], hardware = node) =>
  infeasible(
    {
      gpus: roles.reduce((sum, role) => sum + role.gpus, 0),
      cpus: roles.reduce((sum, role) => sum + role.cpus, 0),
      memGB: roles.reduce((sum, role) => sum + role.memGB, 0),
      devices: [],
    },
    hardware,
    roles,
  );

describe("GPU role admission", () => {
  it("rejects two 24 GB roles on an otherwise idle 8 GB and 24 GB node", () => {
    const hardware = NodeResources.parse({
      ...node,
      gpus: node.gpus
        .slice(0, 2)
        .map((g, index) => ({ ...g, memTotalMiB: (index ? 24 : 8) * 1024 })),
    });
    const roles = [role("main", { gpuMemGB: 24 }), role("policy", { gpuMemGB: 24 })];
    expect(admission(roles, hardware)).toMatch(/distinct GPUs.*policy/);
    expect(allocateRoles(roles, hardware, []).ok).toBe(false);
  });

  it.each([
    { gpuMemGB: 80 },
    { gpuModels: ["H100"] },
    { gpuFeatures: ["h100"] },
    { gpuIds: ["1"] },
  ])("rejects roles competing for one qualifying card: %j", (constraints) => {
    const roles = [role("main", constraints), role("policy", constraints)];
    expect(admission(roles)).toMatch(/distinct GPUs.*policy/);
    expect(allocateRoles(roles, node, []).ok).toBe(false);
  });

  it("rejects overlapping multi-card requirements despite sufficient total cards", () => {
    const roles = [
      role("main", { gpus: 2, gpuModels: ["RTX"] }),
      role("policy", { gpuModels: ["RTX"] }),
    ];
    expect(admission(roles)).toMatch(/distinct GPUs.*policy/);
    expect(allocateRoles(roles, node, []).ok).toBe(false);
  });

  it("reassigns earlier roles and admits different capacity requirements", () => {
    const roles = [role("main", { gpus: 2, gpuMemGB: 24 }), role("policy", { gpuMemGB: 80 })];
    expect(admission(roles)).toBeNull();
    expect(allocateRoles(roles, node, [])).toMatchObject({
      ok: true,
      roles: [
        { role: "main", gpuIds: ["GPU-0", "GPU-2"] },
        { role: "policy", gpuIds: ["GPU-1"] },
      ],
    });
  });

  it("admits fitting hardware even when every GPU, CPU and available memory are busy", () => {
    const roles = [role("main", { gpuMemGB: 80 }), role("policy", { gpuMemGB: 24 })];
    const busy = NodeResources.parse({
      ...node,
      cpu: { ...node.cpu, busy: node.cpu.count },
      memory: { ...node.memory, availableGB: 0 },
      gpus: node.gpus.map((g) => ({ ...g, available: false, memUsedMiB: g.memTotalMiB })),
    });
    const before = structuredClone(busy);
    expect(admission(roles, busy)).toBeNull();
    expect(allocateRoles(roles, busy, []).ok).toBe(false);
    expect(busy).toEqual(before);
  });

  it("checks legacy model features while leaving graphics declarations unverified", () => {
    expect(admission([role("sim", { gpuFeatures: ["missing-model"] })])).toMatch(/missing-model/);
    expect(admission([role("sim", { gpuFeatures: ["egl", "vulkan", "cuda"] })])).toBeNull();
  });
});

describe("GPU model allocation", () => {
  it("matches card names case-insensitively and retains memory and ID constraints", () => {
    expect(allocateRoles([role("sim", { gpuFeatures: [" rTx "] })], node, [])).toMatchObject({
      ok: true,
      gpuIds: ["GPU-0"],
    });
    expect(
      allocateRoles([role("sim", { gpuFeatures: ["RTX"], gpuIds: ["2"] })], node, []),
    ).toMatchObject({ ok: true, gpuIds: ["GPU-2"] });
    expect(
      allocateRoles([role("sim", { gpuFeatures: ["RTX"], gpuMemGB: 80 })], node, []),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("0/1 matching cards free") });
  });

  it("queues unknown models with a concrete role and matching count", () => {
    expect(
      allocateRoles([role("sim", { gpuFeatures: ["does-not-exist"], gpus: 2 })], node, []),
    ).toEqual({
      ok: false,
      reason: "waiting for GPUs (role sim: needs does-not-exist, 0/2 matching cards free)",
    });
  });

  it("does not assign busy or leased matching cards", () => {
    const busy = { ...node, gpus: node.gpus.map((g) => ({ ...g, available: g.index !== 0 })) };
    const held = Lease.parse({
      id: "lease",
      runId: "run",
      node: node.node,
      gpuIds: ["GPU-2"],
      cpus: 1,
      memGB: 1,
      state: "active",
      createdAt: node.probedAt,
      releasedAt: null,
    });
    expect(allocateRoles([role("sim", { gpuFeatures: ["rtx"] })], busy, [held])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("role sim: needs rtx, 0/1 matching cards free"),
    });
  });

  it("treats EGL, Vulkan and CUDA as unverified capabilities, not card names", () => {
    const roles = [role("sim", { gpuFeatures: ["EGL", "vulkan", "cuda"] })];
    expect(allocateRoles(roles, node, [])).toMatchObject({ ok: true, gpuIds: ["GPU-0"] });
    expect(gpuCapabilityWarnings(roles)).toEqual([
      "role sim: egl, vulkan, cuda capabilities declared, not verified",
    ]);
    expect(allocateRoles(roles, { ...node, gpus: [] }, [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("capabilities declared, not verified"),
    });
  });

  it("reassigns an unrestricted role instead of stranding the only matching card", () => {
    const two = { ...node, gpus: node.gpus.slice(0, 2) };
    expect(
      allocateRoles([role("main"), role("sim", { gpuFeatures: ["rtx"] })], two, []),
    ).toMatchObject({
      ok: true,
      roles: [
        { role: "main", gpuIds: ["GPU-1"] },
        { role: "sim", gpuIds: ["GPU-0"] },
      ],
    });
  });

  it("finds assignments through overlapping multi-card roles and refuses impossible overlap", () => {
    const roles = [role("main", { gpus: 2 }), role("sim", { gpuIds: ["0"] })];
    const result = allocateRoles(roles, node, []);
    expect(result).toMatchObject({
      ok: true,
      roles: [
        { role: "main", gpuIds: ["GPU-1", "GPU-2"] },
        { role: "sim", gpuIds: ["GPU-0"] },
      ],
    });
    expect(
      allocateRoles([role("a", { gpuIds: ["0"] }), role("b", { gpuIds: ["0"] })], node, []),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("role b") });
  });

  it("passes service feature declarations through parsed run contracts", () => {
    const spec = RunSpec.parse({
      image: "test",
      command: ["true"],
      services: [{ name: "simulator", role: "sim", image: "test", gpus: 1, gpuFeatures: ["rtx"] }],
    });
    expect(roleRequests(spec).find((x) => x.role === "sim")?.gpuFeatures).toEqual(["rtx"]);
  });
});

it("includes services without explicit roles in aggregate CPU and memory admission", () => {
  const spec = RunSpec.parse({
    image: "fixture",
    command: ["true"],
    resources: { gpus: 0, cpus: 1, memGB: 1 },
    services: [{ name: "monitor", image: "fixture", cpus: 16, memGB: 1 }],
  });
  expect(allocateRoles(roleRequests(spec), node, [])).toMatchObject({
    ok: false,
    reason: expect.stringContaining("CPUs"),
  });
});
