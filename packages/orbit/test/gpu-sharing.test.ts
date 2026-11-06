// Pure allocation and spec translation; no GPUs or Docker are used.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { parseCompose } from "../src/bench/compose.ts";
import { findHarborTasks, harborSolveSpec } from "../src/bench/harbor.ts";
import {
  Lease,
  leaseRequest,
  NodeResources,
  PolicyDefinition,
  type Run,
  RunSpec,
  roleRequests,
} from "../src/contracts/index.ts";
import { runArgs } from "../src/executor/docker.ts";
import { allocateRoles, infeasible } from "../src/resources/allocate.ts";
import { serviceGpus } from "../src/runs/services.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-gpu-sharing-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const gpu = (index: number, name: string) => ({
  index,
  uuid: `GPU-${index}`,
  name,
  memTotalMiB: 24576,
  memUsedMiB: 0,
  utilPct: 0,
  externalMemMiB: 0,
  available: true,
});
const node = NodeResources.parse({
  node: "n",
  probedAt: new Date().toISOString(),
  gpus: [gpu(0, "NVIDIA GeForce RTX 3090"), gpu(1, "NVIDIA L40S")],
  gpuError: null,
  cpu: { count: 16, load1: 0, busy: 0 },
  memory: { totalGB: 64, availableGB: 64 },
  disk: { path: "/tmp", totalGB: 1000, freeGB: 900 },
});

it("places a role only on one of its acceptable GPU models", () => {
  const spec = RunSpec.parse({
    image: "x",
    command: ["x"],
    resources: { gpus: 1, cpus: 1, memGB: 1, gpuModels: ["L40S", "RTX 4090"] },
  });
  const roles = roleRequests(spec);
  expect(infeasible({ gpus: 1, cpus: 1, memGB: 1, devices: [] }, node, roles)).toBeNull();
  const got = allocateRoles(roles, node, []);
  expect(got.ok && got.roles[0]?.gpuIds).toEqual(["GPU-1"]);
  const only3090 = NodeResources.parse({ ...node, gpus: [node.gpus[0]] });
  expect(infeasible({ gpus: 1, cpus: 1, memGB: 1, devices: [] }, only3090, roles)).toMatch(
    /needs 1 GPU\(s\) of L40S \/ RTX 4090, but this node has 0/,
  );
});

it("gives a gpusOf service the owner's cards without leasing more", () => {
  const spec = RunSpec.parse({
    image: "x",
    command: ["x"],
    resources: { gpus: 0, cpus: 1, memGB: 1 },
    services: [
      { name: "sim", image: "s", role: "sim", gpus: 1 },
      { name: "monitor", image: "m", gpusOf: "sim" },
    ],
  });
  expect(roleRequests(spec).map((r) => [r.role, r.gpus])).toEqual([
    ["main", 0],
    ["sim", 1],
  ]);
  const run = {
    lease: {
      gpuIds: ["GPU-1"],
      roles: [
        { role: "main", gpuIds: [] },
        { role: "sim", gpuIds: ["GPU-1"] },
      ],
    },
  } as unknown as Run;
  expect(serviceGpus(run, { gpusOf: "sim" })).toEqual(["GPU-1"]);
  expect(serviceGpus(run, {})).toEqual([]);
  expect(serviceGpus(run, { gpusOf: "main" })).toEqual([]);
});

const capacities = (sizes: number[]) =>
  NodeResources.parse({
    ...node,
    gpus: sizes.map((size, index) => ({ ...gpu(index, "synthetic"), memTotalMiB: size * 1024 })),
  });

const sharedBudget = (owner = "main") =>
  RunSpec.parse({
    image: "synthetic",
    command: ["true"],
    resources: {
      gpus: owner === "main" ? 1 : 0,
      ...(owner === "main" ? { gpuMemGB: 4 } : {}),
      cpus: 1,
      memGB: 1,
    },
    services: [
      ...(owner === "main"
        ? []
        : [{ name: "sim", image: "synthetic", role: owner, gpus: 1, gpuMemGB: 4 }]),
      { name: "policy", image: "synthetic", gpusOf: owner, gpuMemGB: 24, cpus: 1, memGB: 1 },
    ],
  });

