import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const rlbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "rlbench",
  name: "RLBench",
  description:
    "Evaluate Panda manipulation in CoppeliaSim with seeded tasks and fixed test demonstrations.",
  taxonomyGroups: [group("Native manipulation tasks", native)],
  integrations: [
    nativeRoute(
      "MT100 with seeded variations and a separate RVT 18-task test suite with frozen initial states.",
      "examples/bench-adapters/embodied/benchmarks/rlbench/README.md",
    ),
  ],
  verification: checked(
    "MT100 and RVT both ran with native CPU rendering. A fixed RVT replay matched the upstream environment.",
    "docs/tasks/20261109-rlbench.md",
  ),
  suites: ["MT100", "RVT test (18 tasks)"],
};
