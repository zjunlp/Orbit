import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const embodiedlab: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "embodiedlab",
  name: "EmbodiedLab",
  description:
    "Evaluate agents performing robot-controlled scientific experiments and submitting evidenced results.",
  taxonomyGroups: [
    group("Scientific experiments with T0 robot control", {
      domains: ["science", "robotics"],
      taskTypes: ["experimentation", "analysis", "manipulation"],
      targets: ["knowledge", "tool-use", "control"],
      modalities: ["text", "image", "structured-data"],
      interfaces: ["terminal", "file-edit", "physical-control"],
      platforms: ["simulation"],
      world: ["controlled"],
      feedback: ["step"],
      participants: [],
      scoringEvidence: ["artifact", "trajectory"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Native experiment service adapter",
      adapter("embodiedlab"),
      "30 native experiments through the T0 public robot API and private native grader; T1 services and unreleased T2 remain unsupported. Requires Isaac Sim 6.0.1.",
    ),
  ],
  verification: checked(
    "pending-calibration",
    "Images and native CPU dependencies were checked. Real startup detected an incompatible RTX runtime; experiment calibration requires a compatible environment.",
    "docs/tasks/20261110-embodied-harness-benchmarks.md",
  ),
  suites: ["Mechanics", "Circuits", "Optics", "Thermal physics", "Chemistry"],
};
