import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const cliport: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "cliport",
  name: "CLIPort",
  description: "Evaluate language-conditioned tabletop pick-and-place and sweeping in PyBullet.",
  taxonomyGroups: [group("Tabletop manipulation", native)],
  integrations: [
    nativeRoute(
      "All 18 language-conditioned test entries with 100 oracle-feasible seeds each.",
      "examples/bench-adapters/embodied/benchmarks/cliport/README.md",
    ),
  ],
  verification: checked(
    "All entries passed sampled seed preparation. Sampled real-policy pick-and-place and sweeping passed CPU verification and rescore.",
    "docs/tasks/20261112-cliport.md",
  ),
  suites: ["Pick and place", "Push and sweep"],
};
