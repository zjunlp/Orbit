import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const behavior1k: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "behavior-1k",
  name: "BEHAVIOR-1K",
  description: "Evaluate native R1Pro policies on household activities in OmniGibson.",
  taxonomyGroups: [group("Native household manipulation", native)],
  integrations: [
    nativeRoute(
      "Complete released activity catalog, with the prepared 2026 R1Pro public-test subset runnable. Requires licensed assets and an RTX runtime.",
      "examples/bench-adapters/embodied/benchmarks/behavior-1k/README.md",
    ),
  ],
  verification: checked(
    "Source, frozen-instance and evidence checks; native physics calibration remains pending.",
    "docs/tasks/20261113-behavior-robotagent.md",
  ),
  suites: ["2026 R1Pro public test"],
};
