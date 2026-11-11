import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route } from "./shared.ts";

export const humaneval: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "humaneval",
  name: "HumanEval",
  description: "Generate Python functions from specifications and check them with execution tests.",
  taxonomyGroups: [
    group("Function generation", {
      domains: ["software"],
      taskTypes: ["implementation"],
      modalities: ["text"],
      interfaces: ["response"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["none"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
  ],
  integrations: [
    route(
      "HumanEval adapter",
      "examples/bench-adapters/humaneval/adapter.py",
      "Original 164-task Python catalog; oracle, empty and external methods.",
    ),
  ],
  verification: checked(
    "Reference and empty checks passed; this is integration validation, not a model leaderboard result.",
    "docs/tasks/20261105-samples-c1-c7.md",
  ),
  suites: ["Python function completion"],
};
