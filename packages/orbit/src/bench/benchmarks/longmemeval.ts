import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const longmemeval: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "longmemeval",
  name: "LongMemEval",
  description:
    "Original timestamped conversational histories with the native category-specific judge.",
  taxonomyGroups: [
    group("Question answering", {
      targets: ["memory"],
      taskTypes: ["answering"],
      modalities: ["text"],
      interfaces: ["response"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Native question adapter",
      adapter("longmemeval"),
      "Original per-question inputs and native scoring; separately configured judge required.",
    ),
  ],
  verification: checked(
    "Four original questions passed reference/empty checks twice with an explicitly configured alternative judge. Full-suite and official-model parity are unverified.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["Oracle retrieval", "LongMemEval-S", "LongMemEval-M"],
};
