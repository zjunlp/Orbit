import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const ebNavigation: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "eb-navigation",
  name: "EB-Navigation",
  description:
    "Follow language instructions in AI2-THOR with projected first-person and overhead views.",
  taxonomyGroups: [group("Vision-language navigation", { ...native, taskTypes: ["navigation"] })],
  integrations: [
    nativeRoute(
      "300 published episodes across five subsets, with native action feedback and distance-based stopping.",
      "examples/bench-adapters/embodied/benchmarks/eb-navigation/README.md",
    ),
  ],
  verification: checked(
    "All published episodes passed native reset and rendering. Sampled actions matched the upstream evaluator, and sampled SeeNav and Qwen rollouts passed CPU verification.",
    "docs/tasks/20261114-eb-navigation.md",
  ),
  suites: ["Base", "Common sense", "Complex instruction", "Visual appearance", "Long horizon"],
};
