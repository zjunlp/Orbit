import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const bigym2: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "bigym2",
  name: "BiGym 2.0",
  description:
    "Evaluate the twenty native learned-policy tasks with G1 control and success that excludes falls.",
  taxonomyGroups: [group("Native learned-policy tasks", { ...native, targets: ["control"] })],
  integrations: [
    nativeRoute(
      "Twenty learned-policy tasks with separate pitch and no-pitch action profiles. The coding-agent track is not included.",
      "examples/bench-adapters/embodied/benchmarks/bigym2/README.md",
    ),
  ],
  verification: checked(
    "All twenty tasks passed native reset and one-step control checks. Both layouts passed fixed-action comparison, CPU evidence verification and rescore. Trained-policy and full-suite evaluation remain pending.",
    "docs/tasks/20261112-bigym2.md",
  ),
  suites: ["No pitch (6 tasks)", "Pitch (14 tasks)"],
};
