import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";
export const appworld: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "appworld",
  name: "AppWorld",
  description: "Stateful API tasks with original AppWorld evaluation.",
  taxonomyGroups: [
    group("Business operations", {
      domains: ["business-services"],
      taskTypes: ["business-operation"],
      modalities: ["text", "structured-data"],
      interfaces: ["tool-api"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["step"],
      participants: ["simulated-user"],
      scoringEvidence: ["final-state", "trajectory"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "AppWorld adapter",
      adapter("appworld"),
      "Pinned 0.1.3.post1 train/dev native execution and fresh replay.",
    ),
  ],
  verification: checked(
    "Public train calibration uses original AppWorld execution and evaluation; test split and remote services are unsupported.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["AppWorld train/dev"],
};
