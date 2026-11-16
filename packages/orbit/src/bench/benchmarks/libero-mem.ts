import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const liberoMem: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "libero-mem",
  name: "LIBERO-Mem",
  description:
    "Evaluate memory-dependent ordered manipulation with native subgoal progression and alternative valid branches.",
  taxonomyGroups: [
    group("Ordered manipulation tasks", { ...native, targets: ["control", "memory"] }),
  ],
  integrations: [
    nativeRoute(
      "Ten native ordered tasks and twenty frozen initial states per task. Verification checks ordered progress and whole-sequence completion.",
      "examples/bench-adapters/embodied/benchmarks/libero-mem/README.md",
    ),
  ],
  verification: checked(
    "All ten tasks passed reset, observation and control checks. A frozen pi0.5 sample passed independent CPU verification and rescore. Full-suite model evaluation remains pending.",
    "docs/tasks/20261114-libero-mem.md",
  ),
  suites: ["Ordered manipulation (10 tasks)"],
};
