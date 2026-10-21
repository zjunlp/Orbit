import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.each(["posttrainbench", "researchclawbench", "longds"])(
  "checks the %s Python adapter",
  (name) => {
    const dir = fileURLToPath(
      new URL(`../../../examples/bench-adapters/${name}/`, import.meta.url),
    );
    execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", dir], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: "pipe",
    });
  },
);
