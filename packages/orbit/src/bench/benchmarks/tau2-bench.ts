import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const tau2Bench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "tau2-bench",
  name: "τ²-bench",
  description:
    "Check airline and retail service workflows using the original task definitions and offline evaluator.",
  taxonomyGroups: [
    group("Offline airline and retail calibration", {
      domains: ["business-services"],
      taskTypes: ["business-operation"],
      modalities: ["text", "structured-data"],
      interfaces: ["tool-api", "response"],
      platforms: ["software-system"],
      world: ["controlled"],
      scoringEvidence: ["trajectory", "final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Direct τ² adapter",
      adapter("tau2"),
      "Airline and retail oracle/empty paths only. Live user-model and external agent methods are not implemented.",
    ),
  ],
  verification: checked(
    "Offline environment and scorer calibration passed; no live simulated-user or model quality claim.",
    "docs/tasks/20261105-sample-tau2.md",
  ),
  suites: ["Airline", "Retail"],
};
