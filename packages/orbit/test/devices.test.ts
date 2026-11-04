import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatLedger } from "../src/cli/format.ts";
import { ensureHome, orbitPaths, runDirs } from "../src/config/paths.ts";
import {
  DeviceAllocation,
  Lease,
  leaseRequest,
  NodeResources,
  ResourceRequest,
  Run,
  RunSpec,
  roleRequests,
} from "../src/contracts/index.ts";
import { runArgs } from "../src/executor/docker.ts";
import { allocate, allocateRoles, infeasible } from "../src/resources/allocate.ts";
import { probeDevices } from "../src/resources/probe.ts";
import type { RunContext } from "../src/runs/context.ts";
import { containerSpec } from "../src/runs/launch.ts";
import { remoteBlocker } from "../src/runs/placement.ts";
import { RunService } from "../src/runs/service.ts";
import { serviceContainer } from "../src/runs/services.ts";
import { Store } from "../src/store/index.ts";

const node = (devices: unknown[] = []) =>
  NodeResources.parse({
    node: "fixture",
    probedAt: new Date().toISOString(),
    gpus: [],
    gpuError: null,
    cpu: { count: 16, load1: 0, busy: 0 },
    memory: { totalGB: 64, availableGB: 64 },
    disk: { path: "/tmp", totalGB: 1024, freeGB: 900 },
    devices,
  });
const spec = (extra: object = {}) =>
  RunSpec.parse({
    image: "fixture",
    command: ["true"],
    resources: { cpus: 1, memGB: 1 },
    ...extra,
  });
const held = (devices: unknown[]) =>
  Lease.parse({
    id: "lease-owner",
    runId: "owner",
    node: "fixture",
    gpuIds: [],
    cpus: 1,
    memGB: 1,
    roles: [{ role: "main", gpuIds: [], cpus: 1, memGB: 1, devices }],
    state: "active",
    createdAt: new Date().toISOString(),
    releasedAt: null,
  });

