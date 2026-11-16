import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const legalbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "legalbench",
  name: "LegalBench",
  description: "English legal reasoning with the original task-specific metrics.",
  taxonomyGroups: [
    group("Legal reasoning and extraction", {
      domains: ["law-public-affairs"],
      taskTypes: ["answering", "information-processing"],
      targets: ["reasoning"],
      modalities: ["text"],
      interfaces: ["response"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["none"],
      participants: [],
      scoringEvidence: ["response"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "LegalBench adapter",
      adapter("legalbench"),
      "Complete task test sets; native scoring. Human-graded rule_qa is unsupported.",
    ),
  ],
  verification: checked(
    "Four task types passed real Docker empty/reference calibration, repeatability, rescore and cleanup checks. Native scorer comparison agreed; sara_numeric declares a partial oracle due to an upstream zero-reference bug. No model or full-suite parity claim.",
    "docs/tasks/20261116-benchmark-expansion.md",
  ),
  suites: ["Legal reasoning tasks"],
};
