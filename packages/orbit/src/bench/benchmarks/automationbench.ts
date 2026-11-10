import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const automationbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "automationbench",
  name: "AutomationBench",
  description:
    "Execute business workflows through the original simulated service APIs and strict task rubric.",
  taxonomyGroups: [
    group("Public and simple workflows", {
      domains: ["business-services"],
      taskTypes: ["business-operation"],
      targets: ["tool-use"],
      modalities: ["text", "structured-data"],
      interfaces: ["tool-api"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["step"],
      scoringEvidence: ["final-state", "trajectory"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Native auto-bench adapter",
      adapter("automationbench"),
      "600 public tasks and 200 simple tasks registered separately. Native external agent and empty baseline; the leaderboard's private split is unavailable.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Original empty scoring and a real model rollout checked. Full-suite model evaluation and private leaderboard parity are unverified.",
    "docs/tasks/20261110-benchmark-gaps.md",
  ),
  suites: ["Public (six business domains)", "Simple (separate calibration suite)"],
};
