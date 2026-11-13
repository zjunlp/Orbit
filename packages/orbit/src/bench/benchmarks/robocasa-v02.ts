import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const robocasaV02: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robocasa-v02",
  name: "RoboCasa v0.2",
  description: "Evaluate the original RoboCasa atomic kitchen manipulation tasks.",
  taxonomyGroups: [group("Original kitchen manipulation", native)],
  integrations: [
    nativeRoute(
      "24 atomic tasks with held-out object instances, fixed kitchen layouts and PandaOmron arm control.",
      "examples/bench-adapters/embodied/benchmarks/robocasa-v02/README.md",
    ),
  ],
  verification: checked(
    "All 24 tasks passed native CPU checks. A fixed-action replay matched the v0.2 environment.",
    "docs/tasks/20261109-robocasa-v02.md",
  ),
  suites: ["Atomic-24"],
};