it.each(["main", "sim"])(
  "adds shared GPU memory budgets to owner %s without extra cards or mutation",
  (owner) => {
    const spec = sharedBudget(owner);
    const before = structuredClone(spec);
    const roles = roleRequests(spec);
    expect(roles.find((r) => r.role === owner)).toMatchObject({ gpus: 1, gpuMemGB: 28 });
    expect(leaseRequest(spec).gpus).toBe(1);
    expect(roleRequests(spec)).toEqual(roles);
    expect(spec).toEqual(before);
    expect(allocateRoles(roles, capacities([8, 24, 32]), [])).toMatchObject({
      ok: true,
      gpuIds: ["GPU-2"],
    });
  },
);

it("retains a shared model's floor when the owner has no GPU memory budget", () => {
  const spec = sharedBudget();
  delete spec.resources.gpuMemGB;
  expect(allocateRoles(roleRequests(spec), capacities([8, 24]), [])).toMatchObject({
    ok: true,
    gpuIds: ["GPU-1"],
  });
});

it("rejects nodes without enough shared GPU capacity but waits when fitting cards are busy", () => {
  const spec = sharedBudget();
  const roles = roleRequests(spec);
  expect(infeasible(leaseRequest(spec), capacities([8, 24]), roles)).toMatch(/role main.*28 GB/);
  const busy = capacities([8, 32]);
  const fitting = busy.gpus[1];
  if (!fitting) throw new Error("missing GPU fixture");
  fitting.available = false;
  expect(infeasible(leaseRequest(spec), busy, roles)).toBeNull();
  expect(allocateRoles(roles, busy, [])).toMatchObject({
    ok: false,
    reason: expect.stringContaining("role main"),
  });
  const held = Lease.parse({
    id: "held",
    runId: "other",
    node: node.node,
    gpuIds: ["GPU-1"],
    cpus: 1,
    memGB: 1,
    state: "active",
    createdAt: node.probedAt,
    releasedAt: null,
  });
  expect(allocateRoles(roles, capacities([8, 32]), [held]).ok).toBe(false);
});

