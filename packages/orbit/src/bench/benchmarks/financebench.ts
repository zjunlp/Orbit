import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const financebench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "financebench",
  name: "FinanceBench",
  description: "Public financial QA with original PDFs and answer-bound human judgments.",
  taxonomyGroups: [
    group("Question answering", {
      domains: ["finance"],
      taskTypes: ["answering"],
      modalities: ["text"],
      interfaces: ["response"],
      scoringMethods: ["human-review"],
    }),
  ],
  integrations: [
    route(
      "Native question adapter",
      adapter("financebench"),
      "150 public cases, full-document or oracle-context; new answers need human review.",
    ),
  ],
  verification: checked(
    "Four original cases in each context condition passed published human-label reference/empty checks twice. New model answers require human review.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["Original questions"],
};
