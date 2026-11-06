import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectGpuMode } from "../src/executor/docker.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const homes: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Docker GPU mode", () => {
  it("requires Docker to enable the directory, even when an NVIDIA spec exists locally", () => {
    const home = mkdtempSync(join(tmpdir(), "orbit-cdi-"));
    homes.push(home);
    writeFileSync(join(home, "nvidia.yaml"), 'kind: "nvidia.com/gpu"\n');
    const info = vi.mocked(execFileSync);
    info.mockReturnValue(JSON.stringify([home]));
    expect(detectGpuMode()).toBe("cdi");
    expect(info).toHaveBeenCalledWith(
      "docker",
      ["info", "--format", "{{json .CDISpecDirs}}"],
      expect.objectContaining({ timeout: 2000 }),
    );
    info.mockReturnValue("[]");
    expect(detectGpuMode()).toBe("gpus");
    info.mockReturnValue(JSON.stringify([join(home, "missing")]));
    expect(detectGpuMode()).toBe("gpus");
  });

  it("uses the legacy flag when Docker cannot report CDI support", () => {
    const info = vi.mocked(execFileSync);
    for (const value of ["null", "{}", "[42]", "unsupported"] as const) {
      info.mockReturnValue(value);
      expect(detectGpuMode()).toBe("gpus");
    }
    info.mockImplementation(() => {
      throw new Error("Docker info unavailable");
    });
    expect(detectGpuMode()).toBe("gpus");
  });
});
