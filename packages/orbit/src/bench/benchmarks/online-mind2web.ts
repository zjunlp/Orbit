import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const onlineMind2web: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "online-mind2web",
  name: "Online-Mind2Web",
  description:
    "Retrieve information from live websites through the native browser and terminal evaluator.",
  taxonomyGroups: [
    group("GitHub issue and commit retrieval", {
      ...browser,
      domains: ["software"],
      taskTypes: ["retrieval"],
      world: ["live"],
      scoringEvidence: ["response", "trajectory"],
      scoringMethods: ["model-judge"],
    }),
    group("Reinforcement-learning paper retrieval", {
      ...browser,
      domains: ["machine-learning"],
      taskTypes: ["retrieval"],
      world: ["live"],
      scoringEvidence: ["response", "trajectory"],
      scoringMethods: ["model-judge"],
    }),
    group("Recipe and weather retrieval", {
      ...browser,
      domains: ["general-knowledge"],
      taskTypes: ["retrieval"],
      world: ["live"],
      scoringEvidence: ["response", "trajectory"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "CUA-Lite adapter",
      adapter("cua-lite"),
      "Five reviewed read-only tasks; original backend and judge dependencies required. Live website availability is not guaranteed.",
    ),
  ],
  verification: checked(
    "Subset and evaluator boundaries reviewed; positive model calibration is still pending.",
    adapter("cua-lite"),
  ),
  suites: ["Five reviewed read-only tasks"],
};
