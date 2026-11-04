// Pure allocation and spec translation; no GPUs or Docker are used.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { findHarborTasks, harborSolveSpec } from "../src/bench/harbor.ts";
import { NodeResources, type Run, RunSpec, roleRequests } from "../src/contracts/index.ts";
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
