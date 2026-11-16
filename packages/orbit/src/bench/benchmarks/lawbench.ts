import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const lawbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "lawbench",
  name: "LawBench",
  description: "Chinese legal knowledge and reasoning with native task-specific metrics.",
  taxonomyGroups: [
    group("Chinese legal tasks", {
      domains: ["law-public-affairs"],
      taskTypes: ["answering", "information-processing"],
      targets: ["knowledge", "reasoning"],
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
      "LawBench adapter",
      adapter("lawbench"),
      "Original zero-shot task sets and graders; ChERRANT grammar correction is unsupported.",
    ),
  ],
  verification: checked(
    "Four zero-shot task types passed real Docker empty/reference calibration, repeatability, rescore and cleanup checks. Direct native scorer comparison agreed. No model or full-suite parity claim; grammar correction remains unsupported.",
    "docs/tasks/20261116-benchmark-expansion.md",
  ),
  suites: ["Zero-shot legal tasks"],
};
