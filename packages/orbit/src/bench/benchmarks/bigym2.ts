import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const bigym2: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "bigym2",
  name: "BiGym 2.0",
  description: "Evaluate G1 humanoid manipulation with native joint controls.",
  taxonomyGroups: [group("Humanoid manipulation", native)],
  integrations: [
    nativeRoute(
      "20 learned-policy tasks and 2,000 frozen seeds across the 20D and 21D action registrations.",
      "examples/bench-adapters/embodied/benchmarks/bigym2/README.md",
    ),
  ],
  verification: checked(
    "All tasks passed reset, camera and one-step control checks. Fixed-action samples passed CPU verification. Learned checkpoints are pending.",
    "docs/tasks/20261112-bigym2.md",
  ),
  suites: ["G1 20D", "G1 21D"],
};
