import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const embodiedClbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "embodied-clbench",
  name: "EmbodiedCLBench",
  description: "Evaluate embodied agents and experience reuse across native task sequences.",
  taxonomyGroups: [
    group("Basic and zero-shot episodes", {
      domains: ["robotics"],
      taskTypes: ["navigation", "manipulation"],
      targets: ["planning", "tool-use", "perception-grounding"],
      modalities: ["text", "image"],
      interfaces: ["tool-api"],
      platforms: ["simulation"],
      world: ["controlled"],
      feedback: ["step"],
      participants: [],
      scoringEvidence: ["trajectory", "final-state"],
      scoringMethods: ["rule-check"],
    }),
    group("In-context continual sequences", {
      domains: ["robotics"],
      taskTypes: ["navigation", "manipulation"],
      targets: [
        "memory",
        "learning-adaptation",
        "generalization",
        "planning",
        "tool-use",
        "perception-grounding",
      ],
      modalities: ["text", "image"],
      interfaces: ["tool-api"],
      platforms: ["simulation"],
      world: ["controlled"],
      feedback: ["step"],
      participants: [],
      scoringEvidence: ["trajectory", "final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Native sequence MCP adapter",
      adapter("embodied-clbench"),
      "Basic, zero-shot and complete in-context sequences preserve native images, tools and grading. Skill-summary sessions remain unsupported.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "A native basic task and complete in-context sequence passed reference/empty and real visual CLI Agent checks. Full-suite parity is unverified.",
    "docs/tasks/20261110-embodied-harness-benchmarks.md",
  ),
  suites: ["Basic", "Zero-shot", "In-context continual learning"],
};
