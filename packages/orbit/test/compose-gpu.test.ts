import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCompose } from "../src/bench/compose.ts";
import { RunSpec, roleRequests } from "../src/contracts/index.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-compose-gpu-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const reservation = (device: object = { driver: "nvidia", count: 1, capabilities: ["gpu"] }) => ({
  resources: { reservations: { devices: [device] } },
});
const parse = (service: object, extra: object = {}) => {
  const file = join(dir, "docker-compose.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      services: {
        main: { depends_on: ["simulator"] },
        simulator: { image: "sim", ...service },
        ...extra,
      },
    }),
  );
  const problems: string[] = [];
  const plan = parseCompose(file, dir, null, null, {}, problems);
  return { plan, problems };
};

describe("Compose GPU service reservations", () => {
  it("requires an explicit role and maps GPU count and memory to that role", () => {
    const { plan, problems } = parse({
      "x-orbit-role": "sim",
      "x-gpu-memory-gb": 13,
      deploy: reservation({ driver: "nvidia", count: 2, capabilities: ["gpu"] }),
    });
    expect(problems).toEqual([]);
    expect(plan.services[0]).toMatchObject({
      name: "simulator",
      role: "sim",
      gpus: 2,
      gpuMemGB: 13,
    });
    const spec = RunSpec.parse({ image: "agent", command: ["true"], services: plan.services });
    expect(roleRequests(spec).find((r) => r.role === "sim")).toMatchObject({
      gpus: 2,
      gpuMemGB: 13,
    });
  });

  it("leases unroled reservations once, as Compose shares them on one host (EFE standard)", () => {
    const { plan, problems } = parse(
      { deploy: reservation(), "x-gpu-memory-gb": 3 },
      {
        monitor: {
          image: "mon",
          pid: "host",
          network_mode: "none",
          deploy: reservation(),
          "x-gpu-memory-gb": 1,
        },
      },
    );
    expect(problems.filter((p) => !p.includes("hostNamespaces"))).toEqual([]);
    expect(plan.sharedGpuOwner).toBe("simulator");
    expect(plan.services[0]).toMatchObject({ role: "simulator", gpus: 1, gpuMemGB: 4 });
    expect(plan.services[1]).toMatchObject({ gpusOf: "simulator" });
    expect(plan.services[1]?.gpus).toBeUndefined();
  });

  it("gives main's reservation to main and lets a monitor see it (EFE privileged)", () => {
    const file = join(dir, "docker-compose.yaml");
    writeFileSync(
      file,
      JSON.stringify({
        services: {
          main: { deploy: reservation(), "x-gpu-memory-gb": 13, shm_size: "8gb" },
          monitor: { image: "mon", deploy: reservation() },
        },
      }),
    );
    const problems: string[] = [];
    const plan = parseCompose(file, dir, null, null, {}, problems);
    expect(problems).toEqual([]);
    expect(plan).toMatchObject({ mainGpus: 1, mainGpuMemGB: 13, mainShmGB: 8 });
    expect(plan.services[0]).toMatchObject({ gpusOf: "main" });
    const spec = RunSpec.parse({
      image: "x",
      command: ["x"],
      resources: { gpus: 1, cpus: 1, memGB: 1 },
      services: plan.services,
    });
    expect(roleRequests(spec).map((r) => [r.role, r.gpus])).toEqual([["main", 1]]);
    expect(() => RunSpec.parse({ image: "x", command: ["x"], services: plan.services })).toThrow(
      /gpusOf main names no role with GPUs/,
    );
  });

  it("refuses unroled reservations of different sizes or owned only by monitors", () => {
    expect(
      parse(
        { deploy: reservation() },
        {
          other: {
            image: "o",
            deploy: reservation({ driver: "nvidia", count: 2, capabilities: ["gpu"] }),
          },
        },
      ).problems,
    ).toContain("compose GPU reservations without x-orbit-role must request the same count");
  });

  it("maps a list entrypoint to Docker's executable and leading arguments", () => {
    const { plan, problems } = parse({
      entrypoint: ["sh", "-c", 'stage && exec "$$@"', "stage"],
      command: ["python", "/srv/server.py"],
    });
    expect(problems).toEqual([]);
    expect(plan.services[0]).toMatchObject({
      entrypoint: "sh",
      command: ["-c", 'stage && exec "$@"', "stage", "python", "/srv/server.py"],
    });
  });

  it("accepts numeric values after Compose interpolation", () => {
    const { plan, problems } = parse({
      "x-orbit-role": "sim",
      "x-gpu-memory-gb": `\${MEM:-5}`,
      deploy: reservation({ driver: "nvidia", count: `\${GPUS:-1}`, capabilities: ["gpu"] }),
    });
    expect(problems).toEqual([]);
    expect(plan.services[0]).toMatchObject({ gpus: 1, gpuMemGB: 5 });
  });

  it.each([
    { driver: "amd", count: 1, capabilities: ["gpu"] },
    { driver: "nvidia", count: "all", capabilities: ["gpu"] },
    { driver: "nvidia", count: 0, capabilities: ["gpu"] },
    { driver: "nvidia", count: 1.5, capabilities: ["gpu"] },
    { driver: "nvidia", capabilities: ["gpu"] },
    { driver: "nvidia", count: 1, capabilities: ["gpu", "utility"] },
    { driver: "nvidia", count: 1, capabilities: "gpu" },
    { driver: "nvidia", count: 1, capabilities: ["gpu"], device_ids: ["0"] },
    { driver: "nvidia", count: 1, capabilities: ["gpu"], options: { ignored: true } },
  ])("refuses unsupported or ambiguous device reservations: %j", (device) => {
    expect(
      parse({ "x-orbit-role": "sim", deploy: reservation(device) }).problems.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    { ...reservation(), replicas: 2 },
    { resources: { ...reservation().resources, limits: { cpus: "2" } } },
    {
      resources: {
        reservations: {
          devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }],
          memory: "1g",
        },
      },
    },
    { resources: { reservations: { devices: [] } } },
    {
      resources: {
        reservations: {
          devices: [
            { driver: "nvidia", count: 1, capabilities: ["gpu"] },
            { driver: "nvidia", count: 1, capabilities: ["gpu"] },
          ],
        },
      },
    },
    { resources: [] },
    {},
    "global",
  ])("refuses all unsupported deploy keys and shapes: %j", (deploy) => {
    expect(parse({ "x-orbit-role": "sim", deploy }).problems.length).toBeGreaterThan(0);
  });

  it.each(["main", "Not A Role", ""])("refuses invalid or reserved role %s", (role) => {
    expect(parse({ "x-orbit-role": role, deploy: reservation() }).problems).toContain(
      "compose service simulator: x-orbit-role must be a valid role other than main",
    );
  });

  it("refuses duplicate roles and memory without a GPU reservation", () => {
    expect(
      parse(
        { "x-orbit-role": "sim", deploy: reservation() },
        {
          another: { image: "test", "x-orbit-role": "sim", deploy: reservation() },
        },
      ).problems,
    ).toContain("compose service another: x-orbit-role sim is already assigned to another service");
    expect(parse({ "x-orbit-role": "sim", "x-gpu-memory-gb": 5 }).problems).toContain(
      "compose service simulator: x-gpu-memory-gb needs a GPU reservation",
    );
    expect(
      parse({ "x-orbit-role": "sim", deploy: reservation(), "x-gpu-memory-gb": -1 }).problems,
    ).toContain("compose service simulator: x-gpu-memory-gb must be a positive number");
  });

  it("keeps unrelated unsupported service settings visible", () => {
    expect(
      parse({ "x-orbit-role": "sim", deploy: reservation(), privileged: true }).problems,
    ).toContain("compose service simulator: privileged is not supported");
  });
});