it("carries generated GR00T and native simulator budgets into the real allocator", () => {
  const sdk = fileURLToPath(new URL("../../../examples/sdk/", import.meta.url));
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from orbit_embodied.test_provision import configured_resources
with tempfile.TemporaryDirectory() as temporary:
    items=[configured_resources(Path(temporary)/str(shared),shared=shared) for shared in (False,True)]
    print(json.dumps(items))
`,
      sdk,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  const items = JSON.parse(output) as { policy: unknown; spec: object }[];
  for (const [index, item] of items.entries()) {
    const shared = index === 1;
    const policy = PolicyDefinition.parse(item.policy);
    expect(policy.service.gpuMemGB).toBe(24);
    const spec = RunSpec.parse({ ...item.spec, services: [policy.service] });
    const roles = roleRequests(spec);
    expect(roles[0]?.gpuMemGB).toBe(shared ? 28 : 4);
    const hardware = capacities([8, shared ? 32 : 24]);
    expect(infeasible(leaseRequest(spec), hardware, roles)).toBeNull();
    expect(allocateRoles(roles, hardware, [])).toMatchObject({
      ok: true,
      gpuIds: shared ? ["GPU-1"] : ["GPU-0", "GPU-1"],
    });
    if (shared) expect(allocateRoles(roles, capacities([8, 24]), []).ok).toBe(false);
  }
});

it("checks independent role capacities separately during admission", () => {
  const spec = RunSpec.parse({
    image: "synthetic",
    command: ["true"],
    resources: { gpus: 1, gpuMemGB: 32, cpus: 1, memGB: 1 },
    services: [{ name: "policy", image: "synthetic", role: "policy", gpus: 1, gpuMemGB: 8 }],
  });
  const hardware = capacities([8, 32]);
  expect(infeasible(leaseRequest(spec), hardware, roleRequests(spec))).toBeNull();
  expect(allocateRoles(roleRequests(spec), hardware, [])).toMatchObject({
    ok: true,
    roles: [
      { role: "main", gpuIds: ["GPU-1"] },
      { role: "policy", gpuIds: ["GPU-0"] },
    ],
  });
});

it("does not double-count GPU memory already combined by Compose", () => {
  const task = join(dir, "shared-budget-compose");
  mkdirSync(task, { recursive: true });
  const file = join(task, "docker-compose.yaml");
  const reservation = {
    deploy: {
      resources: {
        reservations: { devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }] },
      },
    },
  };
  writeFileSync(
    file,
    JSON.stringify({
      services: {
        main: { ...reservation, "x-gpu-memory-gb": 4 },
        policy: { image: "synthetic", ...reservation, "x-gpu-memory-gb": 24 },
      },
    }),
  );
  const problems: string[] = [];
  const plan = parseCompose(file, task, null, null, {}, problems);
  expect(problems).toEqual([]);
  const spec = RunSpec.parse({
    image: "synthetic",
    command: ["true"],
    resources: { gpus: plan.mainGpus, gpuMemGB: plan.mainGpuMemGB },
    services: plan.services,
  });
  expect(roleRequests(spec)[0]).toMatchObject({ gpus: 1, gpuMemGB: 28 });
});

it("sums multiple shared budgets per card without increasing the GPU count", () => {
  const spec = sharedBudget();
  spec.resources.gpus = 2;
  const policy = spec.services[0];
  if (!policy) throw new Error("missing service fixture");
  spec.services.push({ ...policy, name: "monitor", gpuMemGB: 2 });
  const roles = roleRequests(spec);
  expect(roles[0]).toMatchObject({ gpus: 2, gpuMemGB: 30 });
  expect(allocateRoles(roles, capacities([8, 32, 32]), [])).toMatchObject({
    ok: true,
    gpuIds: ["GPU-1", "GPU-2"],
  });
});

it("translates an EFE-style task: main GPU, monitor sharing it, gpu_types and shm", () => {
  const task = join(dir, "tasks", "suite-a", "t1");
  mkdirSync(join(task, "environment"), { recursive: true });
  mkdirSync(join(task, "tests"), { recursive: true });
  mkdirSync(join(task, "solution"), { recursive: true });
  writeFileSync(join(task, "solution", "solve.sh"), "true");
  writeFileSync(join(task, "instruction.md"), "do it");
  writeFileSync(join(task, "tests", "test.sh"), "true");
  writeFileSync(join(task, "environment", "Dockerfile"), "FROM scratch");
  writeFileSync(
    join(task, "task.toml"),
    '[environment]\ncpus = 2\nmemory_mb = 4096\ngpu_types = ["L40S", "RTX 4090"]\n',
  );
  writeFileSync(
    join(task, "environment", "docker-compose.yaml"),
    JSON.stringify({
      services: {
        main: {
          deploy: {
            resources: {
              reservations: { devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }] },
            },
          },
          shm_size: "8gb",
        },
        mon: {
          image: "m",
          deploy: {
            resources: {
              reservations: { devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }] },
            },
          },
        },
      },
    }),
  );
  const [t] = findHarborTasks(dir);
  expect(t).toMatchObject({ supported: true, tags: { suite: "suite-a" } });
  const spec = RunSpec.parse(
    harborSolveSpec(t as never, { name: "o", agent: "oracle" } as never, join(dir, "s")),
  );
  expect(spec.resources).toMatchObject({ gpus: 1, gpuModels: ["L40S", "RTX 4090"] });
  expect(spec.shmGB).toBe(8);
  expect(spec.services[0]).toMatchObject({ name: "mon", gpusOf: "main" });
  const [any] = findHarborTasks(dir, { gpuTypes: "any" });
  expect(any?.deviations.join(" ")).toMatch(/gpu_types L40S \/ RTX 4090 not enforced/);
  const args = runArgs({
    name: "n",
    image: "i",
    command: [],
    labels: {},
    gpuIds: [],
    gpuMode: "gpus",
    cpus: 2,
    memGB: 4,
    mounts: [],
    env: {},
    workdir: null,
    network: "none",
    user: null,
    shmGB: 8,
  });
  expect(args.filter((a) => a === "--shm-size")).toHaveLength(1);
  expect(args).toContain("8192m");
});

it("routes a GPU-model restricted run only to a worker with that model", async () => {
  const { remoteBlocker } = await import("../src/runs/placement.ts");
  const spec = RunSpec.parse({
    image: "x",
    command: ["x"],
    resources: { gpus: 1, cpus: 1, memGB: 1, gpuModels: ["L40S"] },
  });
  const worker = (resources: NodeResources) => ({
    name: "w",
    online: true,
    resources,
    leases: [],
    datasets: [],
    profiles: [],
  });
  const only3090 = NodeResources.parse({ ...node, gpus: [node.gpus[0]] });
  expect(remoteBlocker(spec, worker(only3090) as never)).toMatch(/L40S/);
  expect(remoteBlocker(spec, worker(node) as never)).toBeNull();
});

it("matches GPU models on whole words of the card name", async () => {
  const { modelMatches } = await import("../src/resources/allocate.ts");
  expect(modelMatches("NVIDIA L4", ["L4"])).toBe(true);
  expect(modelMatches("NVIDIA L40S", ["L4"])).toBe(false);
  expect(modelMatches("NVIDIA A100-SXM4-80GB", ["A10"])).toBe(false);
  expect(modelMatches("NVIDIA GeForce RTX 4090", ["RTX 4090"])).toBe(true);
  expect(modelMatches("NVIDIA RTX 6000 Ada Generation", ["RTX 6000 Ada"])).toBe(true);
  expect(modelMatches("NVIDIA GeForce RTX 3090", ["RTX 4090", "L40S"])).toBe(false);
});

it("refuses ambiguous GPU layouts and applies gpu_types to every GPU role", () => {
  const reservation = {
    deploy: {
      resources: {
        reservations: { devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }] },
      },
    },
  };
  const make = (name: string, toml: string, services: object) => {
    const task = join(dir, "tasks2", name);
    for (const d of ["environment", "tests", "solution"])
      mkdirSync(join(task, d), { recursive: true });
    writeFileSync(join(task, "instruction.md"), "x");
    writeFileSync(join(task, "tests", "test.sh"), "true");
    writeFileSync(join(task, "solution", "solve.sh"), "true");
    writeFileSync(join(task, "environment", "Dockerfile"), "FROM scratch");
    writeFileSync(join(task, "task.toml"), toml);
    writeFileSync(join(task, "environment", "docker-compose.yaml"), JSON.stringify({ services }));
  };
  make("both", "[environment]\ngpus = 1\n", { main: {}, sim: { image: "s", ...reservation } });
  make("roles", '[environment]\ngpu_types = ["L40S"]\n', {
    main: { ...reservation },
    sim: { image: "s", "x-orbit-role": "sim", ...reservation },
  });
  const tasks = findHarborTasks(join(dir, "tasks2"));
  const both = tasks.find((t) => t.id === "both");
  expect(both?.reason).toContain("[environment] gpus with a compose GPU service is not supported");
  const roles = tasks.find((t) => t.id === "roles");
  expect(roles?.supported).toBe(true);
  expect(roles?.env.gpuModels).toEqual(["L40S"]);
  expect(roles?.compose?.services.find((s) => s.name === "sim")?.gpuModels).toEqual(["L40S"]);
});

it("tags Embodied First Exam tasks with their workspace profile by mode", async () => {
  const { embodiedTags } = await import("../src/bench/harbor.ts");
  const task = { name: "embodied-first-exam/x" };
  expect(embodiedTags("mw-i00-privileged", task, { oracle: "full" })).toMatchObject({
    domain: "embodied",
    profile: "embodied-program",
    mode: "privileged",
    oracle: "full",
  });
  expect(embodiedTags("mw-i00-standard-realtime", task, {})).toMatchObject({
    profile: "embodied-live",
    mode: "realtime",
  });
  expect(embodiedTags("roboengineer-g1-i00-standard", task, {}).profile).toBe("embodied-program");
  expect(embodiedTags("x-standard", { name: "other/x" }, {})).toEqual({});
});
