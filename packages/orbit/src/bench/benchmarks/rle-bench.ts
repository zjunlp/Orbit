import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const rleBench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "rle-bench",
  name: "RLE-Bench",
  description: "Evaluate coding agents on robotic engineering, control and design tasks.",
  taxonomyGroups: [
    group("Robotic engineering workflows", {
      ...workspace,
      domains: ["robotics"],
      taskTypes: ["implementation", "experimentation", "optimization"],
      targets: ["planning", "tool-use", "control"],
      platforms: ["simulation"],
      world: ["controlled"],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
  ],
  integrations: [
    route(
      "Native Harbor bridge",
      adapter("rle-bench"),
      "All 51 workflows remain visible; tasks 07 and 08 use the supported Harbor subset. Task 09 lacks native grader isolation; other unsupported runtime conditions remain explicit.",
    ),
  ],
  verification: checked(
    "Native empty/reference calibration passed on task08; saved output from a provider-interrupted Agent run was independently graded. Task07 and full-suite equivalence remain unverified.",
    "docs/tasks/20261110-embodied-harness-benchmarks.md",
  ),
  suites: ["Robot perception", "Policy learning", "Control", "Robot design"],
};
