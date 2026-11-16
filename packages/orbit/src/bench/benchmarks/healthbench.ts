import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const healthbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "healthbench",
  name: "HealthBench",
  description: "Original questions with an independent native LLM judge.",
  taxonomyGroups: [
    group("Question answering", {
      domains: ["healthcare"],
      taskTypes: ["answering"],
      modalities: ["text"],
      interfaces: ["response"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Native question adapter",
      adapter("healthbench"),
      "Original per-question inputs and native scoring; separately configured judge required.",
    ),
  ],
  verification: checked(
    "Four original conversations passed repeated empty-answer native rubric checks with an explicitly configured alternative judge. Nonempty model answers and official aggregate parity remain unverified.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["Original questions"],
};
