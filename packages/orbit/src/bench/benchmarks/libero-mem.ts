import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const liberoMem: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "libero-mem",
  name: "LIBERO-Mem",
  description: "Evaluate ordered manipulation subgoals that require remembering previous actions.",
  taxonomyGroups: [group("Ordered manipulation", native)],
  integrations: [
    nativeRoute(
      "All ten tasks and 200 published initial states, with native subgoal-progress scoring.",
      "examples/bench-adapters/embodied/benchmarks/libero-mem/README.md",
    ),
  ],
  verification: checked(
    "All ten tasks passed reset, observation and action checks. A sampled π₀.₅ rollout passed CPU verification and rescore.",
    "docs/tasks/20261114-libero-mem.md",
  ),
  suites: [],
};
