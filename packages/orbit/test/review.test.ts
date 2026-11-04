// Regressions from the full-branch review: input validation, file serving and container arguments.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expandGrid } from "../src/cli/program.ts";
import { type NodeResources, ResourceRequest, RunSpec } from "../src/contracts/index.ts";
import { runArgs } from "../src/executor/docker.ts";
import { decodePath, outputFile } from "../src/records/index.ts";
import { infeasible } from "../src/resources/allocate.ts";

const tmp = mkdtempSync(join(tmpdir(), "orbit-review-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("RunSpec validation", () => {
  const base = { image: "x", command: ["true"] };
  const ok = (over: object) => RunSpec.safeParse({ ...base, ...over }).success;
  it("rejects unsafe or colliding mount targets and `..` in collect paths", () => {
    expect(ok({ mounts: [{ source: "/a", target: "/data" }] })).toBe(true);
    expect(ok({ mounts: [{ source: "/a", target: "data" }] })).toBe(false);
    expect(ok({ mounts: [{ source: "/a", target: "/orbit/x" }] })).toBe(false);
    expect(ok({ mounts: [{ source: "/a", target: "/workspace" }], project: "/p" })).toBe(false);
    expect(ok({ mounts: [{ source: "/a", target: "/workspace" }] })).toBe(true);
    expect(ok({ mounts: [{ source: "/a", target: "/d/../orbit" }] })).toBe(false);
    expect(
      ok({
        mounts: [
          { source: "/a", target: "/d" },
          { source: "/b", target: "/d/" },
        ],
      }),
    ).toBe(false);
    expect(ok({ collect: ["/app/out"] })).toBe(true);
    expect(ok({ collect: ["/app/../etc"] })).toBe(false);
  });
});

describe("output files", () => {
  const out = join(tmp, "output");
  mkdirSync(join(out, "sub"), { recursive: true });
  writeFileSync(join(out, "sub", "a.txt"), "a");
  writeFileSync(join(tmp, "secret.txt"), "s");
  symlinkSync(join(tmp, "secret.txt"), join(out, "escape"));
  symlinkSync(join(out, "sub", "a.txt"), join(out, "inside"));

  it("serves regular files inside the directory and refuses final-component symlinks", async () => {
    const file = await outputFile(out, "sub/a.txt");
    expect(file?.size).toBe(1);
    expect(await new Response(file?.body).text()).toBe("a");
    expect(await outputFile(out, "inside")).toBeNull();
    expect(await outputFile(out, "escape")).toBeNull();
    expect(await outputFile(out, "../secret.txt")).toBeNull();
    expect(await outputFile(out, "sub")).toBeNull();
  });

  it("decodes request paths and rejects malformed escapes", () => {
    expect(decodePath("/api/v1/runs/r/files/a%20b/%E2%9C%93.txt", "/files/")).toBe("a b/✓.txt");
    expect(() => decodePath("/files/%E2%9C", "/files/")).toThrow(URIError);
  });
});

describe("sweep grid", () => {
  it("expands parameters and rejects empty or unusable keys", () => {
    expect(expandGrid(["lr=1,2", "s=a"])).toEqual([
      { lr: "1", s: "a" },
      { lr: "2", s: "a" },
    ]);
    expect(() => expandGrid([])).toThrow(/at least one/);
    expect(() => expandGrid(["a-b=1"])).toThrow(/key/);
    expect(() => expandGrid(["lr="])).toThrow(/no values/);
  });
});

describe("GPU memory requests", () => {
  const node = (memTotalMiB: number): NodeResources => ({
    node: "n",
    probedAt: "",
    gpus: [
      {
        index: 0,
        uuid: "GPU-0",
        name: "H100",
        memTotalMiB,
        memUsedMiB: 0,
        utilPct: 0,
        externalMemMiB: 0,
        available: true,
        processes: [],
      },
    ],
    gpuError: null,
    devices: [],
    cpu: { count: 32, load1: 0, busy: 0 },
    memory: { totalGB: 256, availableGB: 200 },
    disk: { path: "/", totalGB: 1, freeGB: 1 },
  });
  it("matches a nominal size against the slightly smaller reported size", () => {
    const req = ResourceRequest.parse({ gpus: 1, gpuMemGB: 80 });
    expect(infeasible(req, node(81559))).toBeNull();
    expect(infeasible(req, node(49140))).toMatch(/0 matching/);
  });
});

describe("docker run arguments", () => {
  const spec = {
    name: "orbit-r",
    image: "img",
    command: ["true"],
    labels: {},
    gpuIds: [],
    gpuMode: "gpus" as const,
    cpus: 1,
    memGB: 1,
    mounts: [{ source: "/data/a,b", target: "/in", mode: "ro" as const }],
    env: {},
    workdir: null,
    network: "bridge" as const,
    user: null,
  };
  it("hides all GPUs without a GPU lease and quotes mount fields", () => {
    const args = runArgs(spec);
    expect(args.join(" ")).toContain("NVIDIA_VISIBLE_DEVICES=void");
    expect(args).toContain('type=bind,"source=/data/a,b",target=/in,readonly');
  });
});