describe("device capability probe (injected filesystem and adb)", () => {
  it("reports readable device nodes and diagnostics without losing other probes", async () => {
    const devices = await probeDevices({
      readDir: async (path) =>
        path === "/dev/dri" ? ["card0", "renderD129", "renderD128"] : ["ttyUSB0", "tty0"],
      readWrite: async (path) => {
        if (path === "/dev/kvm" || path === "/dev/dri/renderD129")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      adb: async () => ({ code: 0, stderr: "" }),
    });
    expect(devices.find((d) => d.class === "kvm")).toMatchObject({
      count: 0,
      detail: expect.stringContaining("EACCES"),
    });
    expect(devices.find((d) => d.class === "dri")).toMatchObject({
      count: 1,
      paths: ["/dev/dri/renderD128"],
    });
    expect(devices.find((d) => d.class === "net-tun")).toMatchObject({
      count: 1,
      paths: ["/dev/net/tun"],
    });
    expect(devices.find((d) => d.class === "android")).toMatchObject({
      count: 1,
      exclusive: true,
      paths: [],
    });
    expect(devices.find((d) => d.class === "serial")).toMatchObject({
      count: 1,
      paths: ["/dev/ttyUSB0"],
    });
  });

  it("contains missing directories, inaccessible device nodes and adb failure", async () => {
    const missing = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const devices = await probeDevices({ readDir: missing, readWrite: missing, adb: missing });
    expect(devices).toHaveLength(5);
    expect(devices.every((d) => d.count === 0 && d.detail?.includes("ENOENT"))).toBe(true);
  });
});

describe("device contracts and allocation", () => {
  it("reads old resource and lease documents with empty device assignments", () => {
    const { devices: _, ...old } = node();
    expect(NodeResources.parse(old).devices).toEqual([]);
    expect(ResourceRequest.parse({}).devices).toEqual([]);
    expect(held([]).roles[0]?.devices).toEqual([]);
    expect(spec().devices).toEqual([]);
    expect(
      DeviceAllocation.safeParse({ class: "kvm", count: 1, paths: ["/dev/../etc/passwd"] }).success,
    ).toBe(false);
    expect(
      DeviceAllocation.safeParse({ class: "kvm", count: 1, paths: ["/dev/kvm:/dev/x"] }).success,
    ).toBe(false);
  });

  it("rejects ambiguous roles and device requests on an unsupported backend", () => {
    expect(() =>
      spec({
        devices: [{ class: "kvm", count: 1 }],
        resources: { devices: [{ class: "kvm", count: 1 }] },
      }),
    ).toThrow(/not both/);
    expect(() =>
      RunSpec.parse({
        backend: "process",
        command: ["true"],
        devices: [{ class: "kvm", count: 1 }],
      }),
    ).toThrow(/docker/);
    expect(() =>
      spec({ services: [{ name: "vm", image: "x", devices: [{ class: "kvm", count: 1 }] }] }),
    ).toThrow(/role/);
    expect(() => spec({ services: [{ name: "vm", image: "x", gpus: 1 }] })).toThrow(/role/);
    expect(() =>
      spec({
        services: [
          { name: "a", image: "x", role: "vm" },
          { name: "b", image: "x", role: "vm" },
        ],
      }),
    ).toThrow(/distinct/);
    expect(() => spec({ services: [{ name: "a", image: "x", role: "main" }] })).toThrow(/main/);
  });

  it("allocates distinct device nodes to each role and excludes leased nodes", () => {
    const resources = node([
      {
        class: "dri",
        count: 3,
        paths: ["/dev/dri/renderD128", "/dev/dri/renderD129", "/dev/dri/renderD130"],
      },
    ]);
    const run = spec({
      devices: [{ class: "dri", count: 1 }],
      services: [
        { name: "renderer", role: "sim", image: "x", devices: [{ class: "dri", count: 1 }] },
      ],
    });
    expect(leaseRequest(run).devices).toEqual([
      { class: "dri", count: 1 },
      { class: "dri", count: 1 },
    ]);
    const allocation = allocateRoles(roleRequests(run), resources, [
      held([{ class: "dri", count: 1, paths: ["/dev/dri/renderD128"] }]),
    ]);
    expect(allocation.ok && allocation.roles.map((r) => r.devices)).toEqual([
      [{ class: "dri", count: 1, paths: ["/dev/dri/renderD129"] }],
      [{ class: "dri", count: 1, paths: ["/dev/dri/renderD130"] }],
    ]);
    const tooMany = spec({
      devices: [
        { class: "dri", count: 2 },
        { class: "dri", count: 2 },
      ],
    });
    expect(infeasible(leaseRequest(tooMany), resources)).toContain("needs 4 dri");
  });

  it("does not guess the path held by a count-only lease or share a path across classes", () => {
    const resources = node([
      { class: "dri", count: 2, paths: ["/dev/dri/renderD128", "/dev/dri/renderD129"] },
      { class: "robot:vision", count: 1, paths: ["/dev/dri/renderD129"] },
    ]);
    const request = roleRequests(spec({ devices: [{ class: "dri", count: 1 }] }));
    expect(allocateRoles(request, resources, [held([{ class: "dri", count: 1 }])])).toMatchObject({
      ok: false,
    });
    const busy = held([{ class: "robot:vision", count: 1, paths: ["/dev/dri/renderD129"] }]);
    const allocation = allocateRoles(request, resources, [busy]);
    expect(allocation.ok && allocation.roles[0]?.devices[0]?.paths).toEqual([
      "/dev/dri/renderD128",
    ]);
    const overlapping = node([
      { class: "dri", count: 1, paths: ["/dev/dri/renderD128"] },
      { class: "robot:vision", count: 1, paths: ["/dev/dri/renderD128"] },
    ]);
    const both = roleRequests(
      spec({
        devices: [
          { class: "dri", count: 1 },
          { class: "robot:vision", count: 1 },
        ],
      }),
    );
    expect(allocateRoles(both, overlapping, [])).toMatchObject({ ok: false });
  });

  it("does not consume a shared device class: every run and role gets the same nodes", () => {
    const resources = node([{ class: "kvm", count: 1, shared: true, paths: ["/dev/kvm"] }]);
    const run = spec({
      devices: [{ class: "kvm", count: 1 }],
      services: [{ name: "vm", role: "vm", image: "x", devices: [{ class: "kvm", count: 1 }] }],
    });
    expect(infeasible(leaseRequest(run), resources)).toBeNull();
    const busy = held([{ class: "kvm", count: 1, paths: ["/dev/kvm"] }]);
    const allocation = allocateRoles(roleRequests(run), resources, [busy]);
    expect(allocation.ok && allocation.roles.map((r) => r.devices[0]?.paths)).toEqual([
      ["/dev/kvm"],
      ["/dev/kvm"],
    ]);
    expect(allocateRoles(roleRequests(run), node([]), []).ok).toBe(false);
  });

  it("keeps an exclusive device class with one run until its lease is released", () => {
    const resources = node([{ class: "robot:arm", count: 2, exclusive: true }]);
    const request = ResourceRequest.parse({
      devices: [{ class: "robot:arm", count: 1 }],
      cpus: 1,
      memGB: 1,
    });
    const lease = held([{ class: "robot:arm", count: 1 }]);
    expect(infeasible(request, resources)).toBeNull();
    expect(allocate(request, resources, [lease])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/robot:arm.*0\/1.*owner.*exclusive/),
    });
    expect(allocate(request, resources, [{ ...lease, state: "released" }]).ok).toBe(true);
    expect(allocateRoles(roleRequests(spec({ resources: request })), resources, []).ok).toBe(true);
  });

  it("places a device run only on a worker that reports the capability", () => {
    const run = spec({ devices: [{ class: "kvm", count: 1 }] });
    const worker = {
      name: "worker",
      online: true,
      resources: node(),
      leases: [],
      datasets: [],
      profiles: [],
    };
    expect(remoteBlocker(run, worker)).toContain("kvm");
    expect(
      remoteBlocker(run, {
        ...worker,
        resources: node([{ class: "kvm", count: 1, paths: ["/dev/kvm"] }]),
      }),
    ).toBeNull();
  });

  it("maps only the role's leased device paths into main and service containers", () => {
    const paths = orbitPaths({ ORBIT_HOME: "/tmp/orbit-device-fixture" });
    const run = Run.parse({
      id: "fixture",
      spec: spec({
        devices: [{ class: "kvm", count: 1 }],
        services: [{ name: "sim", image: "x", role: "sim", devices: [{ class: "dri", count: 1 }] }],
      }),
      state: "starting",
      reason: null,
      exitCode: null,
      node: "fixture",
      image: "x",
      containerId: null,
      lease: {
        ...held([{ class: "kvm", count: 1, paths: ["/dev/kvm"] }]),
        roles: [
          {
            role: "main",
            gpuIds: [],
            cpus: 1,
            memGB: 1,
            devices: [{ class: "kvm", count: 1, paths: ["/dev/kvm"] }],
          },
          {
            role: "sim",
            gpuIds: [],
            cpus: 1,
            memGB: 1,
            devices: [{ class: "dri", count: 1, paths: ["/dev/dri/renderD128"] }],
          },
        ],
      },
      code: null,
      cleanup: "pending",
      note: "",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    });
    const ctx = {
      homeLabel: "fixture",
      gpuMode: "gpus",
      deps: {},
      networkNames: () => [],
    } as unknown as RunContext;
    const main = containerSpec(ctx, run, runDirs(paths, run.id), "x");
    const sim = run.spec.services[0];
    if (!sim) throw new Error("missing fixture service");
    const service = serviceContainer(ctx, run, sim, "x");
    expect(main.devices).toEqual(["/dev/kvm"]);
    expect(service.devices).toEqual(["/dev/dri/renderD128"]);
    expect(runArgs(main).join(" ")).toContain("--device /dev/kvm");
    expect(runArgs(service).join(" ")).toContain("--device /dev/dri/renderD128");
    expect(runArgs(main)).not.toContain("/dev/dri/renderD128");
  });

  it("shows unavailable probes and leased owners in the CLI ledger", () => {
    const output = formatLedger({
      resources: node([
        { class: "kvm", count: 1, paths: ["/dev/kvm"] },
        { class: "dri", count: 0, detail: "EACCES" },
      ]),
      leases: [held([{ class: "kvm", count: 1, paths: ["/dev/kvm"] }])],
      queued: [],
      nodes: [],
    });
    expect(output).toMatch(/kvm\s+0\/1 free/);
    expect(output).toMatch(/run owner\s+role main/);
    expect(output).toMatch(/dri\s+0\/0 free\s+EACCES/);
  });
});

const fixtures: { home: string; store: Store; runs: RunService }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runs.stop();
    f.store.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it("rejects absent devices at submission, but queues a run behind an exclusive lease", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-device-test-"));
  const paths = orbitPaths({ ORBIT_HOME: home, ORBIT_NODE: "fixture" });
  ensureHome(paths);
  const store = new Store(paths.db);
  const resources = node([{ class: "robot:arm", count: 1, exclusive: true }]);
  const runs = new RunService({ paths, store, probe: async () => resources });
  fixtures.push({ home, store, runs });
  await expect(runs.submit(spec({ devices: [{ class: "missing", count: 1 }] }))).rejects.toThrow(
    /needs 1 missing.*has 0/,
  );
  expect(store.listRuns({})).toHaveLength(0);
  store.putLease(held([{ class: "robot:arm", count: 1 }]));
  const run = await runs.submit(spec({ devices: [{ class: "robot:arm", count: 1 }] }));
  await runs.tick();
  expect(store.getRun(run.id)).toMatchObject({
    state: "queued",
    lease: null,
    reason: expect.stringMatching(/robot:arm.*owner/),
  });
  expect(store.activeLeases()).toHaveLength(1);
});
